//! Host-side platform state: Electron's `app.getPath` directories, the
//! electron-store JSON files, and the sandboxed file operations the official
//! preload exposed through `$znode.fs`/`$zFileManager`.
//!
//! Paths are real Windows paths. Olaz keeps its data in its own directory and
//! never touches the official client's `ZaloData`.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use base64::Engine;
use serde_json::{json, Map, Value};

use crate::crypto::CryptoState;

/// An error surfaced to the renderer. The text starts with a Node-style code
/// (`ENOENT: …`, `EACCES: …`) because `bridge.js` rebuilds `err.code` from it.
#[derive(Debug, Clone)]
pub struct HostError(pub String);

impl HostError {
    pub fn code(code: &str, detail: impl AsRef<str>) -> Self {
        Self(format!("{code}: {}", detail.as_ref()))
    }
}

impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<io::Error> for HostError {
    fn from(error: io::Error) -> Self {
        let code = match error.kind() {
            io::ErrorKind::NotFound => "ENOENT",
            io::ErrorKind::PermissionDenied => "EACCES",
            io::ErrorKind::AlreadyExists => "EEXIST",
            _ => "EIO",
        };
        Self(format!("{code}: {error}"))
    }
}

impl From<serde_json::Error> for HostError {
    fn from(error: serde_json::Error) -> Self {
        Self(format!("EINVAL: {error}"))
    }
}

pub type HostResult<T> = Result<T, HostError>;

/// Per-install directories and constants shared by every window.
#[derive(Clone)]
pub struct Platform {
    pub user_data: PathBuf,
    pub app_data: PathBuf,
    pub home: PathBuf,
    pub temp: PathBuf,
    pub downloads: PathBuf,
    pub desktop: PathBuf,
    pub documents: PathBuf,
    pub pictures: PathBuf,
    /// `<runtime>/current`, where `app.asar` lives (Electron's `app.getAppPath`).
    pub app_path: PathBuf,
    pub app_version: String,
    pub client_type: String,
    pub client_version: String,
}

impl Platform {
    pub fn new(app_path: PathBuf, app_version: &str, client_type: &str, client_version: &str) -> Self {
        let user_data = olaz_core::runtime::data_root().join("ZaloData");
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        let temp = std::env::temp_dir().join("Olaz");
        let downloads = dirs::download_dir().unwrap_or_else(|| home.join("Downloads"));
        let desktop = dirs::desktop_dir().unwrap_or_else(|| home.join("Desktop"));
        let documents = dirs::document_dir().unwrap_or_else(|| home.join("Documents"));
        let pictures = dirs::picture_dir().unwrap_or_else(|| home.join("Pictures"));
        for dir in [&user_data, &temp] {
            let _ = fs::create_dir_all(dir);
        }
        Self {
            app_data: user_data.clone(),
            user_data,
            home,
            temp,
            downloads,
            desktop,
            documents,
            pictures,
            app_path,
            app_version: app_version.to_string(),
            client_type: client_type.to_string(),
            client_version: client_version.to_string(),
        }
    }

    /// Electron `app.getPath(name)`.
    pub fn path(&self, name: &str) -> PathBuf {
        match name {
            "userData" | "appData" => self.user_data.clone(),
            "temp" => self.temp.clone(),
            "home" => self.home.clone(),
            "downloads" => self.downloads.clone(),
            "desktop" => self.desktop.clone(),
            "documents" => self.documents.clone(),
            "pictures" => self.pictures.clone(),
            "logs" => self.user_data.join("logs"),
            "exe" => std::env::current_exe().unwrap_or_else(|_| self.app_path.clone()),
            // `db` is the official data-access layer's database root. With the
            // IndexedDB backend it is never created, but report a sane path.
            "db" => self.user_data.join("db"),
            _ => self.user_data.clone(),
        }
    }

    pub fn store_path(&self, name: &str) -> PathBuf {
        let safe = name.replace('/', "_").replace('\\', "_").replace("..", "_");
        self.user_data.join(format!("{safe}.json"))
    }

