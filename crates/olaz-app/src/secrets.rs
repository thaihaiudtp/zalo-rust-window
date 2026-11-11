//! `$zsafeStorage` and `$zprotocol` host-side secrets.
//!
//! Electron uses the OS keychain; Olaz keeps the protocol root keys in its own
//! data directory instead (same trust boundary as the official client's local
//! profile, but without touching the user's keychain).

use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use aes::Aes256;
use base64::Engine;
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;

use crate::crypto;
use crate::platform::{str_arg, HostError, HostResult, Platform};

type HmacSha256 = Hmac<Sha256>;

const SAFE_KEY: &[u8; 32] = b"d9c07b9de9915af401607d3f360211ac";
const SAFE_IV: [u8; 16] = [
    155, 72, 37, 195, 9, 217, 80, 42, 145, 102, 171, 75, 214, 176, 134, 18,
];
const KEYCHAIN_INFO: &[u8] = b"ZprotocolSecureKDF";
const KEYCHAIN_TYPE: u8 = 0x49;

pub fn safe_storage(
    platform: &Platform,
    method: &str,
    args: &[Value],
) -> HostResult<Value> {
    match method {
        "encryptString" => {
            let plain = str_arg(args, 0).unwrap_or("");
            let sealed = aes_cbc_encrypt(SAFE_KEY, &SAFE_IV, plain.as_bytes())?;
            Ok(json!(base64::engine::general_purpose::STANDARD.encode(sealed)))
        }
        "decryptString" => {
            let sealed = str_arg(args, 0).unwrap_or("");
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(sealed.as_bytes())
                .map_err(|e| HostError(format!("EINVAL: invalid base64: {e}")))?;
            let plain = aes_cbc_decrypt(SAFE_KEY, &SAFE_IV, &bytes)?;
            Ok(json!(String::from_utf8_lossy(&plain).into_owned()))
        }
        "get" => {
            let Some(key) = str_arg(args, 0) else {
                return Ok(undefined());
            };
            if key.contains('.') {
                return Ok(undefined());
            }
            let store = platform.read_store("zsafe-storage");
            let Some(sealed) = store
                .get("zsskd")
                .and_then(Value::as_object)
                .and_then(|values| values.get(key))
                .and_then(Value::as_str)
            else {
                return Ok(undefined());
            };
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(sealed.as_bytes())
                .map_err(|e| HostError(format!("EINVAL: invalid base64: {e}")))?;
            let plain = aes_cbc_decrypt(SAFE_KEY, &SAFE_IV, &bytes)?;
            Ok(json!(String::from_utf8_lossy(&plain).into_owned()))
        }
        "set" => {
            let Some(key) = str_arg(args, 0) else {
                return Ok(undefined());
            };
            if key.contains('.') {
                return Ok(undefined());
            }
            let mut store = platform.read_store("zsafe-storage");
            let mut values = store
                .get("zsskd")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            match str_arg(args, 1) {
                Some(value) => {
                    let sealed = aes_cbc_encrypt(SAFE_KEY, &SAFE_IV, value.as_bytes())?;
                    values.insert(
                        key.to_string(),
                        json!(base64::engine::general_purpose::STANDARD.encode(sealed)),
                    );
                }
                None => {
                    values.remove(key);
                }
            }
            store["zsskd"] = Value::Object(values);
            store["zsskv"] = json!("2");
            platform.write_store("zsafe-storage", &store)?;
            Ok(undefined())
        }
        other => Err(HostError(format!(
            "ENOTSUP: zsafestorage unknown method {other}"
        ))),
    }
}

fn undefined() -> Value {
    json!({ "__undefined": true })
}

pub fn keychain_encrypt(
    platform: &Platform,
    identifier: &str,
    items: &[Value],
) -> HostResult<Value> {
    let root = root_key(platform, identifier, true)?;
    let mut sealed_items = Vec::with_capacity(items.len());
    for item in items {
        let plain = crypto::bytes_value(Some(item), None)?;
        let mut iv = [0u8; 16];
        let mut salt = [0u8; 16];
        random(&mut iv);
        random(&mut salt);
        let (enc, mac) = derive(&root, &salt)?;
        let ciphertext = aes_cbc_encrypt(&enc, &iv, &plain)?;
        let mut mac_input = Vec::with_capacity(ciphertext.len() + 32);
        mac_input.extend_from_slice(&ciphertext);
        mac_input.extend_from_slice(&iv);
        mac_input.extend_from_slice(&salt);
        let tag = hmac(&mac, &mac_input)?;
        let mut out = Vec::with_capacity(1 + 16 + 16 + ciphertext.len() + 32);
        out.push(KEYCHAIN_TYPE);
        out.extend_from_slice(&iv);
        out.extend_from_slice(&salt);
        out.extend_from_slice(&ciphertext);
        out.extend_from_slice(&tag);
        sealed_items.push(crypto::encode_bytes(&out, None, false));
    }
    Ok(Value::Array(sealed_items))
}

