//! Locating, verifying and installing the official Zalo PC runtime.
//!
//! The runtime Olaz keeps is just what the renderer needs:
//!
//! ```text
//! <data>/Olaz/ZaloRuntime/
//!   current/
//!     app.asar        the official renderer (pc-dist, main-dist, preload…)
//!     version.json    version, client version and hashes
//!   pending/          a verified upgrade, swapped in at next launch
//!   work/             scratch space, emptied at every launch
//! ```

mod installer;
pub mod release;

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

use crate::asar::AsarArchive;
use crate::error::{Error, Result};
pub use release::{
    RuntimeManifest, ASAR_SHA256, ASAR_SIZE, CLIENT_TYPE, CLIENT_VERSION, INSTALLER_SHA256,
    INSTALLER_URL, RUNTIME_VERSION,
};

/// Filename of the renderer archive inside a runtime directory.
pub const ASAR_FILE: &str = "app.asar";
/// Filename of the runtime manifest.
pub const MANIFEST_FILE: &str = "version.json";

/// Progress of a runtime installation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallStage {
    /// Looking for an installed Zalo PC of the pinned version.
    Locating,
    /// Decompressing the NSIS installer.
    ExtractingInstaller,
    /// Extracting `app.asar` from the embedded 7z payload.
    ExtractingArchive,
    /// Checking size and SHA-256.
    Verifying,
    /// Moving the verified runtime into place.
    Installing,
}

/// A verified runtime, ready to be served to WebView2.
pub struct Runtime {
    /// `…/ZaloRuntime/current`
    pub dir: PathBuf,
    /// Parsed `version.json`.
    pub manifest: RuntimeManifest,
    /// The official renderer archive.
    pub asar: AsarArchive,
}

impl std::fmt::Debug for Runtime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Runtime")
            .field("dir", &self.dir)
            .field("manifest", &self.manifest)
            .finish_non_exhaustive()
    }
}

/// Root of Olaz's per-user data.
///
/// Windows: `%LOCALAPPDATA%\Olaz`; other platforms are only used for tests and
/// development (`~/.local/share/Olaz`).
pub fn data_root() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Olaz")
}

/// `<data>/ZaloRuntime`.
pub fn default_root() -> PathBuf {
    data_root().join("ZaloRuntime")
}

/// `<root>/current`.
pub fn current_dir(root: &Path) -> PathBuf {
    root.join("current")
}

/// `<root>/pending`.
pub fn pending_dir(root: &Path) -> PathBuf {
    root.join("pending")
}

/// `<root>/work`.
pub fn work_dir(root: &Path) -> PathBuf {
    root.join("work")
}

/// Reads `<dir>/version.json`.
pub fn read_manifest(dir: &Path) -> Result<RuntimeManifest> {
    let path = dir.join(MANIFEST_FILE);
    let data = fs::read(&path).map_err(|error| {
        Error::IncompleteRuntime(format!("{}: {error}", path.display()))
    })?;
    Ok(serde_json::from_slice(&data)?)
}

/// Fast completeness check: manifest present and archive has the recorded
/// size. The hash is checked when the runtime is installed, not at every
/// launch (hashing 181 MB would delay startup for no security gain: the file
/// lives in the user's own profile).
pub fn is_complete(dir: &Path) -> bool {
    let Ok(manifest) = read_manifest(dir) else {
        return false;
    };
    fs::metadata(dir.join(ASAR_FILE))
        .map(|metadata| metadata.len() == manifest.asar_size)
        .unwrap_or(false)
}

/// Drops leftovers of interrupted installs and swaps in a prepared upgrade.
/// Call once at startup, before anything opens the runtime.
pub fn prepare_for_launch(root: &Path) {
    let current = current_dir(root);
    let pending = pending_dir(root);
    let work = work_dir(root);

    let _ = fs::remove_dir_all(&work);

    if !pending.exists() {
        return;
    }
    if !is_complete(&pending) {
        let _ = fs::remove_dir_all(&pending);
        return;
    }

    let retired = work.join(format!("retired-{}", unique_suffix()));
    if fs::create_dir_all(&work).is_err() {
        return;
    }
    if current.exists() && fs::rename(&current, &retired).is_err() {
        return;
    }
    if fs::rename(&pending, &current).is_err() {
        // Keep the old runtime rather than ending up with none.
        if !current.exists() && retired.exists() {
            let _ = fs::rename(&retired, &current);
        }
        return;
    }
    let _ = fs::remove_dir_all(&retired);
}

impl Runtime {
    /// Opens the runtime in `dir`, checking the manifest and archive size.
    pub fn open(dir: impl AsRef<Path>) -> Result<Self> {
        let dir = dir.as_ref().to_path_buf();
        let manifest = read_manifest(&dir)?;
        let asar_path = dir.join(ASAR_FILE);
        let actual = fs::metadata(&asar_path)?.len();
        if actual != manifest.asar_size {
            return Err(Error::SizeMismatch {
                path: asar_path.display().to_string(),
                expected: manifest.asar_size,
                actual,
            });
        }
        let asar = AsarArchive::open(&asar_path)?;
        Ok(Self {
            dir,
            manifest,
            asar,
        })
    }

    /// Opens `<root>/current`.
    pub fn open_current(root: &Path) -> Result<Self> {
        Self::open(current_dir(root))
    }

    /// `current/app.asar`.
    pub fn asar_path(&self) -> PathBuf {
        self.dir.join(ASAR_FILE)
    }
}

