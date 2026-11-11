//! Windows/WebView2 UI host.
//!
//! An Electron-shaped shell written in Rust: the official `app.asar` is served
//! over a loopback origin to WebView2, and the official preload's `$z*` bridge
//! is re-created by [`bridge`]/`host-scripts` while [`local`], [`platform`],
//! [`crypto`] and [`secrets`] answer the main-process work.

use std::sync::mpsc;
use std::sync::Arc;

use serde_json::{json, Value};
use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::window::{Window, WindowBuilder};
use wry::{PageLoadEvent, WebContext, WebView, WebViewBuilder};

use crate::bridge::{self, Bridge, UiEvent, CONSOLE_SCRIPT};
use crate::platform::{Platform, SyncHost};
use crate::server;

/// Electron's user data for the renderer (localStorage, IndexedDB, cookies).
const WEBVIEW_DATA: &str = "WebView2";

/// Extra WebView2/Chromium switches.
///
/// The renderer's origin is `http://127.0.0.1:47821`, but the Zalo API lives on
/// other origins and does not answer CORS preflights (the official client ran
/// from `file://`, where Electron did not enforce it). SameSite cookies must
/// travel cross-site for the same reason.
#[cfg(target_os = "windows")]
const WEBVIEW2_ARGS: &str = concat!(
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,",
    "SameSiteByDefaultCookies,CookiesWithoutSameSiteMustBeSecure,",
    "ThirdPartyStoragePartitioning ",
    "--disable-web-security ",
    "--disable-background-timer-throttling --disable-renderer-backgrounding ",
    "--autoplay-policy=no-user-gesture-required"
);

