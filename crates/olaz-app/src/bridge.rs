//! The official preload's IPC table and preload-local members, answered the way
//! Electron's main process answered them.
//!
//! `bridge.js` runs inside the renderer, `local-modules.js` implements the pure
//! JavaScript members, and this module handles everything that needs the host:
//! files, crypto, cookies, window/navigation commands and the session events.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::sync::mpsc::Sender;
use std::sync::Mutex;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::crypto::CryptoState;
use crate::platform::{path_string, str_arg, HostError, HostResult, Platform};
use crate::secrets;
use crate::server;

const TABLE_JSON: &str = include_str!("../../../resources/bridge-table.json");

type RoutedEvent = (String, String, Vec<Value>);

#[cfg(test)]
mod router_tests {
    use super::*;

    #[test]
    fn routes_tasks_and_restores_request_ids() {
        let mut router = TaskRouter::default();
        router.dispatch("shared-worker-handle", &[json!("TEST")], "worker");
        let run = router.dispatch("shared-worker-run", &[json!({"id": 7, "type": "TEST"})], "main").unwrap();
        assert_eq!(run[0].0, "worker");
        let routed_id = run[0].2[0]["id"].clone();
        assert_ne!(routed_id, json!(7));
        let progress = router.dispatch("shared-worker-progress", &[json!({"id": routed_id, "progress": 50})], "worker").unwrap();
        assert_eq!(progress[0].0, "main");
        assert_eq!(progress[0].2[0]["id"], 7);
        let result = router.dispatch("shared-worker-resp", &[json!({"id": routed_id, "result": "ok"})], "worker").unwrap();
        assert_eq!(result[0].2[0], json!({"id": 7, "result": "ok"}));
        assert!(router.pending.is_empty());
    }

    #[test]
    fn unsupported_tasks_fail_instead_of_hanging() {
        let result = TaskRouter::default().dispatch("shared-worker-run", &[json!({"id": 2, "type": "MISSING"})], "main").unwrap();
        assert_eq!(result[0].0, "main");
        assert_eq!(result[0].2[0]["error"], "Task type is not supported");
    }
}

#[derive(Default)]
struct TaskRouter {
    handlers: BTreeMap<String, String>,
    pending: BTreeMap<String, PendingTask>,
    remote_config: Option<Value>,
}

struct PendingTask {
    requester: String,
    handler: String,
    id: Value,
    task_type: Value,
}

impl TaskRouter {
    fn dispatch(&mut self, channel: &str, args: &[Value], page: &str) -> Option<Vec<RoutedEvent>> {
        let mut events = Vec::new();
        let message = args.first().cloned().unwrap_or(Value::Null);
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        let key = format!("{page}:{id}");
        match channel {
            "shared-worker-handle" => {
                if let Some(kind) = message.as_str() {
                    self.handlers.insert(kind.to_string(), page.to_string());
                }
            }
            "shared-worker-run" => {
                let kind = message.get("type").and_then(Value::as_str).unwrap_or("");
                if let Some(handler) = self.handlers.get(kind) {
                    self.pending.insert(key.clone(), PendingTask {
                        requester: page.into(), handler: handler.clone(), id,
                        task_type: message.get("type").cloned().unwrap_or(Value::Null),
                    });
                    let mut task = message;
                    task["id"] = json!(key);
                    events.push((handler.clone(), channel.into(), vec![task]));
                } else {
                    events.push((page.into(), "shared-worker-resp".into(), vec![json!({
                        "id": id, "error": "Task type is not supported"
                    })]));
                }
            }
            "shared-worker-resp" | "shared-worker-progress" => {
                let key = id.as_str().unwrap_or("");
                if let Some(pending) = self.pending.get(key) {
                    // A page cannot settle another page's registered task.
                    if pending.handler == page {
                        let mut response = message;
                        response["id"] = pending.id.clone();
                        if channel == "shared-worker-progress" {
                            response["type"] = pending.task_type.clone();
                        }
                        events.push((pending.requester.clone(), channel.into(), vec![response]));
                        if channel == "shared-worker-resp" { self.pending.remove(key); }
                    }
                }
            }
            "shared-worker-abort" | "shared-worker-update-params" => {
                if let Some(pending) = self.pending.get(&key) {
                    let mut forwarded = message;
                    forwarded["id"] = json!(key);
                    events.push((pending.handler.clone(), channel.into(), vec![forwarded]));
                    if channel == "shared-worker-abort" {
                        events.push((page.into(), "shared-worker-resp".into(), vec![json!({
                            "id": pending.id, "error": "Aborted"
                        })]));
                        self.pending.remove(&key);
                    }
                }
            }
            "shared-worker-remote-config-change" => {
                let config = message.get("config").cloned().unwrap_or(message);
                self.remote_config = Some(config.clone());
                events.push(("worker".into(), channel.into(), vec![config]));
            }
            "shared-worker-start" => {
                if page == "worker" {
                    if let Some(config) = &self.remote_config {
                        events.push((page.into(), "shared-worker-remote-config-change".into(), vec![config.clone()]));
                    }
                }
            }
            "shared-worker-ping" | "shared-worker-dispose" => {}
            _ => return None,
        }
        Some(events)
    }
}

