//! Pure-Rust extraction of the official Zalo PC NSIS installer.
//!
//! The installer is a small NSIS bootstrap whose `$PLUGINSDIR` contains
//! `app-32.7z` (a non-solid 7z with one BCJ2 block per file). Only
//! `resources/app.asar` is needed; the rest of the payload (Electron, native
//! DLLs, the 32-bit `Zalo.exe`) is ignored.

use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};

use memmap2::MmapOptions;
use sha2::{Digest, Sha256};
use sevenz_rust2::{ArchiveReader, EntryDecision, Password};

use crate::error::{Error, Result};
use crate::runtime::{InstallStage, ASAR_SHA256, ASAR_SIZE};

/// Extracts `resources/app.asar` from `installer` to `destination`.
///
/// The destination is inside a staging directory; the caller verifies and
/// swaps it in. Returns the destination path.
pub fn extract_asar(
    installer: &Path,
    work: &Path,
    destination: &Path,
    progress: &mut impl FnMut(InstallStage),
) -> Result<PathBuf> {
    let file = File::open(installer)?;
    let bytes = unsafe { MmapOptions::new().map(&file)? };
    let nsis = nsis::NsisInstaller::from_bytes(&bytes)?;

    progress(InstallStage::ExtractingInstaller);
    let mut payload = None;
    for entry in nsis.files() {
        let entry = entry?;
        let path = entry.dest_path()?.to_path().replace('\\', "/");
        if path.to_ascii_lowercase().ends_with("app-32.7z") {
            payload = Some(entry.decompress()?);
            break;
        }
    }
    let Some(payload) = payload else {
        return Err(Error::message(
            "Zalo installer does not contain $PLUGINSDIR/app-32.7z",
        ));
    };
    tracing::debug!("runtime: decompressed app-32.7z ({} bytes)", payload.len());

    let mut archive = tempfile::Builder::new()
        .prefix("app-32-")
        .suffix(".7z")
        .tempfile_in(work)?;
    archive.write_all(&payload)?;
    archive.flush()?;
    drop(payload);

    progress(InstallStage::ExtractingArchive);
    let mut reader = ArchiveReader::open(archive.path(), Password::empty())?;
    let mut found = false;
    reader.for_each_entries_with_decision(|entry, input| {
        let name = entry.name.replace('\\', "/");
        if entry.is_directory || !name.to_ascii_lowercase().ends_with("resources/app.asar") {
            return Ok(EntryDecision::Continue);
        }

        let mut output = File::create(destination)?;
        let mut hasher = Sha256::new();
        let mut total = 0u64;
        let mut buffer = vec![0u8; 4 << 20];
        loop {
            let read = input.read(&mut buffer).map_err(sevenz_rust2::Error::from)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            output.write_all(&buffer[..read])?;
            total += read as u64;
        }
        output.sync_all()?;

        if total != ASAR_SIZE {
            return Err(sevenz_rust2::Error::Other(
                format!("app.asar size {total}, expected {ASAR_SIZE}").into(),
            ));
        }
        let digest = hex(&hasher.finalize());
        if digest != ASAR_SHA256 {
            return Err(sevenz_rust2::Error::Other(
                format!("app.asar SHA-256 {digest}, expected {ASAR_SHA256}").into(),
            ));
        }
        found = true;
        Ok(EntryDecision::Stop)
    })?;

    if !found {
        return Err(Error::message(
            "Zalo installer payload does not contain resources/app.asar",
        ));
    }
    progress(InstallStage::Verifying);
    Ok(destination.to_path_buf())
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