    pub fn read_store(&self, name: &str) -> Value {
        let path = self.store_path(name);
        let mut value = fs::read(&path).ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| Value::Object(Map::new()));
        if name == "database-config" { normalize_database_config(&mut value); }
        value
    }

    pub fn write_store(&self, name: &str, value: &Value) -> HostResult<()> {
        let path = self.store_path(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut value = value.clone();
        if name == "database-config" { normalize_database_config(&mut value); }
        let bytes = serde_json::to_vec_pretty(&value)?;
        let temp = path.with_extension("json.tmp");
        fs::write(&temp, &bytes)?;
        fs::rename(&temp, &path)?;
        Ok(())
    }

    /// Node's `os` values consumed by `local-modules.js`.
    pub fn os_info(&self) -> Value {
        let hostname = hostname();
        let mut info = Map::new();
        info.insert("arch".into(), json!(std::env::consts::ARCH));
        info.insert("hostname".into(), json!(hostname));
        info.insert("homedir".into(), json!(path_string(&self.home)));
        info.insert("tmpdir".into(), json!(path_string(&self.temp)));
        info.insert("username".into(), json!(username()));
        info.insert("cpus".into(), json!(std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1)));
        info.insert("totalmem".into(), json!(0u64));
        info.insert("release".into(), json!(os_release()));
        info.insert("version".into(), json!(os_version()));
        info.insert("networkInterfaces".into(), json!("[]"));
        Value::Object(info)
    }

    /// `$znode.crypto.constants` (Node's RSA padding constants).
    pub fn crypto_constants(&self) -> Value {
        json!({
            "RSA_NO_PADDING": 3,
            "RSA_PKCS1_PADDING": 1,
            "RSA_PKCS1_OAEP_PADDING": 4,
            "RSA_PKCS1_PSS_PADDING": 6,
            "RSA_PSS_SALTLEN_DIGEST": -1,
            "RSA_PSS_SALTLEN_MAX_SIGN": -2,
            "RSA_PSS_SALTLEN_AUTO": -2,
        })
    }

    /// Lexical, case-insensitive containment check used for writes.
    pub fn is_writable(&self, path: &str) -> bool {
        let candidate = normalize_path(&self.user_data.join(path));
        let candidate = path_key(&candidate);
        for root in [&self.user_data, &self.temp, &self.downloads] {
            let root = path_key(&normalize_path(root));
            if candidate == root || candidate.starts_with(&(root.clone() + &separator().to_string())) {
                return true;
            }
        }
        false
    }

    // ---- fs operations -------------------------------------------------

    pub fn stat(&self, path: &str, follow: bool) -> HostResult<Value> {
        let meta = if follow {
            fs::metadata(path).map_err(|e| missing(e, path))?
        } else {
            fs::symlink_metadata(path).map_err(|e| missing(e, path))?
        };
        let file_type = meta.file_type();
        let mtime = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let created = meta
            .created()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let mode = if file_type.is_file() { 0o100666 } else if file_type.is_dir() { 0o040777 } else { 0o120777 };
        Ok(json!({
            "__stats": true,
            "size": meta.len(),
            "mode": mode,
            "mtimeMs": mtime,
            "ctimeMs": mtime,
            "atimeMs": mtime,
            "birthtimeMs": created,
            "mtime": mtime,
            "isFile": file_type.is_file(),
            "isDirectory": file_type.is_dir(),
            "isSymbolicLink": file_type.is_symlink(),
        }))
    }

    pub fn exists(&self, path: &str) -> bool {
        Path::new(path).exists()
    }

    pub fn read_dir(&self, path: &str) -> HostResult<Value> {
        let mut names = Vec::new();
        for entry in fs::read_dir(path).map_err(|e| missing(e, path))? {
            let entry = entry.map_err(HostError::from)?;
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
        names.sort();
        Ok(Value::Array(names.into_iter().map(Value::String).collect()))
    }

    pub fn mkdir(&self, path: &str, recursive: bool) -> HostResult<()> {
        let target = Path::new(path);
        if target.is_dir() {
            return Ok(());
        }
        if recursive {
            fs::create_dir_all(self.writable(path)?)?;
        } else {
            fs::create_dir(self.writable(path)?)?;
        }
        Ok(())
    }

    pub fn unlink(&self, path: &str) -> HostResult<()> {
        let target = Path::new(path);
        match fs::symlink_metadata(target) {
            Ok(meta) if meta.is_dir() => fs::remove_dir(target).map_err(HostError::from),
            Ok(_) => fs::remove_file(target).map_err(HostError::from),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(HostError::from(error)),
        }
    }

    pub fn remove_all(&self, path: &str) -> HostResult<()> {
        let target = Path::new(path);
        match fs::symlink_metadata(target) {
            Ok(meta) if meta.is_dir() => fs::remove_dir_all(target).map_err(HostError::from),
            Ok(_) => fs::remove_file(target).map_err(HostError::from),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(HostError::from(error)),
        }
    }

    pub fn rename(&self, from: &str, to: &str) -> HostResult<()> {
        let to = self.writable(to)?;
        if Path::new(&to).exists() {
            self.remove_all(&to)?;
        }
        if let Some(parent) = Path::new(&to).parent() {
            fs::create_dir_all(parent)?;
        }
        match fs::rename(from, &to) {
            Ok(()) => Ok(()),
            Err(_) => {
                self.copy(from, &to)?;
                self.remove_all(from)
            }
        }
    }

    pub fn copy(&self, from: &str, to: &str) -> HostResult<()> {
        let to = self.writable(to)?;
        let source = Path::new(from);
        let meta = fs::symlink_metadata(source).map_err(|e| missing(e, from))?;
        let _ = fs::symlink_metadata(&to).map(|existing| {
            if existing.is_dir() {
                let _ = fs::remove_dir_all(&to);
            } else {
                let _ = fs::remove_file(&to);
            }
        });
        if meta.is_dir() {
            copy_dir(source, Path::new(&to))?;
        } else {
            if let Some(parent) = Path::new(&to).parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(source, &to)?;
        }
        Ok(())
    }

    pub fn read_file(&self, path: &str) -> HostResult<Vec<u8>> {
        fs::read(path).map_err(|e| missing(e, path))
    }

    pub fn write_file(&self, path: &str, bytes: &[u8]) -> HostResult<()> {
        let target = self.writable(path)?;
        if let Some(parent) = Path::new(&target).parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&target, bytes)?;
        Ok(())
    }

    pub fn append_file(&self, path: &str, bytes: &[u8]) -> HostResult<()> {
        use std::io::Write;
        let target = self.writable(path)?;
        if let Some(parent) = Path::new(&target).parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = fs::OpenOptions::new().create(true).append(true).open(&target)?;
        file.write_all(bytes)?;
        Ok(())
    }

    fn writable(&self, path: &str) -> HostResult<String> {
        if self.is_writable(path) {
            Ok(path.to_string())
        } else {
            Err(HostError::code("EACCES", path))
        }
    }
}