#[derive(Clone, Debug, Deserialize, serde::Serialize)]
pub struct IpcEntry {
    pub channel: String,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Deserialize)]
struct BridgeTableFile {
    table: BTreeMap<String, IpcEntry>,
    local: Vec<String>,
}

/// Events that need the window/event loop (things the WebView2 IPC callback
/// cannot do itself, or must do on the UI thread).
#[derive(Debug)]
pub enum UiEvent {
    #[cfg_attr(not(windows), allow(dead_code))] // Native WebView2 callbacks only.
    BridgeResponse { page: String, id: i64, payload: String },
    EmitIpc {
        /// `Some("main" | "login" | "worker")` addresses one page; `None`
        /// broadcasts to every page.
        page: Option<String>,
        channel: String,
        args: Vec<Value>,
    },
    LoginSucceeded,
    LoggedOut,
    Reload,
    SetAppCookie(String),
    SetCookie {
        name: String,
        value: String,
        domain: String,
    },
    ClearCookies,
    OpenDevTools,
    #[cfg_attr(not(windows), allow(dead_code))]
    PageStarted(String),
    PageReady(String),
    #[cfg_attr(not(windows), allow(dead_code))]
    PageFinished(String),
    Quit,
}

pub struct Spec {
    pub globals: Vec<String>,
    pub members: BTreeMap<String, String>,
    pub values: BTreeMap<String, Value>,
    pub ipc: BTreeMap<String, IpcEntry>,
}

impl Spec {
    /// `window.__zaloBridgeSpec = {…}` injection.
    pub fn script(&self) -> String {
        let spec = json!({
            "globals": self.globals,
            "members": self.members,
            "values": self.values,
            "ipc": self.ipc,
        });
        format!("window.__zaloBridgeSpec = {spec};")
    }
}

pub struct Bridge {
    pub platform: Platform,
    pub origin: String,
    pub spec: Spec,
    pub crypto: Mutex<CryptoState>,
    ui: Sender<UiEvent>,
    session: Mutex<Option<Value>>,
    viewer_key: Mutex<Option<Value>>,
    worker_connected: Mutex<bool>,
    tasks: Mutex<TaskRouter>,
    subscriptions: Mutex<HashSet<String>>,
    provided: Mutex<HashSet<String>>,
    logged_unhandled: Mutex<HashSet<String>>,
}

impl Bridge {
    pub fn new(platform: Platform, origin: String, ui: Sender<UiEvent>) -> Self {
        let spec = build_spec(&platform);
        Self {
            platform,
            origin,
            spec,
            crypto: Mutex::new(CryptoState::default()),
            ui,
            session: Mutex::new(None),
            viewer_key: Mutex::new(None),
            worker_connected: Mutex::new(false),
            tasks: Mutex::new(TaskRouter::default()),
            subscriptions: Mutex::new(HashSet::new()),
            provided: Mutex::new(HashSet::new()),
            logged_unhandled: Mutex::new(HashSet::new()),
        }
    }

