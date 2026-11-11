// Olaz media-store adapter: exposes `window.__zaloMediaStore` on the main page (index.html) only. It reads the photos /
// videos, files and links ever shared in a conversation from the official client's own media service — the one behind
// the "Kho lưu trữ" panel (STR_TITLE_RIGHT_MENU_SHARED_MEDIA) — instead of the messages loaded in the chat box.
//
//   Service   webpack module "dEOl" (found by shape when the id changes between versions): `exports.MEDIA_TYPE`
//             {images, files, links} and `exports.default`, a singleton with
//       getChatMedia(convId, kind, lastId, limit, options) → Promise<{items, isSupportedLoadMediaFromMessage, hasMore?}>
//             Reads the local media DB (filled by synced / received messages). `kind` is 'images' | 'files' | 'links'.
//             `lastId` = server msgId of the oldest item already held (null for the first page; the DB index orders msgIds by
//             string length, then string). `limit` is only a hint (a request for 10–30 photos may return 50) and items are not
//             strictly sorted by date. An empty page is the end. `options` is always {} here.
//             NOT used: the panel's "load more" button passes {loadMediaFromCloudMessages: true} when a result says
//             `isSupportedLoadMediaFromMessage`. In the bundle that branch ignores `lastId`: it walks the cloud MESSAGE history with
//             its own per-session cursor (`_oldestMessageLoaded`), answers {hasMore: true, items: []} for segments that hold no
//             media of the kind, spends that cursor on every first-page refresh, and races between kinds. It cannot serve a
//             cursor-paged list that is read again after every new message, so only the local DB is listed.
//       activateConversation(convId) / deactivateConversation(convId)
//             The panel keeps the conversation active in a Set (`_activeConversationList`) while it is shown; reads are done
//             inside the same window and the conversation is deactivated again unless something else had activated it.
//   Item      {mediaId, msgId, cliMsgId, fromUid ('0' = me), userId (conversation), sendDttm (ms), type 'image'|'file'|'link',
//             subType (images: 1 photo, 2 video, 3 doodle), width, height, localPath,
//             message: {title, description, href, thumb, thumbUrl, oriUrl, hdUrl, normalUrl, duration, params (JSON string)}}
//             params — image: rawUrl, is_original, width, hd, height, duration · file: fileSize, checksum, fileExt, fType (2 = folder)
//             · link: mediaTitle, src, streamUrl…
//
// Swift → JS : page(convId, kind, cursor, limit) → Promise<{items:[ChatMessageJSON], cursor: string|null, more: bool} | null>
//                (null = the service is unavailable or failed — not "nothing shared". `items` newest first, ChatMessageJSON as in
//                chat-adapter.js with the same message ids (mine: client message id, others: server msgId) so a loaded message
//                and its store item merge. `cursor` = oldest server msgId of the page, to pass back for the next one; `more`
//                false at the end or when the page made no progress.)
//              item(convId, msgId) → the raw store item of a recently listed photo / video (id as listed, server msgId or client id;
//                the last ~600 per conversation, a few conversations), or null. chat-adapter.js `resolveMedia` uses it for photos of
//                messages that are not loaded in the chat box.
(() => {
  'use strict';
  if (window.__zaloMediaStore) return;
  if (location.pathname.split('/').pop() !== 'index.html') return;

  const diag = (s) => { try { window.webkit.messageHandlers.zlog.postMessage('[media-store] ' + s); } catch {} };
  const safe = (fn, d) => { try { const v = fn(); return v === undefined ? d : v; } catch { return d; } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const str = (v) => (typeof v === 'string' ? v : '');
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.max(-Number.MAX_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, n)) : 0; };
  const seconds = (d) => { const n = num(d); return n > 600 ? Math.round(n / 1000) : Math.round(n); };
  const scrubErr = (e) => String((e && (e.name + ':' + e.message)) || e).replace(/https?:\/\/\S+/g, '<url>').replace(/\d{5,}/g, '<id>').slice(0, 80);
  const parseJSON = (v) => { if (v && typeof v === 'object') return v; if (typeof v !== 'string' || !v) return {}; try { const r = JSON.parse(v); return r && typeof r === 'object' ? r : {}; } catch { return {}; } };
  const isFakeId = (id) => !id || String(id).includes('_') || String(id) === '0';
  // The DB index order of msgIds: shorter strings first, then plain string order.
  const cmpId = (a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0);

  // Chat adapter internals (names, "is it me", URL cleaning); the adapter is injected before this one.
  const core = () => safe(() => window.__zaloChat.__core, null) || {};
  const isMe = (uid) => safe(() => core().isMeUid(uid), uid === '0');
  const absUrl = (v) => safe(() => core().absUrl(v), '') || '';
  const domainOf = (u) => { const m = /^https?:\/\/([^/?#]+)/i.exec(str(u)); return m ? m[1].replace(/^www\./i, '') : ''; };

  // ---- service ----
  const KINDS = ['images', 'files', 'links'];
  const isService = (s) => !!s && typeof s === 'object' && ['getChatMedia', 'activateConversation', 'deactivateConversation'].every((k) => typeof s[k] === 'function');
  const fitsModule = (ex) => !!ex && typeof ex === 'object' && !!ex.MEDIA_TYPE && typeof ex.MEDIA_TYPE === 'object' && isService(ex.default);
  let svc = null, lastScan = 0;
  const resolveService = () => {
    if (svc) return svc;
    const req = window.__zaloRequire;
    if (!req) return null;
    const known = safe(() => req.c['dEOl'].exports, null);
    if (fitsModule(known)) return (svc = known.default);
    // The module id can change between Zalo versions: look for the shape (misses are not rescanned for 3s).
    if (Date.now() - lastScan < 3000 || typeof window.__zaloEachExport !== 'function') return null;
    lastScan = Date.now();
    safe(() => window.__zaloEachExport(req, (ex) => {
      if (svc || !ex || typeof ex !== 'object') return;
      try { if (fitsModule(ex)) svc = ex.default; } catch {}
    }), null);
    if (svc) diag('service resolved by shape');
    return svc;
  };
  const ready = async (timeout = 6000) => {
    const end = Date.now() + timeout;
    for (;;) {
      const s = resolveService();
      if (s) return s;
      if (Date.now() >= end) return null;
      await sleep(300);
    }
  };

  // The conversation stays active while reads are in flight (reads of one conversation overlap: the first starts the hold, the last
  // ends it). One that was already active when the first read began (`_activeConversationList`) is left active.
  const holds = new Map();
  const hold = (s, convId) => {
    let h = holds.get(convId);
    if (!h) {
      const set = s._activeConversationList;
      h = { n: 0, ours: !(set instanceof Set && set.has(convId)) };
      if (h.ours) safe(() => s.activateConversation(convId), null);
      holds.set(convId, h);
    }
    h.n++;
    return () => {
      if (--h.n > 0) return;
      holds.delete(convId);
      if (h.ours) safe(() => s.deactivateConversation(convId), null);
    };
  };

  // ---- item mapping (ChatMessageJSON as chat-adapter.js `mapOne` emits it for the same message) ----
  const myAvatar = () => safe(() => window.__zaloStore.getState().user.avatar, '') || '';
  const TYPE_OF = { images: 'image', files: 'file', links: 'link' };
  const mapItem = (it, convId, listKind) => {
    const type = str(it.type) || TYPE_OF[listKind];
    const o = it.message && typeof it.message === 'object' ? it.message : {};
    const p = parseJSON(o.params);
    let kind, text;
    if (type === 'image') {
      const sub = Number(it.subType);
      if (sub === 2) {
        kind = { type: 'video', thumbnail: str(o.thumbUrl) || str(o.thumb), url: str(o.oriUrl) || str(o.href) || str(o.videoUrl), duration: seconds(p.duration || o.duration) };
        text = '[Video]';
      } else if (sub === 3) {
        kind = { type: 'photo', url: str(o.href) || str(o.thumb), width: num(p.width || it.width), height: num(p.height || it.height) };
        text = '[Vẽ hình]';
      } else {
        kind = { type: 'photo', url: str(o.normalUrl) || str(o.hdUrl) || str(o.oriUrl) || str(o.thumbUrl) || str(o.href) || str(o.thumb), width: num(p.width || o.width || it.width), height: num(p.height || o.height || it.height) };
        text = str(o.title) || '[Hình ảnh]';
      }
    } else if (type === 'file') {
      kind = { type: 'file', name: str(o.title), size: num(p.fileSize || o.fileSize), url: str(o.href) };
      text = Number(p.fType) === 2 ? '[Thư mục]' : '[Tệp]';
    } else if (type === 'link') {
      const href = absUrl(o.href); // only http(s) is ever opened, as in the chat cards
      if (!href) return null;
      const desc = str(o.description), title = str(o.title);
      const showDesc = desc && (!title || title.indexOf(desc.split('...')[0]) < 0);
      kind = { type: 'link', title: str(p.mediaTitle) || href, url: href, thumbnail: absUrl(o.thumb) || absUrl(p.thumb), description: showDesc ? desc : '', source: str(p.src) || domainOf(href) };
      text = title || '[Link] ' + href;
    } else return null;

    const fromUid = String(it.fromUid ?? '');
    const mine = isMe(fromUid);
    const cli = String(it.cliMsgId ?? '');
    const validCli = cli && cli !== '0' && cli !== 'undefined';
    const server = String(it.msgId ?? '');
    const id = mine ? (validCli ? cli : server) : (!isFakeId(server) ? server : cli);
    if (!id) return null;
    let ts = num(it.sendDttm);
    if (ts && ts < 1e12) ts *= 1000;
    const me = safe(() => core().meNow(), '') || '';
    return {
      id, conversationId: convId, senderId: mine ? me : fromUid,
      senderName: mine ? (safe(() => core().myName(), '') || '') : (str(it.dName) || safe(() => core().nameOf(fromUid), '') || ''),
      senderAvatar: mine ? myAvatar() : (safe(() => core().avatarOf(fromUid), '') || ''),
      isMine: mine, kind, text, date: ts, status: 'sent', quote: null, reactions: [], mentions: [],
      isE2EE: num(it.e2eeStatus) >= 3000 && num(it.e2eeStatus) < 4000,
    };
  };

  // Raw items of recently listed photos / videos (the only ones `item()` is asked for), for the official downloader: per conversation the
  // last MAX_ITEMS listed, and the last MAX_CONVS conversations listed from (least recently used dropped first). An item is found by the id
  // it was listed under, its server msgId and its client message id.
  const MAX_ITEMS = 600, MAX_CONVS = 4;
  const known = new Map(); // convId → { byId: Map(id → {raw, keys}), alias: Map(key → id) }
  const bucketFor = (convId) => {
    let b = known.get(convId);
    if (b) known.delete(convId); else b = { byId: new Map(), alias: new Map() };
    known.set(convId, b);
    while (known.size > MAX_CONVS) known.delete(known.keys().next().value);
    return b;
  };
  const validKey = (k) => !!k && k !== '0' && k !== 'undefined';
  const forget = (b, id) => {
    const rec = b.byId.get(id);
    if (!rec) return;
    b.byId.delete(id);
    for (const k of rec.keys) if (b.alias.get(k) === id) b.alias.delete(k);
  };
  const remember = (b, raw, id) => {
    forget(b, id);
    const keys = [...new Set([id, String(raw.msgId ?? ''), String(raw.cliMsgId ?? '')])].filter(validKey);
    b.byId.set(id, { raw, keys });
    for (const k of keys) b.alias.set(k, id);
    while (b.byId.size > MAX_ITEMS) forget(b, b.byId.keys().next().value);
  };
  const item = (convId, msgId) => {
    const b = known.get(String(convId));
    const id = b && b.alias.get(String(msgId));
    const rec = id !== undefined ? b.byId.get(id) : null;
    if (!rec) return null;
    b.byId.delete(id); b.byId.set(id, rec); // used: kept longer
    return rec.raw;
  };

  const withTimeout = (p, ms) => Promise.race([Promise.resolve(p), sleep(ms).then(() => { throw new Error('timeout'); })]);

  const page = async (convId, kind, cursor, limit) => {
    convId = String(convId ?? ''); kind = String(kind ?? '');
    if (!convId || !KINDS.includes(kind)) return null;
    const s = await ready();
    if (!s) { diag('page: service not found'); return null; }
    const n = Math.max(1, Math.min(100, Math.floor(num(limit)) || 30));
    const last = cursor === null || cursor === undefined || cursor === '' ? null : String(cursor);
    const release = hold(s, convId);
    try {
      const res = await withTimeout(s.getChatMedia(convId, kind, last, n, {}), 25000);
      const list = Array.isArray(res && res.items) ? res.items : [];
      let bucket = null;
      const seen = new Set(), items = [];
      let oldest = null;
      for (const raw of list) {
        if (!raw || typeof raw !== 'object') continue;
        const sid = String(raw.msgId ?? '');
        if (!isFakeId(sid) && (oldest === null || cmpId(sid, oldest) < 0)) oldest = sid;
        const j = safe(() => mapItem(raw, convId, kind), null);
        if (!j || seen.has(j.id)) continue;
        seen.add(j.id); items.push(j);
        if (kind === 'images') remember(bucket = bucket || bucketFor(convId), raw, j.id);
      }
      items.sort((a, b) => (b.date - a.date) || cmpId(b.id, a.id));
      const more = list.length > 0 && oldest !== null && oldest !== last;
      return { items, cursor: oldest, more };
    } catch (e) {
      diag('page ' + kind + ': ' + scrubErr(e));
      return null;
    } finally {
      release();
    }
  };

  window.__zaloMediaStore = {
    page,
    item,
  };
})();
