//! Locating (and, when needed, installing) the official Zalo runtime.

use std::path::{Path, PathBuf};

use olaz_core::runtime::Runtime;

/// A runtime directory supplied by the test harness (e.g. the Windows install
/// mounted under `/mnt/c` in WSL) takes precedence over the per-user copy.
pub fn runtime_dir() -> Option<PathBuf> {
    std::env::var_os("OLAZ_RUNTIME_DIR").map(PathBuf::from)
}

pub fn find_installer() -> Option<PathBuf> {
    let filename = format!(
        "ZaloSetup-{}.exe",
        olaz_core::runtime::RUNTIME_VERSION
    );
    if let Ok(path) = std::env::var("OLAZ_INSTALLER") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    let mut candidates = vec![olaz_core::runtime::data_root().join(&filename)];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(&filename));
        }
    }
    if let Ok(dir) = std::env::current_dir() {
        candidates.push(dir.join(&filename));
    }
    candidates.into_iter().find(|path| path.is_file())
}

/// Opens the already-prepared runtime when possible, otherwise runs the normal
/// locate/install flow.
pub fn load_runtime() -> anyhow::Result<Runtime> {
    let dir = runtime_dir().or_else(|| {
        #[cfg(not(windows))]
        {
            windows_runtime_dir()
        }
        #[cfg(windows)]
        {
            None
        }
    });
    if let Some(dir) = dir {
        tracing::info!("using runtime directory {}", dir.display());
        return Ok(Runtime::open(dir)?);
    }
    let root = olaz_core::runtime::default_root();
    let installer = find_installer();
    tracing::info!(
        "olaz: starting (runtime {}, installer {})",
        olaz_core::runtime::RUNTIME_VERSION,
        installer
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "not found".to_string())
    );
    if installer.is_none() {
        tracing::warn!(
            "no ZaloSetup installer found; an installed Zalo {} is used when present",
            olaz_core::runtime::RUNTIME_VERSION
        );
    }
    Ok(olaz_core::runtime::ensure_runtime(&root, installer.as_deref())?)
}

/// Typical Windows install of the official runtime, reachable from WSL.
pub fn windows_runtime_dir() -> Option<PathBuf> {
    let candidates = [
        "/mnt/c/Users/Admin/AppData/Local/Olaz/ZaloRuntime/current",
        "/mnt/c/Users/Admin/AppData/Local/ZaloPC/ZaloRuntime/current",
    ];
    candidates
        .iter()
        .map(Path::new)
        .find(|path| path.join("app.asar").is_file())
        .map(Path::to_path_buf)
}
