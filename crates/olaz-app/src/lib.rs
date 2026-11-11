//! Olaz — Windows host for the official Zalo PC renderer.
//!
//! An Electron-shaped shell written in Rust: the official `app.asar` is served
//! over a loopback origin to the renderer, and the official preload's `$z*`
//! bridge is re-created by [`bridge`]/`host-scripts` while [`local`],
//! [`platform`], [`crypto`] and [`secrets`] answer the main-process work.
//!
//! On Windows the renderer runs in WebView2 ([`ui`]). On other platforms a
//! development harness ([`edge`]) drives Microsoft Edge in app mode and uses
//! the HTTP bridge transport instead; it exists because Smart App Control on
//! the development machine rejects freshly built WebView2 hosts.

mod bridge;
mod crypto;
mod local;
mod patch;
mod platform;
mod secrets;
mod server;
mod startup;

#[cfg(windows)]
mod ui;

#[cfg(not(windows))]
mod edge;

/// Entry point for both `Olaz.exe` and the `rundll32` test harness.
pub fn run() -> anyhow::Result<()> {
    #[cfg(windows)]
    {
        ui::run()
    }
    #[cfg(not(windows))]
    {
        edge::run()
    }
}

/// `rundll32 Olaz.dll,OlazRun` entry point.
///
/// Smart App Control blocks unsigned standalone executables on some machines,
/// while a DLL loaded by the signed `rundll32.exe` can run. The release build
/// ships both: `Olaz.exe` for normal use and `Olaz.dll` for application-control
/// environments that reject the exe.
#[cfg(windows)]
#[no_mangle]
pub extern "system" fn OlazRun(
    _hwnd: *mut std::ffi::c_void,
    _hinstance: *mut std::ffi::c_void,
    _command: *mut std::ffi::c_char,
    _show: i32,
) {
    if let Err(error) = run() {
        eprintln!("olaz: {error:#}");
    }
}