    /// Handles one JSON message from `chrome.webview.postMessage`. Returns the
    /// response payload when the page waits for one.
    pub fn handle_message(&self, body: &str) -> Option<(i64, String)> {
        let message: Value = match serde_json::from_str(body) {
            Ok(message) => message,
            Err(error) => {
                tracing::warn!("bridge: bad message: {error}");
                return None;
            }
        };
        let kind = message.get("kind").and_then(Value::as_str).unwrap_or("");
        let id = message.get("id").and_then(Value::as_i64).unwrap_or(0);
        let args = message
            .get("args")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let path = message.get("path").and_then(Value::as_str).unwrap_or("");
        let channel = message.get("channel").and_then(Value::as_str).unwrap_or("");
        let page = message.get("page").and_then(Value::as_str).unwrap_or("main");
        tracing::debug!(
            "bridge message: kind={kind} page={page} path={path} channel={channel} args={}",
            args.len()
        );

        match kind {
            "call" => {
                let path = message.get("path").and_then(Value::as_str).unwrap_or("");
                let value = self.dispatch_path(path, &args);
                match &value {
                    Ok(_) => tracing::debug!("bridge call {path}: ok"),
                    Err(error) => tracing::debug!("bridge call {path}: {error}"),
                }
                Some((id, response_payload(value)))
            }
            "invoke" => {
                let channel = message
                    .get("channel")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let value = self.dispatch_channel(channel, &args, page);
                match &value {
                    Ok(_) => tracing::debug!("bridge invoke {channel}: ok"),
                    Err(error) => tracing::debug!("bridge invoke {channel}: {error}"),
                }
                Some((id, response_payload(value)))
            }
            "send" => {
                let channel = message
                    .get("channel")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                self.dispatch_send(channel, &args);
                None
            }
            "subscribe" => {
                if let Some(channel) = message.get("channel").and_then(Value::as_str) {
                    self.subscriptions
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner())
                        .insert(format!("ipc:{channel}"));
                }
                if let Some(path) = message.get("path").and_then(Value::as_str) {
                    self.subscriptions
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner())
                        .insert(path.to_string());
                }
                None
            }
            "provide" => {
                if let Some(channel) = message.get("channel").and_then(Value::as_str) {
                    self.provided
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner())
                        .insert(channel.to_string());
                }
                None
            }
            "ready" => {
                let url = message.get("url").and_then(Value::as_str).unwrap_or("");
                tracing::debug!("page reports ready: {url}");
                self.send_ui(UiEvent::PageReady(url.to_string()));
                None
            }
            "log" => {
                let line = message.get("line").and_then(Value::as_str).unwrap_or("");
                tracing::info!(target: "olaz.renderer", "{}", line.chars().take(1200).collect::<String>());
                None
            }
            "devtools" => {
                self.send_ui(UiEvent::OpenDevTools);
                None
            }
            other => {
                tracing::debug!("bridge: unknown message kind {other}");
                None
            }
        }
    }

    pub fn dispatch_path(&self, path: &str, args: &[Value]) -> HostResult<Value> {
        match path {
            // Values are usually resolved in JS from the spec; answer a call
            // anyway so a stray `()` does not stall.
            p if self.spec.values.contains_key(p) => {
                Ok(self.spec.values.get(p).cloned().unwrap_or(Value::Null))
            }
            _ => crate::local::dispatch(&self.platform, &self.crypto, path, args),
        }
    }

    fn dispatch_channel(&self, channel: &str, args: &[Value], page: &str) -> HostResult<Value> {
        if let Some(events) = self.tasks.lock().unwrap_or_else(|p| p.into_inner()).dispatch(channel, args, page) {
            for (target, channel, args) in events {
                self.emit_to(Some(&target), &channel, args);
            }
            return Ok(undefined());
        }
        let p = &self.platform;
        match channel {
            // ---- paths / app ------------------------------------------------
            "_electron_get-path" => Ok(path_value(&p.path(str_arg(args, 0).unwrap_or("userData")))),
            "_electron_get-app-version" => Ok(json!(p.app_version)),
            "_electron_get-app-path" => Ok(path_value(&p.app_path)),
            "get-child-url" => Ok(json!(format!("{}/child.html", self.origin))),
            "get-photo-viewer-url" => Ok(json!(format!("{}/popup-viewer.html", self.origin))),
            "get-resource-dir" => Ok(json!(format!("{}/", self.origin))),
            "_electron_open-devtool" => {
                self.send_ui(UiEvent::OpenDevTools);
                Ok(undefined())
            }
            "_electron_clear-host-cache"
            | "_electron_clear-session-cache"
            | "_electron_clear-session-storage"
            | "_electron_enable-win-context-menu"
            | "_electron_take-heap-snapshot-and-zip" => Ok(undefined()),

            // ---- cookies ---------------------------------------------------
            "_electron_set-app-cookie" => {
                if let Some(value) = str_arg(args, 0) {
                    self.send_ui(UiEvent::SetAppCookie(value.to_string()));
                }
                Ok(undefined())
            }
            "_electron_set-cookie" => {
                if let (Some(name), Some(value)) = (str_arg(args, 0), str_arg(args, 1)) {
                    let url = str_arg(args, 2).unwrap_or("");
                    let domain = str_arg(args, 3)
                        .map(str::to_string)
                        .or_else(|| url::Url::parse(url).ok().and_then(|url| url.host_str().map(str::to_string)))
                        .unwrap_or_else(|| "zalo.me".to_string());
                    self.send_ui(UiEvent::SetCookie {
                        name: name.to_string(),
                        value: value.to_string(),
                        domain,
                    });
                }
                Ok(undefined())
            }
            "_electron_clear-cookie" => {
                self.send_ui(UiEvent::ClearCookies);
                Ok(undefined())
            }

            // ---- storage selection (forced IndexedDB) ----------------------
            "sqlite-available" => Ok(json!(false)),
            "fail-load-sqlite3" => Ok(json!(true)),
            "is-migrate-full-done" => Ok(json!(false)),
            "get-migrate-local-info" => Ok(json!({ "disable_migrate": true })),
            "migratedb:check_need_wait_bu" => Ok(json!(false)),
            "migratedb:signal_done" | "update-migrate-local-info" => Ok(undefined()),
            "dev-only-reset-migrate-state" => Ok(undefined()),
            "z-db-corruption-detector" => Ok(json!(0)),
            "get-name-of-target-script-for-dal-channel-from-host" => Ok(json!("preload-sqlite")),
            "migratedb:signal_restart" => {
                self.send_ui(UiEvent::Reload);
                Ok(undefined())
            }

            // ---- session / login -------------------------------------------
            "login-success" => {
                self.send_ui(UiEvent::LoginSucceeded);
                Ok(undefined())
            }
            "login" => {
                self.send_ui(UiEvent::LoggedOut);
                Ok(undefined())
            }
            "script-connected" => Ok(undefined()),
            "new-session" => {
                let session = args.first().cloned();
                *self
                    .session
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner()) = session;
                // Renderer → main → every other renderer.
                if page != "worker" {
                    self.emit_to(Some("worker"), "new-session", args.to_vec());
                }
                Ok(undefined())
            }
            "db-authenticated" => {
                let session = args.first().cloned();
                *self
                    .session
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner()) = session;
                // The database lives in the hidden shared-worker page.
                if page != "worker" {
                    self.emit_to(Some("worker"), "db-authenticated", args.to_vec());
                }
                Ok(undefined())
            }
            "db-client-connected" => {
                *self
                    .worker_connected
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner()) = true;
                let session = self
                    .session
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .clone();
                if let Some(session) = session {
                    self.emit_to(Some("worker"), "db-authenticated", vec![session]);
                }
                Ok(undefined())
            }
            "receive-viewerkey" => {
                *self
                    .viewer_key
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner()) =
                    args.first().cloned();
                self.emit_to(Some("worker"), "receive-viewerkey", args.to_vec());
                Ok(undefined())
            }
            "db-start-close-dbs" => {
                let connected = *self
                    .worker_connected
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner());
                if connected {
                    self.emit_to(Some("worker"), "db-start-close-dbs", args.to_vec());
                } else {
                    // No database client to wait for; resolve the request now.
                    self.emit_to(Some("main"), "db-finish-close-dbs", Vec::new());
                }
                Ok(undefined())
            }
            "db-finish-close-dbs" => {
                self.emit_to(Some("main"), "db-finish-close-dbs", args.to_vec());
                Ok(undefined())
            }
            "sync-msg-abort" => {
                self.emit_to(Some("worker"), "sync-msg-abort", args.to_vec());
                Ok(undefined())
            }
            "shared-worker-req-events" => {
                // `$zdb.sendRequest` in the main renderer → worker's
                // `$zdb.processRequest`.
                self.emit_to(Some("worker"), "shared-worker-req-events", args.to_vec());
                Ok(undefined())
            }
            "shared-worker-resp-events" => {
                // `$zdb.sendResponse` in the worker → main renderer's
                // `$zdb.processResponse`.
                self.emit_to(Some("main"), "shared-worker-resp-events", args.to_vec());
                Ok(undefined())
            }

            // ---- secrets ---------------------------------------------------
            "zsafestorage-execute" => {
                let method = str_arg(args, 0).unwrap_or("");
                secrets::safe_storage(p, method, &args[1..])
            }
            "zproto-encrypt-with-keychain" => {
                let identifier = str_arg(args, 0).unwrap_or("");
                let items = args
                    .get(1)
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                secrets::keychain_encrypt(p, identifier, &items)
            }
            "zproto-decrypt-with-keychain" => {
                let identifier = str_arg(args, 0).unwrap_or("");
                let items = args
                    .get(1)
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                secrets::keychain_decrypt(p, identifier, &items)
            }

            // ---- native helpers / telemetry --------------------------------
            "exec" | "exec_raw" => Ok(json!({
                "error": { "name": "NotSupported", "message": "Not supported", "code": "ENOTSUP" }
            })),
            "get-cpu-infos" => Ok(json!([{
                "pid": std::process::id(),
                "type": "Browser",
                "cpu": { "percentCPUUsage": 0, "idleWakeupsPerSecond": 0 },
                "memory": { "workingSetSize": 0, "peakWorkingSetSize": 0 },
            }])),
            "get-process-info" => Ok(json!([])),
            "badge-count" => Ok(undefined()),
            "_noti_is-supported" => Ok(json!(false)),
            "_noti_create" => Ok(json!(0)),
            "_noti_close" => Ok(undefined()),
            "__shell__" => Ok(json!(true)),
            "__child_process__" => Err(HostError("EPERM: child_process is not available".into())),
            "request-compressed-log-file" => Ok(json!({
                "status": 2,
                "data": { "message": "Not supported", "errorData": Value::Null }
            })),
            "call-init" | "call-send-to-native" | "call-send-signal" | "call-request" => {
                Ok(undefined())
            }
            "check-recently-crash" => Ok(json!(false)),
            "tf-models:ss:config:get" | "tf-models:ss:item-2-sticker:get"
            | "tf-models:ss:kwd-2-stickers:get" | "tf-models:ss:sticker-2-score:get" => Ok(json!({})),
            "log" | "log-ga" | "cross_OS_LOG_QOS_config" | "cross_OS_LOG_QOS"
            | "cross_OS_LOG_ACTION_READY" | "signal_OS_CLOSE_MAIN" | "cross_OS_LOG_QOS_READY"
            | "net-collect-net-error-info" | "net-start-monitor" | "net-stop-monitor"
            | "net-update-net-error-config" | "zproto-config-sync-to-main"
            | "renderer-ready" | "app-started" | "noti-ready" | "get-auth-domain"
            | "get-auth-domain-ready" | "update-remote-configs" | "cert-config"
            | "zmain_register_process" | "register-idle-check-interval"
            | "active-deactive:setup" | "active-deactive:clear-timer"
            | "active-deactive:create-timer" | "port-delivered" | "open-channel-to"
            | "set-main-window-resizable" | "hide-shared-worker" | "show-shared-worker"
            | "shared-worker-handle" | "shared-worker-start" | "shared-worker-ping"
            | "shared-worker-dispose" | "send-metrics" | "load-shell-qos"
            | "enable-creating-backup" | "tf-models:ss:resource:init"
            | "shared-worker-abort" | "shared-worker-run" | "shared-worker-update-params"
            | "shared-worker-resp" | "shared-worker-progress"
            | "shared-worker-remote-config-change" => {
                Ok(undefined())
            }

            // ---- window ----------------------------------------------------
            "get-app-visibility" => Ok(json!("show")),
            "check-fullscreen" | "check-maximize" => Ok(json!(false)),
            "close-window" | "hide-window" | "show" | "show-inactive" | "focus-window"
            | "minimize" | "toggle-maximize" | "toggle-fullscreen" | "set-login-size"
            | "main-window-expand" | "flash-frame" | "set-content-protection"
            | "hide-window-complete" => Ok(undefined()),
            "quit" | "do-quit" => {
                self.send_ui(UiEvent::Quit);
                Ok(undefined())
            }
            "request_relaunch" => {
                self.send_ui(UiEvent::Reload);
                Ok(undefined())
            }
            "os-confirm-restart" => Ok(json!(false)),
            "get-theme-conf" => Ok(Value::Null),
            "get-zalo-installed-time" => Ok(json!(0)),
            "check-auto-launch" => Ok(json!(false)),
            "toggle-auto-launch" => Ok(undefined()),
            "update-screenshot-shortcut" => Ok(undefined()),
            "update-theme-conf" => Ok(undefined()),
            "proxy-get" => Ok(Value::Null),
            "check-startup-open-conv-request" => Ok(Value::Null),
            "check-network-timeout" => Ok(json!(false)),
            "enable-net-handler" => Ok(json!(false)),
            "get-recent-file" => Ok(json!([])),
            "get-clipboard" => Ok(json!("")),
            "get-auth-domain-reply" | "backup-app-state" | "restore-app-state"
            | "check-updater-busy" => Ok(undefined()),
            "is_trust_path" => Ok(json!(true)),
            "set_readonly_file" => Ok(json!(true)),
            "verify_zalo_pc_hardlink_support" => Ok(json!(true)),
            "request_flush_zlog" => Ok(undefined()),
            "z-simulate-crash-main" => Ok(undefined()),

            // ---- features that have no host implementation yet -------------
            "language-detector_detect"
            | "language-detector_dominant-language"
            | "language-detector_info" => Ok(Value::Null),
            "language-detector_is-supported" | "ocr_is-supported" => Ok(json!(false)),
            "ocr_prewarm" | "ocr_recognize" => Ok(Value::Null),
            "kiki-start-csp-monitor" | "kiki-stop-csp-monitor" | "kiki-open-oauth-window" => {
                Ok(undefined())
            }
            "file-walker-stream-start" | "file-walker-stream-cancel"
            | "file-walker-stream-build-index" => Ok(Value::Null),
            "trigger-auto-download" | "noti-receive-media-msg" => Ok(undefined()),
            "active-deactive:get-idle-time" => Ok(json!(0)),
            "download-thumb-temp" | "download-config-change" | "invalid-file-exts-change" => {
                Ok(undefined())
            }
            "new-download-channel" => Ok(Value::Null),
            "gen-thumb_write-savepath-file-photo" => Ok(undefined()),
            "show-sqlite" | "status-load-sqlite3" | "db-open-fail" => {
                Ok(undefined())
            }
            "open-photo-viewer-devtool" | "close-all-childs" | "restart-cap"
            | "rewrite-clipboard" | "screen-capture" | "get-imei" => Ok(undefined()),
            "set_readonly_file " => Ok(undefined()),
            "ZAM_RESET_DB" => Ok(undefined()),

            key if key.starts_with("__SENTRY_IPC__") => Ok(undefined()),
            key if key.starts_with("$zpinVault") => Ok(undefined()),
            key => {
                self.log_unhandled(key);
                Ok(undefined())
            }
        }
    }

    fn dispatch_send(&self, channel: &str, args: &[Value]) {
        match channel {
            "login" | "login-after-install" => self.send_ui(UiEvent::LoggedOut),
            "login-step" => {
                let _ = args;
            }
            "call-init" | "call-send-to-native" | "call-send-signal" => {}
            _ => {}
        }
    }

    /// Sends an IPC event to one page (or broadcasts when `page` is `None`).
    /// Used to emulate the main process' `webContents.send` between the main
    /// window and the hidden shared-worker window.
    fn emit_to(&self, page: Option<&str>, channel: &str, args: Vec<Value>) {
        self.send_ui(UiEvent::EmitIpc {
            page: page.map(str::to_string),
            channel: channel.to_string(),
            args,
        });
    }

    fn send_ui(&self, event: UiEvent) {
        let _ = self.ui.send(event);
    }

    fn log_unhandled(&self, key: &str) {
        let mut seen = self
            .logged_unhandled
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if seen.insert(key.to_string()) {
            tracing::info!("unhandled ipc channel {key}");
        }
    }

    #[allow(dead_code)]
    pub fn has_subscription(&self, channel: &str) -> bool {
        self.subscriptions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .contains(&format!("ipc:{channel}"))
    }
}

