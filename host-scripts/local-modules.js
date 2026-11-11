// Olaz host script — bridge members that are pure JavaScript in Node/Electron
// and need no host round trip. Exposed through `window.__zaloLocal`, which
// bridge.js consults before falling back to the Rust host.
(() => {
  'use strict';
  if (window.__zaloLocal) return;

  // ---- Node's `path` (Windows flavour, as in the official Windows client) ----
  const isSep = (code) => code === 47 || code === 92; // '/' or '\\'
  const isDrive = (code) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
  // Node's win32 normalizeString, ported verbatim (lib/path.js). It works on
  // a string because the `..` handling depends on separator positions.
  const normalizeString = (value, allowAboveRoot) => {
    let res = '';
    let lastSegmentLength = 0;
    let lastSlash = -1;
    let dots = 0;
    let code = 0;
    for (let i = 0; i <= value.length; ++i) {
      if (i < value.length) code = value.charCodeAt(i);
      else if (isSep(code)) break;
      else code = 47;
      if (isSep(code)) {
        if (lastSlash === i - 1 || dots === 1) {
          // NOOP
        } else if (dots === 2) {
          if (res.length < 2 || lastSegmentLength !== 2 ||
              res.charCodeAt(res.length - 1) !== 46 ||
              res.charCodeAt(res.length - 2) !== 46) {
            if (res.length > 2) {
              const lastSlashIndex = res.length - lastSegmentLength - 1;
              if (lastSlashIndex === -1) {
                res = '';
                lastSegmentLength = 0;
              } else {
                res = res.slice(0, lastSlashIndex);
                lastSegmentLength = res.length - 1 - res.lastIndexOf('\\');
              }
              lastSlash = i;
              dots = 0;
              continue;
            } else if (res.length !== 0) {
              res = '';
              lastSegmentLength = 0;
              lastSlash = i;
              dots = 0;
              continue;
            }
          }
          if (allowAboveRoot) {
            res += res.length > 0 ? '\\..' : '..';
            lastSegmentLength = 2;
          }
        } else {
          if (res.length > 0) res += '\\' + value.slice(lastSlash + 1, i);
          else res = value.slice(lastSlash + 1, i);
          lastSegmentLength = i - lastSlash - 1;
        }
        lastSlash = i;
        dots = 0;
      } else if (code === 46 && dots !== -1) {
        ++dots;
      } else {
        dots = -1;
      }
    }
    return res;
  };

  let defaultCwd = 'C:\\';
  const rootOf = (value) => {
    if (/^\\\\/.test(value)) {
      const m = /^\\\\[^\\]+\\[^\\]+/.exec(value);
      return m ? m[0] + '\\' : '\\\\';
    }
    if (/^[A-Za-z]:[\\/]/.test(value)) return value.slice(0, 3);
    if (/^[\\/]/.test(value)) return '\\';
    return '';
  };

  const path = {
    sep: '\\', delimiter: ';',
    isAbsolute(value) {
      value = String(value);
      const len = value.length;
      if (len === 0) return false;
      const code = value.charCodeAt(0);
      if (isSep(code)) return true;
      return len > 2 && isDrive(code) && value.charCodeAt(1) === 58 && isSep(value.charCodeAt(2));
    },
    normalize(value) {
      value = String(value);
      const len = value.length;
      if (len === 0) return '.';
      let rootEnd = 0;
      let device;
      let isAbsolute = false;
      const code = value.charCodeAt(0);
      if (len === 1) return isSep(code) ? '\\' : value;
      if (isSep(code)) {
        isAbsolute = true;
        if (isSep(value.charCodeAt(1))) {
          let j = 2;
          let last = j;
          while (j < len && !isSep(value.charCodeAt(j))) j++;
          if (j < len && j !== last) {
            const firstPart = value.slice(last, j);
            last = j;
            while (j < len && isSep(value.charCodeAt(j))) j++;
            if (j < len && j !== last) {
              last = j;
              while (j < len && !isSep(value.charCodeAt(j))) j++;
              if (j === len) return '\\\\' + firstPart + '\\' + value.slice(last) + '\\';
              if (j !== last) {
                device = '\\\\' + firstPart + '\\' + value.slice(last, j);
                rootEnd = j;
              }
            }
          } else {
            rootEnd = 1;
          }
        } else {
          rootEnd = 1;
        }
      } else if (isDrive(code) && value.charCodeAt(1) === 58) {
        device = value.slice(0, 2);
        rootEnd = 2;
        if (len > 2 && isSep(value.charCodeAt(2))) {
          isAbsolute = true;
          rootEnd = 3;
        }
      }
      let tail = rootEnd < len ? normalizeString(value.slice(rootEnd), !isAbsolute) : '';
      if (tail.length === 0 && !isAbsolute) tail = '.';
      if (tail.length > 0 && isSep(value.charCodeAt(len - 1))) tail += '\\';
      if (device === undefined) return isAbsolute ? '\\' + tail : tail;
      if (isAbsolute) return device + '\\' + tail;
      if (tail.length > 0) return device + tail;
      return device;
    },
    join(...parts) {
      let joined;
      for (const part of parts) {
        if (part && part.length > 0) joined = joined === undefined ? part : joined + '\\' + part;
      }
      return joined === undefined ? '.' : path.normalize(joined);
    },
    resolve(...parts) {
      let resolvedDevice = '';
      let resolvedTail = '';
      let resolvedAbsolute = false;
      for (let i = parts.length - 1; i >= -1; i--) {
        let value;
        if (i >= 0) value = String(parts[i]);
        else if (resolvedDevice) value = resolvedDevice + '\\';
        else value = defaultCwd;
        const len = value.length;
        if (len === 0) continue;
        let rootEnd = 0;
        let device;
        let isAbsolute = false;
        const code = value.charCodeAt(0);
        if (len === 1) {
          if (isSep(code)) { rootEnd = 1; isAbsolute = true; }
        } else if (isSep(code)) {
          isAbsolute = true;
          if (isSep(value.charCodeAt(1))) {
            let j = 2;
            let last = j;
            while (j < len && !isSep(value.charCodeAt(j))) j++;
            if (j < len && j !== last) {
              const firstPart = value.slice(last, j);
              last = j;
              while (j < len && isSep(value.charCodeAt(j))) j++;
              if (j < len && j !== last) {
                last = j;
                while (j < len && !isSep(value.charCodeAt(j))) j++;
                if (j === len) {
                  rootEnd = j;
                } else if (j !== last) {
                  device = '\\\\' + firstPart + '\\' + value.slice(last, j);
                  rootEnd = j;
                }
              }
            }
          } else {
            rootEnd = 1;
          }
        } else if (isDrive(code) && value.charCodeAt(1) === 58) {
          device = value.slice(0, 2);
          rootEnd = 2;
          if (len > 2 && isSep(value.charCodeAt(2))) {
            isAbsolute = true;
            rootEnd = 3;
          }
        }
        if (device) {
          if (resolvedDevice) {
            if (device.toLowerCase() !== resolvedDevice.toLowerCase()) continue;
          } else {
            resolvedDevice = device;
          }
        }
        if (resolvedAbsolute) {
          if (resolvedDevice) break;
        } else {
          resolvedTail = value.slice(rootEnd) + '\\' + resolvedTail;
          resolvedAbsolute = isAbsolute;
          if (isAbsolute && resolvedDevice) break;
        }
      }
      resolvedTail = normalizeString(resolvedTail, !resolvedAbsolute);
      if (resolvedAbsolute) return resolvedDevice + '\\' + resolvedTail;
      return resolvedDevice + resolvedTail || '.';
    },
    dirname(value) {
      value = String(value);
      const len = value.length;
      if (len === 0) return '.';
      let rootEnd = -1;
      let offset = 0;
      const code = value.charCodeAt(0);
      if (len === 1) return isSep(code) ? value : '.';
      if (isSep(code)) {
        rootEnd = offset = 1;
        if (isSep(value.charCodeAt(1))) {
          let j = 2;
          let last = j;
          while (j < len && !isSep(value.charCodeAt(j))) j++;
          if (j < len && j !== last) {
            last = j;
            while (j < len && isSep(value.charCodeAt(j))) j++;
            if (j < len && j !== last) {
              last = j;
              while (j < len && !isSep(value.charCodeAt(j))) j++;
              if (j === len) return value;
              if (j !== last) rootEnd = offset = j + 1;
            }
          }
        }
      } else if (isDrive(code) && value.charCodeAt(1) === 58) {
        rootEnd = len > 2 && isSep(value.charCodeAt(2)) ? 3 : 2;
        offset = rootEnd;
      }
      let end = -1;
      let matchedSlash = true;
      for (let i = len - 1; i >= offset; --i) {
        if (isSep(value.charCodeAt(i))) {
          if (!matchedSlash) { end = i; break; }
        } else {
          matchedSlash = false;
        }
      }
      if (end === -1) {
        if (rootEnd === -1) return '.';
        end = rootEnd;
      }
      return value.slice(0, end);
    },
    basename(value, ext) {
      value = String(value);
      let end = value.length;
      while (end > 0 && isSep(value.charCodeAt(end - 1))) end--;
      if (end === 0) return '';
      const trimmed = value.slice(0, end);
      if (/^[A-Za-z]:$/.test(trimmed)) return '';
      if (/^\\\\[^\\]+\\[^\\]+$/.test(trimmed)) return '';
      let base = trimmed.slice(Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/')) + 1);
      if (ext && base.length > ext.length && base.endsWith(ext)) base = base.slice(0, -ext.length);
      return base;
    },
    extname(value) {
      const base = path.basename(value);
      if (base === '.' || base === '..') return '';
      const i = base.lastIndexOf('.');
      return i <= 0 ? '' : base.slice(i);
    },
    relative(from, to) {
      const fromPath = path.resolve(from);
      const toPath = path.resolve(to);
      if (fromPath.toLowerCase() === toPath.toLowerCase()) return '';
      const fromParts = fromPath.split(/[\\/]+/).filter(Boolean);
      const toParts = toPath.split(/[\\/]+/).filter(Boolean);
      if ((fromParts[0] || '').toLowerCase() !== (toParts[0] || '').toLowerCase()) return toPath;
      let common = 0;
      while (common < fromParts.length && common < toParts.length &&
             fromParts[common].toLowerCase() === toParts[common].toLowerCase()) common++;
      return [...Array(fromParts.length - common).fill('..'), ...toParts.slice(common)].join('\\');
    },
    parse(value) {
      value = String(value);
      const root = rootOf(value);
      const base = path.basename(value);
      const ext = path.extname(value);
      const dir = path.dirname(value);
      return { root, dir: dir === '.' && !root ? '' : dir, base, ext, name: base.slice(0, base.length - ext.length) };
    },
    format(object) {
      const dir = object.dir || object.root || '';
      const base = object.base || ((object.name || '') + (object.ext || ''));
      if (!dir) return base;
      return isSep(dir.charCodeAt(dir.length - 1)) ? dir + base : dir + '\\' + base;
    },
    toNamespacedPath(value) {
      if (!value) return value;
      const resolved = path.resolve(String(value));
      if (/^\\\\[?.]\\/.test(resolved)) return resolved;
      if (/^\\\\/.test(resolved)) return '\\\\?\\UNC\\' + resolved.slice(2);
      return '\\\\?\\' + resolved;
    },
    // Node 22+ `path.matchesGlob` (a small glob: `*`, `**`, `?`).
    matchesGlob(value, pattern) {
      const escape = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      const body = String(pattern).split(/[\\/]/).map((part) => {
        if (part === '**') return '.*';
        return escape(part).replace(/\*\*/g, '.*').replace(/\*/g, '[^\\\\/]*').replace(/\?/g, '[^\\\\/]');
      }).join('[\\\\/]');
      try { return new RegExp('^' + body + '$', 'i').test(String(value)); } catch { return false; }
    },
  };
  path.win32 = path;

  // Node's POSIX flavour is still reachable for code that asks for it.
  const normalizePosix = (parts, allowAboveRoot) => {
    const out = [];
    for (const p of parts) {
      if (!p || p === '.') continue;
      if (p === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (allowAboveRoot) out.push('..'); }
      else out.push(p);
    }
    return out;
  };
  const posix = {
    sep: '/', delimiter: ':',
    isAbsolute: (p) => String(p).startsWith('/'),
    normalize(p) {
      p = String(p); if (!p) return '.';
      const abs = p.startsWith('/'), trailing = p.endsWith('/');
      let r = normalizePosix(p.split('/'), !abs).join('/');
      if (!r && !abs) r = '.';
      if (r && trailing) r += '/';
      return (abs ? '/' : '') + r;
    },
    join(...parts) { const j = parts.filter((x) => typeof x === 'string' && x).join('/'); return j ? posix.normalize(j) : '.'; },
    resolve(...parts) {
      let resolved = '', abs = false;
      for (let i = parts.length - 1; i >= -1 && !abs; i--) {
        const p = i >= 0 ? String(parts[i]) : (defaultCwd || '/');
        if (!p) continue;
        resolved = p + '/' + resolved; abs = p.startsWith('/');
      }
      resolved = normalizePosix(resolved.split('/'), !abs).join('/');
      return ((abs ? '/' : '') + resolved) || '.';
    },
    dirname(p) {
      p = String(p); if (!p) return '.';
      const trimmed = p.replace(/\/+$/, '') || '/';
      const i = trimmed.lastIndexOf('/');
      if (i === -1) return '.'; if (i === 0) return '/';
      return trimmed.slice(0, i);
    },
    basename(p, ext) {
      let b = String(p).replace(/\/+$/, ''); b = b.slice(b.lastIndexOf('/') + 1);
      if (ext && b.endsWith(ext) && b !== ext) b = b.slice(0, -ext.length);
      return b;
    },
    extname(p) { const b = posix.basename(p); const i = b.lastIndexOf('.'); return i <= 0 ? '' : b.slice(i); },
    relative(from, to) {
      const f = posix.resolve(from).split('/').filter(Boolean), t = posix.resolve(to).split('/').filter(Boolean);
      let i = 0; while (i < f.length && i < t.length && f[i] === t[i]) i++;
      return [...Array(f.length - i).fill('..'), ...t.slice(i)].join('/');
    },
    parse(p) {
      const root = String(p).startsWith('/') ? '/' : '', base = posix.basename(p), ext = posix.extname(p);
      return { root, dir: posix.dirname(p), base, ext, name: ext ? base.slice(0, -ext.length) : base };
    },
    format(o) { const dir = o.dir || o.root || ''; const base = o.base || ((o.name || '') + (o.ext || '')); return dir ? (dir === o.root ? dir + base : dir + '/' + base) : base; },
    toNamespacedPath: (p) => p,
    matchesGlob(value, pattern) {
      const escape = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      const body = String(pattern).split('/').map((part) => {
        if (part === '**') return '.*';
        return escape(part).replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
      }).join('/');
      try { return new RegExp('^' + body + '$').test(String(value)); } catch { return false; }
    },
  };
  posix.posix = posix;
  posix.win32 = path;
  path.posix = posix;

  // ---- electron-store (sync JSON file at <userData>/<name>.json) ----
  // Mirrors the preload's `$zelectron.getElectronStore(opts)`: one cached
  // instance per name, dot-path keys, synchronous reads and writes.
  const sync = (p, args) => window.__zaloBridge.callSync(p, args);
  const getPathValue = (obj, key) => String(key).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  const setPathValue = (obj, key, value) => {
    const parts = String(key).split('.'); let o = obj;
    for (const k of parts.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; }
    o[parts[parts.length - 1]] = value;
  };
  const deletePathValue = (obj, key) => {
    const parts = String(key).split('.'); let o = obj;
    for (const k of parts.slice(0, -1)) { if (o == null) return; o = o[k]; }
    if (o) delete o[parts[parts.length - 1]];
  };
  const stores = new Map();
  function createStore(opts) {
    const name = (opts && opts.name) || 'config';
    let data = Object.assign({}, (opts && opts.defaults) || {}, sync('$zelectron.storeRead', [name]) || {});
    const listeners = new Set();
    const persist = (old) => {
      sync('$zelectron.storeWrite', [name, data]);
      // The IndexedDB-only host normalizes adapter selectors. Keep the page's
      // cache consistent with that policy even on the very first login.
      if (name === 'database-config') data = sync('$zelectron.storeRead', [name]) || {};
      for (const l of listeners) { try { l(data, old); } catch {} }
    };
    const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
    return {
      get(key, def) { if (key === undefined) return clone(data); const v = getPathValue(data, key); return v === undefined ? def : clone(v); },
      set(key, value) {
        const old = clone(data);
        if (key && typeof key === 'object') for (const [k, v] of Object.entries(key)) setPathValue(data, k, v);
        else setPathValue(data, key, value);
        persist(old);
      },
      has(key) { return getPathValue(data, key) !== undefined; },
      delete(key) { const old = clone(data); deletePathValue(data, key); persist(old); },
      clear() { const old = clone(data); data = {}; persist(old); },
      reset(...keys) { const old = clone(data); for (const k of keys) setPathValue(data, k, getPathValue((opts && opts.defaults) || {}, k)); persist(old); },
      get store() { return clone(data); },
      set store(v) { const old = clone(data); data = Object.assign({}, v); persist(old); },
      get size() { return Object.keys(data).length; },
      get path() { return sync('$zelectron.storePath', [name]); },
      onDidChange(key, cb) { const l = (n, o) => { const a = getPathValue(n, key), b = getPathValue(o, key); if (JSON.stringify(a) !== JSON.stringify(b)) cb(a, b); }; listeners.add(l); return () => listeners.delete(l); },
      onDidAnyChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
      openInEditor() {},
    };
  }
  const getElectronStore = (opts) => {
    const name = (opts && opts.name) || 'default';
    if (!stores.has(name)) stores.set(name, createStore(opts));
    return stores.get(name);
  };

  // ---- Node's `url` (file URL helpers the official image/file components use) ----
  const nodeUrl = {
    pathToFileURL(p) {
      let resolved = path.resolve(String(p)).replace(/\\/g, '/');
      let prefix = 'file:///';
      if (resolved.startsWith('//')) { prefix = 'file://'; resolved = resolved.slice(2); }
      else if (resolved.startsWith('/')) resolved = resolved.slice(1);
      const escaped = resolved.replace(/%/g, '%25').replace(/\\/g, '%5C').replace(/\n/g, '%0A').replace(/\r/g, '%0D')
        .replace(/\t/g, '%09').replace(/\?/g, '%3F').replace(/#/g, '%23');
      return new URL(prefix + escaped);
    },
    fileURLToPath(u) {
      const url = typeof u === 'string' ? new URL(u) : u;
      if (!url || url.protocol !== 'file:') throw new TypeError('The URL must be of scheme file');
      let pathname = decodeURIComponent(url.pathname);
      if (url.hostname && url.hostname !== 'localhost') {
        return '\\\\' + url.hostname + pathname.replace(/\//g, '\\');
      }
      if (/^\/[A-Za-z]:/.test(pathname)) pathname = pathname.slice(1);
      return pathname.replace(/\//g, '\\');
    },
    // Legacy `url.format`, enough for the renderer's file:// URLs
    // (`{ pathname, protocol: 'file:', slashes: true }`).
    format(object) {
      const o = object || {};
      const protocol = o.protocol || '';
      const host = o.host || (o.hostname ? o.hostname + (o.port ? ':' + o.port : '') : (o.port ? ':' + o.port : ''));
      let pathname = o.pathname || '';
      if (protocol === 'file:' && o.slashes && pathname && !pathname.startsWith('/')) pathname = '/' + pathname;
      let out = protocol;
      if (o.slashes || (host && protocol !== 'file:')) out += '//';
      if (o.auth) out += o.auth + '@';
      out += host + pathname;
      if (o.search) out += o.search;
      else if (o.query != null) out += '?' + (typeof o.query === 'string' ? o.query : new URLSearchParams(o.query).toString());
      if (o.hash) out += o.hash;
      return out;
    },
  };

  // ---- Node's `util` — only promisify is part of the preload surface ----
  const util = {
    promisify(fn) {
      if (typeof fn !== 'function') throw new TypeError('The "original" argument must be of type function');
      return function (...args) {
        return new Promise((resolve, reject) => {
          fn.call(this, ...args, (error, result) => (error ? reject(error) : resolve(result)));
        });
      };
    },
  };
  util.promisify.custom = Symbol.for('nodejs.util.promisify.custom');

  // ---- Node's `os` — values supplied by the host in the bridge spec ----
  const info = (window.__zaloBridgeSpec && window.__zaloBridgeSpec.values['$znode.os.__info']) || {};
  defaultCwd = String(info.cwd || defaultCwd);
  window.__zaloCwd = defaultCwd;
  const os = {
    EOL: '\r\n',
    platform: () => 'win32', type: () => 'Windows_NT', arch: () => info.arch || 'x64',
    release: () => info.release || '10.0.26100', version: () => info.version || 'Windows 11',
    hostname: () => info.hostname || 'Olaz',
    homedir: () => info.homedir || 'C:\\Users\\Olaz', tmpdir: () => info.tmpdir || 'C:\\Temp',
    endianness: () => 'LE',
    totalmem: () => info.totalmem || 0, freemem: () => info.freemem || 0, uptime: () => info.uptime || 0,
    cpus: () => Array.from({ length: info.cpus || 1 }, () => ({ model: info.cpuModel || 'x64', speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } })),
    loadavg: () => [0, 0, 0],
    networkInterfaces: () => {
      const out = {};
      for (const [name, addrs] of (info.networkInterfaces ? JSON.parse(info.networkInterfaces) : [])) out[name] = addrs;
      return out;
    },
    userInfo: () => ({ username: info.username || '', homedir: info.homedir || 'C:\\Users', shell: info.comspec || 'C:\\Windows\\system32\\cmd.exe', uid: -1, gid: -1 }),
    constants: { signals: {}, errno: {} },
  };

  // ---- webFrame/process stats the preload read synchronously ----
  const usage = () => { const z = { count: 0, size: 0, liveSize: 0 }; return { images: z, scripts: z, cssStyleSheets: z, xslStyleSheets: z, fonts: z, other: z }; };

  // ---- Node crypto stateful objects (state lives in the Rust host) ----
  const cipher = (kind, alg, key, iv) => {
    const h = sync('$znode.crypto.__cipherCreate', [kind, alg, key, iv]);
    const obj = {
      update: (data, inEnc, outEnc) => sync('$znode.crypto.__cipherUpdate', [h, data, inEnc, outEnc]),
      final: (outEnc) => sync('$znode.crypto.__cipherFinal', [h, outEnc]),
      setAutoPadding: (on = true) => { sync('$znode.crypto.__cipherOption', [h, 'autoPadding', on]); return obj; },
      setAuthTag: (tag) => { sync('$znode.crypto.__cipherOption', [h, 'authTag', tag]); return obj; },
      setAAD: (aad) => { sync('$znode.crypto.__cipherOption', [h, 'aad', aad]); return obj; },
      getAuthTag: () => sync('$znode.crypto.__cipherOption', [h, 'getAuthTag']),
    };
    return obj;
  };
  const createHash = (alg) => {
    const h = sync('$znode.crypto.__hashCreate', [alg]);
    const obj = { update: (data, enc) => { sync('$znode.crypto.__hashUpdate', [h, data, enc]); return obj; }, digest: (enc) => sync('$znode.crypto.__hashDigest', [h, enc]) };
    return obj;
  };

  // ---- $zFeatures.fileRes (preload module Hz92) ----
  let keepDel = null;
  const createKeepDelDb = (initialConfig) => {
    if (!keepDel) {
      keepDel = {
        config: initialConfig || {}, data: null, pending: [], trans: 0,
        get storeName() { return 'keepdel-' + String(this.config.db_name || 'db').replace('$0$', this.config.userId || '') .replace(/[^\w.-]/g, '_'); },
        load() { if (!this.data) { const s = sync('$zelectron.storeRead', [this.storeName]) || {}; this.data = Array.isArray(s.items) ? s.items : []; } },
        save(force) {
          if (!this.data) return;
          const limit = this.config.keep_limit || 5000, batch = this.config.trans_batch || 1;
          if (!force && this.trans < batch) return;
          this.trans = 0;
          if (this.data.length > limit) this.data.splice(0, this.data.length - limit);
          sync('$zelectron.storeWrite', [this.storeName, { items: this.data }]);
        },
        add(item, front) {
          if (!item) return;
          this.trans++;
          if (!this.data) { this.pending.push(item); return; }
          for (const it of [...this.pending.splice(0), item]) { const json = JSON.stringify(it); front ? this.data.unshift(json) : this.data.push(json); }
          this.save(false);
        },
      };
    }
    keepDel.config = Object.assign({}, keepDel.config, initialConfig || {});
    return {
      loadConfig: (c) => { keepDel.config = Object.assign({}, keepDel.config, c || {}); },
      setup: () => { keepDel.load(); },
      destroy: () => { keepDel.save(true); keepDel.data = null; keepDel.trans = 0; },
      uninstall: async () => { keepDel.data = []; sync('$zelectron.storeWrite', [keepDel.storeName, { items: [] }]); },
      connect: async () => { keepDel.load(); },
      unshift: (item) => keepDel.add(item, true),
      push: (item) => keepDel.add(item, false),
      pop: () => { if (!keepDel.data) return undefined; keepDel.trans++; const v = keepDel.data.pop(); keepDel.save(false); try { return v ? JSON.parse(v) : undefined; } catch { return undefined; } },
    };
  };
  const createDetachCleaner = (target) => ({
    start: () => window.__zaloBridge.callAsync('$znode.fsExtra.remove', [String(target)]).then(() => 0, () => 0),
    stop: () => Promise.resolve(),
  });

  // ---- Native-module features without a native module here ----
  const unsupported = (name) => () => Promise.reject(Object.assign(new Error("Cannot find module '" + name + "'"), { code: 'MODULE_NOT_FOUND' }));

  // ---- MetriczGlobal: process stats ----
  const metrics = {
    getProcessStats: () => ({ heapUsed: 0, heapTotal: 0, rss: 0, cpu: 0 }),
    getProcessMemory: () => 0,
    startCPUMonitor: () => {}, stopCPUMonitor: () => {}, getCPUUsage: () => 0,
    onCPUChange: () => {}, removeCPUChangeListener: () => {},
    getArch: () => (info.arch === 'x64' ? 'x64' : 'arm64'),
  };

  // `$zsqlite` (preload-shared-worker only): native sqlite3 binding behind the
  // message search index and the phone-backup reader. This host has no SQLite
  // backend (storage is forced to IndexedDB), so every call fails the way a
  // missing native lib does; the bundle only needs the global to exist.
  const noSqlite = (what) => Promise.reject(Object.assign(new Error('SQLite is not available (' + what + ')'), { code: 'ENOTSUP' }));
  const sqliteMethods = ['openDb', 'query', 'queryV2', 'queryGlobalMessage', 'queryGlobalMessageV2', 'queryGlobalMessageV3', 'queryGlobalMessageV4',
    'deleteRow', 'deleteRows', 'write', 'writev2', 'pureQuery', 'prepareInsertSearch', 'prepareDeleteSearch', 'getConversationMatch', 'flushDb',
    'flushDbBatchv2', 'flushDbBatch', 'closeDb', 'finalizeInsertStatement', 'finalizeDeleteStatement', 'doListSqls', 'createKey', 'initDebug', 'countTotal'];
  const sqliteConnection = () => new Proxy({}, { get: (_c, m) => (typeof m === 'string' && /^(open|close|run|get|each|all|exec|prepare)/.test(m)) ? () => noSqlite(m) : undefined });
  const sqliteStub = {
    isLoadedLib: () => false,
    isDbTransactionStepError: () => false,
    createConnection: sqliteConnection,
  };
  for (const m of sqliteMethods) sqliteStub[m] = () => noSqlite(m);

  window.__zaloLocal = {
    '$zsqlite': sqliteStub,
    'MetriczGlobal': metrics,
    '$zpreload.triggerWindowLoadedEvent': () => undefined,
    '$zcommon.send': () => undefined,
    '$zcommon.receive': () => undefined,
    '$zcommon.remove': () => undefined,
    '$zelectronNative.lockWebframeZoom': () => undefined,
    '$zelectronNative.setZoomFactor': () => undefined,
    '$zelectronNative.getClipboardText': () => sync('$zelectronNative.clipboardText', []) || '',
    '$zelectronNative.writeTextToClipboard': (text) => { sync('$zelectronNative.clipboardWriteText', [String(text == null ? '' : text)]); },
    '$zelectronNative.availableClipboardFormats': () => sync('$zelectronNative.clipboardFormats', []) || [],
    '$zelectronNative.readClipboard': () => '',
    '$zelectronNative.getClipboardImage': () => ({ isEmpty: () => true, toJPEG: () => new Uint8Array(0), toPNG: () => new Uint8Array(0) }),
    '$zFeatures.libvips.resizeImage': unsupported('libvips'),
    '$zFeatures.libjxl.decodeToJpeg': unsupported('libjxl'),
    '$zFeatures.libjxl.encodeJxl': unsupported('libjxl'),
    '$zFeatures.libjxl.getJxlInfo': unsupported('libjxl'),
    '$zFeatures.libjxl.jxlDecompressMulti': unsupported('libjxl'),
    '$zFeatures.libjxl.moduleReady': () => Promise.resolve(false),
    '$zFeatures.fileRes.createKeepDelDb': createKeepDelDb,
    '$zFeatures.fileRes.createDetachCleaner': createDetachCleaner,
    '$znode.crypto.createCipheriv': (alg, key, iv) => cipher('cipher', alg, key, iv),
    '$znode.crypto.createDecipheriv': (alg, key, iv) => cipher('decipher', alg, key, iv),
    '$znode.crypto.createHash': createHash,
    '$znode.path': path,
    '$znode.url': nodeUrl,
    '$znode.util': util,
    '$znode.os': os,
    '$zelectron.getElectronStore': getElectronStore,
    '$zelectronNative.getResourceUsage': usage,
    '$zelectronNative.clearCache': () => {},
    '$zelectronNative.getAvailableHeapSize': () => 4 * 1024 * 1024 * 1024,
    // Native .node addons: synchronous factories returning addon objects whose
    // methods are implemented by the Rust host under $znode.nativelibs.<addon>.*
    '$znode.nativelibs.fileUtilities': () => window.$znode.nativelibs.fileUtilitiesAddon,
    '$znode.nativelibs.fileUtils': () => window.$znode.nativelibs.fileUtilsAddon,
    '$znode.nativelibs.dbUtils': () => window.$znode.nativelibs.dbUtilsAddon,
    '$znode.nativelibs.zcall': () => window.$znode.nativelibs.zcallAddon,
  };
})();
