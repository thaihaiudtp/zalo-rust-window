//! Loopback HTTP origin for the official renderer.
//!
//! WebView2 needs a real origin so `localStorage`/`IndexedDB` and cookies are
//! stable across launches (`http://127.0.0.1:47821` is a secure context). The
//! server reads every file straight out of the official `app.asar`, applies the
//! renderer patches, and answers the preload bridge at
//! `POST /__olaz/bridge-sync` (blocking XHR) and `POST /__olaz/bridge-call`
//! (async `fetch`, used by the Edge development harness).
//!
//! Host → page messages travel over `GET /__olaz/events`, a long-poll queue.
//! The Edge harness uses it because it has no `chrome.webview` channel; the
//! WebView2 host keeps using IPC and only creates the queue for completeness.

use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

use olaz_core::AsarArchive;
use percent_encoding::percent_decode_str;
use serde_json::{json, Value};
use tiny_http::{Header, Method, Request, Response, Server};

use crate::bridge::{Bridge, CONSOLE_SCRIPT};
use crate::patch;
use crate::platform::SyncHost;

/// Fixed loopback origin. The port is part of the origin, so it must not change
/// between releases or renderer storage would be orphaned.
pub const PORT: u16 = 47821;
pub const HOST: &str = "127.0.0.1";

/// How long a `/__olaz/events` request waits for a message before returning an
/// empty answer. Shorter values keep proxies from closing the connection.
const EVENT_WAIT: Duration = Duration::from_secs(20);
/// Events retained for reconnect/catch-up. The renderer only needs the latest
/// handful; the cap keeps a forgotten tab from growing the queue forever.
const EVENT_BACKLOG: usize = 2048;

pub fn origin() -> String {
    format!("http://{HOST}:{PORT}")
}

/// Characters left as-is in query strings. The renderer parses
/// `location.search` with `split('&')`/`split('=')` and only decodes the
/// value, so parameter *names* must stay literal (`client_version`, not
/// `client%5Fversion`). Keeping `.`/`-`/`_`/`~` literal also keeps versions
/// readable and matches what the official Electron main process builds.
const QUERY_ENCODE: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

fn encode_query(value: &str) -> String {
    percent_encoding::utf8_percent_encode(value, QUERY_ENCODE).to_string()
}

pub fn page_url(page: &str, query: &[(String, String)]) -> String {
    let mut url = format!("{}/{page}", origin());
    if !query.is_empty() {
        let mut pairs: Vec<&(String, String)> = query.iter().collect();
        pairs.sort_by(|a, b| a.0.cmp(&b.0));
        url.push('?');
        url.push_str(
            &pairs
                .into_iter()
                .map(|(key, value)| format!("{}={}", encode_query(key), encode_query(value)))
                .collect::<Vec<_>>()
                .join("&"),
        );
    }
    url
}

// ---- event queue ------------------------------------------------------

/// Monotonic host → page event queue with a blocking tail read.
///
/// Events may be broadcast to every page or addressed to one page (`main`,
/// `login`, `worker`). Electron gave each `webContents` its own IPC channel;
/// the loopback harness has one queue per browser page instead.
#[derive(Clone)]
pub struct EventBus {
    inner: Arc<(Mutex<BusState>, Condvar)>,
}

struct BusState {
    next: u64,
    events: VecDeque<(u64, Option<String>, Value)>,
}

impl EventBus {
    pub fn new() -> Self {
        Self {
            inner: Arc::new((
                Mutex::new(BusState {
                    next: 0,
                    events: VecDeque::new(),
                }),
                Condvar::new(),
            )),
        }
    }

    pub fn publish(&self, event: Value) {
        self.publish_to(None, event);
    }

    pub fn publish_to(&self, page: Option<&str>, event: Value) {
        let (lock, cvar) = &*self.inner;
        let mut state = lock.lock().unwrap_or_else(|poison| poison.into_inner());
        let id = state.next;
        state.next += 1;
        state
            .events
            .push_back((id, page.map(str::to_string), event));
        while state.events.len() > EVENT_BACKLOG {
            state.events.pop_front();
        }
        drop(state);
        cvar.notify_all();
    }