fn path_value(path: &std::path::Path) -> Value {
    json!(path_string(path))
}

fn undefined() -> Value {
    json!({ "__undefined": true })
}

fn response_payload(result: HostResult<Value>) -> String {
    let value = match result {
        Ok(value) => json!({ "value": value }),
        Err(error) => json!({ "error": error.0 }),
    };
    serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string())
}

/// Builds the `__zaloBridgeSpec` object from the generated preload table.
pub fn build_spec(platform: &Platform) -> Spec {
    let parsed: BridgeTableFile = serde_json::from_str(TABLE_JSON).unwrap_or(BridgeTableFile {
        table: BTreeMap::new(),
        local: Vec::new(),
    });

    let mut globals = BTreeSet::new();
    let mut members = BTreeMap::new();
    let mut values = BTreeMap::new();
    let mut ipc = BTreeMap::new();

    for (path, entry) in &parsed.table {
        if entry.channel.is_empty() || entry.kind.is_empty() {
            continue;
        }
        ipc.insert(path.clone(), entry.clone());
        if let Some(global) = path.split('.').next() {
            globals.insert(global.to_string());
        }
    }

    for path in &parsed.local {
        let mode = if path == "$zupdater.onReceiveUpdateInfo" { "event" } else { local_mode(path) };
        members.insert(path.clone(), mode.to_string());
        if let Some(global) = path.split('.').next() {
            globals.insert(global.to_string());
        }
    }

    // Members the Windows preload adds through local wrappers or that the
    // renderer reaches dynamically.
    for (path, mode) in [
        ("$znode.fs.readFile", "async"),
        ("$znode.fs.writeFile", "async"),
        ("$znode.fs.readFileSync", "sync"),
        ("$znode.fs.writeFileSync", "sync"),
        ("$znode.fs.link", "async"),
        ("$znode.fsExtra.pathExists", "async"),
        ("$znode.nativelibs.fileUtilitiesAddon.detectFilesystemAsync", "async"),
        ("$znode.nativelibs.fileUtilitiesAddon.detectFilesystemSync", "sync"),
        ("$znode.nativelibs.fileUtilitiesAddon.detectHardlinksAsync", "async"),
        ("$znode.nativelibs.fileUtilsAddon.getDiskUsage", "sync"),
        ("$znode.util.promisify", "noop"),
        ("$znode.url.format", "noop"),
        ("$zsqlite.isLoadedLib", "async"),
    ] {
        members.insert(path.to_string(), mode.to_string());
        if let Some(global) = path.split('.').next() {
            globals.insert(global.to_string());
        }
    }
    for method in [
        "openDb", "query", "queryV2", "queryGlobalMessage", "queryGlobalMessageV2",
        "queryGlobalMessageV3", "queryGlobalMessageV4", "deleteRow", "deleteRows", "write",
        "writev2", "pureQuery", "prepareInsertSearch", "prepareDeleteSearch",
        "getConversationMatch", "flushDb", "flushDbBatch", "flushDbBatchv2", "closeDb",
        "finalizeInsertStatement", "finalizeDeleteStatement", "doListSqls", "createKey",
        "initDebug", "countTotal", "createConnection", "isDbTransactionStepError",
    ] {
        members.insert(format!("$zsqlite.{method}"), "async".into());
    }

    values.insert("$zenv.isPreloaded".into(), json!(true));
    values.insert("$zenv.isRenderer".into(), json!(true));
    let mut os = platform.os_info();
    if let Some(map) = os.as_object_mut() {
        map.insert(
            "arch".into(),
            json!(match std::env::consts::ARCH {
                "x86_64" => "x64",
                "aarch64" => "arm64",
                other => other,
            }),
        );
        map.insert(
            "cwd".into(),
            json!(std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(path_string))
                .unwrap_or_default()),
        );
    }
    values.insert("$znode.os.__info".into(), os);
    let constants = json!({ "F_OK": 0, "R_OK": 4, "W_OK": 2, "X_OK": 1 });
    values.insert("$znode.fs.constants".into(), constants.clone());
    values.insert("$znode.fs.constanst".into(), constants);
    values.insert("$znode.crypto.constants".into(), platform.crypto_constants());

    globals.insert("$zsqlite".into());
    globals.insert("$zenv".into());
    globals.insert("$zpinVault".into());
    globals.insert("MetriczGlobal".into());

    Spec {
        globals: globals.into_iter().collect(),
        members,
        values,
        ipc,
    }
}