fn missing(error: io::Error, path: &str) -> HostError {
    if error.kind() == io::ErrorKind::NotFound {
        HostError::code("ENOENT", path)
    } else {
        HostError::from(error)
    }
}

fn copy_dir(from: &Path, to: &Path) -> HostResult<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let source = entry.path();
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&source, &target)?;
        } else {
            fs::copy(&source, &target)?;
        }
    }
    Ok(())
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(windows)]
fn path_key(path: &Path) -> String {
    path.to_string_lossy().replace('/', "\\").to_lowercase()
}

#[cfg(not(windows))]
fn path_key(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

pub fn separator() -> char {
    std::path::MAIN_SEPARATOR
}

pub fn path_string(path: &Path) -> String {
    let text = path.to_string_lossy().into_owned();
    #[cfg(not(windows))]
    if text.starts_with('/') {
        // The Edge harness runs Windows renderer code, including drive-letter
        // parsing. Give Linux-backed files a reversible Windows-shaped path.
        return format!("C:\\__olaz_wsl__{}", text.replace('/', "\\"));
    }
    text
}

/// Reverse only our synthetic WSL prefix; ordinary strings and Windows builds
/// are untouched. File operations still run through the usual write sandbox.
pub fn host_arguments(args: &[Value]) -> Vec<Value> {
    fn translate(value: &Value) -> Value {
        match value {
            #[cfg(not(windows))]
            Value::String(text) if text.starts_with("C:\\__olaz_wsl__\\") =>
                json!(text.trim_start_matches("C:\\__olaz_wsl__").replace('\\', "/")),
            Value::Array(items) => Value::Array(items.iter().map(translate).collect()),
            Value::Object(map) => Value::Object(map.iter().map(|(key, value)| (key.clone(), translate(value))).collect()),
            _ => value.clone(),
        }
    }
    args.iter().map(translate).collect()
}

/// The MVP has no SQLite/DAL backend. The official renderer defaults new
/// accounts to SQLite even when `sqlite-available` is false. Keep the persisted
/// adapter selectors on IDB, as the macOS IndexedDB host does, without touching
/// unrelated settings or database contents.
fn normalize_database_config(value: &mut Value) {
    let Some(store) = value.as_object_mut() else { return };
    store.entry("sh_adp-st").or_insert_with(|| json!("{\"shared\":0}"));
    store.retain(|key, _| !key.to_ascii_lowercase().contains("upgraderequired"));
    for (key, value) in store.iter_mut() {
        if !key.ends_with("adp-st") { continue; }
        let Some(text) = value.as_str() else { continue };
        let Ok(Value::Object(mut states)) = serde_json::from_str::<Value>(text) else { continue };
        for state in states.values_mut() { *state = json!(0); }
        *value = json!(Value::Object(states).to_string());
    }
}

#[cfg(test)]
mod database_config_tests {
    use super::*;

    #[cfg(not(windows))]
    #[test]
    fn harness_paths_round_trip() {
        let rendered = path_string(Path::new("/home/test/Olaz/file.txt"));
        assert!(rendered.starts_with("C:\\"));
        assert_eq!(host_arguments(&[json!(rendered)]), vec![json!("/home/test/Olaz/file.txt")]);
        assert_eq!(host_arguments(&[json!("ordinary data")]), vec![json!("ordinary data")]);
    }

    #[test]
    fn keeps_accounts_on_idb_and_preserves_other_settings() {
        let mut value = json!({
            "sh_adp-st": "{\"shared\":1,\"test-user\":1}",
            "upgradeRequired": true,
            "other": "unchanged"
        });
        normalize_database_config(&mut value);
        assert_eq!(serde_json::from_str::<Value>(value["sh_adp-st"].as_str().unwrap()).unwrap(), json!({"shared":0,"test-user":0}));
        assert!(value.get("upgradeRequired").is_none());
        assert_eq!(value["other"], "unchanged");
    }
}

fn hostname() -> String {
    if let Ok(name) = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")) {
        if !name.trim().is_empty() {
            return name;
        }
    }
    // `HOSTNAME` is a bash variable in WSL, not always exported to children.
    #[cfg(not(windows))]
    if let Ok(name) = std::fs::read_to_string("/etc/hostname") {
        let name = name.trim();
        if !name.is_empty() {
            return name.to_string();
        }
    }
    "Olaz".to_string()
}