    /// Returns `(cursor, events)` where `events` are those after `after` that
    /// target `page` (or every page). `None` means "just tell me the current
    /// cursor" (initial subscription).
    fn wait(&self, page: &str, after: Option<u64>) -> (u64, Vec<Value>) {
        let (lock, cvar) = &*self.inner;
        let mut state = lock.lock().unwrap_or_else(|poison| poison.into_inner());
        let Some(after) = after else {
            return (state.next, Vec::new());
        };
        if state.next <= after {
            let (next, _) = cvar
                .wait_timeout(state, EVENT_WAIT)
                .unwrap_or_else(|poison| poison.into_inner());
            state = next;
        }
        let events = state
            .events
            .iter()
            .filter(|(id, target, _)| *id >= after && target.as_deref().map_or(true, |t| t == page))
            .map(|(_, _, event)| event.clone())
            .collect();
        (state.next, events)
    }
}

// ---- server -----------------------------------------------------------

struct Shared {
    asar: Arc<AsarArchive>,
    sync: Arc<SyncHost>,
    bridge: Arc<Bridge>,
    events: EventBus,
    host_scripts: String,
}

/// Starts the server on a background thread. It lives for the process'
/// lifetime; failures to bind are reported to the caller.
pub fn start(
    asar: Arc<AsarArchive>,
    sync: Arc<SyncHost>,
    bridge: Arc<Bridge>,
    events: EventBus,
) -> std::io::Result<()> {
    let server = Server::http((HOST, PORT))
        .map_err(|error| std::io::Error::other(format!("bind {HOST}:{PORT}: {error}")))?;
    let shared = Arc::new(Shared {
        asar,
        sync,
        host_scripts: build_host_scripts(&bridge),
        bridge,
        events,
    });
    thread::Builder::new()
        .name("olaz-http".into())
        .spawn(move || {
            tracing::info!("serving renderer on {}", origin());
            for request in server.incoming_requests() {
                let shared = shared.clone();
                let spawned = thread::Builder::new()
                    .name("olaz-http-req".into())
                    .spawn(move || {
                        if let Err(error) = handle(request, &shared) {
                            tracing::warn!("http: {error}");
                        }
                    });
                if let Err(error) = spawned {
                    tracing::warn!("http worker: {error}");
                }
            }
        })?;
    Ok(())
}

/// Everything the page needs at document start, in one blocking script:
/// console capture, origin, bridge spec, Node shims and the bridge itself.
fn build_host_scripts(bridge: &Bridge) -> String {
    let mut out = String::with_capacity(64 * 1024);
    out.push_str(CONSOLE_SCRIPT);
    out.push('\n');
    out.push_str("window.__olazOrigin = ");
    out.push_str(
        &serde_json::to_string(&bridge.origin).unwrap_or_else(|_| "\"\"".to_string()),
    );
    out.push_str(";\n");
    out.push_str(&bridge.spec.script());
    out.push('\n');
    out.push_str(include_str!("../../../host-scripts/local-modules.js"));
    out.push('\n');
    out.push_str(include_str!("../../../host-scripts/bridge.js"));
    out
}

