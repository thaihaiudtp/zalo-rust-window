//! Tests against the real Zalo PC 26.11.11 files.
//!
//! They are ignored by default because VNG's code is not distributed with
//! Olaz. Point the environment variables at local copies:
//!
//! ```text
//! OLAZ_TEST_ASAR=/path/to/app.asar \
//! OLAZ_TEST_INSTALLER=/path/to/ZaloSetup-26.11.11.exe \
//!   cargo test -p olaz-core --test real_runtime -- --ignored
//! ```

use std::path::PathBuf;

use olaz_core::asar::AsarArchive;
use olaz_core::runtime;
use sha2::{Digest, Sha256};

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from).filter(|path| path.exists())
}

#[test]
#[ignore = "needs OLAZ_TEST_ASAR"]
fn reads_official_renderer_from_asar() {
    let Some(path) = env_path("OLAZ_TEST_ASAR") else {
        eprintln!("OLAZ_TEST_ASAR not set; skipping");
        return;
    };
    let asar = AsarArchive::open(&path).expect("open app.asar");

    for required in [
        "pc-dist/login.html",
        "pc-dist/index.html",
        "pc-dist/shared-worker.html",
        "main-dist/preload-render.js",
        "main-dist/main.js",
    ] {
        assert!(asar.contains(required), "missing {required}");
    }

    let login = asar
        .read_to_string("pc-dist/login.html")
        .expect("read login.html")
        .expect("login.html exists");
    assert!(login.contains("<html"), "login.html is not HTML");

    let dal_workers = asar.paths_with_prefix("pc-dist/dal-worker.");
    assert!(!dal_workers.is_empty(), "no dal-worker bundle");
    let sub_workers = asar.paths_with_prefix("pc-dist/sync-v2-sub-worker.");
    assert!(!sub_workers.is_empty(), "no sync-v2-sub-worker bundle");
    let startup = asar.paths_with_prefix("pc-dist/lazy/main-startup.");
    assert!(!startup.is_empty(), "no lazy/main-startup bundle");

    // The ASAR must expose the preload's IPC table source.
    assert!(asar.contains("main-dist/preload-render.js"));
}

#[test]
#[ignore = "needs OLAZ_TEST_INSTALLER and takes a minute"]
fn extracts_and_verifies_pinned_runtime() {
    let Some(installer) = env_path("OLAZ_TEST_INSTALLER") else {
        eprintln!("OLAZ_TEST_INSTALLER not set; skipping");
        return;
    };

    let data = tempfile::tempdir().expect("temp dir");
    let root = data.path().join("ZaloRuntime");
    let mut stages = Vec::new();
    runtime::install_from_installer(&installer, &root, |stage| stages.push(stage))
        .expect("install runtime from installer");

    assert!(stages.contains(&runtime::InstallStage::ExtractingInstaller));
    assert!(stages.contains(&runtime::InstallStage::ExtractingArchive));
    assert!(stages.contains(&runtime::InstallStage::Installing));

    let installed = runtime::Runtime::open_current(&root).expect("open installed runtime");
    assert_eq!(installed.manifest.version, runtime::RUNTIME_VERSION);
    assert_eq!(installed.manifest.asar_size, runtime::ASAR_SIZE);

    let bytes = std::fs::read(installed.asar_path()).expect("read installed app.asar");
    let digest = Sha256::digest(&bytes);
    assert_eq!(
        format!("{digest:x}"),
        runtime::ASAR_SHA256,
        "installed app.asar hash"
    );
    assert!(installed.asar.contains("pc-dist/index.html"));

    // A second call must reuse the verified runtime without touching the
    // installer (the path is deliberately bogus).
    let reused = runtime::ensure_runtime(&root, Some(std::path::Path::new("missing.exe")))
        .expect("reuse installed runtime");
    assert_eq!(reused.manifest, installed.manifest);
}