#[cfg(target_os = "windows")]
fn browser_args() -> String {
    let mut args = WEBVIEW2_ARGS.to_string();
    if let Ok(port) = std::env::var("OLAZ_REMOTE_DEBUG") {
        if !port.is_empty() {
            args.push_str(&format!(" --remote-debugging-port={port} --remote-allow-origins=*"));
        }
    }
    args
}

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

    let event_loop = EventLoopBuilder::<UiEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    let (events, receiver) = mpsc::channel::<UiEvent>();
    spawn_event_forwarder(receiver, proxy.clone());

    let bridge = Arc::new(Bridge::new(platform.clone(), origin.clone(), events));
    server::start(
        Arc::new(runtime.asar),
        sync.clone(),
        bridge.clone(),
        server::EventBus::new(),
    )?;

    let window = WindowBuilder::new()
        .with_title("Olaz")
        .with_inner_size(LogicalSize::new(1100.0, 720.0))
        .with_min_inner_size(LogicalSize::new(520.0, 480.0))
        .build(&event_loop)?;

    let mut web_context = WebContext::new(Some(
        olaz_core::runtime::data_root().join(WEBVIEW_DATA),
    ));

    let user_agent = olaz_core::runtime::release::user_agent();
    let bridge_ipc = bridge.clone();
    let proxy_ipc = proxy.clone();
    let proxy_page = proxy.clone();

    let builder = WebViewBuilder::new_with_web_context(&mut web_context)
        .with_user_agent(user_agent)
        .with_devtools(true)
        // Console capture first: errors thrown by the host scripts themselves
        // must reach the Rust log too.
        .with_initialization_script(CONSOLE_SCRIPT)
        .with_initialization_script(bridge.spec.script())
        .with_initialization_script(include_str!("../../../host-scripts/local-modules.js"))
        .with_initialization_script(include_str!("../../../host-scripts/bridge.js"))
        .with_initialization_script(format!(
            "window.__olazOrigin = {};",
            serde_json::to_string(&origin).unwrap_or_else(|_| "\"\"".into())
        ))
        .with_ipc_handler(move |request| {
            if let Some((id, payload)) = bridge_ipc.handle_message(request.body()) {
                let _ = proxy_ipc.send_event(UiEvent::BridgeResponse { page: "main".into(), id, payload });
            }
        })
        .with_on_page_load_handler(move |event, url| {
            let event = match event {
                PageLoadEvent::Started => UiEvent::PageStarted(url),
                PageLoadEvent::Finished => UiEvent::PageFinished(url),
            };
            let _ = proxy_page.send_event(event);
        })
        .with_navigation_handler(move |url| allow_navigation(&url));
    // The renderer runs from a loopback origin, while Zalo's API answers live on
    // zalo.me/zaloapp.com. The official client loaded from file:// without a
    // usable origin and had no CORS either, so WebView2 must not enforce it.
    #[cfg(target_os = "windows")]
    let builder = {
        use wry::WebViewBuilderExtWindows;
        builder.with_additional_browser_args(browser_args())
    };
    let webview = builder.build(&window)?;

    // Match Electron's hidden shared-worker window. Both WebViews share their
    // WebContext/profile; the loopback HTML injects the same preload bridge.
    let worker_window = WindowBuilder::new()
        .with_title("Olaz Shared Worker")
        .with_visible(false)
        .build(&event_loop)?;
    let worker_bridge = bridge.clone();
    let worker_proxy = proxy.clone();
    let worker_page_proxy = proxy.clone();
    let worker_builder = WebViewBuilder::new_with_web_context(&mut web_context)
        .with_user_agent(olaz_core::runtime::release::user_agent())
        .with_ipc_handler(move |request| {
            if let Some((id, payload)) = worker_bridge.handle_message(request.body()) {
                let _ = worker_proxy.send_event(UiEvent::BridgeResponse { page: "worker".into(), id, payload });
            }
        })
        .with_on_page_load_handler(move |event, url| {
            if matches!(event, PageLoadEvent::Finished) {
                let _ = worker_page_proxy.send_event(UiEvent::PageFinished(url));
            }
        })
        .with_navigation_handler(move |url| allow_navigation(&url));
    #[cfg(target_os = "windows")]
    let worker_builder = {
        use wry::WebViewBuilderExtWindows;
        worker_builder.with_additional_browser_args(browser_args())
    };
    let worker_webview = worker_builder.build(&worker_window)?;
    worker_webview.load_url(&server::page_url("shared-worker.html", &bridge::page_query(&platform, false)))?;

    let logged_in = server::has_session(&sync);
    let initial = if logged_in {
        bridge::main_url(&platform)
    } else {
        bridge::login_url(&platform)
    };
    tracing::info!("loading {initial}");
    webview.load_url(&initial)?;

    run_event_loop(event_loop, window, webview, worker_window, worker_webview, platform, sync, initial);
}