fn handle(mut request: Request, shared: &Shared) -> std::io::Result<()> {
    let url = request.url().to_string();
    let path = url.split('?').next().unwrap_or("/").to_string();
    let decoded = worker_script_path(&percent_decode_str(&path).decode_utf8_lossy());
    tracing::debug!("http {} {decoded}", request.method());

    if request.method() == &Method::Options {
        return respond(request, 204, Vec::new(), "text/plain", Vec::new());
    }

    if request.method() == &Method::Post && decoded == "/__olaz/bridge-sync" {
        let body = read_body(&mut request)?;
        tracing::debug!("bridge-sync request ({} bytes)", body.len());
        let response = shared.sync.handle(&body);
        tracing::debug!("bridge-sync response ({} bytes)", response.len());
        return respond(
            request,
            200,
            response,
            "application/json",
            Vec::new(),
        );
    }

    if request.method() == &Method::Post && decoded == "/__olaz/ready" {
        let body = read_body(&mut request)?;
        let url = serde_json::from_slice::<Value>(&body)
            .ok()
            .and_then(|value| value.get("url").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_default();
        shared
            .bridge
            .handle_message(&json!({ "kind": "ready", "url": url }).to_string());
        return respond(request, 200, b"{}".to_vec(), "application/json", Vec::new());
    }

    if request.method() == &Method::Post && decoded == "/__olaz/bridge-call" {
        let body = read_body(&mut request)?;
        tracing::debug!("bridge-call request ({} bytes)", body.len());
        // `handle_message` also dispatches fire-and-forget kinds (subscribe,
        // provide, log); those have no response, so answer with an empty object.
        let response = match shared.bridge.handle_message(&String::from_utf8_lossy(&body)) {
            Some((_id, payload)) => payload.into_bytes(),
            None => b"{}".to_vec(),
        };
        return respond(
            request,
            200,
            response,
            "application/json",
            Vec::new(),
        );
    }

    if request.method() == &Method::Get && decoded == "/__olaz/events" {
        let after = url
            .split_once('?')
            .map(|(_, query)| query)
            .and_then(|query| {
                query.split('&').find_map(|pair| {
                    pair.strip_prefix("after=")
                        .and_then(|value| value.parse::<u64>().ok())
                })
            });
        let page = url
            .split_once('?')
            .map(|(_, query)| query)
            .and_then(|query| {
                query.split('&').find_map(|pair| {
                    pair.strip_prefix("page=")
                        .map(|value| percent_decode_str(value).decode_utf8_lossy().into_owned())
                })
            })
            .unwrap_or_else(|| "main".to_string());
        let (cursor, events) = shared.events.wait(&page, after);
        let body = json!({ "cursor": cursor, "events": events }).to_string();
        return respond(
            request,
            200,
            body.into_bytes(),
            "application/json",
            Vec::new(),
        );
    }

    if !matches!(request.method(), &Method::Get | &Method::Head) {
        return respond(
            request,
            405,
            b"method not allowed".to_vec(),
            "text/plain; charset=utf-8",
            Vec::new(),
        );
    }

    if decoded == "/__olaz/host-scripts.js" {
        let body = shared.host_scripts.as_bytes().to_vec();
        let total = body.len() as u64;
        return if request.method() == &Method::Head {
            respond_headers_only(request, 200, "text/javascript; charset=utf-8", total, Vec::new())
        } else {
            respond(
                request,
                200,
                body,
                "text/javascript; charset=utf-8",
                Vec::new(),
            )
        };
    }

    if decoded == "/__olaz/state" {
        let body = json!({
            "session": has_session(&shared.sync),
            "origin": origin(),
        })
        .to_string();
        return respond(
            request,
            200,
            body.into_bytes(),
            "application/json",
            Vec::new(),
        );
    }

    let candidates = [format!("pc-dist{decoded}"), decoded.trim_start_matches('/').to_string()];
    let mut body = None;
    for candidate in candidates {
        match shared.asar.read(&candidate) {
            Ok(Some(bytes)) => {
                body = Some(patch::patch(&decoded, bytes));
                break;
            }
            Ok(None) => {}
            Err(error) => {
                tracing::warn!("asar read {candidate}: {error}");
            }
        }
    }

    let Some(mut body) = body else {
        tracing::debug!("404 {decoded}");
        return respond(
            request,
            404,
            format!("not found: {decoded}").into_bytes(),
            "text/plain; charset=utf-8",
            Vec::new(),
        );
    };

    if decoded.ends_with(".html") || decoded.ends_with(".htm") {
        body = inject_host_scripts(body);
    }

    let total = body.len() as u64;
    let range = request
        .headers()
        .iter()
        .find(|header| header.field.equiv("Range"))
        .and_then(|header| parse_range(header.value.as_str(), total));
    let mime = mime_for(&decoded);
    let head = request.method() == &Method::Head;

    match range {
        Some((start, end)) => {
            let slice = body[start as usize..=end as usize].to_vec();
            let extra = vec![(
                "Content-Range".to_string(),
                format!("bytes {start}-{end}/{total}"),
            )];
            if head {
                respond_headers_only(request, 206, mime, total, extra)
            } else {
                respond(request, 206, slice, mime, extra)
            }
        }
        None => {
            if head {
                respond_headers_only(request, 200, mime, total, Vec::new())
            } else {
                respond(request, 200, body, mime, Vec::new())
            }
        }
    }
}

// Some official HTML entry points name the search worker with a `.css`
// suffix even though importScripts needs the JavaScript bundle in app.asar.
fn worker_script_path(path: &str) -> String {
    if (path.starts_with("/search-worker.") || path.starts_with("/sync-v2-sub-worker."))
        && path.ends_with(".css")
    {
        format!("{}.js", path.trim_end_matches(".css"))
    } else {
        path.to_string()
    }
}

/// Loads the harness bridge before the renderer's own scripts run. The script
/// tag sits at the very start of `<head>`; it is external and has no `async`, so
/// parsing waits for it and `$z*` globals exist by the time the app boots.
fn inject_host_scripts(body: Vec<u8>) -> Vec<u8> {
    const TAG: &str = "<script src=\"/__olaz/host-scripts.js\"></script>";
    let mut text = match String::from_utf8(body) {
        Ok(text) => text,
        Err(error) => return error.into_bytes(),
    };
    let lower = text.to_ascii_lowercase();
    let position = lower
        .find("<head")
        .and_then(|start| lower[start..].find('>').map(|end| start + end + 1))
        .unwrap_or(0);
    text.insert_str(position, TAG);
    text.into_bytes()
}

fn read_body(request: &mut Request) -> std::io::Result<Vec<u8>> {
    let mut body = Vec::new();
    let mut reader = request.as_reader();
    std::io::Read::read_to_end(&mut reader, &mut body)?;
    Ok(body)
}

fn respond_headers_only(
    request: Request,
    status: u16,
    mime: &str,
    length: u64,
    extra: Vec<(String, String)>,
) -> std::io::Result<()> {
    let mut response = Response::empty(status);
    for header in headers(mime, length, extra) {
        response.add_header(header);
    }
    request.respond(response)
}

fn respond(
    request: Request,
    status: u16,
    body: Vec<u8>,
    mime: &str,
    extra: Vec<(String, String)>,
) -> std::io::Result<()> {
    let length = body.len() as u64;
    let mut response = Response::from_data(body)
        .with_status_code(status)
        .with_chunked_threshold(usize::MAX);
    for header in headers(mime, length, extra) {
        response.add_header(header);
    }
    request.respond(response)
}

fn headers(mime: &str, length: u64, extra: Vec<(String, String)>) -> Vec<Header> {
    let mut values = vec![
        ("Content-Type".to_string(), mime.to_string()),
        ("Content-Length".to_string(), length.to_string()),
        ("Cache-Control".to_string(), "no-cache".to_string()),
        ("Access-Control-Allow-Origin".to_string(), "*".to_string()),
        (
            "Access-Control-Allow-Headers".to_string(),
            "Content-Type, Range".to_string(),
        ),
        (
            "Access-Control-Allow-Methods".to_string(),
            "GET, HEAD, POST, OPTIONS".to_string(),
        ),
        ("Accept-Ranges".to_string(), "bytes".to_string()),
    ];
    values.extend(extra);
    values
        .into_iter()
        .filter_map(|(name, value)| Header::from_bytes(name.as_bytes(), value.as_bytes()).ok())
        .collect()
}

/// Parses a single `bytes=start-end` / `bytes=start-` / `bytes=-suffix` range.
fn parse_range(value: &str, total: u64) -> Option<(u64, u64)> {
    let value = value.strip_prefix("bytes=")?.split(',').next()?.trim();
    let (start, end) = value.split_once('-')?;
    if total == 0 {
        return None;
    }
    if start.is_empty() {
        let suffix: u64 = end.parse().ok()?;
        if suffix == 0 {
            return None;
        }
        let start = total.saturating_sub(suffix);
        return Some((start, total - 1));
    }
    let start: u64 = start.parse().ok()?;
    if start >= total {
        return None;
    }
    let end: u64 = if end.is_empty() {
        total - 1
    } else {
        end.parse::<u64>().ok()?.min(total - 1)
    };
    (start <= end).then_some((start, end))
}

fn mime_for(path: &str) -> &'static str {
    let extension = path
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "js" | "mjs" | "cjs" | "jsapi" => "text/javascript; charset=utf-8",
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "eot" => "application/vnd.ms-fontobject",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "pdf" => "application/pdf",
        "txt" | "log" => "text/plain; charset=utf-8",
        "xml" => "application/xml",
        _ => "application/octet-stream",
    }
}

