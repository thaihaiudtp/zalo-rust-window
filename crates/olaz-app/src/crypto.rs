//! `$znode.crypto` — Node's synchronous crypto API as used by the official
//! preload. Login needs AES-256-CBC, MD5/SHA hashes and random bytes; stateful
//! cipher/hash objects back `local-modules.js`.

use std::collections::HashMap;

use aes::{Aes128, Aes192, Aes256};
use aes_gcm::aead::consts::U12;
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{AesGcm, Nonce};
use base64::Engine;
use cbc::cipher::{
    block_padding::NoPadding, block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit,
    StreamCipher,
};
use hmac::digest::Digest;
use serde_json::{json, Value};

use crate::platform::{str_arg, HostError, HostResult};

#[derive(Default)]
pub struct CryptoState {
    sessions: HashMap<i64, CipherSession>,
    hashes: HashMap<i64, (String, Vec<u8>)>,
    next: i64,
}

impl CryptoState {
    fn handle(&mut self) -> i64 {
        self.next += 1;
        self.next
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Cbc,
    Ctr,
    Ecb,
    Gcm,
}

struct CipherSession {
    encrypting: bool,
    mode: Mode,
    key: Vec<u8>,
    iv: Vec<u8>,
    auto_padding: bool,
    buffer: Vec<u8>,
    aad: Vec<u8>,
    auth_tag: Option<Vec<u8>>,
}

impl CipherSession {
    fn new(encrypting: bool, algorithm: &str, key: Vec<u8>, iv: Vec<u8>) -> HostResult<Self> {
        let alg = algorithm.to_ascii_lowercase();
        let mode = if alg.ends_with("-cbc") {
            Mode::Cbc
        } else if alg.ends_with("-ctr") {
            Mode::Ctr
        } else if alg.ends_with("-ecb") {
            Mode::Ecb
        } else if alg.ends_with("-gcm") {
            Mode::Gcm
        } else {
            return Err(HostError(format!("ENOTSUP: unsupported cipher {alg}")));
        };
        if !matches!(key.len(), 16 | 24 | 32) {
            return Err(HostError("EINVAL: Invalid key length".into()));
        }
        match mode {
            Mode::Cbc | Mode::Ctr if iv.len() != 16 => {
                return Err(HostError("EINVAL: Invalid initialization vector".into()))
            }
            Mode::Gcm if iv.len() != 12 => {
                return Err(HostError("EINVAL: Invalid initialization vector".into()))
            }
            _ => {}
        }
        Ok(Self {
            encrypting,
            mode,
            key,
            iv,
            auto_padding: true,
            buffer: Vec::new(),
            aad: Vec::new(),
            auth_tag: None,
        })
    }

    /// Consumes the buffered input the way Node's `update()`+`final()` pair
    /// would. The session stays alive for GCM encryption so `getAuthTag()`
    /// can still read the tag the final call produced.
    fn finish(&mut self) -> HostResult<Vec<u8>> {
        let data = std::mem::take(&mut self.buffer);
        match self.mode {
            Mode::Cbc => self.finish_block(data, true),
            Mode::Ecb => self.finish_block(data, false),
            Mode::Ctr => self.finish_ctr(data),
            Mode::Gcm => self.finish_gcm(data),
        }
    }

