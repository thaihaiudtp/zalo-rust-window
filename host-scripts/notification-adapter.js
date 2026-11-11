// Olaz notification adapter (index.html only).
//
// The official client decides *whether* to notify (`rHyJ` OOAN class + chat `_notifyNewMessage`):
//   global toggle (`askNoti`), per-conversation mute (MuteDataManager, incl. timed mute), group vs 1-1,
//   stranger / archived / OA rules, urgent + mention rules, app-lock text ("Bạn có tin nhắn mới"),
//   "not while the app is focused" (FocusDetector / ifvisible), sound setting (`z_sound`).
// It then creates a web `Notification` (V1 path, `enable_improve_by_window_version` off) or Electron's
// `$znoti.createNotification` (V2 path). Electron/Chromium provides `window.Notification`; WKWebView's is
// inert (`permission` stays "default"), so the official code would never notify. This script:
//
//   1. replaces `window.Notification` with a shim whose `permission` mirrors macOS authorization and
//      whose constructor calls `$znoti.createNotification` (channel `_noti_create`, answered in Swift by
//      NativeNotifier → UNUserNotificationCenter). show/click/close come back on `_noti_on-*`.
//   2. routes the official notification sound (`new Audio(<static>/sound/noti.mp3).play()`, played by
//      the official code only when its sound rules allow) to Swift, which plays it natively.
//   3. exposes `window.__zaloNotification` for the native Settings UI: global toggle / sound via the
//      official helpers (same calls as the official settings page) and per-conversation mute via
//      `GlobalResolver.MuteDataManager.onMute/onUnMute` (which sync through the server).
//
// Swift → JS : setPermission(p) permissionResult(p) refresh() setEnabled(bool) setSound(bool)
//              reconcileDefaults() mute(convId, mode 1|2|3|4) unmute(convId) activity()
// JS → Swift (`zstate`): {page:'main', notification:{kind:'ready'}}
//                        {…{kind:'requestPermission'}}  {…{kind:'sound', url}}
//                        {…{kind:'settings', userId, enabled, sound, hasSoundSetting,
//                           mutes:[{id, startTime(s), duration(s, -1 = until reopened)}]}}
(() => {
  'use strict';
  if (window.__zaloNotification) return;
  if (location.pathname.split('/').pop() !== 'index.html') return;

  const post = (notification) => { try { window.webkit.messageHandlers.zstate.postMessage({ page: 'main', notification }); } catch {} };
  const diag = (s) => { try { window.webkit.messageHandlers.zlog.postMessage('[notification] ' + s); } catch {} };
  const safe = (fn, d) => { try { const v = fn(); return v === undefined ? d : v; } catch { return d; } };

  // ---------------------------------------------------------------------------------------------
  // 1. Web Notification shim
  // ---------------------------------------------------------------------------------------------
  let permission = 'default';
  const permissionWaiters = [];
  const instances = new Map();   // native id -> shim instance
  const earlyEvents = new Map(); // native id -> [type] that arrived before createNotification resolved
  let wired = false;

  const wire = () => {
    if (wired || typeof window.$znoti === 'undefined') return;
    wired = true;
    const on = (subscribe, type) => subscribe((_event, payload) => {
      const p = typeof payload === 'string' ? { id: payload } : (payload || {});
      const inst = instances.get(p.id);
      if (!inst) {
        if (!earlyEvents.has(p.id)) earlyEvents.set(p.id, []);
        earlyEvents.get(p.id).push(type);
        setTimeout(() => earlyEvents.delete(p.id), 10000);
        return;
      }
      inst._emit(type);
      if (type === 'close') instances.delete(p.id);
    });
    on((cb) => $znoti.onNotificationClick(cb), 'click');
    on((cb) => $znoti.onNotificationShow(cb), 'show');
    on((cb) => $znoti.onNotificationClose(cb), 'close');
  };

  class ZaloNotification extends EventTarget {
    constructor(title, options = {}) {
      super();
      this.title = String(title == null ? '' : title);
      this.body = options.body == null ? '' : String(options.body);
      this.tag = options.tag == null ? '' : String(options.tag);
      this.icon = options.icon == null ? '' : String(options.icon);
      this.silent = options.silent == null ? null : !!options.silent;
      this.requireInteraction = !!options.requireInteraction;
      this.data = options.data == null ? null : options.data;
      this.dir = 'auto'; this.lang = ''; this.image = ''; this.badge = ''; this.renotify = false;
      this.onclick = null; this.onshow = null; this.onclose = null; this.onerror = null;
      this._id = null; this._closeRequested = false;
      wire();
      this._created = Promise.resolve($znoti.createNotification(this.title, {
        body: this.body, icon: this.icon, tag: this.tag, silent: this.silent === true,
      })).then((id) => {
        if (!id) { this._emit('error'); return; }
        this._id = id;
        instances.set(id, this);
        for (const type of earlyEvents.get(id) || []) { this._emit(type); if (type === 'close') instances.delete(id); }
        earlyEvents.delete(id);
        if (this._closeRequested) $znoti.closeNotification(id);
      }).catch(() => { this._emit('error'); });
    }
    close() {
      this._closeRequested = true;
      if (this._id) $znoti.closeNotification(this._id);
    }
    _emit(type) {
      const event = new Event(type);
      try { this.dispatchEvent(event); } catch {}
      const handler = this['on' + type];
      if (typeof handler === 'function') { try { handler.call(this, event); } catch (e) { setTimeout(() => { throw e; }); } }
    }
    static get permission() { return permission; }
    static get maxActions() { return 0; }
    static requestPermission(callback) {
      return new Promise((resolve) => {
        const done = (p) => { try { if (typeof callback === 'function') callback(p); } catch {} resolve(p); };
        if (permission !== 'default') { done(permission); return; }
        permissionWaiters.push(done);
        post({ kind: 'requestPermission' });
      });
    }
  }
  Object.defineProperty(window, 'Notification', { value: ZaloNotification, writable: true, configurable: true });

  // ---------------------------------------------------------------------------------------------
  // 2. Notification sound (official: new Audio(staticNew + '/sound/noti.mp3').play())
  // ---------------------------------------------------------------------------------------------
  const nativePlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    try {
      const src = String(this.currentSrc || this.src || '');
      if (/^https:\/\/[^/]+\/sound\/noti\.mp3(\?|$)/.test(src)) { post({ kind: 'sound', url: src }); return Promise.resolve(); }
    } catch {}
    return nativePlay.apply(this, args);
  };

  // ---------------------------------------------------------------------------------------------
  // 3. Settings + mute through the official services
  // ---------------------------------------------------------------------------------------------
  const S = { notifier: null, sound: null, mute: null, storage: null };
  let lastResolve = 0;
  // Lazy-loading module wrappers are Proxies that answer every property with a function: only accept real APIs.
  const real = (ex) => { try { return ex.__olaz_probe__ === undefined; } catch { return false; } };
  const resolve = () => {
    if (S.notifier && S.sound && S.mute) return true;
    const req = window.__zaloRequire;
    if (!req || typeof window.__zaloEachExport !== 'function') return false;
    if (Date.now() - lastResolve < 1000) return false;
    lastResolve = Date.now();
    window.__zaloEachExport(req, (ex) => {
      try {
        if (!ex || !(typeof ex === 'function' || typeof ex === 'object') || !real(ex)) return;
        // Official OOAN notifier class (module `rHyJ`): isEnabled/setEnabled = the `askNoti` setting.
        if (!S.notifier && typeof ex === 'function' && typeof ex.createNotifyForMessages === 'function' && typeof ex.isEnabled === 'function' && typeof ex.setEnabled === 'function') S.notifier = ex;
        // Official settings helper (module `Enw1`): z_sound.
        // Official client storage (module `XS0u`): `removeCollapseBannerMuted`, which `_unMute` runs before `onUnMute`.
        for (const o of [ex, ex.default]) { if (!S.storage && o && real(o) && typeof o.removeCollapseBannerMuted === 'function' && typeof o.getConvUXVersion === 'function') S.storage = o; }
        if (!S.sound && typeof ex.isSetSound === 'function' && typeof ex.setSound === 'function' && typeof ex.hasSetSound === 'function') S.sound = ex;
      } catch {}
    });
    // Official MuteDataManager singleton (tsyringe container) — what `GlobalResolver.MuteDataManager` resolves to.
    if (!S.mute && typeof window.__zaloDI === 'function') {
      for (const reg of window.__zaloDI(req)) {
        const i = reg.instance;
        try { if (i && typeof i === 'object' && typeof i.onMute === 'function' && typeof i.onUnMute === 'function' && typeof i.isMuted === 'function') { S.mute = i; break; } } catch {}
      }
    }
    return !!(S.notifier && S.sound && S.mute);
  };
  const userId = () => safe(() => String(window.__zaloStore.getState().user.userId || ''), '');

  // Mute entries as the official MuteDataManager persists them (`<uid>_z_ml_<convId>` → JSON
  // {id, startTime, duration, systemTime, currentTime, muteMode}; times in seconds, duration -1 = until reopened).
  const readMutes = () => {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const at = key ? key.indexOf('z_ml_') : -1;
      if (at < 0) continue;
      const id = key.slice(at + 5);
      if (!id) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      let data = null;
      try { data = JSON.parse(raw); } catch {}
      if (data && typeof data === 'object') {
        out.push({ id, startTime: Number(data.startTime) || 0, duration: data.duration == null ? -1 : Number(data.duration) });
      } else if (data !== false && data !== 0 && data !== null) {
        out.push({ id, startTime: 0, duration: -1 });
      }
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : 1));
  };

  const snapshot = () => {
    const uid = userId();
    return {
      kind: 'settings', userId: uid,
      enabled: safe(() => !!S.notifier.isEnabled(uid), true),
      sound: safe(() => !!S.sound.isSetSound(uid), false),
      hasSoundSetting: safe(() => !!S.sound.hasSetSound(uid), false),
      mutes: readMutes(),
    };
  };
  let lastKey = '';
  const publish = (force) => {
    if (!resolve()) return false;
    const snap = snapshot();
    const key = JSON.stringify(snap);
    if (force || key !== lastKey) { lastKey = key; post(snap); }
    return true;
  };
  const publishSoon = () => { setTimeout(() => publish(false), 250); setTimeout(() => publish(false), 1500); };

  window.__zaloNotification = {
    setPermission(p) { permission = p === 'granted' || p === 'denied' ? p : 'default'; },
    permissionResult(p) {
      this.setPermission(p);
      permissionWaiters.splice(0).forEach((done) => done(permission));
    },
    refresh() { publish(true); },
    // Official settings page, "Cài đặt thông báo ▸ Bật/Tắt": askNoti + sound are switched together.
    setEnabled(on) {
      if (!resolve()) return;
      const uid = userId();
      S.notifier.setEnabled(uid, on ? 1 : 0);
      S.sound.setSound(uid, on ? 1 : 0);
      publishSoon(); publish(false);
    },
    setSound(on) {
      if (!resolve()) return;
      S.sound.setSound(userId(), on ? 1 : 0);
      publishSoon(); publish(false);
    },
    // The official settings page runs these two effects when it mounts (first-run defaults).
    reconcileDefaults() {
      if (!resolve()) return;
      const uid = userId();
      const notiOn = safe(() => !!S.notifier.isEnabled(uid), true) && permission === 'granted';
      const hasSound = safe(() => !!S.sound.hasSetSound(uid), false);
      const soundOn = hasSound ? safe(() => !!S.sound.isSetSound(uid), false) : notiOn;
      if (!notiOn && soundOn && !safe(() => !!S.notifier.isEnabled(uid), true)) S.sound.setSound(uid, 0);
      else if (!hasSound && notiOn && soundOn) S.sound.setSound(uid, 1);
      publishSoon();
    },
    // Context-menu actions of the official conversation list: `_mute(1|2|3|4)` / `_unMute()`.
    mute(convId, mode) {
      if (!resolve()) return;
      const m = S.mute;
      Promise.resolve(m.onMute(String(convId), Number(mode))).then(() => publishSoon(), (e) => diag('mute failed: ' + (e && e.message || e)));
    },
    unmute(convId) {
      if (!resolve()) return;
      const m = S.mute;
      // Official `_unMute`: drop the collapsed "muted" banner state, then un-mute (synced through the server).
      safe(() => S.storage && S.storage.removeCollapseBannerMuted(String(convId)), null);
      Promise.resolve(m.onUnMute(String(convId))).then(() => publishSoon(), (e) => diag('unmute failed: ' + (e && e.message || e)));
    },
    // Native user input in the SwiftUI window, forwarded as the DOM event the official activity
    // tracker (ifvisible) listens for, so "user is active in the app" matches the official client.
    activity() { try { document.dispatchEvent(new Event('touchstart')); } catch {} },
  };

  const t = setInterval(() => { try { publish(false); } catch (e) { diag('publish failed: ' + e); } }, 1500);
  window.addEventListener('beforeunload', () => clearInterval(t));
  post({ kind: 'ready' });
  diag('shim installed');
})();