fn username() -> String {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_default()
}

#[cfg(windows)]
fn os_release() -> String {
    "10.0.26100".to_string()
}

#[cfg(not(windows))]
fn os_release() -> String {
    "6.0.0".to_string()
}

#[cfg(windows)]
fn os_version() -> String {
    "Windows 11".to_string()
}

#[cfg(not(windows))]
fn os_version() -> String {
    "Linux".to_string()
}

// ---- crypto state shared by synchronous bridge calls -------------------

/// The synchronous bridge host. Only calls that must not go through the
/// WebView2 event loop (Node crypto, electron-store, clipboard) are answered
/// here; the HTTP server thread owns it.
pub struct SyncHost {
    pub platform: Platform,
    pub crypto: std::sync::Mutex<CryptoState>,
}

impl SyncHost {
    pub fn new(platform: Platform) -> Self {
        Self {
            platform,
            crypto: std::sync::Mutex::new(CryptoState::default()),
        }
    }

    /// Handles a JSON sync request (`{path}|{channel, args}`) and returns the
    /// JSON response body.
    pub fn handle(&self, body: &[u8]) -> Vec<u8> {
        let mut response = Map::new();
        let request: Value = match serde_json::from_slice(body) {
            Ok(value) => value,
            Err(error) => {
                response.insert("error".into(), json!(format!("bad sync request: {error}")));
                return serde_json::to_vec(&Value::Object(response)).unwrap_or_else(|_| b"{}".to_vec());
            }
        };
        let args = request.get("args").and_then(Value::as_array).cloned().unwrap_or_default();
        let key = request
            .get("path")
            .and_then(Value::as_str)
            .map(|path| path.to_string())
            .or_else(|| request.get("channel").and_then(Value::as_str).map(|c| format!("ipc:{c}")));
        let Some(key) = key else {
            response.insert("error".into(), json!("bad sync request"));
            return serde_json::to_vec(&Value::Object(response)).unwrap_or_else(|_| b"{}".to_vec());
        };
        tracing::debug!("sync start: {key}");
        let result = self.dispatch_sync(&key, &args);
        match result {
            Ok(value) => {
                tracing::debug!("sync ok: {key}");
                response.insert("value".into(), value);
            }
            Err(error) => {
                tracing::debug!("sync {key} failed: {error}");
                response.insert("error".into(), json!(error.0));
            }
        }
        serde_json::to_vec(&Value::Object(response)).unwrap_or_else(|_| b"{}".to_vec())
    }