pub fn keychain_decrypt(
    platform: &Platform,
    identifier: &str,
    items: &[Value],
) -> HostResult<Value> {
    let root = root_key(platform, identifier, false)?;
    let mut plain_items = Vec::with_capacity(items.len());
    for item in items {
        let sealed = crypto::bytes_value(Some(item), None)?;
        if sealed.len() < 65 {
            return Err(HostError("EINVAL: Invalid encrypted data length".into()));
        }
        let iv = &sealed[1..17];
        let salt = &sealed[17..33];
        let ciphertext = &sealed[33..sealed.len() - 32];
        let tag = &sealed[sealed.len() - 32..];
        let (enc, mac) = derive(&root, salt)?;
        let mut mac_input = Vec::with_capacity(ciphertext.len() + 32);
        mac_input.extend_from_slice(ciphertext);
        mac_input.extend_from_slice(iv);
        mac_input.extend_from_slice(salt);
        verify_hmac(&mac, &mac_input, tag)?;
        let plain = aes_cbc_decrypt(&enc, iv, ciphertext)?;
        plain_items.push(crypto::encode_bytes(&plain, None, false));
    }
    Ok(Value::Array(plain_items))
}

fn root_key(platform: &Platform, identifier: &str, create: bool) -> HostResult<Vec<u8>> {
    let store_name = "zprotocol-keys";
    let key = identifier.to_lowercase();
    let mut store = platform.read_store(store_name);
    let mut keys = store
        .get("keys")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(existing) = keys.get(&key).and_then(Value::as_str) {
        if let Some(bytes) = decode_hex(existing) {
            if bytes.len() == 32 {
                return Ok(bytes);
            }
        }
    }
    if !create {
        return Err(HostError(format!("ENOENT: No secret for {identifier}")));
    }
    let mut root = [0u8; 32];
    random(&mut root);
    keys.insert(key, json!(encode_hex(&root)));
    store["keys"] = Value::Object(keys);
    platform.write_store(store_name, &store)?;
    Ok(root.to_vec())
}

fn derive(root: &[u8], salt: &[u8]) -> HostResult<(Vec<u8>, Vec<u8>)> {
    let hkdf = Hkdf::<Sha256>::new(Some(salt), root);
    let mut okm = [0u8; 64];
    hkdf.expand(KEYCHAIN_INFO, &mut okm)
        .map_err(|e| HostError(format!("EINVAL: HKDF failed: {e}")))?;
    Ok((okm[..32].to_vec(), okm[32..].to_vec()))
}

fn hmac(key: &[u8], data: &[u8]) -> HostResult<Vec<u8>> {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key)
        .map_err(|e| HostError(format!("EINVAL: HMAC key: {e}")))?;
    mac.update(data);
    Ok(mac.finalize().into_bytes().to_vec())
}

fn verify_hmac(key: &[u8], data: &[u8], tag: &[u8]) -> HostResult<()> {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key)
        .map_err(|e| HostError(format!("EINVAL: HMAC key: {e}")))?;
    mac.update(data);
    mac.verify_slice(tag)
        .map_err(|_| HostError("EINVAL: Invalid MAC".into()))
}

fn random(output: &mut [u8]) {
    let _ = getrandom::getrandom(output);
}

fn aes_cbc_encrypt(key: &[u8], iv: &[u8], plain: &[u8]) -> HostResult<Vec<u8>> {
    let cipher = cbc::Encryptor::<Aes256>::new_from_slices(key, iv)
        .map_err(|e| HostError(format!("EINVAL: {e}")))?;
    Ok(cipher.encrypt_padded_vec_mut::<Pkcs7>(plain))
}

fn aes_cbc_decrypt(key: &[u8], iv: &[u8], sealed: &[u8]) -> HostResult<Vec<u8>> {
    let cipher = cbc::Decryptor::<Aes256>::new_from_slices(key, iv)
        .map_err(|e| HostError(format!("EINVAL: {e}")))?;
    cipher
        .decrypt_padded_vec_mut::<Pkcs7>(sealed)
        .map_err(|_| HostError("EINVAL: bad decrypt".into()))
}

fn encode_hex(bytes: &[u8]) -> String {
    const CHARS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(CHARS[(*byte >> 4) as usize] as char);
        out.push(CHARS[(*byte & 0x0f) as usize] as char);
    }
    out
}

fn decode_hex(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    if bytes.len() % 2 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 2);
    let mut index = 0;
    while index < bytes.len() {
        out.push(u8::from_str_radix(&text[index..index + 2], 16).ok()?);
        index += 2;
    }
    Some(out)
}
