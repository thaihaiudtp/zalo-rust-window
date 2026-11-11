// Olaz zCloud adapter ("Quản lý dữ liệu zCloud"), index.html only. Exposes `window.__zaloCloud` and posts
// {page:'main', zcloud:{…}} via `zstate`. Everything goes through the official client's own cloud services — the
// same ones the official "Zalo Cloud" sidebar tab (`ZCLOUD_TAB`, screens MEDIA / MY_CLOUD / SETTING) uses:
//
//   usage / quota     UsageService   (`getInstance().usage(true)` → {quota, usage, plan, service_usage,
//                                     usageByConversation, usageByType, family}; server `usage` v2 + local
//                                     ZCloud DB tally, exactly the numbers of the official storage bar)
//   plan / package    CloudConfigv2 (plan: zcloud | free | grace_period | free_after_grace_period),
//                     CloudInfoService (`getInfo()` subscription, `getNameInfo()` package name),
//                     `cloud-settings` API (opt_in bit-mask, size limits, enable_offload)
//   browse            CloudService.filterAndSort(sortBy, direction, convId, {offset, limit, type, excludeConvIds})
//                     — the local ZCloud table the official media screens page through (60 per page); metadata
//                     (file name, extension, duration, size) is decrypted with the personal cloud key
//                     (`decryptCloudInfo`), as the official `useCloudItemMessage` hook does.
//   download          the official "download cloud item" function (FDxV `downloadCloudItem`): builds the request
//                     and runs `CloudService.getDownloader().downloadByCloud` → `new-download-channel`
//                     (cloud-viewer-key header + pcloud decryption in the Swift DownloadManager), written to
//                     `getzCloudCachePath(item)`.
//   delete            the same call the official "Xoá dữ liệu" confirm runs: sync-delete of the message
//                     (`deleteCloudItems`, no local shortcut) — WRITE ACTION, only on explicit user confirmation.
//   offload           `zcloud-offload-controller.changeEnableOffload` (Settings ▸ "Tự động giải phóng dung lượng")
//                     — WRITE ACTION, only on explicit user action.
//
// Swift → JS : refresh() list({convId, kind, sort, dir, offset, limit}) thumb(key) fetch(key)
//              deleteItems([key]) setOffload(bool)
// JS → Swift : partial snapshots, each key replaces that section:
//   plan:          {kind:'paid'|'free'|'grace'|'afterGrace', name, quota, usage, family, cloudMedia, messageBackup,
//                   myCloud, expireAt (ms, 0 unknown), autoRenew (bool|null), months, hasKey,
//                   optIn:{media, myCloud, backup}, enableOffload (server flag), fileLimit}
//   types:         {media:{photo, video, file, voice}, myCloud:{photo, video, file, voice}}   (bytes)
//   conversations: [{id, name, avatar, isGroup, total, lastTs (ms, 0 unknown)}]
//   settings:      {offloadEnabled, offloadAvailable, lastOffloadAt, lastOffloadSize, ttlDays}
//   changed:       Int   (bumped whenever cloud items were added / removed — Swift reloads open lists)
//   selfId:        the My Cloud conversation id
(() => {
  'use strict';
  const NAME = window.__zaloCloudTestName || '__zaloCloud';
  if (window[NAME]) return;
  if (location.pathname.split('/').pop() !== 'index.html') return;

  const post = (zcloud) => {
    if (window.__zaloCloudTestName && typeof window.__zaloCloudTestSink === 'function') { window.__zaloCloudTestSink(zcloud); return; }
    try { window.webkit.messageHandlers.zstate.postMessage({ page: 'main', zcloud }); } catch {}
  };
  const diag = (s) => { try { window.webkit.messageHandlers.zlog.postMessage('[zcloud] ' + s); } catch {} };
  const safe = (fn, d) => { try { const v = fn(); return v === undefined ? d : v; } catch { return d; } };
  const str = (v) => (typeof v === 'string' ? v : '');
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const errText = (e) => {
    if (!e) return '';
    if (typeof e === 'string') return e;
    return str(e.error_message) || str(e.message) || str(e.name) || (e.error_code ? 'Mã lỗi ' + e.error_code : (e.code ? 'Mã lỗi ' + e.code : ''));
  };

  // ---- services: webpack ids of Zalo PC 26.10.x first, then found by shape (the catch-all placeholders the host
  // answers unknown preload globals with are skipped) ----
  const S = {};
  let lastResolve = 0, resolveTries = 0;
  const mod = (id) => { try { const m = window.__zaloRequire && window.__zaloRequire.c[id]; return m ? m.exports : null; } catch { return null; } };
  const real = (ex) => !!ex && (typeof ex === 'object' || typeof ex === 'function') && safe(() => ex.__olaz_not_a_member__, undefined) === undefined;
  const klass = (ex, ...protoMethods) => typeof ex === 'function' && typeof ex.getInstance === 'function' && !!ex.prototype && protoMethods.every((m) => typeof ex.prototype[m] === 'function');
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  const byId = () => {
    const usageCls = safe(() => mod('qwfD').a, null);
    if (klass(usageCls, 'usage', 'getCloudUsageByConversation')) S.usage = S.usage || usageCls.getInstance();
    const cloudCls = safe(() => mod('/1VS').CloudService, null);
    if (klass(cloudCls, 'filterAndSort', 'downloadWithMultiSrc', 'getCloudItem')) S.cloud = S.cloud || cloudCls.getInstance();
    const cfg = safe(() => mod('t9fU').CloudConfigv2, null);
    if (klass(cfg, 'isPaidUser', 'isFreev2')) S.cfg = S.cfg || cfg.getInstance();
    const api = safe(() => mod('tP1L').a, null);
    if (api && typeof api.getCloudSettings === 'function' && typeof api.getUsageZCloudV2 === 'function') S.api = S.api || api;
    const dec = safe(() => mod('Ivja').a, null);
    if (dec && typeof dec.instance === 'function' && safe(() => typeof dec.instance().decryptCloudInfo, '') === 'function') S.dec = S.dec || dec.instance();
    const pkg = safe(() => mod('xn9U').a, null);
    if (klass(pkg, 'getFullPackageName', 'getInfo')) S.pkg = S.pkg || pkg.getInstance();
    const bw = safe(() => mod('bWos').a, null);
    if (bw && typeof bw.getzCloudCachePath === 'function' && typeof bw.getConversationIdFromCloudItem === 'function') S.bw = S.bw || bw;
    const dl = mod('FDxV');
    if (dl && typeof dl.a === 'function' && typeof dl.b === 'function' && String(dl.a).includes('Download by cloud item')) S.dl = S.dl || dl;
    // The destructive resolver is pinned: module id AND signature must match, otherwise delete stays unavailable.
    const del = safe(() => mod('akSd').e, null);
    if (typeof del === 'function') { const src = String(del); if (src.includes('enable_sync_del_msg') && src.includes('syncDeleteMessage')) S.del = S.del || del; }
    const consts = mod('u4F8');
    if (consts && consts.zCloudPlans && consts.CLOUD_EVENT_TYPES) S.consts = S.consts || consts;
    const msg = mod('1pet');
    if (msg && msg.MSG_PHOTO !== undefined && msg.MSG_VIDEO !== undefined && msg.MSG_FILE !== undefined) S.msg = S.msg || msg;
  };
  const scan = () => {
    window.__zaloEachExport(window.__zaloRequire, (ex) => {
      if (!ex || (typeof ex !== 'object' && typeof ex !== 'function') || !real(ex)) return;
      try {
        if (!S.usage && klass(ex, 'usage', 'getCloudUsageByConversation')) S.usage = ex.getInstance();
        if (!S.cloud && klass(ex, 'filterAndSort', 'downloadWithMultiSrc', 'getCloudItem')) S.cloud = ex.getInstance();
        if (!S.cfg && klass(ex.CloudConfigv2, 'isPaidUser', 'isFreev2')) S.cfg = ex.CloudConfigv2.getInstance();
        if (!S.api && typeof ex.getCloudSettings === 'function' && typeof ex.getUsageZCloudV2 === 'function') S.api = ex;
        if (!S.dec && typeof ex === 'function' && typeof ex.instance === 'function' && ex.prototype && typeof ex.prototype.decryptCloudInfo === 'function') S.dec = ex.instance();
        if (!S.pkg && klass(ex, 'getFullPackageName', 'getInfo')) S.pkg = ex.getInstance();
        if (!S.bw && typeof ex.getzCloudCachePath === 'function' && typeof ex.getConversationIdFromCloudItem === 'function') S.bw = ex;
        if (!S.dl && typeof ex.a === 'function' && typeof ex.b === 'function' && String(ex.a).includes('Download by cloud item')) S.dl = ex;
        if (!S.consts && ex.zCloudPlans && ex.CLOUD_EVENT_TYPES) S.consts = ex;
        if (!S.msg && ex.MSG_PHOTO !== undefined && ex.MSG_VIDEO !== undefined && ex.MSG_FILE !== undefined && ex.MSG_VOICE !== undefined) S.msg = ex;
        if (!S.conf && own(ex, 'sendToMeId') && own(ex, 'online_configs')) S.conf = ex;
        if (!S.conf && !S.confLite && own(ex, 'sendToMeId')) S.confLite = ex;
      } catch {}
    });
  };
  const optional = () => {
    // Offload controller (DI), settings store, hidden-chat privacy, preview manager, media TTL — all optional.
    if (!S.ctl && typeof window.__zaloDI === 'function') {
      for (const reg of window.__zaloDI(window.__zaloRequire)) {
        const i = reg.instance;
        try { if (i && typeof i === 'object' && typeof i.changeEnableOffload === 'function' && typeof i.checkBeforeOffload === 'function') { S.ctl = i; break; } } catch {}
      }
    }
    if (!S.settings) {
      const cls = safe(() => mod('y6jC').a, null);
      if (klass(cls, 'getSetting', 'updateSetting')) S.settings = cls.getInstance();
    }
    if (!S.hidden) {
      const ok = (h) => h && typeof h.enableHiddenChat === 'function' && typeof h.isThreadHidden === 'function' && typeof h.getUidsHiddenChat === 'function';
      const h = safe(() => mod('EFQ6').a, null);
      if (ok(h)) S.hidden = h;
      else window.__zaloEachExport(window.__zaloRequire, (ex) => { if (!S.hidden && real(ex) && ok(ex)) S.hidden = ex; if (!S.hidden && real(ex) && ok(safe(() => ex.a, null))) S.hidden = ex.a; });
    }
    if (!S.preview) {
      const MC = safe(() => mod('jDHv').ModuleContainer, null), pm = safe(() => mod('yzMR').PreviewDataManager, null);
      if (MC && pm) S.preview = safe(() => MC.resolve(pm), null);
    }
    if (!S.ttl) S.ttl = safe(() => mod('sy4E').a(), null);
    if (!S.friendsIO && typeof window.__zaloDI === 'function') {
      for (const reg of window.__zaloDI(window.__zaloRequire)) {
        const i = reg.instance;
        try { if (i && typeof i === 'object' && typeof i.getFriendManagerModule === 'function') { S.friendsIO = i; break; } } catch {}
      }
      if (S.friendsIO) {
        Promise.all([S.friendsIO.getFriendManagerModule(), S.friendsIO.getGroupManagerModule()]).then(([f, g]) => {
          S.friends = f.default || f; S.groups = g.default || g;
        }).catch((e) => { S.friendsIO = null; diag('friend/group modules: ' + errText(e)); });
      }
    }
  };
  const ready = () => S.usage && S.cloud && S.cfg && S.api && S.bw && S.dl && S.consts && S.msg && S.dec && S.pkg;
  const resolve = () => {
    const req = window.__zaloRequire;
    if (!req || !window.__zaloStore || typeof window.__zaloEachExport !== 'function') return false;
    if (ready()) { optional(); return true; }
    if (Date.now() - lastResolve < (resolveTries < 240 ? 500 : 15000)) return false;
    lastResolve = Date.now(); resolveTries++;
    byId();
    if (!ready()) scan();
    optional();
    if (ready()) diag('services resolved');
    return !!ready();
  };

  const selfId = () => str((S.conf || S.confLite || {}).sendToMeId) || str(safe(() => mod('NDmK').default.sendToMeId, ''));
  const myId = () => str(safe(() => window.__zaloStore.getState().user.userId, ''));

  // ---- plan ----
  const PLAN_KINDS = () => {
    const P = S.consts.zCloudPlans;
    return { [P.zcloud]: 'paid', [P.free]: 'free', [P.grace_period]: 'grace', [P.free_after_grace_period]: 'afterGrace' };
  };
  const planKind = () => PLAN_KINDS()[S.cfg.plan] || (S.cfg.isPaidUser() ? 'paid' : 'free');
  const hasKey = () => {
    const X = safe(() => mod('Vf6s').a, null);
    if (typeof X === 'function') return !!safe(() => X(), false);
    return !!safe(() => mod('TTXJ').a.pcloudKey, false);
  };

  // ---- usage ----
  const TYPE = () => ({ photo: [S.msg.MSG_PHOTO, S.msg.MSG_PHOTO_2, S.msg.MSG_DOODLE], video: [S.msg.MSG_VIDEO], file: [S.msg.MSG_FILE], voice: [S.msg.MSG_VOICE] });
  const sumTypes = (t) => {
    const out = { photo: 0, video: 0, file: 0, voice: 0 };
    const m = TYPE();
    for (const k of Object.keys(out)) out[k] = Math.max(0, m[k].reduce((a, id) => a + num(safe(() => t[id], 0)), 0));
    return out;
  };
  // Fail closed: without the official hidden-chat lookup, nothing grouped by conversation is shown (it could
  // expose "Trò chuyện ẩn").
  const hiddenReady = () => !!S.hidden;
  const hiddenIds = () => {
    if (!S.hidden || !safe(() => S.hidden.enableHiddenChat(), false)) return [];
    return safe(() => S.hidden.getUidsHiddenChat(), []) || [];
  };
  const isHidden = (id) => !!S.hidden && safe(() => S.hidden.enableHiddenChat() && S.hidden.isThreadHidden(id), true) === true;
  const avatarOf = (id, isGroup) => safe(() => isGroup ? S.groups.getAvatarGroup(id) : S.friends.getAvatar(id), '') || '';
  const nameOf = (id) => {
    const n = safe(() => S.bw.getConvName(id), '');
    return typeof n === 'string' ? n : '';
  };
  const lastTsOf = (id) => num(safe(() => S.preview.getPreviewByIDSync(id).messageTime, 0));

  const buildConversations = (usageByConv) => {
    const me = selfId(), hidden = new Set(hiddenIds().map(String)), out = [];
    for (const id of Object.keys(usageByConv || {})) {
      const row = usageByConv[id];
      if (!row || id === me || hidden.has(id) || !num(row.total)) continue;
      const isGroup = id.startsWith('g');
      out.push({ id, name: nameOf(id), avatar: avatarOf(id, isGroup), isGroup, total: num(row.total), lastTs: lastTsOf(id) });
    }
    return out.sort((a, b) => b.total - a.total);
  };

  const last = {};
  const emit = (key, value) => {
    if (value === null || value === undefined) return;
    const k = JSON.stringify(value);
    if (last[key] === k) return;
    last[key] = k;
    post({ [key]: value });
  };

  let changedSeq = 0;
  let info = null, infoAt = 0, settingsApi = null, settingsAt = 0;
  const loadInfo = async (force) => {
    if (!force && info && Date.now() - infoAt < 600000) return;
    infoAt = Date.now();
    try { info = await S.pkg.getInfo(); } catch (e) { diag('cloud info failed: ' + errText(e)); }
    try { settingsApi = await S.api.getCloudSettings(); settingsAt = Date.now(); } catch (e) { diag('cloud-settings failed: ' + errText(e)); }
  };

  let publishing = null;
  const publish = (force) => {
    if (!resolve()) return Promise.resolve();
    if (publishing) return publishing;
    publishing = (async () => {
      try {
        await loadInfo(force);
        const u = await S.usage.usage(true);
        if (u) {
          const me = selfId();
          const su = u.service_usage || {};
          const myRow = (u.usageByConversation || {})[me];
          const myTypes = sumTypes((myRow && myRow.type) || {});
          const all = sumTypes(u.usageByType || {});
          const media = {};
          for (const k of Object.keys(all)) media[k] = Math.max(0, all[k] - myTypes[k]);
          const sub = (info && info.subscription_info) || {};
          const cs = settingsApi || {};
          const optIn = num(cs.opt_in);
          let names = null;
          try { names = await S.pkg.getNameInfo(); } catch {}
          const kind = planKind();
          emit('selfId', me);
          emit('plan', {
            kind, plan: num(u.plan !== undefined ? u.plan : S.cfg.plan),
            name: str(names && names.vi) || 'zCloud',
            quota: num(u.quota), usage: Math.max(0, num(u.usage)), family: num(u.family),
            cloudMedia: num(su.cloud_media), messageBackup: num(su.message_backup),
            myCloud: num((myRow && myRow.total) || su.my_cloud),
            expireAt: num(sub.expire_time) > 0 ? num(sub.expire_time) : 0,
            autoRenew: sub.cancelled_renew === undefined && !sub.auto_renew_product_id ? null : !sub.cancelled_renew && !!sub.auto_renew_product_id,
            months: num(sub.duration_months), hasKey: hasKey(),
            optIn: { media: (optIn & 1) !== 0, myCloud: (optIn & 2) !== 0, backup: (optIn & 4) !== 0 },
            enableOffload: num(cs.enable_offload) === 1,
            fileLimit: num(cs.cloud_media_file_size_limit),
          });
          emit('types', { media, myCloud: myTypes });
          emit('conversations', hiddenReady() ? buildConversations(u.usageByConversation) : []);
          emit('hiddenLookup', hiddenReady());
        }
        emit('settings', settingsSnapshot());
        emit('loaded', true);
      } catch (e) { diag('publish failed: ' + errText(e)); }
      finally { publishing = null; }
    })();
    return publishing;
  };

  const settingsSnapshot = () => {
    const get = (k) => safe(() => S.settings.getSetting(k), undefined);
    const ttl = num(safe(() => S.ttl.getMediaTTL(), 0));
    return {
      offloadEnabled: get('enableOffload') === true,
      // Official condition (zCloud settings screen): paid plan and cloud key; the server flag is not consulted.
      offloadAvailable: !!S.ctl && safe(() => S.cfg.isPaidUser(), false) && hasKey(),
      lastOffloadAt: num(get('lastOffloadTime')), lastOffloadSize: num(get('lastOffloadSize')),
      ttlDays: ttl > 0 ? Math.round(ttl / 864e5) : 0,
    };
  };

  // ---- browsing ----
  const items = new Map();                     // zKey → raw cloud item (Swift refers to items by key)
  const metas = new Map();                     // zKey → decrypted metadata
  const remember = (raw) => {
    if (!raw || !raw.zKey) return;
    items.delete(raw.zKey); items.set(raw.zKey, raw);
    if (items.size > 6000) for (const k of items.keys()) { items.delete(k); metas.delete(k); if (items.size <= 5000) break; }
  };
  const FILTER = { photo: 'chat.photo', video: 'chat.video.msg', file: 'share.file', voice: 'chat.voice' };
  const kindOf = (raw) => {
    const t = safe(() => S.bw.normalizeMessageType(raw.zType || (raw.msgInfo && raw.msgInfo.msgType)), -1);
    const T = TYPE();
    for (const k of Object.keys(T)) if (T[k].includes(t)) return k;
    return 'other';
  };
  const metaOf = async (raw) => {
    if (metas.has(raw.zKey)) return metas.get(raw.zKey);
    const ei = (raw.mediaInfo && raw.mediaInfo.mediaExtInfo) || {};
    let d = null;
    try {
      if (ei.decryptedData) d = JSON.parse(ei.decryptedData);
      else if (ei.data && S.dec) d = JSON.parse(await S.dec.decryptCloudInfo(ei.data, (ei.encryptInfo || {}).encryptKey));
    } catch (e) { diag('decrypt meta failed: ' + errText(e)); }
    d = d || {};
    const m = { title: str(d.title) || str(d.name), ext: str(d.fileExt) || str(d.ext), duration: num(d.duration), width: num(d.width), height: num(d.height) };
    if (m.title || m.width || m.duration || m.ext) metas.set(raw.zKey, m);
    return m;
  };
  const rowOf = async (raw) => {
    const m = await metaOf(raw);
    const conv = str(safe(() => S.bw.getConversationIdFromCloudItem(raw), ''));
    return {
      key: raw.zKey, kind: kindOf(raw), conv, convName: conv === selfId() ? '' : nameOf(conv),
      size: num(raw.zSize || (raw.mediaInfo && raw.mediaInfo.mediaSize)), date: num(raw.zDate || (raw.msgInfo && raw.msgInfo.ts)),
      title: m.title, ext: m.ext, duration: m.duration, width: m.width, height: m.height,
    };
  };

  // Items removed by the user's delete: the local ZCloud table is only updated when the server echoes
  // REMOVE_CLOUD_ITEMS, so lists hide them meanwhile (official ListItemsState.excludedZKeys: over-fetch by
  // the set size and filter).
  const excluded = new Set();
  const list = async (opts) => {
    if (!resolve()) return { items: [], hasMore: false, error: 'Chưa sẵn sàng' };
    if (!hiddenReady()) return { items: [], hasMore: false, error: 'Chưa xác định được trò chuyện ẩn nên chưa thể hiển thị dữ liệu zCloud.' };
    const o = opts || {};
    const convId = str(o.convId), kind = str(o.kind);
    if (convId && isHidden(convId)) return { items: [], hasMore: false };
    const limit = Math.max(1, Math.min(200, num(o.limit) || 60));
    try {
      // Same arguments as the official ListItemsState.__load (sort 0 = DATE / 1 = SIZE, direction 0 = ASC / 1 = DESC).
      const raws = await S.cloud.filterAndSort(o.sort === 'size' ? 1 : 0, o.dir === 'asc' ? 0 : 1, convId,
        { noiseId: '', offset: Math.max(0, num(o.offset)), limit: limit + excluded.size, type: FILTER[kind] || '', excludeConvIds: convId ? [] : hiddenIds() });
      const hidden = new Set(hiddenIds().map(String));
      const kept = (raws || []).filter((r) => r && r.zKey && !excluded.has(r.zKey) && !hidden.has(str(safe(() => S.bw.getConversationIdFromCloudItem(r), ''))));
      const page = kept.slice(0, limit);
      page.forEach(remember);
      const rows = await Promise.all(page.map(rowOf));
      return { items: rows, hasMore: (raws || []).length >= limit + excluded.size };
    } catch (e) {
      diag('list failed: ' + errText(e));
      return { items: [], hasMore: false, error: errText(e) || 'Không đọc được dữ liệu zCloud' };
    }
  };

  // ---- download (official path), two lanes so thumbnails never starve an explicit open ----
  const lanes = { thumb: { max: 3, running: 0, queue: [] }, open: { max: 2, running: 0, queue: [] } };
  const pump = (lane) => {
    while (lane.running < lane.max && lane.queue.length) {
      const job = lane.queue.shift();
      lane.running++;
      job.run().then(job.res, job.rej).finally(() => { lane.running--; pump(lane); });
    }
  };
  const inflight = new Map();                  // zKey → Promise<path>
  const ensureFile = (raw, laneName) => {
    const existing = inflight.get(raw.zKey);
    if (existing) return existing;
    const lane = lanes[laneName] || lanes.open;
    const p = new Promise((res, rej) => {
      lane.queue.push({
        run: async () => {
          const path = await S.bw.getzCloudCachePath(raw);
          if (path && await S.dl.b(raw)) return path;
          await S.dl.a(raw, true);
          if (!(await S.dl.b(raw))) throw new Error('Tệp chưa được lưu về máy');
          return path;
        }, res, rej,
      });
      pump(lane);
    });
    inflight.set(raw.zKey, p);
    p.then(() => inflight.delete(raw.zKey), () => inflight.delete(raw.zKey));
    return p;
  };
  const itemOf = async (key) => {
    let raw = items.get(key);
    if (raw) return raw;
    try {
      const got = await S.cloud.getCloudItemsByZCloudKeys([key]);
      raw = Array.isArray(got) ? got[0] : got && got[key];
      if (raw && raw.zKey) { remember(raw); return raw; }
    } catch {}
    return null;
  };
  const failure = (e) => {
    const text = errText(e), code = num(e && (e.error_code || e.code));
    // Exact "gone" semantics only (HTTP 404 / 410 as the downloader reports them), like the chat media resolver.
    if (code === 404 || code === 410 || e && (e.name === 'DOWNLOAD_SERVICE_NET_404' || e.name === 'DOWNLOAD_SERVICE_NET_410')) return { state: 'expired', reason: text };
    return { state: 'unavailable', reason: text };
  };

  const THUMB_MAX = { photo: 40 << 20, video: 30 << 20 };
  const thumb = async (key) => {
    if (!resolve()) return { state: 'unavailable', reason: 'not-ready' };
    const raw = await itemOf(key);
    if (!raw) return { state: 'unavailable', reason: 'no-item' };
    const kind = kindOf(raw), size = num(raw.zSize || (raw.mediaInfo && raw.mediaInfo.mediaSize));
    if (kind !== 'photo' && kind !== 'video') return { state: 'unsupported' };
    // A video thumbnail comes from the video itself (the official tool downloads it too): only for small ones.
    if (size > THUMB_MAX[kind]) return { state: 'unsupported', reason: 'tooLarge', kind };
    try { return { state: 'ok', kind, path: await ensureFile(raw, 'thumb') }; }
    catch (e) { diag('thumb ' + kind + ' failed: ' + errText(e).slice(0, 80)); return failure(e); }
  };
  const fetchFull = async (key) => {
    if (!resolve()) return { state: 'unavailable', reason: 'not-ready' };
    const raw = await itemOf(key);
    if (!raw) return { state: 'unavailable', reason: 'no-item' };
    try {
      const path = await ensureFile(raw, 'open');
      const row = await rowOf(raw);
      return { state: 'ok', path, kind: row.kind, title: row.title, ext: row.ext, size: row.size, date: row.date, duration: row.duration };
    } catch (e) { diag('fetch failed: ' + errText(e).slice(0, 80)); return failure(e); }
  };

  // ---- write actions (never called by the adapter itself; each runs only on explicit user confirmation) ----
  let deleting = false;
  const deleteItems = async (keys) => {
    const wanted = Array.from(new Set(Array.isArray(keys) ? keys.map(String) : []));
    if (!resolve() || typeof S.del !== 'function') return { ok: false, deleted: [], failed: wanted, error: 'Tính năng xoá chưa sẵn sàng.' };
    if (deleting) return { ok: false, deleted: [], failed: wanted, error: 'Đang xoá dữ liệu, vui lòng đợi.' };
    deleting = true;
    const me = myId(), deleted = [], failed = [];
    let error = '';
    try {
      for (const key of wanted) {
        if (excluded.has(key)) { deleted.push(key); continue; }          // already deleted: never twice
        const raw = await itemOf(key);
        if (!raw || !raw.msgInfo) { failed.push(key); error = error || 'Không tìm thấy một số mục.'; continue; }
        const m = raw.msgInfo, conv = str(S.bw.getConversationIdFromCloudItem(raw)), src = String(m.srcId);
        // Exactly the entry the official `deleteCloudItems` builds for each item.
        const entry = { msgId: String(m.glbMsgId || `${m.cliMsgId}_001`), cliMsgId: String(m.cliMsgId), toUid: conv, fromUid: src === me ? '0' : src, sendDttm: num(m.ts) };
        try { await S.del(conv, entry); deleted.push(key); excluded.add(key); }
        catch (e) { failed.push(key); error = errText(e) || 'Không xoá được một số mục.'; diag('delete failed: ' + error.slice(0, 80)); }
      }
    } finally { deleting = false; }
    if (deleted.length) setTimeout(() => publish(false), 1500);
    return { ok: failed.length === 0, deleted, failed, error };
  };
  const setOffload = (enabled) => {
    if (!resolve() || !S.ctl) return { ok: false, error: 'Tính năng chưa sẵn sàng.' };
    if (!settingsSnapshot().offloadAvailable) return { ok: false, error: 'Tính năng này chỉ hoạt động khi gói zCloud đang bật và đã có khoá cloud.' };
    try { S.ctl.changeEnableOffload(!!enabled); } catch (e) { return { ok: false, error: errText(e) }; }
    emit('settings', settingsSnapshot());
    return { ok: true };
  };

  // ---- live updates ----
  let listening = false, debounce = null;
  const attach = () => {
    if (listening || !resolve()) return;
    listening = true;
    const E = S.consts.CLOUD_EVENT_TYPES;
    const refreshSoon = () => { clearTimeout(debounce); debounce = setTimeout(() => publish(false), 800); };
    const itemsChanged = () => { changedSeq++; post({ changed: changedSeq }); refreshSoon(); };
    // The server echo of a delete: the local table no longer has the rows, stop hiding them.
    const removed = (keys) => { if (Array.isArray(keys)) keys.forEach((k0) => { const k = typeof k0 === 'string' ? k0 : k0 && k0.zKey; if (k) { excluded.delete(k); items.delete(k); metas.delete(k); } }); itemsChanged(); };
    const threadRemoved = () => { excluded.clear(); itemsChanged(); };
    const on = (type, fn) => { try { S.cloud.addListener(type, fn); } catch (e) { diag('listener ' + type + ': ' + errText(e)); } };
    for (const t of [E.USAGE_UPDATED, E.CHANGE_PLAN, E.FAMILY_INFO_UPDATED, E.UPDATE_CLOUD_KEY_STATUS, E.UPDATE_INFO]) on(t, refreshSoon);
    on(E.ADD_CLOUD_ITEMS, itemsChanged);
    on(E.REMOVE_CLOUD_ITEMS, removed);
    on(E.REMOVE_THREAD_CLOUD, threadRemoved);
    setInterval(() => { emit('settings', settingsSnapshot()); }, 3000);
    setInterval(() => publish(false), 60000);
    publish(true);
  };
  const starter = setInterval(() => { attach(); if (listening) clearInterval(starter); }, 1000);

  window[NAME] = {
    refresh() { return publish(true); },
    list(opts) { return list(opts); },
    thumb(key) { return thumb(String(key)); },
    fetch(key) { return fetchFull(String(key)); },
    deleteItems(keys) { return deleteItems(keys); },
    setOffload(enabled) { return setOffload(enabled); },
  };
  diag('adapter installed (' + NAME + ')');
})();