fn local_mode(path: &str) -> &'static str {
    if path.ends_with("Sync")
        || path.starts_with("$znode.crypto.")
        || path.starts_with("$znode.path.")
        || path.starts_with("$znode.os.")
        || path.starts_with("$znode.url.")
        || path == "$znode.rimraf"
    {
        "sync"
    } else if path.starts_with("$zcommon.")
        || path.starts_with("$zelectronNative.")
        || path.starts_with("$zFeatures.")
        || path.starts_with("MetriczGlobal.")
    {
        "noop"
    } else {
        "async"
    }
}

/// Query string main appends to pages (spec §2.4). `already_login` is only set
/// for the main page.
pub fn page_query(platform: &Platform, already_login: bool) -> Vec<(String, String)> {
    let mut query = vec![
        ("type".to_string(), platform.client_type.clone()),
        ("client_version".to_string(), platform.client_version.clone()),
        ("app_version".to_string(), platform.app_version.clone()),
        ("about_version".to_string(), String::new()),
        ("new_install".to_string(), "0".to_string()),
        ("fail_sqlite3".to_string(), "true".to_string()),
        ("mode_lang".to_string(), String::new()),
    ];
    if already_login {
        query.push(("already_login".to_string(), "y".to_string()));
    }
    query
}

/// The URL the host loads first (always the login page; the session marker in
/// [`server::has_session`] selects the main page).
pub fn login_url(platform: &Platform) -> String {
    server::page_url("login.html", &page_query(platform, false))
}