    fn finish_block(&self, data: Vec<u8>, cbc: bool) -> HostResult<Vec<u8>> {
        let key = &self.key;
        let iv = &self.iv;
        let encrypting = self.encrypting;
        let auto_padding = self.auto_padding;
        macro_rules! run {
            ($aes:ty) => {{
                if encrypting {
                    if cbc {
                        let encryptor = cbc::Encryptor::<$aes>::new_from_slices(key, iv)
                            .map_err(|e| HostError(format!("EINVAL: {e}")))?;
                        if auto_padding {
                            encryptor.encrypt_padded_vec_mut::<Pkcs7>(&data)
                        } else {
                            encryptor.encrypt_padded_vec_mut::<NoPadding>(&data)
                        }
                    } else {
                        let encryptor = ecb::Encryptor::<$aes>::new_from_slice(key)
                            .map_err(|e| HostError(format!("EINVAL: {e}")))?;
                        if auto_padding {
                            encryptor.encrypt_padded_vec_mut::<Pkcs7>(&data)
                        } else {
                            encryptor.encrypt_padded_vec_mut::<NoPadding>(&data)
                        }
                    }
                } else if cbc {
                    let decryptor = cbc::Decryptor::<$aes>::new_from_slices(key, iv)
                        .map_err(|e| HostError(format!("EINVAL: {e}")))?;
                    if auto_padding {
                        decryptor
                            .decrypt_padded_vec_mut::<Pkcs7>(&data)
                            .map_err(|_| HostError("EINVAL: bad decrypt".into()))?
                    } else {
                        decryptor
                            .decrypt_padded_vec_mut::<NoPadding>(&data)
                            .map_err(|_| HostError("EINVAL: bad decrypt".into()))?
                    }
                } else {
                    let decryptor = ecb::Decryptor::<$aes>::new_from_slice(key)
                        .map_err(|e| HostError(format!("EINVAL: {e}")))?;
                    if auto_padding {
                        decryptor
                            .decrypt_padded_vec_mut::<Pkcs7>(&data)
                            .map_err(|_| HostError("EINVAL: bad decrypt".into()))?
                    } else {
                        decryptor
                            .decrypt_padded_vec_mut::<NoPadding>(&data)
                            .map_err(|_| HostError("EINVAL: bad decrypt".into()))?
                    }
                }
            }};
        }
        Ok(match key.len() {
            16 => run!(Aes128),
            24 => run!(Aes192),
            _ => run!(Aes256),
        })
    }

    fn finish_ctr(&self, mut data: Vec<u8>) -> HostResult<Vec<u8>> {
        let key = &self.key;
        let iv = &self.iv;
        macro_rules! run {
            ($aes:ty) => {{
                let mut cipher = ctr::Ctr128BE::<$aes>::new_from_slices(key, iv)
                    .map_err(|e| HostError(format!("EINVAL: {e}")))?;
                cipher.apply_keystream(&mut data);
            }};
        }
        match key.len() {
            16 => run!(Aes128),
            24 => run!(Aes192),
            _ => run!(Aes256),
        }
        Ok(data)
    }

    fn finish_gcm(&mut self, data: Vec<u8>) -> HostResult<Vec<u8>> {
        let key = self.key.clone();
        let iv = self.iv.clone();
        let aad = self.aad.clone();
        let encrypting = self.encrypting;
        macro_rules! run {
            ($aes:ty) => {{
                let cipher = AesGcm::<$aes, U12>::new_from_slice(&key)
                    .map_err(|e| HostError(format!("EINVAL: {e}")))?;
                let nonce = Nonce::from_slice(&iv);
                if encrypting {
                    let mut sealed = cipher
                        .encrypt(nonce, Payload { msg: &data, aad: &aad })
                        .map_err(|_| HostError("EINVAL: cipher final failed".into()))?;
                    let split = sealed.len().saturating_sub(16);
                    self.auth_tag = Some(sealed.split_off(split));
                    Ok(sealed)
                } else {
                    let tag = self.auth_tag.clone().ok_or_else(|| {
                        HostError("EINVAL: Unsupported state or unable to authenticate data".into())
                    })?;
                    let mut sealed = data;
                    sealed.extend_from_slice(&tag);
                    cipher
                        .decrypt(nonce, Payload { msg: &sealed, aad: &aad })
                        .map_err(|_| {
                            HostError(
                                "EINVAL: Unsupported state or unable to authenticate data".into(),
                            )
                        })
                }
            }};
        }
        match key.len() {
            16 => run!(Aes128),
            24 => run!(Aes192),
            _ => run!(Aes256),
        }
    }
}

pub fn bytes_value(value: Option<&Value>, encoding: Option<&str>) -> HostResult<Vec<u8>> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    match value {
        Value::Null => Ok(Vec::new()),
        Value::Object(map) => {
            if let Some(encoded) = map.get("__bytes").and_then(Value::as_str) {
                return base64::engine::general_purpose::STANDARD
                    .decode(encoded.as_bytes())
                    .map_err(|e| HostError(format!("EINVAL: invalid base64: {e}")));
            }
            Ok(Vec::new())
        }
        Value::String(text) => decode_text(text, encoding),
        _ => Ok(Vec::new()),
    }
}

