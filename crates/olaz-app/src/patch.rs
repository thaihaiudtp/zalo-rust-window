//! The three renderer patches the macOS host applied, needed because the
//! official preload/worker wiring assumes Electron's process layout.
//!
//! Everything is optional: when a patch cannot be applied unambiguously the
//! original script is served unchanged, exactly like the Swift host.

/// Prepended to `dal-worker*.js`: finishes the sync-v2 sub-worker's DB-client
/// setup and forwards uncaught worker errors to the page log.
pub const WORKER_PRELUDE: &str = r#"
(() => {
  const fwd = (k, v) => { try { self.postMessage({ __zhostLog: k + ' ' + String(v).slice(0, 300) }); } catch {} };
  self.__zhostFwd = fwd;
  const errText = (e) => e ? (e.name || '') + ': ' + (e.message || e) : String(e);
  self.addEventListener('error', (e) => fwd('error', e.message));
  self.addEventListener('unhandledrejection', (e) => fwd('unhandledrejection', errText(e.reason)));
  for (const lvl of ['warn', 'error']) { const o = console[lvl]; console[lvl] = (...a) => { fwd('console.' + lvl, a.map((x) => x instanceof Error ? errText(x) : (typeof x === 'string' ? x : '')).join(' ')); return o.apply(console, a); }; }
  // The sync-v2 sub-worker writes imported messages through its "lite IDB" path, whose
  // encryption-state store needs the DB client (`database-manager.createQueryBuilder`).
  // Zalo's own SQLite-migrated clients never take this path and nothing in a web worker
  // creates the client (Application lifecycle is unsupported there), so create it once after
  // the sub-worker script has loaded — through its official singleton accessor.
  const ensureDatabaseClient = () => {
    try {
      const req = self.__swReq;
      if (!req || !req.c) { fwd('webpack require not exposed', ''); return; }
      for (const id of Object.keys(req.c)) {
        try {
          const d = req.c[id] && req.c[id].exports && req.c[id].exports.default;
          if (d && typeof d.getInstance === 'function' && String(d.getInstance).includes('createQueryBuilder')) { d.getInstance(); fwd('database client ready', id); return; }
        } catch (e) { /* a throwing export getter must not abort the search */ }
      }
      fwd('database client accessor not found', '');
    } catch (e) { fwd('database client setup failed', errText(e)); }
  };
  if (typeof self.importScripts === 'function') {
    const imp = self.importScripts;
    self.importScripts = function (...urls) { const r = imp.apply(this, urls); if (urls.some((u) => /sync-v2-sub-worker/.test(String(u)))) ensureDatabaseClient(); return r; };
  }
  if (typeof IDBDatabase !== 'undefined') {
    const tx = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...a) {
      const t = tx.apply(this, a);
      t.addEventListener('abort', () => fwd('idb-abort', errText(t.error)));
      return t;
    };
    for (const m of ['add', 'put']) {
      const o = IDBObjectStore.prototype[m];
      IDBObjectStore.prototype[m] = function (...a) {
        try { const r = o.apply(this, a); r.addEventListener('error', () => fwd('idb-' + m + '-error', this.name + ' ' + errText(r.error))); return r; }
        catch (e) { fwd('idb-' + m + '-throw', this.name + ' ' + errText(e)); throw e; }
      };
    }
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...a) {
      const r = open.apply(this, a);
      r.addEventListener('error', () => fwd('idb-open-error', errText(r.error)));
      r.addEventListener('blocked', () => fwd('idb-open-blocked', ''));
      return r;
    };
  }
})();

"#;

/// Applies the patches that match `path` (the URL path of a served script).
pub fn patch(path: &str, bytes: Vec<u8>) -> Vec<u8> {
    if path.starts_with("/dal-worker.") && path.ends_with(".js") {
        let mut out = Vec::with_capacity(WORKER_PRELUDE.len() + bytes.len());
        out.extend_from_slice(WORKER_PRELUDE.as_bytes());
        out.extend_from_slice(&bytes);
        return out;
    }
    if path.starts_with("/sync-v2-sub-worker.") && path.ends_with(".js") {
        return expose_webpack_require(&bytes);
    }
    if path.starts_with("/lazy/main-startup.") && path.ends_with(".js") {
        return patch_global_id_resolver(&bytes);
    }
    bytes
}