    fn dispatch_sync(&self, key: &str, args: &[Value]) -> HostResult<Value> {
        let p = &self.platform;
        // `REQUEST_SYNC` members arrive as IPC channels, i.e. `ipc:<channel>`;
        // preload-local sync members arrive as their bridge path. Both share
        // the same handler space here.
        let key = key.strip_prefix("ipc:").unwrap_or(key);
        match key {
            // App paths and Electron store handshakes (REQUEST_SYNC members).
            "_electron_get-path-sync" => {
                let name = str_arg(args, 0).unwrap_or("userData");
                Ok(json!(path_string(&p.path(name))))
            }
            "_electron_get-app-path-sync" => Ok(json!(path_string(&p.app_path))),
            "_electron_get-info-screen-of-mouse-sync" => Ok(json!({ "x": 0, "y": 0 })),
            "electron-store-get-data" => Ok(json!({
                "defaultCwd": path_string(&p.user_data),
                "appVersion": p.app_version,
            })),
            // Everything else is shared with the asynchronous bridge.
            _ => crate::local::dispatch(p, &self.crypto, key, args),
        }
    }
}

pub fn str_arg(args: &[Value], index: usize) -> Option<&str> {
    args.get(index).and_then(Value::as_str)
}

pub fn int_arg(args: &[Value], index: usize) -> Option<i64> {
    args.get(index).and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_f64().map(|f| f as i64))
    })
}

pub fn bool_arg(args: &[Value], index: usize) -> Option<bool> {
    args.get(index).and_then(Value::as_bool)
}

/// Decodes `{__bytes: base64}` as produced by `bridge.js`.
pub fn bytes_at(args: &[Value], index: usize) -> Option<Vec<u8>> {
    let value = args.get(index)?;
    let mut map = HashMap::new();
    if let Value::Object(obj) = value {
        if let Some(encoded) = obj.get("__bytes").and_then(Value::as_str) {
            map.insert("bytes", encoded.to_string());
        }
    }
    map.get("bytes").and_then(|encoded| {
        base64::engine::general_purpose::STANDARD
            .decode(encoded.as_bytes())
            .ok()
    })
}