/// Marker written once the renderer reports a successful login. It selects the
/// main page on the next launch (the cookie jar itself is the browser's).
pub fn session_marker(sync: &SyncHost) -> std::path::PathBuf {
    sync.platform.user_data.join(".olaz-session")
}

pub fn has_session(sync: &SyncHost) -> bool {
    session_marker(sync).exists()
}

pub fn mark_session(sync: &SyncHost, logged_in: bool) {
    let path = session_marker(sync);
    if logged_in {
        let _ = std::fs::write(&path, json!({ "at": 0 }).to_string());
    } else {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_css_aliases_use_javascript() {
        assert_eq!(worker_script_path("/search-worker.hash.css"), "/search-worker.hash.js");
        assert_eq!(worker_script_path("/sync-v2-sub-worker.hash.css"), "/sync-v2-sub-worker.hash.js");
        assert_eq!(worker_script_path("/other.css"), "/other.css");
    }

    #[test]
    fn parses_ranges() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=100-", 1000), Some((100, 999)));
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=0-5000", 1000), Some((0, 999)));
        assert_eq!(parse_range("bytes=1000-", 1000), None);
    }

    #[test]
    fn page_urls_are_stable() {
        let url = page_url(
            "login.html",
            &[
                ("client_version".into(), "696".into()),
                ("app_version".into(), "26.11.11".into()),
                ("fail_sqlite3".into(), "true".into()),
                ("type".into(), "24".into()),
            ],
        );
        // Parameter names must not be percent-encoded: the renderer splits the
        // query manually and skips decoding the key.
        assert_eq!(
            url,
            "http://127.0.0.1:47821/login.html?app_version=26.11.11&client_version=696&fail_sqlite3=true&type=24"
        );
    }

    #[test]
    fn query_keeps_unreserved_characters() {
        let url = page_url(
            "login.html",
            &[("mode_lang".into(), "vi-VN".into()), ("x".into(), "a b&c=d".into())],
        );
        assert!(url.contains("mode_lang=vi-VN"));
        assert!(url.contains("x=a%20b%26c%3Dd"));
    }

    #[test]
    fn event_bus_resumes_after_cursor() {
        let bus = EventBus::new();
        let (cursor, events) = bus.wait("main", None);
        assert_eq!(cursor, 0);
        assert!(events.is_empty());
        bus.publish(json!({ "n": 1 }));
        bus.publish(json!({ "n": 2 }));
        let (cursor, events) = bus.wait("main", Some(0));
        assert_eq!(cursor, 2);
        assert_eq!(events.len(), 2);
        let (cursor, events) = bus.wait("main", Some(2));
        assert_eq!(cursor, 2);
        assert!(events.is_empty());
    }

    #[test]
    fn event_bus_routes_pages() {
        let bus = EventBus::new();
        bus.publish_to(Some("worker"), json!({ "n": 1 }));
        bus.publish_to(Some("main"), json!({ "n": 2 }));
        bus.publish(json!({ "n": 3 }));
        let (_, worker) = bus.wait("worker", Some(0));
        assert_eq!(worker, vec![json!({ "n": 1 }), json!({ "n": 3 })]);
        let (_, main) = bus.wait("main", Some(0));
        assert_eq!(main, vec![json!({ "n": 2 }), json!({ "n": 3 })]);
    }

    #[test]
    fn injects_script_after_head() {
        let html = b"<!doctype html><html><head><meta charset=\"utf-8\"></head><body></body></html>";
        let out = String::from_utf8(inject_host_scripts(html.to_vec())).unwrap();
        assert!(out.contains("<head><script src=\"/__olaz/host-scripts.js\"></script><meta"));
    }
}