fn decode_text(text: &str, encoding: Option<&str>) -> HostResult<Vec<u8>> {
    match encoding.unwrap_or("utf8").to_ascii_lowercase().as_str() {
        "utf8" | "utf-8" => Ok(text.as_bytes().to_vec()),
        "hex" => {
            let mut out = Vec::with_capacity(text.len() / 2);
            let bytes = text.as_bytes();
            let mut i = 0;
            while i + 1 < bytes.len() {
                let pair = &text[i..i + 2];
                if let Ok(byte) = u8::from_str_radix(pair, 16) {
                    out.push(byte);
                } else {
                    break;
                }
                i += 2;
            }
            Ok(out)
        }
        "base64" => {
            let cleaned: String = text.chars().filter(|c| !c.is_whitespace()).collect();
            base64::engine::general_purpose::STANDARD
                .decode(cleaned.as_bytes())
                .map_err(|e| HostError(format!("EINVAL: invalid base64: {e}")))
        }
        "base64url" => {
            let mut value = text.replace('-', "+").replace('_', "/");
            while value.len() % 4 != 0 {
                value.push('=');
            }
            base64::engine::general_purpose::STANDARD
                .decode(value.as_bytes())
                .map_err(|e| HostError(format!("EINVAL: invalid base64: {e}")))
        }
        "binary" | "latin1" | "ascii" => {
            Ok(text.chars().map(|c| c as u32 as u8).collect())
        }
        "ucs2" | "ucs-2" | "utf16le" | "utf-16le" => {
            let mut out = Vec::with_capacity(text.len() * 2);
            for unit in text.encode_utf16() {
                out.extend_from_slice(&unit.to_le_bytes());
            }
            Ok(out)
        }
        other => Err(HostError(format!("EINVAL: Unknown encoding: {other}"))),
    }
}