/// Adds `self.__swReq = <require>;` in front of the webpack runtime's
/// `<require>.e = function (chunkId) { var promises = [], installedChunkData =
/// … }`. Served unchanged when the shape is missing or ambiguous.
fn expose_webpack_require(data: &[u8]) -> Vec<u8> {
    const TAIL: &[u8] = b"=function(e){var t=[],n=a[e]";
    let Some(position) = find(data, TAIL) else {
        tracing::warn!("sync-v2-sub-worker served unpatched: runtime shape not found");
        return data.to_vec();
    };
    if find(&data[position + TAIL.len()..], TAIL).is_some() {
        tracing::warn!("sync-v2-sub-worker served unpatched: runtime shape ambiguous");
        return data.to_vec();
    }
    if position < 2 || data[position - 1] != b'e' || data[position - 2] != b'.' {
        tracing::warn!("sync-v2-sub-worker served unpatched: no .e accessor");
        return data.to_vec();
    }
    let mut ident_start = position - 2;
    while ident_start > 0 && is_ident(data[ident_start - 1]) {
        ident_start -= 1;
    }
    if ident_start >= position - 2
        || data[ident_start].is_ascii_digit()
        || ident_start == 0
        || !matches!(data[ident_start - 1], b'}' | b';')
    {
        tracing::warn!("sync-v2-sub-worker served unpatched: not at a statement boundary");
        return data.to_vec();
    }
    let ident = String::from_utf8_lossy(&data[ident_start..position - 2]).into_owned();
    let mut out = Vec::with_capacity(data.len() + ident.len() + 16);
    out.extend_from_slice(&data[..ident_start]);
    out.extend_from_slice(format!("self.__swReq={ident};").as_bytes());
    out.extend_from_slice(&data[ident_start..]);
    out
}

fn is_ident(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$'
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// DEVIATION FROM OFFICIAL (sync-v2 `GET_GLOBAL_NOISED_IDS`):
/// asks `window.__swzGlobalIdFallback` for the user ids the profile lookup left
/// unmapped, then merges the answer. See the Swift host's comment for why.
fn patch_global_id_resolver(data: &[u8]) -> Vec<u8> {
    let Ok(source) = std::str::from_utf8(data) else {
        tracing::warn!("main-startup served without global-id fallback: not utf8");
        return data.to_vec();
    };
    let ident = r"[A-Za-z_$][A-Za-z0-9_$]*";
    let pattern = format!(
        r"({ident})\.resolveWithRetry\(({ident}),\(({ident})=>({ident})\.default\.getGlobalIdsFromUserIds\(({ident})\)\)\)"
    );
    let Ok(regex) = regex::Regex::new(&pattern) else {
        tracing::warn!("main-startup served without global-id fallback: bad pattern");
        return data.to_vec();
    };
    let matches: Vec<_> = regex.captures_iter(source).collect();
    if matches.len() != 1 {
        tracing::warn!(
            "main-startup served without global-id fallback: resolver shape {}",
            if matches.is_empty() { "not found" } else { "ambiguous" }
        );
        return data.to_vec();
    }
    let captures = &matches[0];
    let (Some(svc), Some(ids), Some(arg), Some(manager), Some(repeated)) = (
        captures.get(1),
        captures.get(2),
        captures.get(3),
        captures.get(4),
        captures.get(5),
    ) else {
        return data.to_vec();
    };
    if arg.as_str() != repeated.as_str() {
        tracing::warn!("main-startup served without global-id fallback: callback argument differs");
        return data.to_vec();
    }
    let whole = captures.get(0).unwrap();
    let replacement = format!(
        "{}.resolveWithRetry({},(async {}=>{{let __r=await {}.default.getGlobalIdsFromUserIds({})||{{}};\
         const __m={}.filter(__i=>!__r[__i]),__f=window.__swzGlobalIdFallback;\
         if(__m.length&&typeof __f===\"function\")try{{__r=Object.assign({{}},__r,await __f(__m))}}catch(__e){{}}return __r}}))",
        svc.as_str(),
        ids.as_str(),
        arg.as_str(),
        manager.as_str(),
        arg.as_str(),
        arg.as_str()
    );
    let mut out = String::with_capacity(source.len() + replacement.len());
    out.push_str(&source[..whole.start()]);
    out.push_str(&replacement);
    out.push_str(&source[whole.end()..]);
    out.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_require_at_statement_boundary() {
        let source = b"x};a.e=function(e){var t=[],n=a[e]";
        let patched = expose_webpack_require(source);
        let text = String::from_utf8(patched).unwrap();
        assert!(text.contains("};self.__swReq=a;a.e=function"));
    }

    #[test]
    fn ambiguous_require_shape_is_left_alone() {
        let source = b"};a.e=function(e){var t=[],n=a[e]};b.e=function(e){var t=[],n=a[e]";
        assert_eq!(expose_webpack_require(source), source);
    }

    #[test]
    fn global_id_resolver_is_patched_once() {
        let source = b"q.resolveWithRetry(z,(y=>m.default.getGlobalIdsFromUserIds(y)))";
        let text = String::from_utf8(patch_global_id_resolver(source)).unwrap();
        assert!(text.contains("async y=>"));
        assert!(text.contains("window.__swzGlobalIdFallback"));
    }
}
