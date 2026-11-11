//! Edge development harness.
//!
//! Smart App Control on the development machine rejects freshly built WebView2
//! hosts, so renderer work can be exercised with Microsoft Edge in app mode:
//! the Rust host keeps serving the official `app.asar` over the same loopback
//! origin, while the page uses the HTTP/EventSource bridge transport instead of
//! `chrome.webview`. This is a development aid, not the shipping UI.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::bridge::{self, Bridge, UiEvent};
use crate::platform::{Platform, SyncHost};
use crate::server::{self, EventBus};

/// Edge app-mode window size, matching the WebView2 host.
const WINDOW_SIZE: &str = "1100,760";

pub fn run() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("olaz=info,warn")),
        )
        .init();

    let runtime = crate::startup::load_runtime()?;
    tracing::info!(
        "runtime ready: {} ({} bytes, asar {})",
        runtime.dir.display(),
        runtime.manifest.asar_size,
        runtime.manifest.asar_sha256
    );

    let platform = Platform::new(
        runtime.dir.clone(),
        &runtime.manifest.version,
        &runtime.manifest.client_type,
        &runtime.manifest.client_version,
    );
    let sync = Arc::new(SyncHost::new(platform.clone()));
    let origin = server::origin();

    let (events, receiver) = mpsc::channel::<UiEvent>();
    let bridge = Arc::new(Bridge::new(platform.clone(), origin.clone(), events));
    let bus = EventBus::new();
    server::start(
        Arc::new(runtime.asar),
        sync.clone(),
        bridge.clone(),
        bus.clone(),
    )?;

    let cdp = match Cdp::new(edge_helper_dir()) {
        Ok(cdp) => Some(Arc::new(cdp)),
        Err(error) => {
            tracing::warn!("CDP cookie bridge unavailable: {error:#}");
            None
        }
    };
    spawn_event_pump(
        receiver,
        platform.clone(),
        sync.clone(),
        bus,
        cdp,
        bridge.clone(),
    );

    let logged_in = server::has_session(&sync);
    let initial = if logged_in {
        bridge::main_url(&platform)
    } else {
        bridge::login_url(&platform)
    };

    // Let the loopback listener settle before Windows opens the page. A failed
    // first navigation would leave Edge on its error page until a reload.
    thread::sleep(std::time::Duration::from_millis(150));
    // Start the worker first, with the same persistent profile and origin.
    // It must keep running even when its window is offscreen.
    let worker = server::page_url("shared-worker.html", &bridge::page_query(&platform, false));
    launch_edge(&worker, true)?;
    launch_edge(&initial, false)?;
    tracing::info!("edge harness running; press Ctrl-C to stop");

    loop {
        thread::park();
    }
}

fn spawn_event_pump(
    receiver: mpsc::Receiver<UiEvent>,
    platform: Platform,
    sync: Arc<SyncHost>,
    bus: EventBus,
    cdp: Option<Arc<Cdp>>,
    bridge: Arc<Bridge>,
) {
    let spawned = thread::Builder::new()
        .name("olaz-edge-events".into())
        .spawn(move || {
            let mut pending_login_success = false;
            while let Ok(event) = receiver.recv() {
                match event {
                    UiEvent::BridgeResponse { .. } => {
                        // The HTTP bridge answers `bridge-call` requests
                        // directly; nothing waits on this channel here.
                    }
                    UiEvent::EmitIpc { page, channel, args } => {
                        bus.publish_to(page.as_deref(), json!({ "kind": "ipc", "channel": channel, "args": args }));
                    }
                    UiEvent::LoginSucceeded => {
                        tracing::info!("login-success: switching to the main page");
                        server::mark_session(&sync, true);
                        pending_login_success = true;
                        bus.publish_to(Some("login"), json!({ "kind": "navigate", "url": bridge::main_url(&platform) }));
                    }
                    UiEvent::LoggedOut => {
                        tracing::info!("logged out: switching to the login page");
                        server::mark_session(&sync, false);
                        pending_login_success = false;
                        bus.publish_to(Some("main"), json!({ "kind": "navigate", "url": bridge::login_url(&platform) }));
                    }
                    UiEvent::Reload => {
                        bus.publish(json!({ "kind": "reload" }));
                    }
                    UiEvent::SetAppCookie(value) => {
                        tracing::info!("set-app-cookie ({} bytes)", value.len());
                        if let Some(cdp) = &cdp {
                            if let Err(error) = cdp.set_app_cookie(&value) {
                                tracing::warn!("CDP set-app-cookie: {error:#}");
                            }
                        }
                        bus.publish(json!({
                            "kind": "cookie",
                            "cookie": {
                                "name": "zpw_sek",
                                "value": value,
                                "domain": "zalo.me",
                                "path": "/",
                                "secure": true,
                                "httpOnly": true,
                                "sameSite": "None",
                                "maxAge": 604800
                            }
                        }));
                    }
                    UiEvent::SetCookie {
                        name,
                        value,
                        domain,
                    } => {
                        if let Some(cdp) = &cdp {
                            if let Err(error) =
                                cdp.set_cookie(&name, &value, &domain, false, 365)
                            {
                                tracing::warn!("CDP set-cookie {name}: {error:#}");
                            }
                        }
                        bus.publish(json!({
                            "kind": "cookie",
                            "cookie": {
                                "name": name,
                                "value": value,
                                "domain": domain,
                                "path": "/",
                                "secure": true,
                                "httpOnly": false,
                                "sameSite": "None",
                                "maxAge": 31536000
                            }
                        }));
                    }
                    UiEvent::ClearCookies => {
                        if let Some(cdp) = &cdp {
                            if let Err(error) = cdp.clear_zalo_cookies() {
                                tracing::warn!("CDP clear-cookies: {error:#}");
                            }
                        }
                        bus.publish(json!({ "kind": "clear-cookies" }));
                    }
                    UiEvent::OpenDevTools => {
                        tracing::info!("open-devtools requested (edge harness: remote debugging on 9333)");
                    }
                    UiEvent::PageStarted(url) => {
                        tracing::debug!("page started: {url}");
                    }
                    UiEvent::PageReady(url) => {
                        tracing::debug!("page ready: {url}");
                        bus.publish_to(Some("main"), json!({
                            "kind": "ipc",
                            "channel": "visibility-change",
                            "args": ["show"]
                        }));
                        if pending_login_success && url.contains("index.html") {
                            pending_login_success = false;
                            // The main page subscribes a little after its load
                            // event. Wait for the subscription before pushing,
                            // otherwise the renderer never sees it.
                            let bus = bus.clone();
                            let bridge = bridge.clone();
                            thread::spawn(move || {
                                for _ in 0..50 {
                                    if bridge.has_subscription("ipc:login-success") {
                                        break;
                                    }
                                    thread::sleep(std::time::Duration::from_millis(100));
                                }
                                bus.publish_to(Some("main"), json!({
                                    "kind": "ipc",
                                    "channel": "login-success",
                                    "args": []
                                }));
                            });
                        }
                    }
                    UiEvent::PageFinished(url) => {
                        tracing::debug!("page finished: {url}");
                    }
                    UiEvent::Quit => {
                        tracing::info!("quit requested");
                        std::process::exit(0);
                    }
                }
            }
        });
    if let Err(error) = spawned {
        tracing::error!("cannot start the edge event thread: {error}");
    }
}