/// Encodes bytes the way `bridge.js` expects. `arraybuffer` mirrors the
/// preload's `Buffer.buffer` returns (`Uint8Array` otherwise).
pub fn encode_bytes(bytes: &[u8], encoding: Option<&str>, arraybuffer: bool) -> Value {
    let Some(encoding) = encoding else {
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        return if arraybuffer {
            json!({ "__bytes": encoded, "__arraybuffer": true })
        } else {
            json!({ "__bytes": encoded })
        };
    };
    match encoding.to_ascii_lowercase().as_str() {
        "hex" => Value::String(hex(bytes)),
        "base64" => Value::String(base64::engine::general_purpose::STANDARD.encode(bytes)),
        "base64url" => Value::String(
            base64::engine::general_purpose::STANDARD_NO_PAD.encode(bytes),
        ),
        "binary" | "latin1" | "ascii" => {
            Value::String(bytes.iter().map(|&b| b as char).collect())
        }
        "ucs2" | "ucs-2" | "utf16le" | "utf-16le" => {
            let units: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            Value::String(String::from_utf16_lossy(&units))
        }
        _ => Value::String(String::from_utf8_lossy(bytes).into_owned()),
    }
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

pub fn digest(algorithm: &str, data: &[u8]) -> HostResult<Vec<u8>> {
    let algorithm = algorithm.to_ascii_lowercase().replace('-', "");
    Ok(match algorithm.as_str() {
        "md5" => {
            let mut hasher = md5::Md5::new();
            hasher.update(data);
            hasher.finalize().to_vec()
        }
        "sha1" => {
            let mut hasher = sha1::Sha1::new();
            hasher.update(data);
            hasher.finalize().to_vec()
        }
        "sha256" => {
            let mut hasher = sha2::Sha256::new();
            hasher.update(data);
            hasher.finalize().to_vec()
        }
        "sha384" => {
            let mut hasher = sha2::Sha384::new();
            hasher.update(data);
            hasher.finalize().to_vec()
        }
        "sha512" => {
            let mut hasher = sha2::Sha512::new();
            hasher.update(data);
            hasher.finalize().to_vec()
        }
        _ => return Err(HostError(format!("EINVAL: Digest method not supported: {algorithm}"))),
    })
}

pub fn one_shot(
    encrypting: bool,
    args: &[Value],
) -> HostResult<Value> {
    let encodings = args.get(4).and_then(Value::as_object);
    let options = args.get(5).and_then(Value::as_object);
    let algorithm = str_arg(args, 1).unwrap_or("aes-256-cbc");
    let key_encoding = encodings.and_then(|map| map.get("key")).and_then(Value::as_str);
    let input_encoding = encodings
        .and_then(|map| map.get("input"))
        .and_then(Value::as_str);
    let output_encoding = encodings
        .and_then(|map| map.get("output"))
        .and_then(Value::as_str);
    let key = bytes_value(args.get(2), key_encoding)?;
    let iv = match args.get(3) {
        None | Some(Value::Null) => vec![0u8; 16],
        Some(value) => {
            let iv_encoding = encodings
                .and_then(|map| map.get("iv"))
                .and_then(Value::as_str)
                .or(key_encoding);
            bytes_value(Some(value), iv_encoding)?
        }
    };
    let input = bytes_value(args.first(), input_encoding)?;
    tracing::debug!(
        "crypto one_shot {} alg={algorithm} key_len={} iv_len={} encodings={:?}",
        if encrypting { "encrypt" } else { "decrypt" },
        key.len(),
        iv.len(),
        encodings
    );
    let mut session = CipherSession::new(encrypting, algorithm, key, iv)?;
    if let Some(tag) = options
        .and_then(|map| map.get("authTag"))
        .filter(|_| !encrypting)
    {
        session.auth_tag = Some(bytes_value(Some(tag), None)?);
    }
    if let Some(aad) = options
        .and_then(|map| map.get("aad"))
        .filter(|_| !encrypting)
    {
        session.aad = bytes_value(Some(aad), None)?;
    }
    session.buffer = input;
    let output = session.finish()?;
    Ok(encode_bytes(&output, output_encoding, output_encoding.is_none()))
}

pub fn cipher_create(state: &std::sync::Mutex<CryptoState>, args: &[Value]) -> HostResult<Value> {
    let encrypting = str_arg(args, 0) == Some("cipher");
    let algorithm = str_arg(args, 1).unwrap_or("aes-256-cbc");
    let key = bytes_value(args.get(2), Some("utf8"))?;
    let iv = match args.get(3) {
        None | Some(Value::Null) => vec![0u8; 16],
        Some(value) => bytes_value(Some(value), Some("utf8"))?,
    };
    let session = CipherSession::new(encrypting, algorithm, key, iv)?;
    let mut state = state.lock().unwrap_or_else(|poison| poison.into_inner());
    let handle = state.handle();
    state.sessions.insert(handle, session);
    Ok(json!(handle))
}

pub fn cipher_update(
    state: &std::sync::Mutex<CryptoState>,
    args: &[Value],
) -> HostResult<Value> {
    let handle = crate::platform::int_arg(args, 0).unwrap_or(0);
    let data = bytes_value(args.get(1), str_arg(args, 2))?;
    let mut state = state.lock().unwrap_or_else(|poison| poison.into_inner());
    let session = state
        .sessions
        .get_mut(&handle)
        .ok_or_else(|| HostError("EINVAL: cipher released".into()))?;
    session.buffer.extend_from_slice(&data);
    Ok(json!({ "__undefined": true }))
}

pub fn cipher_final(
    state: &std::sync::Mutex<CryptoState>,
    args: &[Value],
) -> HostResult<Value> {
    let handle = crate::platform::int_arg(args, 0).unwrap_or(0);
    let mut state = state.lock().unwrap_or_else(|poison| poison.into_inner());
    let output = {
        let session = state
            .sessions
            .get_mut(&handle)
            .ok_or_else(|| HostError("EINVAL: cipher released".into()))?;
        let output = session.finish()?;
        // Node removes the cipher on final() except for GCM encryption, whose
        // getAuthTag() comes after final().
        if !(session.mode == Mode::Gcm && session.encrypting) {
            state.sessions.remove(&handle);
        }
        output
    };
    Ok(encode_bytes(&output, str_arg(args, 1), str_arg(args, 1).is_none()))
}

pub fn cipher_option(
    state: &std::sync::Mutex<CryptoState>,
    args: &[Value],
) -> HostResult<Value> {
    let handle = crate::platform::int_arg(args, 0).unwrap_or(0);
    let option = str_arg(args, 1).unwrap_or("");
    let mut state = state.lock().unwrap_or_else(|poison| poison.into_inner());
    let Some(session) = state.sessions.get_mut(&handle) else {
        return Ok(json!({ "__undefined": true }));
    };
    match option {
        "autoPadding" => {
            session.auto_padding = crate::platform::bool_arg(args, 2).unwrap_or(true);
            Ok(json!({ "__undefined": true }))
        }
        "authTag" => {
            session.auth_tag = Some(bytes_value(args.get(2), None)?);
            Ok(json!({ "__undefined": true }))
        }
        "aad" => {
            session.aad = bytes_value(args.get(2), None)?;
            Ok(json!({ "__undefined": true }))
        }
        "getAuthTag" => {
            let tag = session.auth_tag.clone().unwrap_or_default();
            state.sessions.remove(&handle);
            Ok(encode_bytes(&tag, None, true))
        }
        _ => Ok(json!({ "__undefined": true })),
    }
}

pub fn hash_create(state: &std::sync::Mutex<CryptoState>, args: &[Value]) -> HostResult<Value> {
    let algorithm = str_arg(args, 0).unwrap_or("sha256").to_string();
    let mut state = state.lock().unwrap_or_else(|poison| poison.into_inner());
    let handle = state.handle();
    state.hashes.insert(handle, (algorithm, Vec::new()));
    Ok(json!(handle))
}

pub fn hash_update(state: &std::sync::Mutex<CryptoState>, args: &[Value]) -> HostResult<Value> {
    let handle = crate::platform::int_arg(args, 0).unwrap_or(0);
    let data = bytes_value(args.get(1), str_arg(args, 2))?;
    let mut state = state.lock().unwrap_or_else(|poison| poison.into_inner());
    let entry = state
        .hashes
        .get_mut(&handle)
        .ok_or_else(|| HostError("EINVAL: Digest already called".into()))?;
    entry.1.extend_from_slice(&data);
    Ok(json!({ "__undefined": true }))
}

pub fn hash_digest(state: &std::sync::Mutex<CryptoState>, args: &[Value]) -> HostResult<Value> {
    let handle = crate::platform::int_arg(args, 0).unwrap_or(0);
    let mut state = state.lock().unwrap_or_else(|poison| poison.into_inner());
    let entry = state
        .hashes
        .remove(&handle)
        .ok_or_else(|| HostError("EINVAL: Digest already called".into()))?;
    drop(state);
    let output = digest(&entry.0, &entry.1)?;
    Ok(encode_bytes(&output, str_arg(args, 1), str_arg(args, 1).is_none()))
}
