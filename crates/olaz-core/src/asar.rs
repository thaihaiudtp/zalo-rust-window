//! Read-only access to an Electron `app.asar` archive.
//!
//! Olaz never redistributes VNG's code. It reads the official renderer
//! (`pc-dist/…`) directly from the `app.asar` embedded in the official Zalo PC
//! installer, so the protocol, crypto and sync logic remain Zalo's own.
//!
//! Layout: `[u32 4][u32 header_pickle_size]` then a pickle
//! `[u32 payload][u32 json_len][json]`. File offsets in `json` are relative to
//! `8 + header_pickle_size`. Entries flagged `unpacked` live beside the archive
//! in `app.asar.unpacked/`.

use std::collections::HashMap;
use std::fs::File;
use std::path::{Path, PathBuf};

use memmap2::{Mmap, MmapOptions};
use serde_json::Value;

use crate::error::{Error, Result};

/// One file inside an ASAR archive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// Offset from the start of the archive's data section.
    pub offset: u64,
    /// Size in bytes.
    pub size: u64,
    /// Whether the bytes live in `app.asar.unpacked/` instead.
    pub unpacked: bool,
}

/// Memory-mapped, read-only ASAR archive.
pub struct AsarArchive {
    path: PathBuf,
    mmap: Mmap,
    base: u64,
    entries: HashMap<String, Entry>,
}

impl std::fmt::Debug for AsarArchive {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AsarArchive")
            .field("path", &self.path)
            .field("entries", &self.entries.len())
            .finish_non_exhaustive()
    }
}

impl AsarArchive {
    /// Opens and indexes an archive.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        let file = File::open(&path)?;
        // The mapping is read-only; the file is not mutated while the app runs.
        let mmap = unsafe { MmapOptions::new().map(&file)? };
        Self::from_mmap(path, mmap)
    }

    fn from_mmap(path: PathBuf, mmap: Mmap) -> Result<Self> {
        if mmap.len() < 16 || u32::from_le_bytes(mmap[0..4].try_into().unwrap()) != 4 {
            return Err(Error::Asar("bad header prefix".into()));
        }
        let header_pickle_size = u32::from_le_bytes(mmap[4..8].try_into().unwrap()) as u64;
        let json_len = u32::from_le_bytes(mmap[12..16].try_into().unwrap()) as u64;
        let json_start = 16usize;
        let json_end = json_start
            .checked_add(json_len as usize)
            .filter(|end| *end <= mmap.len())
            .ok_or_else(|| Error::Asar("header JSON runs past end of file".into()))?;

        let root: Value = serde_json::from_slice(&mmap[json_start..json_end])?;
        let mut entries = HashMap::new();
        index_node(&root, "", &mut entries);

        Ok(Self {
            path,
            mmap,
            base: 8 + header_pickle_size,
            entries,
        })
    }

    /// Path of the archive on disk.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Number of indexed files.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the archive contains no files.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Metadata for `path` (leading slashes and percent-encoding are ignored).
    pub fn entry(&self, path: &str) -> Option<&Entry> {
        self.entries.get(&normalize(path))
    }

    /// Whether `path` exists.
    pub fn contains(&self, path: &str) -> bool {
        self.entry(path).is_some()
    }

    /// Reads a file. Returns `Ok(None)` when the path is not in the archive or
    /// when an unpacked file is absent from `app.asar.unpacked/`.
    pub fn read(&self, path: &str) -> Result<Option<Vec<u8>>> {
        let key = normalize(path);
        let Some(entry) = self.entries.get(&key) else {
            return Ok(None);
        };

        if entry.unpacked {
            let Some(parent) = self.path.parent() else {
                return Ok(None);
            };
            let unpacked = parent.join("app.asar.unpacked").join(&key);
            return match std::fs::read(unpacked) {
                Ok(bytes) => Ok(Some(bytes)),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(error) => Err(error.into()),
            };
        }

        let start = self
            .base
            .checked_add(entry.offset)
            .ok_or_else(|| Error::Asar("entry offset overflow".into()))? as usize;
        let end = start
            .checked_add(entry.size as usize)
            .filter(|end| *end <= self.mmap.len())
            .ok_or_else(|| Error::Asar(format!("entry {key} runs past end of file")))?;
        Ok(Some(self.mmap[start..end].to_vec()))
    }

    /// Reads a file as UTF-8 text.
    pub fn read_to_string(&self, path: &str) -> Result<Option<String>> {
        Ok(self
            .read(path)?
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned()))
    }

    /// Every file path, sorted.
    pub fn paths(&self) -> Vec<&str> {
        let mut paths: Vec<_> = self.entries.keys().map(String::as_str).collect();
        paths.sort_unstable();
        paths
    }

    /// File paths starting with `prefix`, sorted.
    pub fn paths_with_prefix<'a>(&'a self, prefix: &str) -> Vec<&'a str> {
        let prefix = normalize(prefix);
        let mut paths: Vec<_> = self
            .entries
            .keys()
            .filter(|path| path.starts_with(&prefix))
            .map(String::as_str)
            .collect();
        paths.sort_unstable();
        paths
    }
}

fn index_node(node: &Value, prefix: &str, entries: &mut HashMap<String, Entry>) {
    let Some(files) = node.get("files").and_then(Value::as_object) else {
        return;
    };
    for (name, child) in files {
        let Some(child) = child.as_object() else {
            continue;
        };
        let path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if child.contains_key("files") {
            index_node(&Value::Object(child.clone()), &path, entries);
            continue;
        }
        let Some(size) = child.get("size").and_then(Value::as_u64) else {
            continue;
        };
        let offset = child
            .get("offset")
            .and_then(Value::as_str)
            .and_then(|value| value.parse().ok())
            .unwrap_or(0);
        let unpacked = child
            .get("unpacked")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        entries.insert(
            path,
            Entry {
                offset,
                size,
                unpacked,
            },
        );
    }
}

fn normalize(path: &str) -> String {
    let decoded = percent_encoding::percent_decode_str(path)
        .decode_utf8_lossy()
        .into_owned();
    decoded.trim_start_matches('/').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_strips_leading_slashes_and_decodes() {
        assert_eq!(normalize("/pc-dist/a%20b.js"), "pc-dist/a b.js");
        assert_eq!(normalize("pc-dist/a.js"), "pc-dist/a.js");
    }
}