/// Ensures a verified runtime exists under `root` and returns it.
///
/// Sources, in order: the runtime already installed by Olaz, an installed Zalo
/// PC of the pinned version, and finally `installer` when supplied.
pub fn ensure_runtime(root: &Path, installer: Option<&Path>) -> Result<Runtime> {
    prepare_for_launch(root);

    let current = current_dir(root);
    if is_complete(&current) {
        return Runtime::open(current);
    }

    fs::create_dir_all(root)?;

    if let Some(source) = find_installed_zalo_asar() {
        match install_asar(&source, root) {
            Ok(()) => return Runtime::open(current),
            Err(error) => {
                tracing::warn!(
                    "runtime: installed Zalo at {} is not usable: {error}",
                    source.display()
                );
            }
        }
    }

    let Some(installer) = installer else {
        return Err(Error::RuntimeNotFound {
            expected: RUNTIME_VERSION.to_string(),
        });
    };

    install_from_installer(installer, root, |_| {})?;
    Runtime::open(current)
}

/// Installs the pinned runtime from an official NSIS installer.
pub fn install_from_installer(
    installer: &Path,
    root: &Path,
    mut progress: impl FnMut(InstallStage),
) -> Result<()> {
    progress(InstallStage::Locating);
    let work = work_dir(root);
    fs::create_dir_all(&work)?;

    let staging = tempfile::Builder::new()
        .prefix(".staging-")
        .tempdir_in(root)?;

    progress(InstallStage::ExtractingInstaller);
    let extracted = installer::extract_asar(installer, &work, &staging.path().join(ASAR_FILE), &mut progress)?;
    tracing::debug!("runtime: extracted app.asar to {}", extracted.display());

    progress(InstallStage::Installing);
    write_manifest(staging.path(), RuntimeManifest::pinned())?;
    swap_in(staging.path(), root)?;
    let _ = fs::remove_dir_all(&work);
    Ok(())
}

/// Copies a verified `app.asar` into the runtime directory.
pub fn install_asar(source: &Path, root: &Path) -> Result<()> {
    let staged = tempfile::Builder::new()
        .prefix(".staging-asar-")
        .tempdir_in(root)?;
    copy_and_verify(source, &staged.path().join(ASAR_FILE))?;
    write_manifest(staged.path(), RuntimeManifest::pinned())?;
    swap_in(staged.path(), root)
}

fn write_manifest(dir: &Path, mut manifest: RuntimeManifest) -> Result<()> {
    manifest.installed_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let data = serde_json::to_vec_pretty(&manifest)?;
    let mut file = File::create(dir.join(MANIFEST_FILE))?;
    file.write_all(&data)?;
    file.sync_all()?;
    Ok(())
}

/// Moves a complete staging directory into `<root>/current`.
fn swap_in(staging: &Path, root: &Path) -> Result<()> {
    let current = current_dir(root);
    let retired = work_dir(root).join(format!("retired-{}", unique_suffix()));
    fs::create_dir_all(work_dir(root))?;

    if current.exists() {
        fs::rename(&current, &retired)?;
    }
    match fs::rename(staging, &current) {
        Ok(()) => {
            let _ = fs::remove_dir_all(&retired);
            Ok(())
        }
        Err(error) => {
            if !current.exists() && retired.exists() {
                let _ = fs::rename(&retired, &current);
            }
            Err(error.into())
        }
    }
}

/// Copies `source` to `destination`, hashing and verifying the pinned runtime.
fn copy_and_verify(source: &Path, destination: &Path) -> Result<()> {
    let size = fs::metadata(source)?.len();
    if size != ASAR_SIZE {
        return Err(Error::SizeMismatch {
            path: source.display().to_string(),
            expected: ASAR_SIZE,
            actual: size,
        });
    }

    let mut input = File::open(source)?;
    let mut output = File::create(destination)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 4 << 20];
    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        output.write_all(&buffer[..read])?;
    }
    output.sync_all()?;

    let digest = hex(&hasher.finalize());
    if digest != ASAR_SHA256 {
        return Err(Error::HashMismatch {
            path: source.display().to_string(),
            expected: ASAR_SHA256.to_string(),
            actual: digest,
        });
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    const CHARS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(CHARS[(byte >> 4) as usize] as char);
        out.push(CHARS[(byte & 0x0f) as usize] as char);
    }
    out
}

fn unique_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("{}-{nanos}", std::process::id())
}

/// An installed Zalo PC of the pinned version, when present.
///
/// `OLAZ_ZALO_ASAR` may point directly at an `app.asar` (or at a Zalo install
/// directory); otherwise the usual electron-builder locations are checked.
pub fn find_installed_zalo_asar() -> Option<PathBuf> {
    if let Some(value) = std::env::var_os("OLAZ_ZALO_ASAR") {
        let path = PathBuf::from(value);
        let candidate = if path.is_dir() {
            path.join("resources").join(ASAR_FILE)
        } else {
            path
        };
        if is_pinned_asar(&candidate) {
            return Some(candidate);
        }
    }

    let mut roots = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        roots.push(local.join("Programs").join("Zalo"));
        roots.push(local.join("Zalo"));
    }
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        roots.push(PathBuf::from(program_files).join("Zalo"));
    }
    if let Some(program_files) = std::env::var_os("ProgramFiles(x86)") {
        roots.push(PathBuf::from(program_files).join("Zalo"));
    }

    roots
        .into_iter()
        .map(|root| root.join("resources").join(ASAR_FILE))
        .find(|candidate| is_pinned_asar(candidate))
}

fn is_pinned_asar(path: &Path) -> bool {
    fs::metadata(path)
        .map(|metadata| metadata.len() == ASAR_SIZE)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_encodes_lowercase() {
        assert_eq!(hex(&[0x00, 0x0f, 0xa5, 0xff]), "000fa5ff");
    }

    #[test]
    fn incomplete_runtime_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!is_complete(dir.path()));
        assert!(Runtime::open(dir.path()).is_err());
    }
}
