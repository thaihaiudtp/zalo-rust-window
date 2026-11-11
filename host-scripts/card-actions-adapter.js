// Olaz card-actions adapter: the buttons on message cards (e-cards, contact cards, OA / info messages,
// call log). Attaches to `window.__zaloChat` (chat-adapter.js, which hands over its internals as `chat.__core`)
// and exposes `window.__zaloCardActions.describe` (called by chat-adapter `mapOne`).
//
// Where the official client keeps each handler (offsets in compact-app-pc.*.js):
//   e-card buttons     message view `_sendMessageEcard(e)` ~576787: switch on `e.actionId`
//                        action.open.sendsticker  pick a random `data.stickerList` entry (or `data` itself) → `sendMessage(conv, MSG_STICKER, {id, catId, type})`
//                        action.open.sendtext     `sendMessage(conv, MSG_TEXT, data)`
//                        action.change.alias      EDIT_ALIAS modal "Yxnj" ~11937852 → native alias sheet (`aliasOpen` checks, `aliasSave` writes on confirm)
//                        action.open.inapp        group invite link (`groupLinkRegEx`) → GROUP_PREVIEW modal "AXH7" ~3793133 → native group sheet
//                                                 (`groupPreview` = group service `getGroupInfoByLink`; `groupJoin` = group manager `joinGroupByLink`)
//                        default                  action-list handler `hi/S` ~15107500 `handleAction({actionType, actionData}, {toUid})`:
//                                                 open.profile / open.chat.v2 / open.outapp / open.tab.* / open.grouplist are native here;
//                                                 open.sticker → sticker category sheet (`stickerCategory` / `stickerCategorySend`, official sticker manager);
//                                                 groupchat.open.polldetail → the poll sheet (PollViews); the handlers with an empty body in the PC build
//                                                 (`PC_NOOP`) do nothing officially either; `PC_PANEL` ones only open the PC side panel / React dialogs
//                      Buttons shown: layout 1 → `genActions` only for 1 or 2 actions; layout 2 → the first two (~246981 / ~247394).
//   sticker suggestions new-friend card `_a` / birthday `ga` / sticker card `fa` ~227500: stickers of `actions[0].data.stickerList`
//                      (`fetchStickersFromList`), click → `sendSticker(sticker, ECARD_MSG)` = chat-box controller `_sendSticker(sticker, 14)` ~4885795.
//                      Old new-friend cards (no `versionEcardNewFr` 1) show the "Xin chào" text button: `sendtext` "Chào <name>" (~213713).
//   contact card       module "F1+M" ~5102186 (buttons) + message view ~1074396 `_onAddFriend`, `_onMessaging`, `_onCall`, `_showInfoHandler`:
//                      KẾT BẠN = friend-request status check, `setFriendRequestSource(uid, ECARD, {uidTo})`, then the add-friend page
//                      (message box prefilled by `getSayHiV2`); the request itself is `__zaloContacts.sendRequest` on the user's confirmation.
//   info messages      `msginfo.actionlist` / `customMsg.actions` ~142200 (`renderAction`): labelled links → action-list handler.
//   call log           module "r6Qt" ~17553477: "GỌI LẠI" shown when params.isEnableCallback.
//   OA messages        module "9hee" ~3601526: header/child click → `openLink(href)`; `action.open.popup` opens the modal named by the row's
//                      server-supplied `popup_id` (React only, not available here).
//   ZInstant buttons   live in the downloaded template drawn by the zinstant engine (not available headless). Here: `customMsg.actions` (action-list
//                      handler) and any labelled `actions` of the metadata, run through the zinstant action handler's native types (lazy chunk 51
//                      "yUIi"): outapp / inapp link, clipboard copy, `query.show` text, sendsticker, open.profile.
//   reminder cards     v2 `ReminderEcard` module "GUnh" ~5547774 (active: `renderEcard` registered by main-startup, remote config `reminder.enabled` = 1):
//                      official controller class of module "eD/0" ~14249061 (`new N(message, convId)`: `start()`, `getState()`, `subscribe`, `respond(EVENT_STATUS)`,
//                      which calls the reminder detail service `respond`). Variants: invite (RSVP buttons / status), alert, demotedCreate / demotedAlert; hidden /
//                      pending draw nothing officially (the static card is kept here).
//
// Swift → JS : performAction(convId, msgId, ref) → Promise<{status, effect?, text?}>
//                ref: 'ecard:N' (N-th button) · 'greet' · 'info:N' · 'zns:N' · 'stk:<cateId>_<id>' (suggested sticker)
//                status: 'done' | 'effect' | 'locked' | 'unsupported' | 'not-found' | 'not-open' | 'error'
//                effect: {type:'openChat', id} | {type:'openProfile', uid} | {type:'openURL', url} | {type:'copy', text}   (Swift performs it)
//                        | sheets (Swift presents them, `CardSheet`): {type:'alias', uid, name, suggest, placeholder, max} | {type:'groupInvite', url}
//                          | {type:'stickers', cateId} | {type:'poll', pollId} | {type:'tab', tab:'chats'|'contacts'|'groups'}
//                status 'busy' / 'pending': an earlier run of the same button has not settled / did not answer within ~40 s; nothing new was started.
//                  A run is never cancelled, its slot (conv|msg|ref) stays taken until it settles, so a retry cannot send twice.
//              cardStickers(convId, msgId) → Promise<[{ref, url}]>
//              contactState(uid) → Promise<{isSelf, isFriend}>        (local data only)
//              contactProfile(uid) → Promise<{uid, name, zaloName, avatar, bio, isSelf, isFriend, isOA}>
//              prepareFriendRequest(uid, convId, via) → Promise<{state:'ready'|'requested'|'requesting'|'friend'|'self'|'error', defaultMessage, maxMessage}>
//                (the official `_onAddFriend` steps; nothing is sent. via: 'add' = the card's KẾT BẠN (source ECARD, {uidTo}), 'card' = profile opened
//                from the card (source ECARD, {toUid} for groups, as `_showUserInfo`), 'none' = profile action (no source is set). The default message
//                follows the STORED source (`getFriendRequestSource(uid).src`), which the official `setFriendRequestSource` may have kept.)
//              aliasSave(uid, name) → Promise<{ok, text}>                      (official `setAliasName`; empty name removes the alias)
//              groupPreview(link) → Promise<{state:'preview'|'member'|'error', groupId, name, avatar, totalMember, desc, community, creatorName, members, text}>
//              groupJoin(link) → Promise<{state:'joined'|'pending'|'already'|'error', groupId?, text?}>   (needs the preview of that link first)
//              stickerCategory(cateId) → Promise<{id, name, icon, stickers:[{ref:'<cate>_<id>', url}]} | null>
//              stickerCategorySend(convId, cateId, stickerId) → Promise<{status}>   (same statuses as performAction)
//              reminderWatch(convId, msgId, knownSig) → Promise<ReminderSnapshot | null>   (resolves on change or after ~25 s)
//              reminderRespond(convId, msgId, 'accept'|'reject') → Promise<{ok, pending?, text?, snapshot}>
//                (one answer at a time per reminder id, through one controller shared by its cards; a timeout is `pending`, not a failure)
//              reminderResponders(convId, msgId) → Promise<{ok, accept:[{uid,name,avatar,isMe}], reject:[…], acceptTotal, rejectTotal} | null>
//                ("Danh sách tham gia": reminder-detail-service `listResponders`, a read; group reminders only; called when the page is opened)
// JS → Swift (message JSON, merged by chat-adapter): {buttons:[{ref, label, enabled, help}], stickers:Bool}
(() => {
  'use strict';
  if (window.__zaloCardActions) return;
  if (location.pathname.split('/').pop() !== 'index.html') return;
  const chat = window.__zaloChat;
  const core = chat && chat.__core;
  if (!core) return;
  const { S, safe, str, own, parseJSON, diag, scrubErr, isGroupId, isMeUid, meNow, nameOf, avatarOf, MSG } = core;

  const NOT_AVAILABLE = 'Chưa hỗ trợ trên ứng dụng này';
  // Sticker send sources (module "Anfm" ~3869223): the enum's values are listed without their base offset, 100 is added to each.
  const ECARD_MSG_SRC = 114;           // `Sticker.ECARD_MSG` (14 + 100)
  // Official sticker panel `_sendSticker` (~12176127): source = Sticker[`${inStore ? 'STORE_' : ''}STICKER_${SMALL|EMOJI|BIG}_PANEL`]; a category the
  // user has downloaded is shown with inStore false (`_changeStickerCat`, ~12175381), one that is not is shown in the store. The chat's sticker popover is the
  // small panel (displayPos 1).
  const STICKER_SMALL_PANEL_SRC = 106;         // STICKER_SMALL_PANEL (6 + 100)
  const STORE_STICKER_SMALL_PANEL_SRC = 122;   // STORE_STICKER_SMALL_PANEL (22 + 100)
  const NO_MOBILE = 'Vui lòng mở trên thiết bị di động.';   // STR_PC_NOT_SUPPORT_ACTION, the official wording for "not on PC"
  const NO_NATIVE_UI = 'Thao tác này cần giao diện của Zalo PC, chưa có trên ứng dụng này.';
  const BUSY_TEXT = 'Thao tác trước đó vẫn đang được xử lý. Hãy chờ giây lát rồi kiểm tra lại cuộc trò chuyện.';
  const PENDING_TEXT = 'Thao tác đang được xử lý, chưa nhận được phản hồi. Hãy kiểm tra lại cuộc trò chuyện trước khi thử lại.';
  const SGG_SRC_EVENT = 4;             // official `SGG_SRC_EVENT` (module "1pet", offset ~1693770)
  const LOCKED_TEXT = 'Chỉ trưởng/phó nhóm được gửi tin nhắn vào nhóm này.';   // STR_LOCK_SEND_MESSAGE_MESSAGE_FULL
  const MAX_INFO_ACTIONS = 8;

  // ---- lookups ----
  const rawOf = (m) => (m && m.message && typeof m.message === 'object' && !Array.isArray(m.message) ? m.message : {});
  const dataOf = (v) => { const r = parseJSON(v); return r && typeof r === 'object' ? r : null; };
  const uidOf = (v) => { const s = typeof v === 'number' ? String(v) : str(v).trim(); return /^\d{1,24}$/.test(s) ? s : ''; };
  // A conversation id: a user id, or a group id with its "g" prefix.
  const chatIdOf = (v) => { const s = typeof v === 'number' ? String(v) : str(v).trim(); return /^g?\d{1,24}$/.test(s) ? s : ''; };
  const truthy = (v) => v === true || (typeof v === 'number' && v !== 0) || (typeof v === 'string' && !['', '0', 'false'].includes(v.trim().toLowerCase()));
  const webURL = (v) => { const u = str(v).trim(); return /^https?:\/\/[^\s/]/i.test(u) ? u : ''; };

  // ---- official modules found by shape (throttled, like chat-adapter) ----
  const X = { sticker: null, stickerSrc: null, consts: null, verify: null, frSvc: null, storage: null, reminder: null, stickerMgr: null, groupSvc: null };
  // The host answers unknown preload globals with catch-all placeholders; real modules don't (same probe as zcloud-adapter `real`).
  const real = (o) => !!o && (typeof o === 'object' || typeof o === 'function') && safe(() => o.__olaz_not_a_member__, undefined) === undefined;
  let lastScan = 0;
  const scan = () => {
    if (X.sticker && X.stickerSrc && X.consts && X.verify && X.frSvc && X.storage && X.reminder && X.stickerMgr && X.groupSvc) return;
    if (Date.now() - lastScan < 500) return;
    lastScan = Date.now();
    const req = window.__zaloRequire;
    if (!req) return;
    if (!X.verify && typeof window.__zaloDI === 'function') {
      safe(() => { for (const reg of window.__zaloDI(req)) { const i = reg && reg.instance; if (real(i) && typeof i === 'object' && typeof i.verifySetting === 'function') { X.verify = i; break; } } }, null);
    }
    if (typeof window.__zaloEachExport !== 'function') return;
    safe(() => window.__zaloEachExport(req, (ex) => {
      if (!ex || (typeof ex !== 'object' && typeof ex !== 'function')) return;
      try {
        if (!real(ex)) return;
        if (!X.reminder && typeof ex.a === 'function' && real(ex.a) && ex.a.prototype && typeof ex.a.prototype.respond === 'function'
          && typeof ex.a.prototype.loadStored === 'function' && typeof ex.a.prototype.derive === 'function') X.reminder = ex.a;
        for (const o of [ex, ex.default]) {
          if (!real(o) || typeof o !== 'object') continue;
          if (!X.sticker && typeof o.fetchStickersFromList === 'function' && typeof o.fetchStickerCats === 'function') X.sticker = o;
          if (!X.stickerSrc && typeof o.setStickerSrc === 'function' && typeof o.clearStickerSrc === 'function') X.stickerSrc = o;
          if (!X.frSvc && typeof o.requestAddFriend === 'function' && typeof o.getStatusFriendRequest === 'function' && typeof o.setFriendRequestSource === 'function' && own(o, 'friendRequestSources')) X.frSvc = o;
          if (!X.storage && typeof o.getSayHiV2 === 'function' && typeof o.setStrangerCache === 'function') X.storage = o;
          // sticker manager ("Q" of the sticker module ~18822800): category info + a category's stickers
          if (!X.stickerMgr && typeof o.fetchCateIfNotEnoughSticker === 'function' && typeof o.getSingleCategory === 'function' && typeof o.getStickerIfNotExist === 'function') X.stickerMgr = o;
          // group service (module "dThN" ~13927133): invite link info
          if (!X.groupSvc && typeof o.getGroupInfoByLink === 'function' && typeof o.getPendingMember === 'function') X.groupSvc = o;
        }
        if (!X.consts && ex.FRIEND_REQUEST_SRC_ECARD !== undefined && ex.MAX_CHAR_SAY_HI !== undefined) X.consts = ex;
      } catch {}
    }), null);
  };
  const need = (...keys) => { scan(); return keys.every((k) => X[k]); };
  // Official `verifySetting({field:'lockSendMsg', convId})` (true = only admins may post). Without the service the answer is unknown:
  // groups then refuse the send instead of assuming it is allowed.
  const lockState = (convId) => {
    scan();
    if (!X.verify) return isGroupId(convId) ? 'unknown' : 'open';
    try { return X.verify.verifySetting({ field: 'lockSendMsg', convId }) ? 'locked' : 'open'; } catch { return isGroupId(convId) ? 'unknown' : 'open'; }
  };
  const lockReply = (convId) => {
    const state = lockState(convId);
    if (state === 'locked') return { status: 'locked', text: LOCKED_TEXT };
    if (state === 'unknown') return { status: 'error', text: 'Không thể kiểm tra quyền gửi tin nhắn trong nhóm. Hãy thử lại sau giây lát.' };
    return null;
  };
  // A call into the official client that may never answer: no result after `ms` means "did not happen", and nothing is done afterwards.
  const TIMEOUT = Symbol('timeout');
  const within = (promise, ms) => Promise.race([Promise.resolve(promise), core.sleep(ms).then(() => TIMEOUT)]);
  const SLOW_TEXT = 'Hết thời gian chờ phản hồi. Hãy thử lại sau.';
  // One run per key at a time. The work itself is never cancelled: when it has not answered after `ms`, the caller is told
  // 'pending' and the key stays taken until the work really settles, so a retry cannot queue a second send / request.
  const inflight = new Map();
  const guarded = async (key, work, ms) => {
    if (inflight.has(key)) return { status: 'busy', text: BUSY_TEXT };
    const p = Promise.resolve().then(work);
    inflight.set(key, p);
    const clear = () => { if (inflight.get(key) === p) inflight.delete(key); };
    p.then(clear, clear);
    const r = await within(p, ms);
    return r === TIMEOUT ? { status: 'pending', text: PENDING_TEXT } : r;
  };
  // cached for the lightweight contact lookups (core.ready() re-resolves services each call)
  let readyUntil = 0;
  const readyCached = async () => {
    if (Date.now() < readyUntil) return true;
    const ok = await core.ready();
    if (ok) readyUntil = Date.now() + 30000;
    return ok;
  };
  const groupLink = (url) => { const re = safe(() => S.cfg.groupLinkRegEx, null); return re instanceof RegExp ? re.test(url) : /^https?:\/\/(?:zaloapp\.com|zalo\.me)\/g\//.test(url); };

  // ---- sending (the chat-box controller, the same objects the composer / official message view use) ----
  const controllerFor = async (convId) => {
    if (!(await core.ready())) return null;
    if (!core.controller() || core.controller().convId !== convId) core.repairController(convId);
    const cc = core.controller();
    return cc && cc.convId === convId ? cc : null;
  };
  const stickerPick = (data) => {
    // Official: `JSON.parse(data)`, a `stickerList` entry chosen at random, else the object itself.
    let t = dataOf(data);
    if (t && Array.isArray(t.stickerList) && t.stickerList.length) t = t.stickerList[Math.floor(Math.random() * t.stickerList.length)];
    if (!t || typeof t !== 'object') return null;
    const id = Number(t.id), catId = Number(t.catId !== undefined ? t.catId : t.cateId), type = Number(t.type);
    // The parsed object is what the official handler passes on; the three numbers are validated.
    return id > 0 && catId > 0 && Number.isFinite(type) ? Object.assign({}, t, { id, catId, type }) : null;
  };
  // Zinstant `SEND_STICKER` (lazy chunk 51 "yUIi"): the data itself ({id, catId, type}) is the sticker; no random pick from a list.
  const znsStickerPick = (data) => {
    const t = dataOf(data);
    if (!t) return null;
    const id = Number(t.id), catId = Number(t.catId !== undefined ? t.catId : t.cateId), type = Number(t.type);
    return id > 0 && catId > 0 && Number.isFinite(type) ? { id, catId, type } : null;
  };
  const sendStickerAction = async (convId, data, zns = false) => {
    const pick = zns ? znsStickerPick(data) : stickerPick(data);
    if (!pick) return { status: 'error' };
    const blocked = lockReply(convId);
    if (blocked) return blocked;
    const cc = await controllerFor(convId);
    if (!cc) return { status: 'not-open' };
    const info = safe(() => cc._getConversationInfo(), null);
    if (!info) return { status: 'not-open' };
    scan();
    // E-card: official `Messaging.setStickerSrc(SGG_SRC_EVENT)` right before `sendMessage(conv, MSG_STICKER, sticker)` (~577294).
    // Zinstant sends without it. If the send is not reached the source is cleared again.
    let srcSet = false;
    if (!zns && X.stickerSrc) srcSet = safe(() => { X.stickerSrc.setStickerSrc(Number(X.consts && X.consts.SGG_SRC_EVENT) || SGG_SRC_EVENT); return true; }, false);
    const unset = () => { if (srcSet) safe(() => X.stickerSrc.clearStickerSrc(), null); srcSet = false; };
    try {
      Promise.resolve(cc._sendMessage(info, MSG.STICKER, pick)).catch((e) => { unset(); diag('send sticker ' + scrubErr(e)); });
    } catch (e) { unset(); throw e; }
    return { status: 'done' };
  };
  const sendTextAction = async (convId, text) => {
    if (!text || typeof text !== 'string') return { status: 'error' };
    const blocked = lockReply(convId);
    if (blocked) return blocked;
    const r = await chat.sendText(convId, text, null, []);
    return r === 'sent' ? { status: 'done' } : { status: r === 'not-open' || r === 'not-ready' ? 'not-open' : 'error' };
  };

  // Official suggestion list of a sticker card: `actions[0].data.stickerList` → [{cate_id, autoplay, type, sticker_id}] (~227971).
  const stickerRawOf = (acts) => {
    const d = acts[0] && acts[0].data ? dataOf(acts[0].data) : null;
    const list = d && Array.isArray(d.stickerList) ? d.stickerList : [];
    return list.map((x) => (x && Number(x.id) > 0 && Number(x.catId) > 0 ? { cate_id: x.catId, autoplay: x.autoplay, type: x.type, sticker_id: x.id } : null)).filter(Boolean).slice(0, 24);
  };
  const actionsOf = (m) => {
    const p = dataOf(rawOf(m).params);
    return p && Array.isArray(p.actions) ? p.actions.filter((a) => a && typeof a === 'object') : [];
  };

  const digits = (v) => { const s = typeof v === 'number' ? String(v) : str(v).trim(); return /^\d{1,24}$/.test(s) ? s : ''; };
  // Official action list (module "hi/S" ~15107500): handlers whose body is empty in the PC build do nothing there either;
  // the others only open the PC side panel / React dialogs (member list, admin tools, notice board, topics, multi-group forms…).
  const PC_NOOP = new Set(['action.open.group.in.common', 'action.group.open.leavegroup', 'action.group.add.member', 'action.group.search.message',
    'action.group.create.poll', 'action.open.suggest.sticker.birthday', 'action.open.jump.msg.v2', 'action.open.suggestfriend.full', 'action.send.richmsg',
    'action.open.chat', 'action.open.stickerstore', 'action.call.voice', 'action.call.video', 'action.open.groupboard', 'action.group.open.fullavt',
    'action.chat.reply.and.mention', 'action.group.update.name', 'action.group.update.avatar']);
  const PC_PANEL = new Set(['action.group.open.list.member', 'action.group.open.admintool', 'action.group.open.rightmenu', 'action.group.update.notice',
    'action.open.grouptopic.detail', 'action.open.calendar.event', 'action.open.form.invitemultigroup', 'action.open.form.removemultigroup',
    'action.open.request.joingroup', 'action.open.onboard.b2s', 'action.open.creategroup', 'action.groupchat.jump.msg']);
  // Zinstant OPEN_PROFILE_POPUP (lazy chunk 51 ~6135). Mirrors the official code exactly, odd as it looks: `convertId(data, true, ZNS_ACTION)` (module "8/ir")
  // maps "me" to my own uid and otherwise runs the GROUP converter (`getGroupIdFromGlobalId`) on the noise id; an empty answer is the "mobile only" toast, any
  // other answer is handed to the FRIEND_PROFILE modal. Only a numeric user id can be shown as a profile here; anything else (a group id) is not openable.
  const znsProfile = async (noise) => {
    if (!(await readyCached())) return { status: 'not-open' };
    let id = '';
    try {
      if (noise === 'me') id = str(S.friends.getUidMe());
      else id = str(await within(S.groups.getGroupIdFromGlobalId(noise), 10000));
    } catch { id = ''; }
    const uid = uidOf(id);
    return uid ? effect({ type: 'openProfile', uid }) : { status: 'unsupported', text: NO_MOBILE };
  };

  // ---- action plans: one place decides what a button does and whether it can ----
  const effect = (e) => ({ status: 'effect', effect: e });
  // → {enabled, help, run}. ctx: 'ecard' (`_sendMessageEcard`), 'info' (action-list handler for `customMsg.actions`), 'zns' (zinstant action handler).
  const planFor = (convId, actionType, data, ctx = 'ecard') => {
    const off = (help) => ({ enabled: false, help: help || NOT_AVAILABLE, run: async () => ({ status: 'unsupported', text: help || NOT_AVAILABLE }) });
    const on = (run, help = '') => ({ enabled: true, help, run });
    switch (actionType) {
      case 'action.open.sendsticker':
        return (ctx === 'zns' ? znsStickerPick(data) : stickerPick(data)) ? on(() => sendStickerAction(convId, data, ctx === 'zns')) : off('Sticker không hợp lệ');
      case 'action.open.sendtext':
        return ctx === 'ecard' && typeof data === 'string' && data ? on(() => sendTextAction(convId, data)) : off(ctx === 'ecard' ? 'Nội dung không hợp lệ' : '');
      case 'action.query.show':   // zinstant `SHOW`: the text becomes a message of mine (`send_msg`)
        return ctx === 'zns' && typeof data === 'string' && data ? on(() => sendTextAction(convId, data)) : off();
      case 'action.change.alias': {   // e-card only: the EDIT_ALIAS dialog (a 1-1 conversation)
        if (ctx !== 'ecard') return off();
        const d = dataOf(data);
        if (!d) return off('Dữ liệu không hợp lệ');
        if (isGroupId(convId)) return off('Chỉ đặt được tên gợi nhớ trong cuộc trò chuyện cá nhân');
        return on(() => aliasOpen(convId, d), 'Đặt tên gợi nhớ');
      }
      case 'action.open.inapp': {
        const url = webURL(data);
        // E-card: a group invite link opens the GROUP_PREVIEW dialog (the page itself opens nothing else).
        if (ctx === 'ecard') return url && groupLink(url) ? on(async () => effect({ type: 'groupInvite', url }), 'Xem nhóm và tham gia') : off();
        return ctx === 'zns' && url ? on(async () => effect({ type: 'openURL', url })) : off();
      }
      case 'action.open.profile': {
        // Zinstant OPEN_PROFILE_POPUP converts the (noise) id to a user id first (lazy chunk 51); the action list takes a user id as it is.
        if (ctx === 'zns') return data && typeof data === 'string' ? on(() => znsProfile(data)) : off();
        const uid = uidOf(data);
        return uid ? on(async () => effect({ type: 'openProfile', uid })) : off();
      }
      case 'action.open.sticker': {   // action list `_openStickerDetail(data)`: the sticker dock at that category (here: the category sheet)
        if (ctx === 'zns') return off();
        const cate = digits(data);
        return cate && Number(cate) > 0 ? on(async () => effect({ type: 'stickers', cateId: cate }), 'Xem bộ sticker') : off('Dữ liệu không hợp lệ');
      }
      case 'action.groupchat.open.polldetail': {   // `_openGroupPollDetail`: the poll dialog (here: the existing poll sheet)
        if (ctx === 'zns') return off();
        const d = dataOf(data);
        const pollId = d ? digits(d.pollId) : '';
        return pollId && isGroupId(convId) ? on(async () => effect({ type: 'poll', pollId }), 'Xem bình chọn') : off('Dữ liệu không hợp lệ');
      }
      case 'action.open.tab.chat':
      case 'action.open.tab.contact':
      case 'action.open.grouplist': {   // side-bar tabs
        if (ctx === 'zns') return off();
        const tab = actionType === 'action.open.tab.chat' ? 'chats' : actionType === 'action.open.tab.contact' ? 'contacts' : 'groups';
        return on(async () => effect({ type: 'tab', tab }));
      }
      case 'action.open.chat.v2': {
        const d = dataOf(data);
        const uid = d ? chatIdOf(d.uid) : '';
        if (!uid || d.isGroup === undefined || d.isGroup === null) return off();
        const id = uid.startsWith('g') || truthy(d.isGroup) ? (uid.startsWith('g') ? uid : 'g' + uid) : uid;
        return on(async () => effect({ type: 'openChat', id }));
      }
      case 'action.open.outapp': {
        const url = webURL(data);
        return url ? on(async () => effect({ type: 'openURL', url })) : off();
      }
      case 'action.copy.clipboard': {   // zinstant COPY_TO_CLIPBOARD: data JSON {content}
        const d = ctx === 'zns' ? dataOf(data) : null;
        const text = d && typeof d.content === 'string' ? d.content : '';
        return text ? on(async () => effect({ type: 'copy', text: text.slice(0, 20000) })) : off();
      }
      case 'action.click.zinstant.clipboard.write': {   // WRITE_TO_CLIPBOARD: data JSON {data, toast_*}
        const d = ctx === 'zns' ? dataOf(data) : null;
        const text = d && typeof d.data === 'string' ? d.data : '';
        return text ? on(async () => effect({ type: 'copy', text: text.slice(0, 20000) })) : off();
      }
      default:
        if (ctx !== 'zns' && PC_NOOP.has(actionType)) return off(NO_MOBILE);       // empty handlers in the official action list
        if (ctx !== 'zns' && PC_PANEL.has(actionType)) return off(NO_NATIVE_UI);   // open the official side panel / dialogs only
        return off();
    }
  };

  // ---- e-cards ----
  const ecardInfo = (m) => {
    const o = rawOf(m);
    const p = dataOf(o.params) || {};
    const acts = actionsOf(m);
    const type = typeof o.type === 'string' && /^\d+$/.test(o.type) ? Number(o.type) : o.type;
    return { p, acts, type, newFriend: Number(o.versionEcardNewFr) === 1, stickers: stickerRawOf(acts) };
  };
  // Official `isCardSticker()` (~250614): a single sendsticker action carrying a sticker list.
  const isCardSticker = (info) => info.acts.length === 1 && info.acts[0].actionId === 'action.open.sendsticker' && info.stickers.length > 0;
  const isReminder = (info) => info.acts.length === 1 && info.acts[0].actionId === 'action.open.reminder';
  const wantsStickers = (info) => {
    if (isReminder(info)) return false;
    if (info.type === 2 || info.type === 3) return info.newFriend && info.stickers.length > 0;
    if (info.type === 1 && safe(() => S.cfg.ecard_config.render_new_birthday_card, false)) return info.stickers.length > 0;
    return isCardSticker(info);
  };
  // The buttons the official layout draws (labels are the action names).
  const ecardPlans = (m, convId) => {
    const info = ecardInfo(m);
    if (isReminder(info) || wantsStickers(info)) return [];
    if (info.type === 2 || info.type === 3) {
      // Old new-friend card (no sticker list): the "Xin chào <name>" text (~213713).
      if (info.newFriend) return [];
      const name = nameOf(convId);
      const text = 'Chào' + (name ? ' ' + (name.length > 50 ? name.slice(0, 48) + '...' : name) : '');
      return [Object.assign({ label: 'Xin chào' + (name ? ' ' + (name.length > 20 ? name.slice(0, 18) + '...' : name) : ''), ref: 'greet' }, planFor(convId, 'action.open.sendtext', text))];
    }
    const layout2 = Number(info.p.layoutType) === 2;
    const shown = layout2 ? info.acts.slice(0, 2) : (info.acts.length === 1 || info.acts.length === 2 ? info.acts : []);
    return shown.map((a, i) => {
      const label = str(a.name);
      return label ? Object.assign({ label, ref: 'ecard:' + i }, planFor(convId, str(a.actionId), a.data)) : null;
    }).filter(Boolean);
  };

  // ---- info messages (msginfo.actionlist, INFO_CHAT, collapsed ZInstant): customMsg.actions [{actionType, actionData, actionLabel, actionLabelv2}] ----
  // ZInstant metadata may also carry labelled zinstant actions ({type|action|actionId, data, label|name|title|text}); those run through the
  // zinstant handler's native types ('zns:N'). The template's own buttons are drawn by the zinstant engine and are not reachable here.
  const infoPlans = (m, convId) => {
    const o = rawOf(m);
    const t = Number(m.msgType);
    const isZns = t === 52 || t === 53 || t === 27;
    let src = null, meta = null;
    if (isZns) {
      meta = t === 53 ? dataOf(o.zinstant_msg) : dataOf(o.params);
      src = meta && meta.customMsg && typeof meta.customMsg === 'object' ? meta.customMsg : null;
    } else if (t === -1909 || (t === MSG.TEXT && o.action === 'msginfo.actionlist')) {
      src = dataOf(o.params);
    }
    const out = [];
    (src && Array.isArray(src.actions) ? src.actions : []).forEach((a, i) => {
      if (!a || typeof a !== 'object' || a.actionType === 'action.open.pinboard') return;
      const l2 = a.actionLabelv2 && typeof a.actionLabelv2 === 'object' ? a.actionLabelv2 : {};
      const label = (str(l2.vi) || str(a.actionLabel)).trim();
      if (label && out.length < MAX_INFO_ACTIONS) out.push(Object.assign({ label, ref: 'info:' + i }, planFor(convId, str(a.actionType), a.actionData, 'info')));
    });
    if (isZns && meta) {
      const lists = [meta.actions, meta.item && meta.item.actions, meta.pcItem && meta.pcItem.actions];
      let n = 0;
      for (const list of lists) {
        for (const a of Array.isArray(list) ? list : []) {
          const i = n++;
          if (!a || typeof a !== 'object') continue;
          const label = (str(a.label) || str(a.name) || str(a.title) || str(a.text)).trim();
          const type = str(a.type) || str(a.actionId) || str(a.action);
          if (label && type && out.length < MAX_INFO_ACTIONS) out.push(Object.assign({ label, ref: 'zns:' + i }, planFor(convId, type, a.data, 'zns')));
        }
      }
    }
    return out;
  };

  // Plans of a raw message (by message type, so Swift only has to name a ref).
  const plansOf = (m, convId) => {
    const t = Number(m.msgType);
    if (t === MSG.ECARD) return ecardPlans(m, convId);
    if (t === 52 || t === 53 || t === 27 || t === -1909 || t === MSG.TEXT) return infoPlans(m, convId);
    return [];
  };

  const describe = (m, convId, kind) => {
    if (!kind || typeof kind !== 'object') return null;
    const out = {};
    if (kind.type === 'call') {
      const p = dataOf(rawOf(m).params) || {};
      if (p.isEnableCallback && !isGroupId(convId)) out.buttons = [{ ref: 'call:back', label: 'GỌI LẠI', enabled: true, help: '' }];
    } else if (kind.type === 'oaMessage') {
      // Official "9hee": '' / inapp open the page; `action.open.popup` opens the modal named by the row's `popup_id` (server-defined, React
      // only); any other action does nothing. Those rows stay inert; say why. (Same row filter as chat-adapter `partsOf`.)
      const list = (Array.isArray(m.message) ? m.message : []).filter((x) => x && typeof x === 'object' && (str(x.title) || core.absUrl(x.thumb)));
      list.forEach((x, i) => {
        const act = str(x.action);
        if (Array.isArray(kind.parts) && kind.parts[i] && act && act !== 'action.open.inapp') kind.parts[i].help = act === 'action.open.popup' ? NO_NATIVE_UI : NO_MOBILE;
      });
    } else if (kind.type === 'ecard' || kind.type === 'notice' || kind.type === 'zinstant') {
      const plans = plansOf(m, convId);
      if (plans.length) out.buttons = plans.map((p) => ({ ref: p.ref, label: p.label, enabled: p.enabled, help: p.help }));
      if (kind.type === 'ecard') {
        kind.actions = [];   // the buttons replace the label-only list
        if (wantsStickers(ecardInfo(m))) out.stickers = true;
      }
    }
    return Object.keys(out).length ? out : null;
  };

  // ---- Swift entry points ----
  // Suggested sticker (`stk:<cateId>_<id>`): one of this message's own list, sent like the official `sendSticker(sticker, ECARD_MSG)`.
  const sendSuggested = async (m, convId, stk) => {
    const item = ecardInfo(m).stickers.find((x) => String(x.cate_id) === stk[1] && String(x.sticker_id) === stk[2]);
    if (!item) return { status: 'not-found' };
    const blocked = lockReply(convId);
    if (blocked) return blocked;
    if (!need('sticker')) return { status: 'not-open' };
    // The fetch can hang: no answer in time means nothing is sent, now or later (the send below only runs in this continuation).
    const list = await within(X.sticker.fetchStickersFromList([item]), 8000);
    if (list === TIMEOUT) return { status: 'error', text: SLOW_TEXT };
    if (!Array.isArray(list) || !list.length) return { status: 'error' };
    // The controller can be replaced while waiting (repairController): resolve it only now, and re-check the lock.
    const blockedNow = lockReply(convId);
    if (blockedNow) return blockedNow;
    const cc = await controllerFor(convId);
    if (!cc) return { status: 'not-open' };
    cc._sendSticker(list[0], ECARD_MSG_SRC);   // official `sendSticker(sticker, ECARD_MSG)`
    return { status: 'done' };
  };

  const performAction = async (convId, msgId, ref) => {
    convId = String(convId); ref = String(ref || '');
    try {
      const m = core.findMessage(convId, msgId);
      if (!m) return { status: 'not-found' };
      const key = 'act|' + convId + '|' + String(msgId) + '|' + ref;
      const stk = /^stk:(\d+)_(\d+)$/.exec(ref);
      // One sticker send per conversation at a time (any strip / category sticker), so a pending one cannot be followed by another.
      if (stk) return await guarded('stk|' + convId, () => sendSuggested(m, convId, stk), 40000);
      const plan = plansOf(m, convId).find((p) => p.ref === ref);
      if (!plan) return { status: 'not-found' };
      if (!plan.enabled) return { status: 'unsupported', text: plan.help };
      return await guarded(key, () => plan.run(), 40000);
    } catch (e) {
      diag('performAction ' + scrubErr(e));
      return { status: 'error' };
    }
  };

  const cardStickers = async (convId, msgId) => {
    try {
      const m = core.findMessage(String(convId), msgId);
      if (!m || !need('sticker')) return [];
      const raw = ecardInfo(m).stickers;
      if (!raw.length) return [];
      const list = await within(X.sticker.fetchStickersFromList(raw), 8000);
      return (Array.isArray(list) ? list : []).map((s) => {
        const url = s ? core.absUrl(s.stickerUrl || s.url) : '';
        const cate = Number(s && (s.cateId !== undefined ? s.cateId : s.catId)), id = Number(s && s.id);
        return cate > 0 && id > 0 && url ? { ref: `stk:${cate}_${id}`, url } : null;
      }).filter(Boolean);
    } catch (e) { diag('cardStickers ' + scrubErr(e)); return []; }
  };

  // Local friend data only: nothing here touches the network (the official card also decides from its local friend flag).
  const profileOf = (uid) => safe(() => S.friends.getProfileFriendByIdSync(uid), null) || {};
  const isFriendNow = async (uid) => {
    if (!S.friends) return false;
    const p = profileOf(uid);
    if (p.isFr === 1 || p.isFr === true) return true;
    return !!(await Promise.resolve(safe(() => S.friends.isFriend(uid), false)));
  };
  const contactState = async (uid) => {
    uid = uidOf(uid);
    if (!uid) return { isSelf: false, isFriend: false };
    await readyCached();
    return { isSelf: isMeUid(uid) || uid === meNow(), isFriend: await isFriendNow(uid) };
  };
  // Official `isOAType(profile)` (~19911573): not a group and `type >= 1`.
  const contactProfile = async (uid) => {
    uid = uidOf(uid);
    if (!uid) return null;
    await readyCached();
    let p = profileOf(uid);
    // Not in the local cache (a stranger / OA that is not a friend): the official mini-info fetch (`FETCH_MINI_INFO`), then `isOAType`.
    if (!p.userId && !p.displayName && !p.zaloName && S.friends && typeof S.friends.getProfileFriendById === 'function') {
      const src = safe(() => (S.codes && S.codes.FETCH_MINI_INFO) ?? (X.consts && X.consts.SRC_GET_PROFILE && X.consts.SRC_GET_PROFILE.FETCH_MINI_INFO), undefined);
      scan();
      const fetched = src === undefined ? null : await within(Promise.resolve(safe(() => S.friends.getProfileFriendById(uid, src), null)).catch(() => null), 6000);
      if (fetched && fetched !== TIMEOUT && typeof fetched === 'object') p = fetched;
    }
    return {
      uid, name: nameOf(uid) || str(p.displayName) || str(p.zaloName), zaloName: str(p.zaloName),
      avatar: avatarOf(uid) || str(p.avatar), bio: str(p.status),
      isSelf: isMeUid(uid) || uid === meNow(), isFriend: await isFriendNow(uid), isOA: Number(p.type) >= 1,
    };
  };
  // Official `_onAddFriend(uid, e, convId)` (~1074396): status check; "already requested" stops there; otherwise the request
  // source is set and the add-friend page opens with the default message (`getSayHiV2(myName, MAX_CHAR_SAY_HI, src)`, `src` = the stored source).
  const prepareFriendRequest = async (uid, convId, via) => {
    uid = uidOf(uid);
    const fail = { state: 'error', defaultMessage: '', maxMessage: 150 };
    if (!uid) return fail;
    await core.ready();
    if (isMeUid(uid) || uid === meNow()) return Object.assign({}, fail, { state: 'self' });
    if (await isFriendNow(uid)) return Object.assign({}, fail, { state: 'friend' });
    if (!need('frSvc', 'consts', 'storage')) return fail;
    const max = Number(X.consts.MAX_CHAR_SAY_HI) || 150;
    // The status call can hang: no answer in time is an error (nothing is set up), not a silent "ready".
    let status = null;
    try {
      status = await within(X.frSvc.getStatusFriendRequest(uid), 8000);
      if (status === TIMEOUT) return fail;
    } catch { status = null; }
    if (status && (status.isRequested === true || Number(status.isRequested) === 1)) return { state: 'requested', defaultMessage: '', maxMessage: max };
    if (status && (status.isRequesting === true || Number(status.isRequesting) === 1)) return { state: 'requesting', defaultMessage: '', maxMessage: max };
    const group = str(convId);
    const groupId = isGroupId(group) ? group.slice(1) : '';
    const ecard = X.consts.FRIEND_REQUEST_SRC_ECARD;
    if (via === 'add') safe(() => X.frSvc.setFriendRequestSource(uid, ecard, { uidTo: groupId || group }), null);
    else if (via === 'card') safe(() => X.frSvc.setFriendRequestSource(uid, ecard, groupId ? { toUid: groupId } : undefined), null);
    const me = nameOf(meNow()) || core.myName();
    const stored = safe(() => X.frSvc.getFriendRequestSource(uid), null);
    const defaultMessage = safe(() => X.storage.getSayHiV2(me, max, stored && stored.src), '');
    if (typeof defaultMessage !== 'string') return fail;
    return { state: 'ready', defaultMessage: defaultMessage.slice(0, max), maxMessage: max };
  };

  // ---- alias: the official EDIT_ALIAS dialog (module "Yxnj" ~11937852) ----
  // `action.change.alias` only opens the dialog (`aliasOpen`: the official feature / stranger checks, nothing is written); the alias is set by
  // `aliasSave` when the user confirms, through the friend manager's `setAliasName(uid, name)` (empty name = remove the alias).
  const ALIAS_TEXT = {
    disabled: 'Tính năng đặt tên gợi nhớ hiện tại không khả dụng. Vui lòng thử lại sau!',      // STR_ALIAS_ERR_DISABLE
    stranger: 'Không thể đặt tên gợi nhớ cho người lạ.',                                         // STR_ALIAS_ERR_MSG_DO_NOT_SUPPORT_STRANGER
    changed: 'Đổi tên gợi nhớ thành công',                                                       // STR_CHANGE_ALIAS_SUCCESS
    unknown: 'Có lỗi xảy ra, vui lòng thử lại sau',                                              // STR_ERROR_UNKNOWN
    noNet: 'Vui lòng kiểm tra lại kết nối mạng của bạn.',                                        // STR_CHECK_NET
    notReady: 'Chưa sẵn sàng, hãy thử lại sau giây lát.',
  };
  // Official input: `maxLength = group_config.max_group_name_length` (UTF-16 units); control characters 0-7 are stripped (`stripInvalidChar`).
  const aliasMax = () => { const n = Number(safe(() => S.cfg.group_config.max_group_name_length, 50)); return n > 0 && n <= 200 ? Math.floor(n) : 50; };
  const aliasGate = async (uid) => {
    if (!uid || isGroupId(uid) || isMeUid(uid) || uid === meNow()) return { status: 'error', text: 'Không thể đặt tên gợi nhớ cho cuộc trò chuyện này.' };
    if (!(await readyCached()) || !S.friends) return { status: 'not-open' };
    const cfg = S.cfg || {};
    // `enable_feature_alias` is set on the config by the friend manager; like the official check, any falsy value blocks.
    if (!truthy(cfg.enable_feature_alias)) return { status: 'error', text: ALIAS_TEXT.disabled };
    if (!(truthy(cfg.enable_stranger_alias) || (await isFriendNow(uid)))) return { status: 'error', text: ALIAS_TEXT.stranger };
    return null;
  };
  const aliasOpen = async (convId, d) => {
    const uid = uidOf(convId);
    const blocked = await aliasGate(uid);
    if (blocked) return blocked;
    const hint = str(d.hint).length > 0 ? str(d.hint) : str(d.dpn);
    // placeholder: `_getContactName()` (phone-book name, else the Zalo name), else the card's hint
    const placeholder = str(safe(() => S.friends.getPhonebookName(uid), '')) || str(profileOf(uid).zaloName) || hint;
    // Does an alias exist (an empty confirm then removes it)? Unknown → the field is not treated as either.
    let existing = null;
    try {
      const a = await within(Promise.resolve(S.friends.getAliasName(uid)).catch(() => undefined), 3000);
      if (a !== TIMEOUT && a !== undefined) existing = typeof a === 'string' && a.length > 0;
    } catch { existing = null; }
    return effect({ type: 'alias', uid, name: nameOf(uid), suggest: str(d.suggestName), placeholder, max: aliasMax(), hasAlias: existing });
  };
  const okReply = (r) => (r && r.status ? { ok: false, text: r.text || ALIAS_TEXT.unknown } : r);
  const aliasSave = async (uid, name) => {
    try {
      uid = uidOf(uid);
      return okReply(await guarded('alias|' + uid, async () => {
        const blocked = await aliasGate(uid);
        if (blocked) return { ok: false, text: blocked.text || ALIAS_TEXT.notReady };
        if (typeof S.friends.setAliasName !== 'function') return { ok: false, text: ALIAS_TEXT.notReady };
        const value = str(name).replace(/[\x00-\x07]/g, '').trim().slice(0, aliasMax());
        try {
          await S.friends.setAliasName(uid, value);
          return { ok: true, text: value ? ALIAS_TEXT.changed : 'Đã xoá tên gợi nhớ' };
        } catch (e) {
          // the service rejects with the localized text (limits, stranger, offline …)
          diag('alias ' + scrubErr(e));
          return { ok: false, text: typeof e === 'string' && e ? e : (e && e.code === 'ERR_NO_NETWORK' ? ALIAS_TEXT.noNet : ALIAS_TEXT.unknown) };
        }
      }, 40000));
    } catch (e) { diag('aliasSave ' + scrubErr(e)); return { ok: false, text: ALIAS_TEXT.unknown }; }
  };

  // ---- group invite link: the official GROUP_PREVIEW dialog (module "AXH7" ~3793133) ----
  // Opening it fetches the group's info by link (`getGroupInfoByLink`); if I am already in the group the official dialog skips itself and opens the
  // conversation. "Tham gia" = group manager `joinGroupByLink(link, groupInfo)`, run only on the user's click.
  const GJ = {
    plain: { 227: 'Link tham gia không tồn tại.', 228: 'Link tham gia đã hết hạn.', 177: 'Bạn đã vượt quá số nhóm cho phép.', noNet: 'Không có mạng, vui lòng kiểm tra lại kết nối và thử lại', occur: 'Đã có lỗi xảy ra. Vui lòng thử lại' },
    group: {
      240: 'Yêu cầu của bạn đã được gửi đến trưởng/phó nhóm chờ xét duyệt', 178: 'Đã là thành viên của nhóm', 257: 'Bạn không có quyền tham gia nhóm vào lúc này',
      259: 'Bạn không có quyền thực hiện thay đổi trong nhóm vào lúc này', 166: 'Bạn đã bị trưởng nhóm chặn tham gia nhóm này.', unknown: 'Vào nhóm không thành công.',
      280: 'Nhóm đang bật Tin nhắn tự xóa. Cập nhật Zalo bản mới để tham gia nhóm.', 281: 'Không thể tham gia nhóm do bạn đã đạt giới hạn trò chuyện có Tin nhắn tự xóa.',
      283: 'Không thể tham gia nhóm. Liên hệ trưởng hoặc phó nhóm để tham gia.', 284: 'Nhóm đang bật Tin nhắn tự xóa. Cập nhật bản mới Zalo PC và Zalo trên điện thoại để tham gia nhóm.',
      285: 'Nhóm đang bật Tin nhắn tự xóa. Cập nhật Zalo PC bản mới để tham gia nhóm.', 286: 'Nhóm đang bật Tin nhắn tự xóa. Cập nhật Zalo bản mới trên điện thoại để tham gia nhóm.',
      833: 'Không thể tham gia nhóm. Bạn đã đạt giới hạn trò chuyện có Chặn chia sẻ.',
    },
    community: {
      240: 'Yêu cầu của bạn đã được gửi đến trưởng/phó cộng đồng chờ xét duyệt', 178: 'Đã là thành viên của cộng đồng', 257: 'Bạn không có quyền tham gia cộng đồng vào lúc này',
      259: 'Bạn không có quyền thực hiện thay đổi trong cộng đồng vào lúc này', 166: 'Bạn đã bị trưởng cộng đồng chặn tham gia cộng đồng này.', unknown: 'Vào cộng đồng không thành công.',
      280: 'Cộng đồng đang bật Tin nhắn tự xóa. Cập nhật Zalo bản mới để tham gia cộng đồng.', 281: 'Không thể tham gia cộng đồng do bạn đã đạt giới hạn trò chuyện có Tin nhắn tự xóa.',
      283: 'Không thể tham gia cộng đồng. Liên hệ trưởng hoặc phó cộng đồng để tham gia.', 284: 'Cộng đồng đang bật Tin nhắn tự xóa. Cập nhật bản mới Zalo PC và Zalo trên điện thoại để tham gia cộng đồng.',
      285: 'Cộng đồng đang bật Tin nhắn tự xóa. Cập nhật Zalo PC bản mới để tham gia cộng đồng.', 286: 'Cộng đồng đang bật Tin nhắn tự xóa. Cập nhật Zalo bản mới trên điện thoại để tham gia cộng đồng.',
      833: 'Không thể tham gia cộng đồng. Bạn đã đạt giới hạn trò chuyện có Chặn chia sẻ.',
    },
  };
  const gjText = (code, community, fallback) => {
    const k = Number(code);
    if (k === 282) return gjText(280, community);
    return GJ.plain[k] || (community ? GJ.community : GJ.group)[k] || fallback || (community ? GJ.community : GJ.group).unknown;
  };
  const isCommunity = (info) => {
    if (!truthy(safe(() => S.cfg.group_privacy.community.enable_ui, 0))) return false;
    const threshold = Number(safe(() => S.cfg.group_privacy.community.grouptype_threshold, 0));
    return !!info && (Number(info.type) === 2 || (typeof info.totalMember === 'number' && threshold > 0 && info.totalMember > threshold));
  };
  const inviteLink = (v) => { const u = webURL(v); return u && groupLink(u) ? u : ''; };
  const previews = new Map();   // link → last fetched group info (what `groupJoin` needs)
  const errReply = (e) => {
    if (e && e.code === 'ERR_NO_NETWORK') return GJ.plain.noNet;
    const code = e && e.error_code;
    return code ? (GJ.plain[Number(code)] || GJ.plain.occur + ' (' + code + ')') : GJ.plain.occur;
  };
  const groupPreview = async (link) => {
    try {
      link = inviteLink(link);
      if (!link) return { state: 'error', text: GJ.plain[227] };
      if (!(await readyCached())) return { state: 'error', text: ALIAS_TEXT.notReady };
      if (!need('groupSvc')) return { state: 'error', text: ALIAS_TEXT.notReady };
      let info;
      try { info = await within(X.groupSvc.getGroupInfoByLink(link), 25000); } catch (e) { diag('group link ' + scrubErr(e)); return { state: 'error', text: errReply(e) }; }
      if (info === TIMEOUT) return { state: 'error', text: SLOW_TEXT };
      if (!info || info.groupId === undefined || info.groupId === null) return { state: 'error', text: GJ.plain.occur };
      const gid = 'g' + String(info.groupId).replace(/^g/, '');
      // The service builds `admins.concat(currentMems)`, so a person can appear twice: keep the first.
      const seen = new Set();
      const mems = (Array.isArray(info.currentMems) ? info.currentMems : []).filter((m) => {
        if (!m || m.id === undefined || seen.has(String(m.id))) return false;
        seen.add(String(m.id));
        return true;
      });
      if (mems.some((m) => isMeUid(String(m.id)) || String(m.id) === meNow())) return { state: 'member', groupId: gid };
      previews.set(link, { info, gid, mems });
      while (previews.size > 20) previews.delete(previews.keys().next().value);
      const community = isCommunity(info);
      const lockView = truthy(safe(() => info.setting.lockViewMember, 0));
      const admins = new Set((Array.isArray(info.adminIds) ? info.adminIds : []).map(String));
      if (info.creatorId !== undefined) admins.add(String(info.creatorId));
      const creatorId = info.creatorId !== undefined ? String(info.creatorId) : '';
      const nameFor = (m) => nameOf(String(m.id)) || str(m.dName);
      const shown = (lockView ? mems.filter((m) => admins.has(String(m.id))) : mems).slice(0, 12);
      return {
        state: 'preview', groupId: gid, name: str(info.name), avatar: core.absUrl(info.avt), totalMember: Number(info.totalMember) || mems.length,
        desc: str(info.desc).slice(0, 2000), community,
        creatorName: creatorId ? (nameOf(creatorId) || str((mems.find((m) => String(m.id) === creatorId) || {}).dName)) : '',
        members: shown.map((m) => ({ id: String(m.id), name: nameFor(m), avatar: core.absUrl(m.avatar) || avatarOf(String(m.id)), admin: admins.has(String(m.id)) })),
      };
    } catch (e) { diag('groupPreview ' + scrubErr(e)); return { state: 'error', text: GJ.plain.occur }; }
  };
  // → {state:'joined'|'pending'|'already'|'error', groupId?, text?}
  const groupJoin = async (link) => {
    try {
      link = inviteLink(link);
      const pv = link ? previews.get(link) : null;
      if (!pv) return { state: 'error', text: 'Hãy mở lại liên kết nhóm để xem thông tin trước khi tham gia.' };
      const r = await guarded('join|' + link, async () => {
        if (!S.groups || typeof S.groups.joinGroupByLink !== 'function') return { state: 'error', text: ALIAS_TEXT.notReady };
        const info = pv.info, community = isCommunity(info);
        // official `_join`: {id, avatar, dName: user.zaloName}
        const me = { id: meNow(), avatar: avatarOf(meNow()) || core.myAvatar && core.myAvatar(), dName: str(profileOf(meNow()).zaloName) || core.myName() };
        const top = pv.mems.map((m) => ({ id: m.id, dName: m.dName, avatar: m.avatar }));
        // the group record the official `_join` hands over (it is cached locally by the join)
        const record = { userId: pv.gid, groupId: pv.gid, isGroup: true, topMember: [...top, me], displayName: str(info.name), creatorId: info.creatorId, totalMember: top.length + 1, type: info.type };
        try {
          await S.groups.joinGroupByLink(link, record);
          return { state: 'joined', groupId: pv.gid };
        } catch (e) {
          if (e && e.code === 'ERR_NO_NETWORK') return { state: 'error', text: GJ.plain.noNet };
          const code = e && e.error_code;
          diag('join ' + (code || scrubErr(e)));
          if (!code) return { state: 'error', text: GJ.plain.occur };
          if (Number(code) === 240) return { state: 'pending', text: gjText(240, community) };
          if (Number(code) === 178) return { state: 'already', groupId: pv.gid, text: gjText(178, community) };
          const known = GJ.plain[Number(code)] || (community ? GJ.community : GJ.group)[Number(code)];
          return { state: 'error', text: known || str(e.error_message) || gjText('unknown', community) + ' (' + code + ')' };
        }
      }, 45000);
      if (r.status) return { state: 'error', text: r.text || PENDING_TEXT, pending: r.status === 'pending' };
      return r;
    } catch (e) { diag('groupJoin ' + scrubErr(e)); return { state: 'error', text: GJ.plain.occur }; }
  };

  // ---- sticker category (official sticker dock at `_showStickerSet({id})`, here a sheet) ----
  // Category info + stickers come from the official sticker manager (`getSingleCategory`, `fetchCateIfNotEnoughSticker`); a click sends the
  // sticker like the dock does (`chat-box _sendSticker(sticker, STORE_STICKER_BIG_PANEL)`), to the conversation the card is in.
  const stickerList = async (id) => {
    const list = await within(X.stickerMgr.fetchCateIfNotEnoughSticker(id), 25000);
    if (list === TIMEOUT) throw new Error('timeout');
    return (Array.isArray(list) ? list : []).filter((x) => x && Number(x.id) > 0 && Number(x.cateId) === id && !safe(() => X.stickerMgr.isHideSticker(x), false));
  };
  const stickerCategory = async (cateId) => {
    try {
      const id = Number(digits(cateId));
      if (!(id > 0)) return null;
      if (!(await readyCached()) || !need('stickerMgr')) return null;
      const cate = await within(Promise.resolve(X.stickerMgr.getSingleCategory(id)).catch(() => null), 12000);
      const list = await stickerList(id);
      if (!list.length) return null;
      const c = cate && cate !== TIMEOUT && typeof cate === 'object' ? cate : {};
      return {
        id, name: str(c.name), icon: core.absUrl(c.iconUrl),
        stickers: list.slice(0, 300).map((x) => ({ ref: `${id}_${Number(x.id)}`, url: core.absUrl(x.stickerUrl || x.url) })).filter((x) => x.url),
      };
    } catch (e) { diag('stickerCategory ' + scrubErr(e)); return null; }
  };
  // Sends a sticker object resolved by the official sticker manager through the chat-box controller (official `_sendSticker(sticker, src, null, suggestion)`
  // ~4224700: use count, send source tracking, recent list `addStickerToRecentList(sticker, PC_SEND)`). The conversation's lock is checked again here, right
  // before the send, and the controller is resolved only now. `sgg`: the suggestion source the official UI records just before the send (`setStickerSrc`,
  // read and cleared by the send itself, ~11728347); it is cleared again when the send is not reached. `suggestion`: the 4th argument (no use-count point).
  // `_sendSticker` can throw after it handed the message to `_sendMessage`: then the sticker may be on its way, so a throw is 'pending' (never 'error':
  // nobody is invited to send it again) and the slot of the conversation stays taken by the caller's `guarded` until this returns.
  const deliverSticker = async (convId, sticker, src, opts = {}) => {
    const blocked = lockReply(convId);
    if (blocked) return blocked;
    const cc = await controllerFor(convId);
    if (!cc) return { status: 'not-open' };
    scan();
    let srcSet = false;
    if (opts.sgg != null && X.stickerSrc) srcSet = safe(() => { X.stickerSrc.setStickerSrc(Number(opts.sgg)); return true; }, false);
    const unset = () => { if (srcSet) safe(() => X.stickerSrc.clearStickerSrc(), null); };
    try {
      const r = opts.suggestion ? cc._sendSticker(sticker, src, null, true) : cc._sendSticker(sticker, src);
      if (r && typeof r.then === 'function') Promise.resolve(r).catch((e) => { unset(); diag('send sticker ' + scrubErr(e)); });
    } catch (e) {
      unset();
      diag('send sticker ' + scrubErr(e));
      return { status: 'pending', text: PENDING_TEXT };
    }
    return { status: 'done' };
  };
  // Whether the user has downloaded the set (the dock shows it with `inStore` false → the normal panel source, else the store's).
  const isDownloaded = async (cid) => {
    try {
      const ids = await within(Promise.resolve(X.stickerMgr.getDownloadedCateIds()).catch(() => null), 5000);
      return Array.isArray(ids) && ids.some((v) => Number(v) === cid);
    } catch { return false; }
  };
  // Resolve → deliver, shared by the category sheet and the sticker picker: the sticker is resolved by the official manager from its ids
  // (`getStickerIfNotExist`, not whatever the page sent), must be that set's and not hidden, and goes out under the conversation's one-send slot.
  // `plan(sticker)` → {src, sgg?, suggestion?} is called right before the send (it may be async and may record official stats).
  const sendStickerById = (convId, cid, sid, plan) => guarded('stk|' + convId, async () => {
    const blocked = lockReply(convId);
    if (blocked) return blocked;
    if (!need('stickerMgr')) return { status: 'not-open' };
    const found = await within(Promise.resolve(X.stickerMgr.getStickerIfNotExist(cid, sid)).catch(() => null), 12000);
    if (!found || found === TIMEOUT || Number(found.id) !== sid || Number(found.cateId !== undefined ? found.cateId : found.catId) !== cid
      || safe(() => X.stickerMgr.isHideSticker(found), true)) return { status: 'not-found' };
    const p = await plan(found);
    return await deliverSticker(convId, found, p.src, p);
  }, 40000);
  const stickerCategorySend = async (convId, cateId, stickerId) => {
    convId = String(convId);
    try {
      const cid = Number(digits(cateId)), sid = Number(digits(stickerId));
      if (!(cid > 0 && sid > 0)) return { status: 'error' };
      return await sendStickerById(convId, cid, sid, async () => ({ src: (await isDownloaded(cid)) ? STICKER_SMALL_PANEL_SRC : STORE_STICKER_SMALL_PANEL_SRC }));
    } catch (e) { diag('stickerSend ' + scrubErr(e)); return { status: 'error' }; }
  };

  // ---- reminder cards: the official reminder e-card controller (module "eD/0"), one per visible card ----
  // Same object the React card builds (`useReminderEcardState`): it derives the variant from the reminder, permissions and whether this is the
  // latest card of the reminder, refreshes from the server (`loadStored`) and does the RSVP through the reminder detail service (`respond`).
  const reminders = new Map();         // `${convId}|${msgId}` → rec {ctl, convId, seq, last, busy, waiters, unsub}
  let reminderGC = null, reminderSeq = 0;
  const MAX_REMINDERS = 40;
  // One answer at a time per REMINDER (not per card): `${convId}|${reminderId}` → 'accept' | 'reject' while the official `respond` has not
  // settled. The work is never cancelled, so a retry after the timeout text cannot start a second answer; every card of the reminder shows it
  // as `pending`.
  const rsvpFlight = new Map();
  const PENDING_RSVP_TEXT = 'Đang xử lý, hãy kiểm tra lại sau.';
  const rsvpName = (v) => { const E = X.consts && X.consts.EVENT_STATUS; return !E ? '' : v === E.ACCEPT ? 'accept' : v === E.REJECT ? 'reject' : ''; };
  const REPEAT_LABEL = { DAILY: 'Nhắc theo ngày', WEEKLY: 'Nhắc theo tuần', MONTHLY: 'Nhắc theo tháng', YEARLY: 'Nhắc theo năm' };   // STR_RMD_REMIND_*
  const countOf = (v) => { const n = Math.floor(Number(Array.isArray(v) ? v.length : v)); return Number.isFinite(n) && n > 0 ? Math.min(n, 1e6) : 0; };
  const flightKey = (convId, rid) => convId + '|' + rid;
  const ridOf = (rec) => str(safe(() => rec.ctl.getState().reminder.id, ''));
  const reminderSnapshot = (rec) => {
    const st = rec.ctl.getState() || {};
    const r = st.reminder;
    if (!r) return { variant: str(st.variant) || 'hidden', sig: 'hidden' };
    const creator = str(r.creatorId);
    const mine = isMeUid(creator) || creator === meNow() || creator === '0';
    const perm = st.permission || {};
    const onlyMe = r.audience === 'onlyMe';
    const rid = str(r.id);
    const snap = {
      variant: str(st.variant) || 'hidden', rid, title: str(r.title), start: Number(st.ecardStartTime || r.startTime) || 0,
      repeat: REPEAT_LABEL[r.repeatRule && r.repeatRule.freq] || '',
      creatorName: mine ? 'Bạn' : nameOf(creator), onlyMe, isGroup: r.scope === 'group',
      // The answer being sent: this controller's own, or the one in flight through another card of the same reminder.
      mine: rsvpName(r.rsvp && r.rsvp.mine), pending: rsvpName(st.pendingRsvp) || rsvpFlight.get(flightKey(rec.convId, rid)) || '',
      accepted: countOf(r.rsvp && r.rsvp.accept), rejected: countOf(r.rsvp && r.rsvp.reject),
      canRsvp: !!perm.canRsvp, canView: !!perm.canView, deleted: !!st.deleted,
    };
    snap.sig = JSON.stringify(snap);
    return snap;
  };
  const notifyReminder = (rec) => {
    if (!rec.waiters.size) return;
    const sig = reminderSnapshot(rec).sig;
    for (const w of [...rec.waiters]) if (sig !== w.known) { rec.waiters.delete(w); w.resolve(); }
  };
  const notifyReminderId = (convId, rid) => { for (const r of reminders.values()) if (r.convId === convId && ridOf(r) === rid) safe(() => notifyReminder(r), null); };
  const dropReminder = (key, rec) => { reminders.delete(key); safe(() => rec.unsub && rec.unsub(), null); safe(() => rec.ctl.dispose(), null); for (const w of rec.waiters) w.resolve(); rec.waiters.clear(); };
  // Least recently used first, and only controllers nobody is waiting on (a card on screen keeps one) and that are not answering:
  // evicting a watched one would make its card re-create it (each `start()` re-reads, and refreshes a group reminder, from the server).
  const evictReminders = (keep) => {
    while (reminders.size > MAX_REMINDERS) {
      let victim = null;
      for (const [k, r] of reminders) if (r !== keep && !r.waiters.size && !r.busy && (!victim || r.last < victim[1].last)) victim = [k, r];
      if (!victim) return;
      dropReminder(victim[0], victim[1]);
    }
  };
  // Official gate of the v2 reminder card (`legacy-bridge` "2Jz/" `f()`: new UI enabled and `renderEcard` registered). Closed → the
  // official client draws its legacy card, so no controller is used here. Module missing = unknown = not blocked.
  const reminderGate = () => {
    const m = safe(() => window.__zaloRequire.c['2Jz/'].exports, null);
    return m && typeof m.f === 'function' ? safe(() => m.f() === true, null) : null;
  };
  // The reminder reference the official normalizer needs (module "oxPB" `d` / `a`): the action data parses to an object holding a
  // `topicId` / `reminderId` / `id`; otherwise the controller has nothing to show.
  const reminderRefOk = (info) => {
    let d = dataOf(info.acts[0].data);
    if (d && typeof d.act === 'string' && d.data !== undefined) d = typeof d.data === 'string' ? dataOf(d.data) : d.data;
    if (!d || typeof d !== 'object') return false;
    return [d.topicId, d.reminderId, d.id].some((v) => (typeof v === 'string' && v !== '') || (typeof v === 'number' && Number.isFinite(v)));
  };
  const reminderOf = (convId, msgId) => {
    scan();
    if (!X.reminder || !X.consts) return null;
    const m = core.findMessage(convId, msgId);
    if (!m || Number(m.msgType) !== MSG.ECARD) return null;
    const info = ecardInfo(m);
    if (!isReminder(info) || !reminderRefOk(info)) return null;
    if (reminderGate() === false) return null;
    const key = convId + '|' + String(m.msgId || m.cliMsgId);
    let rec = reminders.get(key);
    if (!rec) {
      let ctl;
      try { ctl = new X.reminder(m, convId); } catch (e) { diag('reminder init ' + scrubErr(e)); return null; }
      rec = { ctl, convId, seq: ++reminderSeq, last: Date.now(), busy: 0, waiters: new Set(), unsub: null, started: null };
      rec.unsub = ctl.subscribe(() => notifyReminder(rec));
      reminders.set(key, rec);
      rec.started = Promise.resolve().then(() => ctl.start()).catch((e) => diag('reminder start ' + scrubErr(e)));
      if (!reminderGC) {
        reminderGC = setInterval(() => {
          for (const [k, r] of [...reminders]) if (!r.waiters.size && !r.busy && Date.now() - r.last > 90000) dropReminder(k, r);
        }, 30000);
      }
      evictReminders(rec);
    }
    rec.last = Date.now();
    return rec;
  };
  const reminderWatch = async (convId, msgId, known) => {
    try {
      convId = String(convId);
      await readyCached();
      const rec = reminderOf(convId, msgId);
      if (!rec) return null;
      let snap = reminderSnapshot(rec);
      if (snap.sig !== str(known)) return snap;
      await new Promise((resolve) => {
        const w = { known: snap.sig, resolve };
        rec.waiters.add(w);
        setTimeout(() => { if (rec.waiters.delete(w)) resolve(); }, 25000);
      });
      rec.last = Date.now();
      return reminderSnapshot(rec);
    } catch (e) { diag('reminderWatch ' + scrubErr(e)); return null; }
  };
  // Every card of one reminder (invite / alert) answers through the same controller, the oldest alive: its own `pendingRsvp` guard then
  // covers all of them, like the single controller of the official detail.
  const responderFor = (rec) => {
    const rid = ridOf(rec);
    let pick = rec;
    if (rid) for (const r of reminders.values()) if (r.convId === rec.convId && r.seq < pick.seq && ridOf(r) === rid) pick = r;
    return pick;
  };
  // RSVP: only on the user's click. The controller itself refuses when the reminder is deleted / not answerable / already that answer.
  // A timeout is not a failure: the answer may still land (the key stays taken until it settles) → "đang xử lý".
  const reminderRespond = async (convId, msgId, choice) => {
    try {
      convId = String(convId);
      await readyCached();
      const rec = reminderOf(convId, msgId);
      const E = X.consts && X.consts.EVENT_STATUS;
      if (!rec || !E || (choice !== 'accept' && choice !== 'reject')) return { ok: false, text: 'Không thực hiện được thao tác.' };
      const shown = reminderSnapshot(rec);
      if (shown.deleted) return { ok: false, text: 'Nhắc hẹn đã bị xoá', snapshot: shown };
      const rid = shown.rid;
      if (!rid) return { ok: false, text: 'Không thực hiện được thao tác.', snapshot: shown };
      const key = flightKey(convId, rid);
      if (rsvpFlight.has(key)) return { ok: false, pending: true, text: PENDING_RSVP_TEXT, snapshot: shown };
      const owner = responderFor(rec);
      const before = reminderSnapshot(owner);
      if (before.deleted) return { ok: false, text: 'Nhắc hẹn đã bị xoá', snapshot: shown };
      if (before.pending) return { ok: false, pending: true, text: PENDING_RSVP_TEXT, snapshot: shown };
      rsvpFlight.set(key, choice);
      owner.busy++;
      notifyReminderId(convId, rid);
      const run = Promise.resolve().then(() => owner.ctl.respond(choice === 'accept' ? E.ACCEPT : E.REJECT));
      const settle = () => { owner.busy--; if (rsvpFlight.get(key) === choice) rsvpFlight.delete(key); notifyReminderId(convId, rid); };
      run.then(settle, settle);
      const done = await within(run, 25000);
      const after = reminderSnapshot(rec);
      if (done === TIMEOUT) return { ok: false, pending: true, text: PENDING_RSVP_TEXT, snapshot: after };
      const settled = reminderSnapshot(owner);
      return settled.mine === choice ? { ok: true, snapshot: after } : { ok: false, text: settled.deleted ? 'Nhắc hẹn đã bị xoá' : 'Có lỗi xảy ra', snapshot: after };
    } catch (e) { diag('reminderRespond ' + scrubErr(e)); return { ok: false, text: 'Có lỗi xảy ra' }; }
  };

  // ---- reminder responders ("Danh sách tham gia"): the lists behind the official detail's responders page (component "$c") ----
  // `ModuleContainer.resolve(token "GHUl" = "reminder-detail-service").listResponders(reminder)` → `{accept:[uid], reject:[uid]}` (a READ:
  // `getListResponseEvent`; the service also stores the lists with the cached reminder, as it does for the official page). Names / avatars:
  // the profile service, fetching the ones it lacks with `FETCH_MINI_INFO` (hook "7itQ" `c`). Read-only; called when the page is opened.
  const MAX_RESPONDERS = 500;
  const reminderService = () => {
    const req = window.__zaloRequire;
    const mc = safe(() => req.c['jDHv'].exports.ModuleContainer, null), token = safe(() => req.c['GHUl'].exports.a, null);
    const svc = mc && token ? safe(() => mc.resolve(token), null) : null;
    return svc && typeof svc.listResponders === 'function' ? svc : null;
  };
  const responderProfiles = async (uids) => {
    const svc = S.friends;
    if (!svc || typeof svc.getMiniInfo !== 'function' || typeof svc.getProfileFriendByIds !== 'function') return;
    scan();
    const lacks = uids.filter((u) => { const mi = safe(() => svc.getMiniInfo(u), null); return !mi || !mi.avatar || !(str(mi.dName) || str(mi.displayName) || str(mi.zaloName) || str(mi.zName)); });
    const src = safe(() => (S.codes && S.codes.FETCH_MINI_INFO) ?? (X.consts && X.consts.SRC_GET_PROFILE && X.consts.SRC_GET_PROFILE.FETCH_MINI_INFO), undefined);
    if (!lacks.length || src === undefined) return;
    await within(Promise.resolve(safe(() => svc.getProfileFriendByIds(lacks, src), null)).catch(() => null), 8000);
  };
  const reminderResponders = async (convId, msgId) => {
    try {
      convId = String(convId);
      await readyCached();
      const rec = reminderOf(convId, msgId);
      if (!rec) return null;
      // `listResponders` stores `{...reminder, rsvpMembers}`: let the controller's own stored-data read finish first, so a stale copy
      // cannot overwrite fresher stored data, and use the reminder it ended up with.
      if (rec.started) await within(rec.started, 10000);
      const st = rec.ctl.getState() || {};
      const r = st.reminder;
      // Official: only group reminders that are not "only me" have the page; none for a deleted one.
      if (!r || st.deleted || r.scope !== 'group' || r.audience === 'onlyMe') return null;
      const svc = reminderService();
      if (!svc) return null;
      let lists = null;
      try { lists = await within(svc.listResponders(r), 20000); } catch { lists = null; }
      if (lists === TIMEOUT || !lists || typeof lists !== 'object') lists = r.rsvpMembers && typeof r.rsvpMembers === 'object' ? r.rsvpMembers : null;
      if (!lists) return { ok: false };
      const ids = (v) => (Array.isArray(v) ? [...new Set(v.map(String).filter((u) => /^\d{1,24}$/.test(u)))] : []);
      const accept = ids(lists.accept), reject = ids(lists.reject);
      const shown = [...accept.slice(0, MAX_RESPONDERS), ...reject.slice(0, MAX_RESPONDERS)];
      await responderProfiles(shown);
      // Official row ("Zc"): nothing is drawn for a user without mini info.
      const known = (uid) => !!safe(() => S.friends.getMiniInfo(uid), null);
      const person = (uid) => {
        const me = isMeUid(uid) || uid === meNow();
        return { uid, name: nameOf(uid) || (me ? 'Bạn' : 'Người dùng Zalo'), avatar: avatarOf(uid) || '', isMe: me };
      };
      const rows = (list) => list.slice(0, MAX_RESPONDERS).filter(known).map(person);
      return {
        ok: true, accept: rows(accept), reject: rows(reject), acceptTotal: accept.length, rejectTotal: reject.length,
        acceptMore: Math.max(0, accept.length - MAX_RESPONDERS), rejectMore: Math.max(0, reject.length - MAX_RESPONDERS),
      };
    } catch (e) { diag('reminderResponders ' + scrubErr(e)); return { ok: false }; }
  };

  chat.performAction = performAction;
  chat.reminderWatch = reminderWatch;
  chat.reminderRespond = reminderRespond;
  chat.reminderResponders = reminderResponders;
  chat.cardStickers = cardStickers;
  chat.contactState = contactState;
  chat.contactProfile = contactProfile;
  chat.prepareFriendRequest = prepareFriendRequest;
  // Logout / account change: nothing fetched or in flight for the previous session may be reused.
  chat.cardReset = () => {
    previews.clear(); inflight.clear(); rsvpFlight.clear();
    for (const [k, r] of [...reminders]) dropReminder(k, r);
    return true;
  };
  chat.aliasSave = aliasSave;
  chat.groupPreview = groupPreview;
  chat.groupJoin = groupJoin;
  chat.stickerCategory = stickerCategory;
  chat.stickerCategorySend = stickerCategorySend;
  // Internals for the sticker adapter (sticker-adapter.js): the official sticker modules, the send path and its one-send-per-conversation slot.
  Object.defineProperty(chat, '__cardCore', {
    value: { X, real, need, scan, within, TIMEOUT, guarded, readyCached, lockReply, stickerList, isDownloaded, sendStickerById, STICKER_SMALL_PANEL_SRC },
    enumerable: false,
  });
  window.__zaloCardActions = { describe };
  diag('card actions installed');
})();