fn launch_edge(url: &str, worker: bool) -> anyhow::Result<()> {
    let executable = find_edge().ok_or_else(|| {
        anyhow::anyhow!(
            "Microsoft Edge not found; set OLAZ_EDGE to the msedge.exe path"
        )
    })?;
    let profile = edge_profile();
    if let Err(error) = std::fs::create_dir_all(&profile) {
        tracing::warn!("create edge profile {}: {error}", profile.display());
    }
    let profile_arg = format!(
        "--user-data-dir={}",
        windows_path(&profile).unwrap_or_else(|| profile.display().to_string())
    );

    let mut args = vec![
        format!("--app={url}"),
        profile_arg,
        format!("--window-size={WINDOW_SIZE}"),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--disable-sync".to_string(),
        "--disable-background-timer-throttling".to_string(),
        "--disable-renderer-backgrounding".to_string(),
        "--disable-web-security".to_string(),
        "--autoplay-policy=no-user-gesture-required".to_string(),
        concat!(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,",
            "SameSiteByDefaultCookies,CookiesWithoutSameSiteMustBeSecure,",
            "ThirdPartyStoragePartitioning"
        )
        .to_string(),
        "--remote-debugging-port=9333".to_string(),
        "--remote-debugging-address=0.0.0.0".to_string(),
        "--remote-allow-origins=*".to_string(),
        format!("--user-agent={}", olaz_core::runtime::release::user_agent()),
    ];
    if worker {
        args.push("--window-position=-32000,-32000".into());
    } else {
        args.push("--window-position=100,60".into());
    }

    tracing::info!("launching Edge: {} {}", executable.display(), args.join(" "));
    Command::new(&executable)
        .args(&args)
        .spawn()
        .map(|_| ())
        .map_err(|error| anyhow::anyhow!("launch {}: {error}", executable.display()))
}