fn run_event_loop(
    event_loop: tao::event_loop::EventLoop<UiEvent>,
    window: Window,
    webview: WebView,
    worker_window: Window,
    worker_webview: WebView,
    platform: Platform,
    sync: Arc<SyncHost>,
    initial: String,
) -> ! {
    let mut pending_login_success = false;
    let mut current_url = initial;
    let mut worker_ready = false;
    let mut worker_queue = Vec::new();

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                window_id,
                ..
            } if window_id == window.id() => {
                *control_flow = ControlFlow::Exit;
            }
            Event::UserEvent(event) => match event {
                UiEvent::BridgeResponse { page, id, payload } => {
                    let mut message: Value = serde_json::from_str(&payload)
                        .unwrap_or_else(|_| json!({ "error": "invalid bridge response" }));
                    if let Some(map) = message.as_object_mut() {
                        map.insert("kind".into(), json!("response"));
                        map.insert("id".into(), json!(id));
                    }
                    push_message(if page == "worker" { &worker_webview } else { &webview }, &message);
                }
                UiEvent::EmitIpc { page, channel, args } => {
                    let message = json!({ "kind": "ipc", "channel": channel, "args": args });
                    if page.as_deref() != Some("worker") {
                        push_message(&webview, &message);
                    }
                    if page.is_none() || page.as_deref() == Some("worker") {
                        if worker_ready { push_message(&worker_webview, &message); }
                        else { worker_queue.push(message); }
                    }
                }
                UiEvent::LoginSucceeded => {
                    tracing::info!("login-success: switching to the main page");
                    server::mark_session(&sync, true);
                    pending_login_success = true;
                    let url = bridge::main_url(&platform);
                    if let Err(error) = webview.load_url(&url) {
                        tracing::error!("load {url}: {error}");
                    }
                    current_url = url;
                }
                UiEvent::LoggedOut => {
                    tracing::info!("logged out: switching to the login page");
                    server::mark_session(&sync, false);
                    pending_login_success = false;
                    let url = bridge::login_url(&platform);
                    if let Err(error) = webview.load_url(&url) {
                        tracing::error!("load {url}: {error}");
                    }
                    current_url = url;
                }
                UiEvent::Reload => {
                    tracing::info!("reloading {current_url}");
                    if let Err(error) = webview.reload() {
                        tracing::warn!("reload failed: {error}");
                    }
                }
                UiEvent::SetAppCookie(value) => apply_session_cookie(&webview, &value),
                UiEvent::SetCookie {
                    name,
                    value,
                    domain,
                } => {
                    set_cookie(&webview, &name, &value, &domain, false, 365);
                }
                UiEvent::ClearCookies => clear_zalo_cookies(&webview),
                UiEvent::OpenDevTools => webview.open_devtools(),
                UiEvent::PageStarted(url) => {
                    current_url = url;
                    push_message(
                        &webview,
                        &json!({ "kind": "ipc", "channel": "unload-zlog", "args": [] }),
                    );
                }
                UiEvent::PageReady(_) => {}
                UiEvent::PageFinished(url) => {
                    if url.contains("/shared-worker.html") {
                        worker_ready = true;
                        for message in worker_queue.drain(..) { push_message(&worker_webview, &message); }
                        // Keep the native window alive, but never display it.
                        worker_window.set_visible(false);
                        return;
                    }
                    current_url = url.clone();
                    window.set_title(title_for(&url));
                    log_page_state(&webview, &url);
                    push_message(
                        &webview,
                        &json!({ "kind": "ipc", "channel": "visibility-change", "args": ["show"] }),
                    );
                    push_message(
                        &webview,
                        &json!({ "kind": "ipc", "channel": "visibility-change", "args": ["focus", "1"] }),
                    );
                    if pending_login_success && url.contains("index.html") {
                        pending_login_success = false;
                        push_message(
                            &webview,
                            &json!({ "kind": "ipc", "channel": "login-success", "args": [] }),
                        );
                    }
                }
                UiEvent::Quit => *control_flow = ControlFlow::Exit,
            },
            _ => {}
        }
    });
}

/// Feeds bridge events into the tao event loop. `EventLoopProxy` can be woken
/// from any thread on Windows, which is where the WebView2 IPC handler and the
/// HTTP server run.
fn spawn_event_forwarder(receiver: mpsc::Receiver<UiEvent>, proxy: EventLoopProxy<UiEvent>) {
    let spawned = std::thread::Builder::new()
        .name("olaz-events".into())
        .spawn(move || {
            while let Ok(event) = receiver.recv() {
                if proxy.send_event(event).is_err() {
                    break;
                }
            }
        });
    if let Err(error) = spawned {
        tracing::error!("cannot start the event thread: {error}");
    }
}

/// One-shot diagnostic of the page's bridge state after every load. A missing
/// `__zaloLocal` or an all-stubs `$z…` tree is the usual cause of mysterious
/// renderer dependency-injection failures.
fn log_page_state(webview: &WebView, url: &str) {
    let script = r#"
(() => {
  try {
    const local = window.__zaloLocal || {};
    const spec = window.__zaloBridgeSpec || { members: {} };
    const sample = ['$zelectron.getElectronStore', '$znode.path', '$zlogin.notifyLoginSuccess', '$zsharedWorker.runTask'];
    const types = {};
    for (const path of sample) {
      let value = window;
      for (const part of path.split('.')) value = value == null ? undefined : value[part];
      types[path] = typeof value;
    }
    return JSON.stringify({
      href: location.href,
      title: document.title,
      local: typeof window.__zaloLocal,
      localCount: Object.keys(local).length,
      bridge: typeof window.__zaloBridge,
      specMembers: Object.keys(spec.members || {}).length,
      types,
    });
  } catch (e) { return 'diag failed: ' + String(e); }
})()
"#;
    let page = url.to_string();
    if let Err(error) = webview.evaluate_script_with_callback(script, move |result| {
        tracing::info!("page state {page}: {result}");
    }) {
        tracing::debug!("page state probe failed: {error}");
    }
}

