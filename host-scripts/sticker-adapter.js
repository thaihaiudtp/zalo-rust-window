// Olaz sticker adapter: the sticker picker of the composer and the sticker suggestions while typing. index.html only.
// Exposes `window.__zaloSticker`. It attaches to `window.__zaloChat` (chat-adapter.js `__core`) and to the sticker internals of
// card-actions-adapter.js (`__cardCore`: the official sticker modules, the send path with its one-send-per-conversation slot).
//
// Where the official client keeps each piece (offsets in the main renderer bundle):
//   sticker manager       singleton "Q" ~15621772 (found by shape: getSingleCategory / fetchCateIfNotEnoughSticker / getStickerIfNotExist)
//     getDownloadedStickerCategoriesV2  ~15637831  the user's categories in their own order (what the dock's data model P.i loads, ~10421205)
//     getRecentMediaItems  ~15623999  recent stickers / GIFs / guggies (`recentItemType` "_r_s" = sticker), at most 12 kept (`addStickerToRecentList`)
//     fetchCateIfNotEnoughSticker(id)   a category's stickers (`loadStickers` filters `isHideSticker`)
//     getStickerIfNotExist(cate, id)    one sticker by ids (what the search results and the suggestions are resolved with)
//     getSuggestionFromSentencesV2(text) ~15632889  keyword match of the WHOLE text against `listKeywords` (≤ `maxWords` words, no newline,
//                                       not "#…") → {keyword, keywordType}; `initSuggestStickerData(keywords, maxWords)` ~15621700 filled the list
//     getCacheStickerSearch / cacheStickerSearch   ~15634263 search cache keyed by the keyword
//   sticker service       module "dThN" default (found by fetchStickersFromList + fetchStickerCats)
//     searchSticker(text, 40) → {searchData:[{cate_id, sticker_id}]}      dock search `_startSearch` ~10454736 (debounced 500 ms)
//     fetchStickersSuggestion(keyword, type) → {sugg_sticker:[{cate_id, sticker_id}], sugg_gif, sugg_guggy}   ~8124818 (server, cached by expiry)
//     fetchStickersFromList(list)       resolves ids to sticker objects
//   suggestion handler    module "mrLe" ~13853090 `getStickerSuggestHandler(conversationId)`, driven by the chat box `_checkStickerSuggestion`
//                         ~4233057 (debounced by `sticker_post_typing.debounce`; `sticker_suggest_delay` is read into the config but never used):
//                         `checkSuggestion(text)` = V2 keyword → `fetchStickersSuggestion` → first `shortcut_suggest_config.sticker_display`
//                         (default `DEFAULT_SUGGEST_SSG_LEN`) → `fetchStickersFromList`; the same keyword as last time reuses the last result.
//                         The chat box only asks when `_enableStickerAutoSuggest` (setting below; for an end-to-end encrypted chat also only when
//                         `e2ee.sticker_suggestion`), the text is in the normal mode, not while the @mention list is open and not when
//                         `adminConfig.offCheckInput`. Encrypted chats (`isOnE2ee`) are asked differently in the official client: with
//                         `e2ee.client_sticker_suggestion` an on-device model (`checkSuggestionForE2EE`), falling back to the server check when
//                         `fallback_old_suggestion` is set and the model fails. This adapter is stricter: it has no on-device model and never uses
//                         the server fallback, so an encrypted chat (or one whose encryption state is unknown) gets no suggestions at all and the
//                         typed text never leaves the device for it.
//   after a suggestion    `_sendSuggestionSticker(sticker, byKey)` ~4299848: logAction 10704118 (text typed) / 10704119, `he.a.hitHint()` and
//                         `he.a.goodSuggest(lastSuccessSuggestText, sticker)` (module "7oip": local suggestion-ranking stats, they raise the sticker's
//                         use points; found by shape), then `_clearBoxChatAndClosePopup()` (the typed text is CLEARED, not sent), then
//                         `_sendSticker(sticker, Sticker.SUGGESTION_DEFAULT = 101, null, true)`, after the popover's `setStickerSrc(SGG_SRC_SUGGESTION = 2)`
//                         and its logAction 10704117 / 107041201..04 (position 0..3). The same logAction calls are made here when the logger
//                         (module "Yi2m", found by shape) is there. The post-typing hold (`sticker_post_typing.is_enable`) is off in the server config.
//   send sources          dock `_sendSticker` ~10449524: `Sticker[`${keyword ? 'SEARCH_' : inStore ? 'STORE_' : recent ? 'RECENT_' : ''}STICKER_SMALL_PANEL`]`
//                         = 106 category · 103 recent · 109 search (store 122, only from the store); before it the item calls `setStickerSrc`
//                         with SGG_SRC_CHATBAR (1) or, from search results, SGG_SRC_SEARCH_CHATBAR (5). Sending itself (`_sendSticker`, ~4224700)
//                         is card-actions-adapter `deliverSticker`: use count, source tracking and the recent list update happen inside it.
//   setting               "Gợi ý Sticker" (STR_SETTINGS_STICKER_SUGGEST / STR_SETTINGS_STICKER_CONTENT, settings tab UTILITIES, ~6962114): the key
//                         "auto_sticker" (module "Enw1" export `e`) in `getFlagForCurrentUser(uid, key, 1)` / `setFlagForCurrentUser(uid, key, on)`
//                         (export `g`, ~4330485); default on. The official toggle also sends `GeneralActions.SETTING_CHANGED` (module "OU7N") on the
//                         event bus (module "Ydol" `send`, ~6962301), which `setSuggestSetting` does too.
//   thumbnails            dock cell / suggestion strip show `stickerWebpUrl ?? stickerUrl` (a still PNG, size 130; ~704400, ~8101747). Animation is a
//                         sprite sheet (`stickerSpriteUrl`: `totalFrames` frames of the same size side by side, `duration` ms per frame) played when
//                         `totalFrames >= 2` (`duration || 250` ms per frame), else `stickerGifUrl` (the built-in set's GIFs); for `ext === WEBP` the
//                         `stickerSpriteUrl` is an animated WebP instead (`_getStickerUrl` ~704665). The chat bubble (`stickerURL`) draws the still PNG.
//
// Swift → JS : categories() → [{id, name, icon, count}] | null     (id -2 = "Gần đây" (recent stickers), first, only when there are some)
//              category(id) → {id, stickers:[Sticker]} | null
//              search(text) → [Sticker] | null                      (null = could not be asked)
//              suggest(convId, text) → [Sticker]                    ([] quickly when the setting is off, the chat is end-to-end encrypted or nothing matches)
//              send(convId, {cateId, id}, source, {text?, index?}) → {status, text?}
//                source: 'category' | 'recent' | 'search' | 'suggestion'  (text / index: the typed text and the strip position, for suggestion stats)
//                status: 'done' | 'locked' | 'not-open' | 'not-found' | 'error' | 'busy' | 'pending'   (as card-actions `guarded`)
//              suggestSetting() → {ok, enabled, debounce}           (debounce: the official `sticker_post_typing.debounce`, ms)
//              setSuggestSetting(on) → {ok, enabled}
//              reset()                                              (logout)
//   Sticker = {cateId, id, url, anim?}   url = `stickerWebpUrl ?? stickerUrl`, else the chat bubble's `stickerUrl + id` (chat-adapter `stickerURL`)
//     anim = {kind:'sprite', url, frames, ms} | {kind:'webp', url} | {kind:'gif', url}   only where an animated source exists
(() => {
  'use strict';
  if (window.__zaloSticker) return;
  if (location.pathname.split('/').pop() !== 'index.html') return;
  const chat = window.__zaloChat;
  const core = chat && chat.__core;
  const cc = chat && chat.__cardCore;
  if (!core || !cc) return;
  const { S, safe, str, diag, scrubErr, meNow } = core;
  const { X, real, need, within, TIMEOUT } = cc;

  const RECENT_ID = -2;                 // the dock's `RECENT_CAT`
  const RECENT_TYPE = '_r_s';           // recent item type of a sticker (`RECENT_MEDIA_ITEM_TYPE.STICKER`)
  const AUTO_STICKER_KEY = 'auto_sticker';
  // Send sources (module "Anfm" `Sticker` enum, base 100) and suggestion sources (module "1pet" `SGG_SRC_*`); values read from the live enums
  // when available.
  const SRC = { suggestionDefault: 101, recent: 103, category: 106, search: 109 };
  const SGG = { chatbar: 1, suggestion: 2, searchChatbar: 5 };
  const MAX_SUGGEST_TEXT = 200;         // UTF-16 units (JS `length`); the official matcher takes at most `maxWords` (4) words anyway
  const MAX_SEARCH = 40;                // `searchSticker(keyword, 40)`
  const MAX_STICKERS = 500;
  const DEFAULT_SUGGEST_LEN = 9;        // official default of `shortcut_suggest_config.sticker_display`
  const RECENT_NAME = 'Gần đây';        // STR_STICKER_RECENT
  // Official action-log ids of the suggestion strip (~8124500, ~4299848)
  const LOG = { typedText: 10704118, noText: 10704119, sent: 10704117, position: [107041201, 107041202, 107041203, 107041204] };

  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };

  // ---- modules found by shape; each is cached on its own and the scan stops looking for what it has ----
  const Y = { flags: null, e2eeClass: null, sources: null, stickerExt: null, logger: null, stats: null, bus: null, actions: null };
  const REQUIRED = ['flags', 'e2eeClass'];                                 // the setting and the encryption check: without them nothing is suggested
  const OPTIONAL = ['sources', 'stickerExt', 'logger', 'stats', 'bus', 'actions'];   // constants with fallbacks, stats, logs, the settings event
  let lastScan = 0, scans = 0;
  const scanY = () => {
    const missingRequired = REQUIRED.some((k) => !Y[k]);
    if (!missingRequired && OPTIONAL.every((k) => Y[k])) return;
    // The required ones are retried every second; looking for an optional one that does not exist in this build must not make every
    // keystroke walk all exports: after a few tries, once in a while.
    if (Date.now() - lastScan < (missingRequired || scans < 5 ? 1000 : 30000)) return;
    const req = window.__zaloRequire;
    if (!req || typeof window.__zaloEachExport !== 'function') return;   // not a scan yet: the page has not loaded its modules
    lastScan = Date.now();
    scans++;
    safe(() => window.__zaloEachExport(req, (ex) => {
      if (!ex || (typeof ex !== 'object' && typeof ex !== 'function')) return;
      try {
        if (!real(ex)) return;
        if (!Y.flags && ex.e === AUTO_STICKER_KEY && real(ex.g) && typeof ex.g.getFlagForCurrentUser === 'function' && typeof ex.g.setFlagForCurrentUser === 'function') Y.flags = ex;
        if (!Y.actions && real(ex.GeneralActions) && ex.GeneralActions.SETTING_CHANGED !== undefined) Y.actions = ex.GeneralActions;
        for (const o of [ex, ex.default, ex.a, ex.b]) {
          if (!o || (typeof o !== 'object' && typeof o !== 'function') || !real(o)) continue;
          // `Sticker` send-source enum (module "Anfm", export `b`) and `STICKER_EXT` (PNG 0, JPG 1, WEBP 2)
          if (!Y.sources && o.Sticker && typeof o.Sticker === 'object' && o.Sticker.STICKER_SMALL_PANEL !== undefined) Y.sources = o.Sticker;
          if (!Y.stickerExt && o.STICKER_EXT && typeof o.STICKER_EXT === 'object' && o.STICKER_EXT.WEBP !== undefined) Y.stickerExt = o.STICKER_EXT;
          // E2EE manager class (`A.a.instance().isOnE2ee(convId)`): only the class is kept; its `_instance` is read when asked (never `instance()`,
          // which logs an official error before E2EE is initialised).
          if (!Y.e2eeClass && typeof o === 'function' && typeof o.instance === 'function' && o.prototype && typeof o.prototype.isOnE2ee === 'function') Y.e2eeClass = o;
          // action logger (module "Yi2m" default), suggestion stats (module "7oip"), event bus (module "Ydol" default: send / emit / on / once /
          // subscribe / omitAll)
          if (!Y.logger && typeof o.logAction === 'function' && 'actionList' in o) Y.logger = o;
          if (!Y.stats && typeof o.hitHint === 'function' && typeof o.goodSuggest === 'function') Y.stats = o;
          if (!Y.bus && ['send', 'emit', 'on', 'once', 'subscribe', 'omitAll'].every((k) => typeof o[k] === 'function')) Y.bus = o;
        }
      } catch {}
    }), null);
  };
  const mgr = () => (need('stickerMgr') ? X.stickerMgr : null);
  const svc = () => (need('sticker') ? X.sticker : null);
  const sgg = (key) => Number(safe(() => X.consts[key], 0)) || SGG[{ SGG_SRC_CHATBAR: 'chatbar', SGG_SRC_SUGGESTION: 'suggestion', SGG_SRC_SEARCH_CHATBAR: 'searchChatbar' }[key]];
  const srcOf = (name) => { scanY(); return Number(safe(() => Y.sources[name], 0)) || 0; };

  // ---- setting ----
  const flagOn = () => {
    scanY();
    if (!Y.flags) return null;
    const v = safe(() => Y.flags.g.getFlagForCurrentUser(meNow(), Y.flags.e, 1), 1);
    return !!v && v !== '0' && v !== 'false';
  };
  const debounceMs = () => {
    const n = Number(safe(() => S.cfg.sticker_post_typing.debounce, 0));
    return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 0), 2000) : 0;
  };
  const suggestSetting = () => {
    const enabled = flagOn();
    return { ok: enabled !== null, enabled: enabled !== false, debounce: debounceMs() };
  };
  const setSuggestSetting = (on) => {
    scanY();
    if (!Y.flags) return { ok: false, enabled: flagOn() !== false };
    try {
      Y.flags.g.setFlagForCurrentUser(meNow(), Y.flags.e, !!on);
      // The official toggle then tells the rest of the client (`K.default.send(GeneralActions.SETTING_CHANGED, on)`).
      if (Y.bus && Y.actions) safe(() => Y.bus.send(Y.actions.SETTING_CHANGED, !!on), null);
    } catch (e) { diag('suggest setting ' + scrubErr(e)); }
    const now = flagOn();
    return { ok: now === !!on, enabled: now !== false };
  };

  // ---- stickers ----
  // Dock cell / strip image: `stickerWebpUrl ?? stickerUrl`; without both, the chat bubble's URL logic (chat-adapter `stickerURL`).
  const urlOf = (x, id) => core.absUrl(typeof x.stickerWebpUrl === 'string' && x.stickerWebpUrl ? x.stickerWebpUrl : x.stickerUrl)
    || core.absUrl(x.url) || core.absUrl(str(safe(() => S.cfg.stickerUrl, '')) + id);
  // The animated source, only where there is one (official `_getStickerUrl` ~704665 / `_playSticker`): for `ext === WEBP` the `stickerSpriteUrl` IS an
  // animated WebP; otherwise it is a sprite sheet of `totalFrames >= 2` pictures, `duration || 250` ms each; else `stickerGifUrl` (built-in set).
  const animOf = (x) => {
    const frames = Math.floor(num(x.totalFrames));
    const sprite = core.absUrl(x.stickerSpriteUrl);
    const webp = Number(safe(() => Y.stickerExt.WEBP, 2));
    if (sprite && num(x.ext) === webp) return { kind: 'webp', url: sprite };
    if (sprite && frames >= 2 && frames <= 200) {
      const ms = Math.round(num(x.duration));
      return { kind: 'sprite', url: sprite, frames, ms: Math.min(Math.max(Number.isFinite(ms) && ms > 0 ? ms : 250, 30), 1000) };
    }
    const gif = core.absUrl(x.stickerGifUrl);
    return gif ? { kind: 'gif', url: gif } : null;
  };
  const toItem = (x) => {
    if (!x || typeof x !== 'object') return null;
    const id = num(x.id), cateId = num(x.cateId !== undefined ? x.cateId : x.catId);
    if (!(id > 0) || !(cateId >= 0)) return null;
    const url = urlOf(x, id);
    if (!url) return null;
    const anim = animOf(x);
    return anim ? { cateId, id, url, anim } : { cateId, id, url };
  };
  const items = (list) => { scanY(); return (Array.isArray(list) ? list : []).map(toItem).filter(Boolean).slice(0, MAX_STICKERS); };
  // Recent stickers (the recent list also holds GIFs and guggies, which are not stickers; hidden ones are dropped like the dock does).
  const recentList = () => {
    const m = X.stickerMgr;
    const list = m ? safe(() => m.getRecentMediaItems(), []) : [];
    return (Array.isArray(list) ? list : []).filter((x) => x && (!x.recentItemType || x.recentItemType === RECENT_TYPE) && !x.effectId && !x.extInfo
      && !safe(() => m.isHideSticker(x), false));
  };

  const categories = async () => {
    try {
      if (!(await cc.readyCached()) || !mgr()) return null;
      const list = await within(Promise.resolve(X.stickerMgr.getDownloadedStickerCategoriesV2()).catch(() => null), 25000);
      if (!Array.isArray(list)) return null;
      const tabs = list.filter((c) => c && num(c.id) >= 0).map((c) => ({
        id: num(c.id), name: str(c.name), icon: core.absUrl(c.iconUrl), count: Math.max(0, Math.floor(num(c.totalImage)) || 0),
      }));
      const recent = items(recentList());
      if (recent.length) tabs.unshift({ id: RECENT_ID, name: RECENT_NAME, icon: '', count: recent.length });
      return tabs;
    } catch (e) { diag('categories ' + scrubErr(e)); return null; }
  };

  const category = async (id) => {
    try {
      id = num(id);
      if (!Number.isInteger(id) || id < RECENT_ID) return null;
      if (!(await cc.readyCached()) || !mgr()) return null;
      if (id === RECENT_ID) return { id, stickers: items(recentList()) };
      return { id, stickers: items(await cc.stickerList(id)) };
    } catch (e) { diag('category ' + scrubErr(e)); return null; }
  };

  // Dock search: the cache by keyword, else `searchSticker(keyword, 40)`; every hit is resolved to its sticker like `getStickerById` does.
  const search = async (text) => {
    try {
      text = str(text).trim().slice(0, 100);
      if (!text) return [];
      if (!(await cc.readyCached()) || !mgr() || !svc()) return null;
      let res = safe(() => X.stickerMgr.getCacheStickerSearch(text), null);
      if (!res) {
        res = await within(Promise.resolve(X.sticker.searchSticker(text, MAX_SEARCH)).catch(() => null), 15000);
        if (!res || res === TIMEOUT) return null;
        safe(() => X.stickerMgr.cacheStickerSearch(text, res), null);
      }
      const hits = (Array.isArray(res.searchData) ? res.searchData : []).slice(0, MAX_SEARCH);
      const found = await Promise.all(hits.map((h) => within(Promise.resolve(X.stickerMgr.getStickerIfNotExist(h.cate_id, h.sticker_id)).catch(() => null), 10000)));
      return items(found.filter((x) => x && x !== TIMEOUT && !safe(() => X.stickerMgr.isHideSticker(x), false)));
    } catch (e) { diag('search ' + scrubErr(e)); return null; }
  };

  // ---- suggestions ----
  const lastSuggest = new Map();         // convId → {keyword, list}: the handler's `lastProcessKeyword` / `lastResult`
  const suggestSeq = new Map();          // convId → latest request (a later one makes an earlier one answer [])
  // null = not known (E2EE manager not initialised / not found).
  const isE2ee = (convId) => {
    scanY();
    const inst = safe(() => Y.e2eeClass._instance, null);
    if (!inst || typeof inst.isOnE2ee !== 'function') return null;
    try { return !!inst.isOnE2ee(convId); } catch { return null; }
  };
  const suggest = async (convId, text) => {
    convId = String(convId);
    try {
      text = typeof text === 'string' ? text : '';
      if (!text.trim() || text.length > MAX_SUGGEST_TEXT || text.indexOf('\n') >= 0) { lastSuggest.delete(convId); return []; }
      if (flagOn() !== true) return [];
      if (safe(() => S.cfg.adminConfig.offCheckInput, false)) return [];
      if (!(await cc.readyCached()) || !mgr() || !svc()) return [];
      // Unknown encryption state counts as encrypted: the text must not reach the server by mistake.
      if (isE2ee(convId) !== false) return [];
      const seq = (suggestSeq.get(convId) || 0) + 1;
      suggestSeq.set(convId, seq);
      const kw = await within(Promise.resolve(X.stickerMgr.getSuggestionFromSentencesV2(text)).catch(() => null), 3000);
      if (suggestSeq.get(convId) !== seq) return [];
      if (!kw || kw === TIMEOUT || !kw.keyword) { lastSuggest.delete(convId); return []; }
      const prev = lastSuggest.get(convId);
      if (prev && prev.keyword === kw.keyword) return prev.list;
      const res = await within(Promise.resolve(X.sticker.fetchStickersSuggestion(kw.keyword, kw.keywordType)).catch(() => null), 8000);
      if (suggestSeq.get(convId) !== seq) return [];
      // No answer (timeout / error) is not cached: the next keystroke asks again.
      const answered = !!res && res !== TIMEOUT;
      const raw = answered && Array.isArray(res.sugg_sticker) ? res.sugg_sticker : [];
      const cfgLen = Number(safe(() => S.cfg.shortcut_suggest_config.sticker_display, 0));
      const max = Math.min(Math.max(Math.floor(cfgLen) || Number(safe(() => X.consts.DEFAULT_SUGGEST_SSG_LEN, 0)) || DEFAULT_SUGGEST_LEN, 1), 30);
      const resolved = raw.length ? await within(Promise.resolve(X.sticker.fetchStickersFromList(raw.slice(0, max))).catch(() => null), 8000) : [];
      if (suggestSeq.get(convId) !== seq) return [];
      const list = resolved === TIMEOUT ? [] : items(resolved);
      if (answered && resolved !== TIMEOUT) lastSuggest.set(convId, { keyword: kw.keyword, list });
      return list;
    } catch (e) { diag('suggest ' + scrubErr(e)); return []; }
  };

  // ---- sending ----
  // What `_sendSuggestionSticker` / the strip do around a suggestion send: action logs and the local suggestion stats (not a send).
  const suggestionStats = (found, ctx) => {
    scanY();
    const text = ctx && typeof ctx.text === 'string' ? ctx.text : '';
    const index = ctx && Number.isInteger(ctx.index) ? ctx.index : -1;
    const log = (id) => { if (id && Y.logger) safe(() => Y.logger.logAction(id), null); };
    log(LOG.position[index]);
    log(text.trim() ? LOG.typedText : LOG.noText);
    if (Y.stats) { safe(() => Y.stats.hitHint(), null); safe(() => Y.stats.goodSuggest(text, found), null); }
    log(LOG.sent);
  };
  const send = async (convId, sticker, source, ctx) => {
    convId = String(convId);
    try {
      const cid = num(sticker && sticker.cateId), sid = num(sticker && sticker.id);
      if (!/^g?\d{1,24}$/.test(convId) || !Number.isInteger(cid) || cid < 0 || !(sid > 0)) return { status: 'error' };
      if (!['category', 'recent', 'search', 'suggestion'].includes(source)) return { status: 'error' };
      // Same resolve-and-deliver path (and conversation slot) as the category sheet. A picker tab is always one of the user's downloaded sets,
      // so its source is the panel's (106), never the store's.
      return await cc.sendStickerById(convId, cid, sid, (found) => {
        switch (source) {
          case 'suggestion':
            suggestionStats(found, ctx);
            return { src: srcOf('SUGGESTION_DEFAULT') || SRC.suggestionDefault, sgg: sgg('SGG_SRC_SUGGESTION'), suggestion: true };
          case 'search': return { src: srcOf('SEARCH_STICKER_SMALL_PANEL') || SRC.search, sgg: sgg('SGG_SRC_SEARCH_CHATBAR') };
          case 'recent': return { src: srcOf('RECENT_STICKER_SMALL_PANEL') || SRC.recent, sgg: sgg('SGG_SRC_CHATBAR') };
          default: return { src: cc.STICKER_SMALL_PANEL_SRC || srcOf('STICKER_SMALL_PANEL') || SRC.category, sgg: sgg('SGG_SRC_CHATBAR') };
        }
      });
    } catch (e) { diag('sticker send ' + scrubErr(e)); return { status: 'error' }; }
  };

  // New session: nothing resolved for the previous account may be reused.
  const reset = () => { lastSuggest.clear(); suggestSeq.clear(); return true; };

  window.__zaloSticker = { categories, category, search, suggest, send, suggestSetting, setSuggestSetting, reset };
  diag('sticker adapter installed');
})();
