// Olaz host script — re-creates the Electron preload bridge ($z* globals)
// that the official Zalo renderer expects, backed by the Rust host.
//
// Members are declared in `__zaloBridgeSpec` (injected before this script):
// { "<global>.<member path>": "async" | "sync" | "event" | "off" | "noop",
//   values: { path: value }, ipc: { path: { channel, type } } }.
// Unknown members resolve to a logging stub so new requirements surface in the log.
//
// Transport: the page → host direction is WebView2's web message channel
// (`chrome.webview.postMessage`, always JSON text); host → page messages arrive
// through `window.__olazHostMessage` (called by Rust with `evaluate_script`).
// Synchronous preload members use a blocking XHR to the same-origin
// `/__olaz/bridge-sync` endpoint, served by the loopback HTTP thread.
(() => {
  'use strict';
  if (window.__zaloBridge) return;
  const spec = window.__zaloBridgeSpec || { members: {}, values: {}, globals: [], ipc: {} };
  const webview = window.chrome && window.chrome.webview;
  const httpMode = !webview;
  const origin = window.__olazOrigin || location.origin;
  // Pages are isolated by the host (main window / hidden shared-worker). The
  // page name lets main-process emulation route messages between them, the
  // way Electron used `webContents` identities.
  const PAGE = (() => {
    const path = location.pathname;
    if (path.endsWith('/shared-worker.html')) return 'worker';
    if (path.endsWith('/index.html') || path === '/') return 'main';
    if (path.endsWith('/login.html')) return 'login';
    return 'other';
  })();
  const post = (msg) => {
    if (msg && typeof msg === 'object') msg.page = PAGE;
    if (httpMode) {
      try {
        void fetch(origin + '/__olaz/bridge-call', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(msg),
        }).catch(() => {});
      } catch {}
      return;
    }
    try { webview.postMessage(JSON.stringify(msg)); } catch (e) { try { console.error('[bridge] post failed', e); } catch {} }
  };
  const log = (...a) => post({ kind: 'log', line: a.map(String).join(' ').slice(0, 500) });

  // Electron hands the renderer Uint8Array/ArrayBuffer through structured
  // clone; across WebView2's string-only message channel binary values are
  // tagged as base64.
  const encode = (v) => {
    if (v === undefined) return { __undefined: true };
    if (v instanceof ArrayBuffer) v = new Uint8Array(v);
    if (ArrayBuffer.isView(v)) {
      const b = new Uint8Array(v.buffer, v.byteOffset, v.byteLength); let s = '';
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
      return { __bytes: btoa(s) };
    }
    if (Array.isArray(v)) return v.map(encode);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) { if (typeof v[k] !== 'function') o[k] = encode(v[k]); }
      return o;
    }
    return typeof v === 'function' ? undefined : v;
  };
  const decode = (v) => {
    if (Array.isArray(v)) return v.map(decode);
    if (v && typeof v === 'object') {
      if (typeof v.__bytes === 'string') { const s = atob(v.__bytes); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return v.__arraybuffer ? u.buffer : u; }
      if (v.__undefined) return undefined;
      if (v.__stats) {
        const st = { size: v.size, mode: v.mode, mtimeMs: v.mtimeMs, ctimeMs: v.ctimeMs, atimeMs: v.atimeMs, birthtimeMs: v.birthtimeMs,
          mtime: new Date(v.mtimeMs), ctime: new Date(v.ctimeMs), atime: new Date(v.atimeMs), birthtime: new Date(v.birthtimeMs) };
        st.isFile = () => v.isFile; st.isDirectory = () => v.isDirectory; st.isSymbolicLink = () => v.isSymbolicLink;
        st.isSocket = () => false; st.isFIFO = () => false; st.isBlockDevice = () => false; st.isCharacterDevice = () => false;
        return st;
      }
      const o = {}; for (const k of Object.keys(v)) o[k] = decode(v[k]); return o;
    }
    return v;
  };

  // ---- asynchronous calls (promise ids) ----
  const pending = new Map();
  let nextId = 1;
  function request(kind, path, channel, args) {
    const id = nextId++;
    const msg = { kind, id, page: PAGE, args: encode(args) };
    if (path) msg.path = path;
    if (channel) msg.channel = channel;
    if (httpMode) {
      return fetch(origin + '/__olaz/bridge-call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(msg),
      }).then((response) => response.json()).then((res) => {
        if (res.error) throw toError(res.error);
        return decode(res.value);
      });
    }
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      post(msg);
    });
  }
  function settle(msg) {
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.error) entry.reject(toError(msg.error));
    else entry.resolve(decode(msg.value));
  }

  const listeners = new Map(); // event path -> Set(callback)
  // Node errors carry `code` (ENOENT, EACCES…); the host reports "CODE: detail".
  const toError = (e) => { const msg = String(e); const err = new Error(msg); const m = /^([A-Z][A-Z0-9_]+):/.exec(msg); if (m) err.code = m[1]; return err; };

  function callAsync(path, args) {
    // Node callback style: fs.access(p, mode, (err, result) => …)
    const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    const promise = request('call', path, null, args);
    if (!cb) return promise;
    if (/\.fs\.exists$/.test(path)) promise.then((r) => cb(!!r), () => cb(false)); // legacy fs.exists(p, cb(bool))
    else promise.then((r) => cb(null, r), (e) => cb(e));
    return undefined;
  }
  function callSync(path, args) {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', origin + '/__olaz/bridge-sync', false);
    xhr.send(JSON.stringify({ path, page: PAGE, args: encode(args) }));
    const res = JSON.parse(xhr.responseText || '{}');
    if (res.error) throw toError(res.error);
    return decode(res.value);
  }
  function subscribe(path, args) {
    const cb = args.find((a) => typeof a === 'function');
    if (!cb) return undefined;
    if (!listeners.has(path)) { listeners.set(path, new Set()); post({ kind: 'subscribe', path }); }
    listeners.get(path).add(cb);
    cb.__zid = cb.__zid || nextId++;
    return () => listeners.get(path) && listeners.get(path).delete(cb);
  }
  function unsubscribe(path, args) {
    // removeListenX(cb) pairs with onX(cb); without a callback, drop all.
    const target = path.replace(/\.(removeListen|removeListener|off)([A-Z])/, (m, p, c) => '.on' + c);
    const set = listeners.get(target); if (!set) return;
    const cb = args.find((a) => typeof a === 'function');
    if (cb) set.delete(cb); else set.clear();
  }

  // ---- Electron IPC emulation (table-driven preload members) ----
  // The official preload maps {apiKey, type} entries to ipcRenderer calls;
  // the Rust host plays the main process.
  const ipcListeners = new Map(); // channel -> Set(cb(event, ...args))
  const workerInbox = new Map(); // retain host pushes while worker bundles boot
  let nextV2Key = 0;
  const ipcHandlers = new Map();  // channel -> handler(event, ...args) (PROVIDE)
  const ipcEvent = () => ({ sender: null, ports: [], returnValue: undefined });
  const ipc = {
    invoke: (channel, args) => request('invoke', null, channel, args),
    send: (channel, args) => { post({ kind: 'send', channel, args: encode(args) }); },
    sendSync(channel, args) {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', origin + '/__olaz/bridge-sync', false);
      xhr.send(JSON.stringify({ channel, page: PAGE, args: encode(args) }));
      const res = JSON.parse(xhr.responseText || '{}');
      if (res.error) throw toError(res.error);
      return decode(res.value);
    },
    on(channel, cb, once) {
      if (typeof cb !== 'function') return;
      if (!ipcListeners.has(channel)) { ipcListeners.set(channel, new Set()); post({ kind: 'subscribe', channel }); }
      const wrapped = once ? (...a) => { ipcListeners.get(channel).delete(wrapped); cb(...a); } : cb;
      ipcListeners.get(channel).add(wrapped);
      const queued = workerInbox.get(channel);
      if (queued) {
        workerInbox.delete(channel);
        queueMicrotask(() => { for (const [args, extra] of queued) emitIpc(channel, args, extra); });
      }
    },
    removeAll(channel) { ipcListeners.delete(channel); },
  };
  function ipcMember(path, entry) {
    const { channel, type } = entry;
    switch (type) {
      case 'NOTIFY': case 'REQUEST': return (...a) => ipc.invoke(channel, a);
      case 'REQUEST_SYNC': return (...a) => ipc.sendSync(channel, a);
      case 'RAW_SEND': return (...a) => ipc.send(channel, a);
      case 'SUBSCRIBE': return (cb) => ipc.on(channel, cb);
      case 'SUBSCRIBE_ONCE': return (cb) => ipc.on(channel, cb, true);
      // V2 subscribers receive a key; the event carries the MessagePorts the
      // main process posted under that key (same-page host scripts only).
      case 'SUBSCRIBE_V2': return (cb) => ipc.on(channel, (event, ...a) => cb(event.v2Key || 0, event, ...a));
      case 'UNSUBSCRIBE': return () => ipc.removeAll(channel);
      case 'PROVIDE': return (handler) => { ipcHandlers.set(channel, handler); post({ kind: 'provide', channel }); };
      case 'STOP_PROVIDE': return () => { ipcHandlers.delete(channel); };
      default: return (...a) => ipc.invoke(channel, a);
    }
  }

  function member(path) {
    if (spec.ipc && spec.ipc[path]) return ipcMember(path, spec.ipc[path]);
    if (spec.values && Object.prototype.hasOwnProperty.call(spec.values, path)) return decode(spec.values[path]);
    const mode = spec.members[path];
    if (mode === 'value') return decode(spec.values[path]);
    const name = path.slice(path.lastIndexOf('.') + 1);
    const fn = (...args) => {
      switch (mode) {
        case 'async': return callAsync(path, args);
        case 'sync': return callSync(path, args);
        case 'event': return subscribe(path, args);
        case 'off': return unsubscribe(path, args);
        case 'noop': return undefined;
        case 'noop-async': return Promise.resolve(undefined);
        default:
          if (/^(on|once)[A-Z]/.test(name)) return subscribe(path, args);
          if (/^remove(Listen|Listener)/.test(name)) return unsubscribe(path, args);
          log('[bridge:missing]', path, JSON.stringify(encode(args.filter((a) => typeof a !== 'function'))).slice(0, 200));
          // Most preload members wrap ipcRenderer.invoke (→ Promise); *Sync members return plain values.
          if (/Sync$/.test(name)) return undefined;
          { const cb = args.find((a) => typeof a === 'function'); if (cb) setTimeout(() => cb(null)); }
          return Promise.resolve(undefined);
      }
    };
    return fn;
  }

  // Every bridge path is a hybrid: callable (a preload function) and indexable
  // (nested preload objects such as $znode.nativelibs.fileUtilities()).
  const resolved = new Map();
  function resolve(full) {
    if (resolved.has(full)) return resolved.get(full);
    let v;
    if (spec.values && Object.prototype.hasOwnProperty.call(spec.values, full)) v = decode(spec.values[full]);
    else if (spec.members[full] === 'value') v = decode(spec.values[full]);
    else if (window.__zaloLocal && window.__zaloLocal[full] !== undefined) v = window.__zaloLocal[full];
    else v = hybrid(full);
    resolved.set(full, v);
    return v;
  }
  function hybrid(path) {
    const fn = member(path);
    const children = () => Array.from(new Set(Object.keys(spec.members).filter((k) => k.startsWith(path + '.')).map((k) => k.slice(path.length + 1).split('.')[0])));
    return new Proxy(fn, {
      get(target, prop) {
        if (typeof prop === 'symbol') return target[prop];
        if (prop === 'then' || prop === 'toJSON' || prop === 'prototype') return undefined;
        if (prop === 'bind' || prop === 'call' || prop === 'apply') return Function.prototype[prop].bind(target);
        return resolve(path + '.' + prop);
      },
      has() { return true; },
      ownKeys() { return [...children(), 'length', 'name', 'prototype'].filter((k, i, a) => a.indexOf(k) === i); },
      getOwnPropertyDescriptor(target, prop) {
        if (prop === 'prototype' || prop === 'length' || prop === 'name') return Reflect.getOwnPropertyDescriptor(target, prop);
        return { enumerable: true, configurable: true, value: resolve(path + '.' + String(prop)) };
      }
    });
  }
  const namespace = hybrid;

  for (const g of spec.globals) {
    if (window.__zaloLocal && window.__zaloLocal[g] !== undefined) window[g] = window.__zaloLocal[g];
    else window[g] = namespace(g);
  }

  function emitIpc(channel, args, extra) {
    const set = ipcListeners.get(channel);
    if (!set || !set.size) {
      if (PAGE === 'worker') {
        const queued = workerInbox.get(channel) || [];
        if (queued.length < 256) queued.push([args, extra]);
        workerInbox.set(channel, queued);
      }
      return 0;
    }
    const decoded = decode(args || []);
    const event = Object.assign(ipcEvent(), extra || {});
    for (const cb of Array.from(set)) { try { cb(event, ...decoded); } catch (e) { setTimeout(() => { throw e; }); } }
    return set.size;
  }

  window.__zaloBridge = {
    // Main → renderer: webContents.send(channel, ...args)
    ipcEmit(channel, args) { return emitIpc(channel, args); },
    // Main → renderer: webContents.postMessage(channel, message, ports) — a V2
    // subscription event carrying MessagePorts (same-page host scripts only).
    ipcEmitPorts(channel, args, ports) {
      const set = ipcListeners.get(channel); if (!set) return 0;
      const key = ++nextV2Key;
      const data = { zChannelId: '__Z_I2M__', apiKey: channel, key };
      try { window.dispatchEvent(new MessageEvent('message', { data, origin: 'file://', source: window, ports: ports || [] })); }
      catch (e) { log('[bridge] port message failed', String(e)); }
      return emitIpc(channel, args, { ports: ports || [], v2Key: key });
    },
    // Whether the page listens on an IPC channel (host scripts emulating main-process pushes).
    ipcHasListener(channel) { const set = ipcListeners.get(channel); return !!set && set.size > 0; },
    // Main → renderer request: webContents.invoke(channel, ...args) answered by a PROVIDE handler.
    async ipcInvokeRenderer(channel, args) {
      const handler = ipcHandlers.get(channel);
      if (!handler) throw new Error('No handler registered for ' + channel);
      return encode(await handler(ipcEvent(), ...decode(args || [])));
    },
    // Host → JS events for path-keyed (non-IPC) members.
    emit(path, args) {
      const set = listeners.get(path); if (!set) return 0;
      const decoded = decode(args || []);
      for (const cb of Array.from(set)) { try { cb({ sender: null }, ...decoded); } catch (e) { setTimeout(() => { throw e; }); } }
      return set.size;
    },
    emitRaw(path, args) {
      const set = listeners.get(path); if (!set) return 0;
      const decoded = decode(args || []);
      for (const cb of Array.from(set)) { try { cb(...decoded); } catch (e) { setTimeout(() => { throw e; }); } }
      return set.size;
    },
    callAsync, callSync, log
  };

  // Host → page entry point. Rust evaluates
  // `window.__olazHostMessage({…})` for bridge responses, IPC pushes and
  // path-keyed emits.
  window.__olazHostMessage = (message) => {
    let msg = message;
    if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch { return; } }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.kind) {
      case 'response': return settle(msg);
      case 'ipc': return emitIpc(msg.channel, msg.args || []);
      case 'ipc-v2': return emitIpc(msg.channel, msg.args || [], { v2Key: msg.key, ports: [] });
      case 'emit': return window.__zaloBridge.emit(msg.path, msg.args || []);
      case 'emit-raw': return window.__zaloBridge.emitRaw(msg.path, msg.args || []);
      case 'log': try { console.log('[host]', String(msg.line || '')); } catch {} return;
      case 'navigate': try { if (msg.url) location.href = String(msg.url); } catch {} return;
      case 'reload': try { location.reload(); } catch {} return;
      case 'cookie': {
        // Same-origin cookies only: a web page cannot write another domain's
        // jar. Cross-domain cookies are set by the host through the browser's
        // debugging protocol in the Edge harness.
        try {
          const c = msg.cookie || {};
          const host = location.hostname;
          const domain = String(c.domain || '').replace(/^\./, '');
          if (domain && host !== domain && !host.endsWith('.' + domain)) return;
          const clean = (v) => String(v == null ? '' : v).replace(/[;\r\n]/g, '');
          let text = clean(c.name) + '=' + clean(c.value) + '; path=' + (c.path || '/');
          if (c.maxAge) text += '; Max-Age=' + Number(c.maxAge);
          if (c.secure) text += '; Secure';
          if (c.sameSite) text += '; SameSite=' + c.sameSite;
          document.cookie = text;
        } catch {}
        return;
      }
      case 'clear-cookies': {
        try {
          for (const part of document.cookie.split(';')) {
            const name = part.split('=')[0].trim();
            if (name) document.cookie = name + '=; path=/; Max-Age=0';
          }
        } catch {}
        return;
      }
      default: return;
    }
  };

  if (httpMode) {
    // Logs emitted before this script finished initialising were queued by the
    // console capture script; deliver them now that a transport exists.
    for (const message of window.__olazLogQueue || []) post(message);
    window.__olazLogQueue = [];

    // The host → page queue is a long poll: the request blocks until there is a
    // message (or the server's timeout), then is immediately re-issued. The
    // worker starts from the beginning of its queue so requests recorded while
    // the hidden window was still booting are not lost.
    let cursor = PAGE === 'worker' ? 0 : undefined;
    const poll = async () => {
      try {
        const query = '?page=' + encodeURIComponent(PAGE) +
          (cursor === undefined ? '' : '&after=' + encodeURIComponent(cursor));
        const response = await fetch(origin + '/__olaz/events' + query, { cache: 'no-store' });
        const data = await response.json();
        cursor = data.cursor;
        for (const event of data.events || []) {
          try { window.__olazHostMessage(event); }
          catch (e) { try { console.error('[bridge] event failed', e, event); } catch {} }
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      setTimeout(poll, 0);
    };
    poll();

    addEventListener('load', () => {
      try {
        void fetch(origin + '/__olaz/ready', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: location.href, page: PAGE }),
        }).catch(() => {});
      } catch {}
    });
  }
})();