fn find_edge() -> Option<std::path::PathBuf> {
    if let Some(path) = std::env::var_os("OLAZ_EDGE") {
        let path = std::path::PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    [
        "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
        "/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe",
    ]
    .iter()
    .map(std::path::PathBuf::from)
    .find(|path| path.is_file())
}

/// Windows user data for the Edge harness (`%LOCALAPPDATA%\\Olaz\\EdgeProfile`).
fn edge_profile() -> PathBuf {
    if let Some(path) = std::env::var_os("OLAZ_EDGE_PROFILE") {
        return PathBuf::from(path);
    }
    windows_local_appdata().join("Olaz").join("EdgeProfile")
}

/// Scratch directory for the Windows-side CDP helper script and command file.
fn edge_helper_dir() -> PathBuf {
    windows_local_appdata().join("Olaz").join("EdgeCdp")
}

/// `%LOCALAPPDATA%` as a WSL path (`/mnt/c/...`), falling back to the usual
/// location on the development machine.
fn windows_local_appdata() -> PathBuf {
    Command::new("cmd.exe")
        .args(["/c", "echo", "%LOCALAPPDATA%"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .rev()
                .find(|line| line.contains(":\\"))
                .and_then(|line| wsl_path_from_windows(line.trim()))
        })
        .unwrap_or_else(|| PathBuf::from("/mnt/c/Users/Admin/AppData/Local"))
}

/// Converts `C:\Users\…` to `/mnt/c/Users/…`.
fn wsl_path_from_windows(path: &str) -> Option<PathBuf> {
    let bytes = path.as_bytes();
    if bytes.len() < 3 || bytes[1] != b':' || !bytes[0].is_ascii_alphabetic() {
        return None;
    }
    let drive = (bytes[0] as char).to_ascii_lowercase();
    let tail = path[2..]
        .trim_start_matches(['\\', '/'])
        .replace('\\', "/");
    Some(PathBuf::from(format!("/mnt/{drive}/{tail}")))
}

/// Converts a WSL `/mnt/<drive>/…` path to `C:\…` for Windows processes.
fn windows_path(path: &Path) -> Option<String> {
    let text = path.to_string_lossy();
    let rest = text.strip_prefix("/mnt/")?;
    let (drive, tail) = rest.split_once('/')?;
    let mut out = String::with_capacity(text.len());
    out.push_str(&drive.to_ascii_uppercase());
    out.push(':');
    out.push('\\');
    out.push_str(&tail.replace('/', "\\"));
    Some(out)
}

// ---- CDP cookie bridge -------------------------------------------------

/// Edge's DevTools listener binds 127.0.0.1 on Windows and is unreachable from
/// WSL. Cookie writes therefore go through a Windows PowerShell helper: it
/// connects to the page target, sends one `Network.setCookie` command and
/// prints the answer. The helper is serialized because it shares command files.
struct Cdp {
    dir: PathBuf,
    script: String,
    lock: Mutex<()>,
}

impl Cdp {
    fn new(dir: PathBuf) -> anyhow::Result<Self> {
        std::fs::create_dir_all(&dir)?;
        let script_path = dir.join("cdp-send.ps1");
        std::fs::write(
            &script_path,
            include_str!("../../../host-scripts/cdp-send.ps1"),
        )?;
        let script = windows_path(&script_path)
            .ok_or_else(|| anyhow::anyhow!("not a /mnt/<drive> path: {}", script_path.display()))?;
        Ok(Self {
            dir,
            script,
            lock: Mutex::new(()),
        })
    }

    fn set_app_cookie(&self, value: &str) -> anyhow::Result<()> {
        const DOMAINS: [&str; 3] = ["zaloapp.com", "zalo.me", "chat.zalo.me"];
        for domain in DOMAINS {
            self.set_cookie("zpw_sek", value, domain, true, 7)?;
        }
        Ok(())
    }

    fn set_cookie(
        &self,
        name: &str,
        value: &str,
        domain: &str,
        http_only: bool,
        days: u64,
    ) -> anyhow::Result<()> {
        let domain = if domain.starts_with('.') {
            domain.to_string()
        } else {
            format!(".{domain}")
        };
        let expires = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0)
            + days * 86_400;
        self.send(
            "Network.setCookie",
            json!({
                "name": name,
                "value": value,
                "domain": domain,
                "path": "/",
                "secure": true,
                "httpOnly": http_only,
                "sameSite": "None",
                "expires": expires
            }),
        )?;
        Ok(())
    }

    fn clear_zalo_cookies(&self) -> anyhow::Result<()> {
        self.send("Network.clearBrowserCookies", json!({}))?;
        Ok(())
    }

    fn send(&self, method: &str, params: Value) -> anyhow::Result<Value> {
        let _guard = self
            .lock
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        static NEXT_ID: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(1);
        let id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let command = json!({ "id": id, "method": method, "params": params });
        let command_path = self.dir.join("cdp-command.json");
        std::fs::write(&command_path, command.to_string())?;
        let command_file = windows_path(&command_path)
            .ok_or_else(|| anyhow::anyhow!("not a /mnt/<drive> path: {}", command_path.display()))?;

        let output = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                &self.script,
                "-CommandFile",
                &command_file,
            ])
            .output()
            .map_err(|error| anyhow::anyhow!("run powershell.exe: {error}"))?;
        if !output.status.success() {
            return Err(anyhow::anyhow!(
                "cdp helper failed ({}): {}",
                output.status,
                String::from_utf8_lossy(&output.stderr)
                    .chars()
                    .take(400)
                    .collect::<String>()
            ));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines().rev() {
            let Ok(response) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            if response.get("id").and_then(Value::as_i64) != Some(id) {
                continue;
            }
            if let Some(error) = response.get("error") {
                return Err(anyhow::anyhow!("cdp {method}: {error}"));
            }
            return Ok(response.get("result").cloned().unwrap_or(Value::Null));
        }
        Err(anyhow::anyhow!(
            "cdp {method}: no response: {}",
            stdout.chars().take(400).collect::<String>()
        ))
    }
}
