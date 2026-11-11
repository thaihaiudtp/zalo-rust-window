//! Preload-local bridge members: the parts of `$znode`/`$zFileManager` that
//! Electron implemented in JavaScript or native addons without touching the
//! main process. Both the asynchronous WebView2 bridge and the blocking
//! `/__olaz/bridge-sync` endpoint call these handlers.

use std::sync::Mutex;

use serde_json::{json, Map, Value};

use crate::crypto::{self, CryptoState};
use crate::platform::{int_arg, path_string, str_arg, HostError, HostResult, Platform};

pub fn dispatch(
    platform: &Platform,
    state: &Mutex<CryptoState>,
    key: &str,
    args: &[Value],
) -> HostResult<Value> {
    let p = platform;
    match key {
        // electron-store backing for local-modules.js
        "$zelectron.storePath" => Ok(json!(path_string(
            &p.store_path(str_arg(args, 0).unwrap_or("config"))
        ))),
        "$zelectron.storeRead" => Ok(p.read_store(str_arg(args, 0).unwrap_or("config"))),
        "$zelectron.storeWrite" => {
            let name = str_arg(args, 0).unwrap_or("config");
            let value = args
                .get(1)
                .cloned()
                .unwrap_or_else(|| Value::Object(Map::new()));
            p.write_store(name, &value)?;
            Ok(undefined())
        }

        // Clipboard (local-modules.js keeps the in-page variants; these are the
        // synchronous fallbacks).
        "$zelectronNative.clipboardText" => Ok(json!("")),
        "$zelectronNative.clipboardWriteText" => Ok(undefined()),
        "$zelectronNative.clipboardFormats" => Ok(json!([])),

        // ---- Node crypto -------------------------------------------------
        "$znode.crypto.encrypt" => crypto::one_shot(true, args),
        "$znode.crypto.decrypt" => crypto::one_shot(false, args),
        "$znode.crypto.hash" => {
            let data = crypto::bytes_value(args.first(), str_arg(args, 2))?;
            let digest = crypto::digest(str_arg(args, 1).unwrap_or("sha256"), &data)?;
            Ok(crypto::encode_bytes(&digest, str_arg(args, 3), false))
        }
        "$znode.crypto.randomBytes" => {
            let len = int_arg(args, 0).unwrap_or(0).max(0) as usize;
            let mut bytes = vec![0u8; len];
            getrandom::getrandom(&mut bytes)
                .map_err(|e| HostError(format!("EIO: random bytes: {e}")))?;
            Ok(crypto::encode_bytes(&bytes, None, true))
        }
        "$znode.crypto.__cipherCreate" => crypto::cipher_create(state, args),
        "$znode.crypto.__cipherUpdate" => crypto::cipher_update(state, args),
        "$znode.crypto.__cipherFinal" => crypto::cipher_final(state, args),
        "$znode.crypto.__cipherOption" => crypto::cipher_option(state, args),
        "$znode.crypto.__hashCreate" => crypto::hash_create(state, args),
        "$znode.crypto.__hashUpdate" => crypto::hash_update(state, args),
        "$znode.crypto.__hashDigest" => crypto::hash_digest(state, args),
        "$znode.crypto.publicEncrypt"
        | "$znode.crypto.privateDecrypt"
        | "$znode.crypto.generateKeyPairSync" => Err(HostError(
            "ENOTSUP: RSA is not implemented".into(),
        )),

        // ---- Node fs -----------------------------------------------------
        "$znode.fs.stat" | "$znode.fs.statSync" | "$znode.fsExtra.statSync" => {
            p.stat(str_arg(args, 0).unwrap_or(""), true)
        }
        "$znode.fs.lstat" | "$znode.fsPromise.lstat" => {
            p.stat(str_arg(args, 0).unwrap_or(""), false)
        }
        "$znode.fs.exists" | "$znode.fs.existsSync" | "$znode.fsExtra.existsSync" => {
            Ok(json!(p.exists(str_arg(args, 0).unwrap_or(""))))
        }
        "$znode.fsExtra.pathExists" => Ok(json!(p.exists(str_arg(args, 0).unwrap_or("")))),
        "$znode.fs.access" | "$znode.fs.accessSync" | "$znode.fsPromise.access" => {
            let path = str_arg(args, 0).unwrap_or("");
            if p.exists(path) {
                Ok(undefined())
            } else {
                Err(HostError::code("ENOENT", path))
            }
        }
        "$znode.fs.mkdir" | "$znode.fs.mkdirSync" | "$znode.fsPromise.mkdir" => {
            p.mkdir(str_arg(args, 0).unwrap_or(""), recursive_arg(args, 1))?;
            Ok(undefined())
        }
        "$znode.fsExtra.ensureDir" | "$znode.fsExtra.ensureDirSync" => {
            p.mkdir(str_arg(args, 0).unwrap_or(""), true)?;
            Ok(undefined())
        }
        "$znode.fs.unlink"
        | "$znode.fs.unlinkSync"
        | "$znode.fsPromise.unlink" => {
            p.unlink(str_arg(args, 0).unwrap_or(""))?;
            Ok(undefined())
        }
        "$znode.fs.rmdir"
        | "$znode.fsPromise.rmdir"
        | "$znode.fsPromise.rm"
        | "$znode.fsExtra.remove"
        | "$znode.fsExtra.removeSync"
        | "$znode.rimraf" => {
            p.remove_all(str_arg(args, 0).unwrap_or(""))?;
            Ok(undefined())
        }
        "$znode.fs.readdir" | "$znode.fs.readdirSync" | "$znode.fsPromise.readdir" => {
            p.read_dir(str_arg(args, 0).unwrap_or(""))
        }
        "$znode.fsExtra.rename"
        | "$znode.fsExtra.renameSync"
        | "$znode.fsExtra.move" => {
            p.rename(
                str_arg(args, 0).unwrap_or(""),
                str_arg(args, 1).unwrap_or(""),
            )?;
            Ok(undefined())
        }
        "$znode.fsExtra.copy" | "$znode.fsExtra.copySync" => {
            p.copy(
                str_arg(args, 0).unwrap_or(""),
                str_arg(args, 1).unwrap_or(""),
            )?;
            Ok(undefined())
        }
        "$znode.fs.link" | "$znode.fsPromise.link" => {
            let from = str_arg(args, 0).unwrap_or("");
            let to = str_arg(args, 1).unwrap_or("");
            p.link(from, to)?;
            Ok(undefined())
        }
        "$znode.fs.readFile" => {
            let bytes = p.read_file(str_arg(args, 0).unwrap_or(""))?;
            let encoding = str_arg(args, 1).or_else(|| {
                args.get(1)
                    .and_then(Value::as_object)
                    .and_then(|map| map.get("encoding"))
                    .and_then(Value::as_str)
            });
            match encoding {
                Some(encoding) => Ok(crypto::encode_bytes(&bytes, Some(encoding), false)),
                None => Ok(crypto::encode_bytes(&bytes, None, false)),
            }
        }
        "$znode.fs.writeFile" => {
            let bytes = crypto::bytes_value(args.get(1), None)?;
            p.write_file(str_arg(args, 0).unwrap_or(""), &bytes)?;
            Ok(undefined())
        }
        "$znode.fs.readFileSync" => {
            let bytes = p.read_file(str_arg(args, 0).unwrap_or(""))?;
            let encoding = str_arg(args, 1).or_else(|| {
                args.get(1)
                    .and_then(Value::as_object)
                    .and_then(|map| map.get("encoding"))
                    .and_then(Value::as_str)
            });
            Ok(crypto::encode_bytes(&bytes, encoding, false))
        }
        "$znode.fs.writeFileSync" => {
            let bytes = crypto::bytes_value(args.get(1), None)?;
            p.write_file(str_arg(args, 0).unwrap_or(""), &bytes)?;
            Ok(undefined())
        }

        // ---- Misc Node members ------------------------------------------
        "$znode.diskSpace" => disk_usage(p, str_arg(args, 0)),
        "$znode.fastGlob" | "$znode.admzip" => Ok(undefined()),
        "$znode.shell.openPath" => Ok(json!("")),
        "$znode.shell.showItemInFolder" => Ok(undefined()),
        "$znode.child_process.spawn"
        | "$znode.child_process.exec"
        | "$znode.child_process.execSync" => Err(HostError(
            "EPERM: child_process is not available".into(),
        )),
        "$znode.zlib.gzip" => Err(HostError("ENOTSUP: zlib is not implemented".into())),
        "$znode.unusedFilename.async" | "$znode.unusedFilename.sync" => Ok(undefined()),
        "$znode.progressStream" => Ok(undefined()),

        // ---- native addons ----------------------------------------------
        "$znode.nativelibs.fileUtilitiesAddon.detectFilesystemAsync"
        | "$znode.nativelibs.fileUtilitiesAddon.detectFilesystemSync" => {
            Ok(json!({ "filesystemType": "NTFS" }))
        }
        "$znode.nativelibs.fileUtilitiesAddon.detectHardlinksAsync" => Ok(json!([])),
        "$znode.nativelibs.fileUtilsAddon.getDiskUsage" => disk_usage(p, str_arg(args, 0)),
        key if key.starts_with("$znode.nativelibs.") => Ok(undefined()),

        // ---- $zFileManager (preload-local file helpers) ------------------
        "$zFileManager.getSentryConfig" => Ok(Value::Null),
        "$zFileManager.saveSentryConfig" => Ok(undefined()),
        "$zFileManager.getViewerkey" => {
            let directory = str_arg(args, 0).unwrap_or_else(|| {
                // Keep the borrow local: this value is only used as a path.
                ""
            });
            let file = if directory.is_empty() {
                p.user_data.join("z_u.txt")
            } else {
                p.resolve_path(directory)?.join("z_u.txt")
            };
            let bytes = std::fs::read(&file)
                .map_err(|_| HostError("ENOENT: z_u.txt not found".into()))?;
            Ok(Value::String(String::from_utf8_lossy(&bytes).into_owned()))
        }
        "$zFileManager.writeRecentId" => {
            let text = str_arg(args, 0).unwrap_or("");
            p.write_file(
                &path_string(&p.user_data.join("z_u.txt")),
                text.as_bytes(),
            )?;
            Ok(undefined())
        }
        "$zFileManager.writeZLog" | "$zFileManager.writeZLogBetween" => {
            let name = str_arg(args, 0).unwrap_or("z.log");
            let directory = p.user_data.join("cal");
            let _ = std::fs::create_dir_all(&directory);
            let file = directory.join(log_basename(name)?);
            let bytes = crypto::bytes_value(args.get(1), None)?;
            let overwrite = args
                .get(2)
                .and_then(Value::as_object)
                .and_then(|map| map.get("overwrite"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if overwrite || !file.exists() {
                std::fs::write(&file, bytes).map_err(HostError::from)?;
            } else {
                use std::io::Write;
                let mut handle = std::fs::OpenOptions::new()
                    .append(true)
                    .open(&file)
                    .map_err(HostError::from)?;
                handle.write_all(&bytes).map_err(HostError::from)?;
            }
            Ok(undefined())
        }
        "$zFileManager.readZLog" => {
            let directory = p.user_data.join("cal");
            let name = str_arg(args, 0).unwrap_or("");
            let file = directory.join(log_basename(name)?);
            match std::fs::read(&file) {
                Ok(bytes) => Ok(Value::String(String::from_utf8_lossy(&bytes).into_owned())),
                Err(_) => Ok(Value::Null),
            }
        }
        "$zFileManager.scandirLog" => {
            let directory = p.user_data.join("cal");
            let mut names = Vec::new();
            if let Ok(entries) = std::fs::read_dir(directory) {
                for entry in entries.flatten() {
                    names.push(Value::String(
                        entry.file_name().to_string_lossy().into_owned(),
                    ));
                }
            }
            Ok(Value::Array(names))
        }
        "$zFileManager.getExtraLogFiles" | "$zFileManager.probeCalfLogs" => Ok(json!([])),
        "$zFileManager.getQosLog"
        | "$zFileManager.getActionLog"
        | "$zFileManager.readUptimeLog" => Ok(json!("")),
        "$zFileManager.removeQosLog"
        | "$zFileManager.removeActionLog"
        | "$zFileManager.writeActionLog"
        | "$zFileManager.writeUptimeLog"
        | "$zFileManager.truncateFileUpto"
        | "$zFileManager.cleanupLogFileDescriptors"
        | "$zFileManager.initBinaryLogFile"
        | "$zFileManager.sealCalfLog"
        | "$zFileManager.mergeCalfLogGroup"
        | "$zFileManager.writeLogRange"
        | "$zFileManager.trustBlob"
        | "$zFileManager.cleanupBackupDir"
        | "$zFileManager.cleanConvResourcePhoto"
        | "$zFileManager.removeOutputZipTemp"
        | "$zFileManager.removeDBBackupFile"
        | "$zFileManager.achiveBackupFile"
        | "$zFileManager.renameExportZipFile"
        | "$zFileManager.copyBUResourceToApp"
        | "$zFileManager.extractBackupFile"
        | "$zFileManager.writeSync2BackupData"
        | "$zFileManager.setupWriteStreamBackup"
        | "$zFileManager.removeTempBUFolder" => Ok(undefined()),
        "$zFileManager.getInstallSource" => Err(HostError("ENOENT: install source".into())),
        "$zFileManager.getFileArrayBuffer" => {
            let bytes = p.read_file(str_arg(args, 0).unwrap_or(""))?;
            Ok(crypto::encode_bytes(&bytes, None, true))
        }
        "$zFileManager.readFileAsync" => {
            let bytes = p.read_file(str_arg(args, 0).unwrap_or(""))?;
            if str_arg(args, 1).is_some() {
                Ok(Value::String(String::from_utf8_lossy(&bytes).into_owned()))
            } else {
                Ok(crypto::encode_bytes(&bytes, None, false))
            }
        }
        "$zFileManager.svcStatAsync" => {
            let stat = p.stat(str_arg(args, 0).unwrap_or(""), true)?;
            Ok(json!({ "size": stat["size"] }))
        }
        "$zFileManager.writeBufferToPath" | "$zFileManager.writeBlobToPath" => {
            let bytes = crypto::bytes_value(args.get(1), None)?;
            p.write_file(str_arg(args, 0).unwrap_or(""), &bytes)?;
            Ok(json!(true))
        }
        "$zFileManager.appendBufferToPath" => {
            let bytes = crypto::bytes_value(args.get(1), None)?;
            p.append_file(str_arg(args, 0).unwrap_or(""), &bytes)?;
            Ok(json!(true))
        }
        "$zFileManager.getDefaultExportFolder" => Ok(json!(path_string(&p.downloads))),
        "$zFileManager.pickExportFolder" | "$zFileManager.pickBackupFile" => {
            Ok(json!(path_string(&p.user_data)))
        }
        "$zFileManager.getSync2BackupRootDir" => {
            let directory = p.user_data.join("sync2-backup");
            let _ = std::fs::create_dir_all(&directory);
            Ok(json!(path_string(&directory)))
        }
        "$zFileManager.getSync2BackupFilePath" | "$zFileManager.createSync2BackupFilePath" => {
            let directory = p.user_data.join("sync2-backup");
            let _ = std::fs::create_dir_all(&directory);
            Ok(json!(path_string(&directory)))
        }
        "$zFileManager.createSync2BackupDir" | "$zFileManager.initTempDBFolderPath" => {
            let directory = p.user_data.join("tempdb");
            let _ = std::fs::create_dir_all(&directory);
            Ok(json!(path_string(&directory)))
        }
        "$zFileManager.createTempDBFolder" => {
            let directory = p.user_data.join("tempdb");
            let _ = std::fs::create_dir_all(&directory);
            Ok(undefined())
        }
        "$zFileManager.removeTempDBFolder" => {
            let directory = p.user_data.join("tempdb");
            let _ = std::fs::remove_dir_all(directory);
            Ok(undefined())
        }
        "$zFileManager.testChecksum" => Ok(json!(true)),
        "$zFileManager.getPartialFingerprint" | "$zFileManager.readChunksArrayObject" => {
            Ok(json!([]))
        }
        "$zFileManager.getPhotoWithPaths" | "$zFileManager.readBackUpData" => Ok(Value::Null),
        "$zFileManager.readCalfActiveCompressed" => Ok(Value::Null),
        "$zFileManager.getMd5LargeFileObject" => {
            let path = str_arg(args, 0).unwrap_or("");
            let bytes = p.read_file(path)?;
            let digest = crypto::digest("md5", &bytes)?;
            Ok(json!({
                "md5": crypto::encode_bytes(&digest, Some("hex"), false),
                "size": bytes.len(),
            }))
        }
        "$zFileManager.getFileBlob"
        | "$zFileManager.getFileBlobURL"
        | "$zFileManager.getFileInZip" => Ok(undefined()),
        key if key.starts_with("$zFileManager.") => Ok(undefined()),

        key if key.starts_with("$zpc.") => Ok(undefined()),
        key if key.starts_with("$znode.") => Ok(undefined()),
        _ => Err(HostError(format!("ENOTSUP: unknown local member {key}"))),
    }
}

fn disk_usage(platform: &Platform, requested: Option<&str>) -> HostResult<Value> {
    let mut path = match requested {
        Some(p) if p.len() <= 3 && p.as_bytes().get(1) == Some(&b':') => {
            #[cfg(not(windows))]
            { platform.user_data.clone() }
            #[cfg(windows)]
            { platform.resolve_path(&format!("{}\\", &p[..2]))? }
        }
        Some(p) => platform.resolve_path(p)?,
        None => platform.user_data.clone(),
    };
    // The synthetic C: drive of the WSL development harness is backed by the
    // host's data filesystem, not a Windows volume mounted in the renderer.
    while !path.exists() && path.parent().is_some() { path.pop(); }
    let total = fs2::total_space(&path)?;
    let free = fs2::free_space(&path)?;
    let available = fs2::available_space(&path)?;
    Ok(json!({"total": total, "free": free, "available": available, "used": total.saturating_sub(free)}))
}

fn log_basename(name: &str) -> HostResult<&str> {
    let basename = name.rsplit(['/', '\\']).next().unwrap_or("");
    if matches!(basename, "" | "." | "..") || basename.contains('\0') || basename.contains(':') {
        return Err(HostError::code("EINVAL", "invalid log filename"));
    }
    Ok(basename)
}

fn undefined() -> Value {
    json!({ "__undefined": true })
}

fn recursive_arg(args: &[Value], index: usize) -> bool {
    match args.get(index) {
        Some(Value::Bool(value)) => *value,
        Some(Value::Object(map)) => map
            .get("recursive")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        _ => false,
    }
}