fn push_message(webview: &WebView, message: &Value) {
    let payload = match serde_json::to_string(message) {
        Ok(payload) => payload,
        Err(error) => {
            tracing::warn!("encode host message: {error}");
            return;
        }
    };
    let script =
        format!("window.__olazHostMessage && window.__olazHostMessage({payload});");
    if let Err(error) = webview.evaluate_script(&script) {
        tracing::debug!("host message not delivered (page loading?): {error}");
    }
}

fn title_for(url: &str) -> &'static str {
    if url.contains("index.html") {
        "Olaz — Zalo"
    } else if url.contains("login.html") {
        "Olaz — Đăng nhập Zalo"
    } else {
        "Olaz"
    }
}

/// Only the renderer's own pages stay in this view; everything else opens in
/// the browser. `blob:`/`data:` are renderer-local (attachment previews).
fn allow_navigation(url: &str) -> bool {
    let origin = server::origin();
    if url == origin || url.starts_with(&(origin.clone() + "/")) {
        return true;
    }
    for scheme in ["about:", "blob:", "data:", "javascript:", "devtools:"] {
        if url.starts_with(scheme) {
            return true;
        }
    }
    if url.starts_with("http://") || url.starts_with("https://") {
        open_external(url);
        tracing::info!("external link opened in the browser: {url}");
    } else {
        tracing::debug!("navigation blocked: {url}");
    }
    false
}

fn open_external(url: &str) {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", url])
            .spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
}

// ---- cookies ----------------------------------------------------------

const SESSION_COOKIE_DOMAINS: [&str; 3] = ["zaloapp.com", "zalo.me", "chat.zalo.me"];

fn apply_session_cookie(webview: &WebView, value: &str) {
    if let Ok(cookies) = webview.cookies() {
        for cookie in cookies.iter().filter(|cookie| cookie.name() == "zpw_sek") {
            let _ = webview.delete_cookie(cookie);
        }
    }
    for domain in SESSION_COOKIE_DOMAINS {
        set_cookie(webview, "zpw_sek", value, domain, true, 7);
    }
}

fn set_cookie(
    webview: &WebView,
    name: &str,
    value: &str,
    domain: &str,
    http_only: bool,
    days: i64,
) {
    let domain = if domain.starts_with('.') {
        domain.to_string()
    } else {
        format!(".{domain}")
    };
    let cookie = cookie::Cookie::build((name.to_string(), value.to_string()))
        .domain(domain)
        .path("/")
        .secure(true)
        .same_site(cookie::SameSite::None)
        .http_only(http_only)
        .max_age(cookie::time::Duration::days(days))
        .build();
    if let Err(error) = webview.set_cookie(&cookie) {
        tracing::warn!("set cookie {name}: {error}");
    }
}

fn clear_zalo_cookies(webview: &WebView) {
    let Ok(cookies) = webview.cookies() else {
        return;
    };
    for cookie in cookies {
        let domain = cookie.domain().unwrap_or("").trim_start_matches('.');
        if is_zalo_domain(domain) {
            if let Err(error) = webview.delete_cookie(&cookie) {
                tracing::debug!("delete cookie {}: {error}", cookie.name());
            }
        }
    }
}

fn is_zalo_domain(domain: &str) -> bool {
    const ROOTS: [&str; 5] = ["zalo.me", "zaloapp.com", "zadn.vn", "zdn.vn", "zing.vn"];
    ROOTS
        .iter()
        .any(|root| domain == *root || domain.ends_with(&format!(".{root}")))
}