pub fn main_url(platform: &Platform) -> String {
    server::page_url("index.html", &page_query(platform, true))
}

/// Renderer console/error capture, forwarded through the bridge's log channel.
pub const CONSOLE_SCRIPT: &str = r#"
(() => {
  const post = (lvl, a) => {
    try {
      const line = lvl + ' ' + a.map((x) => {
        try {
          return typeof x === 'string' ? x : (x instanceof Error ? x.message + ' | ' + (x.stack || '').split('\n').slice(0, 3).join(' < ') : JSON.stringify(x));
        } catch { return String(x); }
      }).join(' ').slice(0, 1200);
      if (window.__zaloBridge && window.__zaloBridge.log) window.__zaloBridge.log(line);
      else if (window.chrome && window.chrome.webview) window.chrome.webview.postMessage(JSON.stringify({ kind: 'log', line }));
      else (window.__olazLogQueue = window.__olazLogQueue || []).push({ kind: 'log', line });
    } catch {}
  };
  for (const lvl of ['log', 'warn', 'error', 'info']) {
    const original = console[lvl];
    console[lvl] = (...args) => { post('[' + lvl + ']', args); return original.apply(console, args); };
  }
  addEventListener('error', (e) => post('[uncaught]', [e.message + ' @ ' + e.filename + ':' + e.lineno + ':' + e.colno]));
  addEventListener('unhandledrejection', (e) => post('[unhandled]', [e.reason instanceof Error ? e.reason : (() => {
    try { const j = JSON.stringify(e.reason, (k, v) => typeof v === 'string' && v.length > 60 ? v.slice(0, 60) + '…' : v); return j && j !== '{}' ? j.slice(0, 400) : String(e.reason); }
    catch { return String(e.reason); }
  })()]));
})();
"#;
