// Olaz group-create adapter (index.html only): the official "Tạo nhóm" compose, answered by a native sheet (Views/CreateGroupSheet.swift).
// Exposes `window.__zaloGroupCreate`; Swift awaits its promises. Every step is the call the official compose makes:
//
//   entry      sidebar header button "Tạo nhóm chat" → SidebarController `showGroupCompose` (main-startup ~378406) → modal CREATE_GROUP_COMPOSE
//              (wrapper ~7374027, form "create-group-compose-v3" ~8137980, member picker base `W` ~13330961).
//   list       up to 5 latest 1:1 conversations with friends that are not official accounts (`isOAType`: profile type >= 1) — "Trò chuyện
//              gần đây" —, then every friend (`isFr === 1`) by name; built in Swift from the same data. Blocked friends cannot be picked
//              (`disableBlockedUsers`, toast STR_UNBLOCK_TO_ADD_TO_GROUP); at most `settings.group.max_member` picks (100, STR_MAX_MEM_TOAST);
//              the confirm button needs 2 picks. A pick that is blocked or no longer a friend by the time of `create()` is refused with its id
//              (the official list never lets it be picked), never dropped silently.
//   name       a typed name is checked against `group_config.group_name_regex` (STR_GROUP_NAME_INVALID) and sent with nameChanged=1; without one
//              the picked members' zaloName (else displayName) are joined with ", ". Then /[~`!@#$%^&*]/ is stripped, an untyped name longer
//              than `group_config.max_group_name_length` is cut + "....", and an empty one becomes STR_NEW_GROUP.
//   confirm    the wrapper's `onConfirm` first runs privacy service `checkCreateCondition(NORMAL)` (DI, main-startup ~1255179): joined groups at
//              the package quota → confirm "Không thể tạo nhóm/cộng đồng" (`data.error_message_localize`), any other failure → toast
//              STR_GROUP_PRIVACY_ERROR; either way the compose closes (`close: true`). Then fetcher "dThN" `createGroupV2(name, [{id, avatar, dName}], myUid, "NMlV".next(),
//              memberTypes (MEMBERS_TRACKING_SOURCE.friend), nameChanged, null, null, groupType NORMAL)` → /api/group/create/v2,
//              answering {conv, isExistGroup, errorInfo, successMembers}.
//   after      ConversationController `openConversation(id, openConvParam.fromGroupCompose(conv))`; `addCreateGroupSummary`: errorInfo
//              (error code → member ids) partitioned by "Fdvo".f into MSG_INFO messages {act:'create_group_summary', eventInfo}, stored by
//              "XS0u" `addGroupEventMessages` + FetchActions.ADD_MESSAGES; isExistGroup → toast STR_GROUP_EXISTS. A picked avatar goes to API
//              "fBUP" `updateAvatar(id, 160, myUid + fullTime, file, w, h)` (fire and forget, also for an existing group — official).
//   errors     "S4fx".a: ERR_NO_NETWORK → STR_CONNECTION_ERROR; 160/173/175/177/181/250/254/270 → STR_CREATE_GROUP_ERR_<code>; anything else →
//              error_message or STR_CREATE_GROUP_FAIL. (The compose passes no member list, so 181 shows nothing there; Olaz shows its text.)
//              The official compose closes as soon as the request is sent and reports errors afterwards; Olaz keeps its sheet open until the
//              answer, so a refused group can be fixed and sent again.
//   time       one budget from the start of `create()` (CREATE_WAIT) for readiness and the server answer, plus at most OPEN_WAIT for the official
//              open and STORE_WAIT for the store — below Swift's 45 s. An answer after the budget is 'pending' and only gets summary + avatar.
//   Not offered: E2EE groups (footer checkbox, onboarding — `e2ee.enable_group` is off in the live config), communities, adding people by
//   phone number.
//
// Swift → JS : info() → {status:'ok', maxMembers, maxNameLength, nameRegex, blocked:[id], officialAccounts:[id]} | {status:'not-ready'}
//              create({name, members:[id], avatar:{data (base64 JPEG), width, height}|null})
//                → {status:'created'|'exists', convId, text?, failed:[id]} | {status:'invalid', text, dropped?:[id]}
//                | {status:'failed', text, title?, close?} | {status:'pending'|'busy'|'not-ready', text}
(() => {
  'use strict';
  const NAME = window.__zaloGroupCreateTestName || '__zaloGroupCreate';
  if (window[NAME]) return;
  if (location.pathname.split('/').pop() !== 'index.html') return;
  const diag = (s) => { try { window.webkit.messageHandlers.zlog.postMessage('[groupcreate] ' + s); } catch {} };
  const safe = (fn, d) => { try { const v = fn(); return v === undefined ? d : v; } catch { return d; } };
  const str = (v) => (typeof v === 'string' ? v : '');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const has = (o, ...keys) => keys.every((k) => { try { return typeof o[k] === 'function'; } catch { return false; } });
  // The host answers unknown preload globals with catch-all placeholders that pass any shape test; real modules don't.
  const real = (o) => { try { return !!o && o.__olaz_not_a_member__ === undefined; } catch { return false; } };
  const scrub = (e) => String((e && (e.error_code || e.code || e.message)) || e).replace(/\d{6,}/g, '<id>').slice(0, 80);

  const TEXT = {
    notReady: 'Ứng dụng chưa sẵn sàng, hãy thử lại sau giây lát.',
    busy: 'Nhóm trước vẫn đang được tạo.',
    noReply: 'Chưa nhận được phản hồi. Hãy kiểm tra danh sách hội thoại trước khi thử lại.',
    tooFew: 'Không đủ số thành viên để tạo nhóm (tối thiếu là 3).',          // STR_CREATE_GROUP_ERR_181
    tooMany: (n) => 'Bạn chỉ có thể tạo nhóm với ' + n + ' người khác',       // STR_MAX_MEM_TOAST
    blocked: 'Bỏ chặn để thêm người này',                                     // STR_UNBLOCK_TO_ADD_TO_GROUP
    notFriend: 'Một số người đã chọn không còn trong danh sách bạn bè.',
    nameInvalid: 'Tên nhóm chứa ký tự không hợp lệ. Vui lòng thử lại.',       // STR_GROUP_NAME_INVALID
    newGroup: 'Nhóm mới',                                                    // STR_NEW_GROUP
    exists: 'Nhóm bạn vừa tạo đã tồn tại',                                   // STR_GROUP_EXISTS
    created: 'Bạn vừa tạo nhóm',                                             // STR_CREATE_GROUP_MSG
    limitTitle: 'Không thể tạo nhóm/cộng đồng',                              // STR_GROUP_PRIVACY_CANNOT_CREATE_GROUP_COMMUNITY
    limit: (n) => 'Bạn chỉ có thể tham gia đồng thời ' + n + ' nhóm và cộng đồng. Hãy rời hoặc giải tán các nhóm hoặc cộng đồng ít hoạt động để có thể tạo nhóm mới.',
    privacyError: 'Có lỗi xảy ra. Vui lòng thử lại.',                       // STR_GROUP_PRIVACY_ERROR
    noNetwork: 'Không có mạng, vui lòng kiểm tra lại kết nối và thử lại',    // STR_CONNECTION_ERROR
    fail: 'Tạo nhóm không thành công.',                                      // STR_CREATE_GROUP_FAIL
    errors: {                                                                // STR_CREATE_GROUP_ERR_<code>
      160: 'Tên nhóm không hợp lệ',
      173: 'Một số thành viên đã vượt quá số lượng nhóm cho phép. Số thành viên còn lại không đủ để tạo nhóm (tối thiếu là 3).',
      175: 'Tất cả thành viên đã chặn bạn.',
      177: 'Bạn đã vượt quá số lượng nhóm cho phép.',
      181: 'Không đủ số thành viên để tạo nhóm (tối thiếu là 3).',
      250: 'Tên nhóm không hợp lệ',
      254: 'Bạn không có quyền tạo nhóm vào lúc này',
      270: 'Bạn đã đạt giới hạn tạo nhóm trong ngày.',
    },
  };
  const NO_NETWORK = 'ERR_NO_NETWORK';
  const GROUP_NORMAL = 1;              // "6E7Z".g NORMAL (oMqy.n)
  const AVATAR_SIZE = 160;             // `updateAvatar(…, 160, …)` of the compose
  const CREATE_WAIT = 30000;
  const OPEN_WAIT = 5000;
  const STORE_WAIT = 3000;

  // ---- official services ----
  const S = {};
  let io = null, lastResolve = 0, loadingFriends = false;
  const resolve = () => {
    const req = window.__zaloRequire;
    if (!req || !window.__zaloStore || typeof window.__zaloDI !== 'function' || typeof window.__zaloEachExport !== 'function') return false;
    const complete = () => S.fetcher && S.opener && S.convParam && S.privacy && S.consts && S.clientId && S.friends;
    if (complete()) return true;
    if (Date.now() - lastResolve < 500) return false;
    lastResolve = Date.now();
    for (const reg of window.__zaloDI(req)) {
      const i = reg && reg.instance;
      if (!real(i) || typeof i !== 'object') continue;
      try {
        if (!S.opener && has(i, 'openConversation', 'conversationWillOpen')) S.opener = i;
        if (!S.privacy && has(i, 'checkCreateCondition', 'getOwnedCommunities')) S.privacy = i;
        if (!io && has(i, 'getFriendManagerModule', 'getGroupManagerModule')) io = i;
      } catch {}
    }
    if (io && !S.friends && !loadingFriends) {
      loadingFriends = true;
      Promise.resolve().then(() => io.getFriendManagerModule()).then((f) => { S.friends = (f && f.default) || f; })
        .catch((e) => diag('friend module: ' + scrub(e))).finally(() => { loadingFriends = false; });
    }
    window.__zaloEachExport(req, (ex) => {
      if (!ex || (typeof ex !== 'object' && typeof ex !== 'function') || !real(ex)) return;
      try {
        if (!S.convParam && ex.openConvParam && has(ex.openConvParam, 'fromGroupCompose')) S.convParam = ex.openConvParam;
        if (!S.consts && ex.MEMBERS_TRACKING_SOURCE && ex.GROUPID_PREFIX !== undefined && ex.MSG_INFO !== undefined) S.consts = ex;
        if (!S.partition && ex.a && real(ex.a) && ex.a.MUTUAL_MESSAGES_BLOCKED === 'mutual-messages-blocked' && typeof ex.f === 'function') S.partition = ex.f;
        if (!S.fetch && ex.FetchActions && ex.FetchActions.ADD_MESSAGES) S.fetch = ex.FetchActions;
        for (const o of [ex, ex.default]) {
          if (!real(o) || (typeof o !== 'object' && typeof o !== 'function')) continue;
          if (!S.lang && has(o, 'str', 'trans', 'currentLanguage')) S.lang = o;
          // The fetcher is an instance; the API class "fBUP" (a function) has static createGroupV2 / createGroupTopicv2 / getGroupInfoByLink too.
          if (!S.fetcher && typeof o === 'object' && has(o, 'createGroupV2', 'createGroupNoticeCmd', 'getGroupInfoByLink')) S.fetcher = o;
          if (!S.api && has(o, 'updateAvatar', 'getSocketUrl', 'createGroupV2')) S.api = o;
          if (!S.clientId && has(o, 'next', 'setGetTimeServerFunc') && '_lastClientId' in o) S.clientId = o;
          if (!S.events && has(o, 'addGroupEventMessages')) S.events = o;
          if (!S.time && has(o, 'getFullTimeFromMilisecond')) S.time = o;
          if (!S.utils && has(o, 'isOAType', 'getUserId', 'simpleStripVietnamese')) S.utils = o;
          if (!S.cfg && o.group_config && typeof o.group_config === 'object' && 'max_group_name_length' in o.group_config) S.cfg = o;
          if (!S.settings && o.settings && o.settings.group && typeof o.settings.group.max_member === 'number') S.settings = o;
        }
      } catch {}
    });
    return !!complete();
  };
  const ready = async () => {
    for (let i = 0; i < 20; i++) { if (resolve()) return true; await sleep(250); }
    return false;
  };
  const within = (promise, ms) => Promise.race([Promise.resolve(promise), sleep(ms)]);

  const myId = () => str(safe(() => String(window.__zaloStore.getState().user.userId), ''));
  const maxMembers = () => { const n = safe(() => S.settings.settings.group.max_member, 0); return typeof n === 'number' && n > 0 ? n : 100; };
  const maxNameLength = () => { const n = safe(() => S.cfg.group_config.max_group_name_length, 0); return typeof n === 'number' && n > 0 ? n : 50; };
  const nameRegex = () => str(safe(() => S.cfg.group_config.group_name_regex, '')) || '`|~|!|@|#|%|\\*|\\^|\\$';
  const isBlocked = (id) => !!safe(() => S.friends.isBlocked(id), false);
  // utils `isOAType` (a non-group profile with type >= 1).
  const isOA = (p) => !!safe(() => (S.utils ? S.utils.isOAType(p) : !String(p.userId).startsWith('g') && p.type >= 1), false);
  // The picker's friend map (`loadFriend`): friend entries with isFr === 1, never My Cloud.
  const friendMap = () => {
    const map = new Map();
    for (const x of safe(() => S.friends.getFriendsSync(), null) || []) if (x && x.userId && x.isFr === 1) map.set(String(x.userId), x);
    return map;
  };

  // The compose's `onConfirm` name: typed (trimmed) or the members' names, cleaned the same way.
  const groupName = (typed, picked) => {
    let name = typed;
    if (!name) name = picked.map((p) => str(p.zaloName) || str(p.displayName)).filter(Boolean).join(', ');
    if (!name) name = TEXT.newGroup;
    name = name.replace(/[~`!@#$%\^&*]/g, '').trim();
    if (name.length > maxNameLength() && !typed) name = name.substring(0, maxNameLength()) + '....';
    return name || TEXT.newGroup;
  };

  // "S4fx".a, as text for Swift.
  const errorText = (e) => {
    const code = e && e.error_code;
    if (e && e.code === NO_NETWORK) return TEXT.noNetwork;
    if (TEXT.errors[code]) return TEXT.errors[code];
    return str(e && e.error_message) || TEXT.fail;
  };

  // `addCreateGroupSummary`: the members the server did not add, as info messages of the new group.
  const addSummary = (convId, errorInfo, successMembers) => {
    try {
      if (!errorInfo || typeof errorInfo !== 'object' || !S.partition || !S.events) return;
      const kept = {};
      for (const [code, ids] of Object.entries(errorInfo)) if (Array.isArray(ids) && ids.length) kept[code] = ids.slice();
      if (!Object.keys(kept).length) return;
      const text = str(safe(() => S.lang.str('STR_CREATE_GROUP_MSG'), '')) || TEXT.created;
      const msgs = S.partition(kept).map((part) => {
        const eventInfo = { errorMembers: part.errorMembers };
        if (part.group === null && Array.isArray(successMembers) && successMembers.length) eventInfo.successMembers = successMembers.slice();
        return { cliMsgId: String(S.clientId.next()), toUid: convId, msgType: S.consts.MSG_INFO, sendDttm: Date.now() + '', message: text,
          act: 'create_group_summary', eventInfo };
      });
      Promise.resolve(S.events.addGroupEventMessages(convId, msgs)).then((r) => {
        if (r && r.conversation && r.messages && S.fetch) {
          window.__zaloStore.dispatch({ type: S.fetch.ADD_MESSAGES,
            payload: { conversationId: r.conversation.userId, messages: r.messages, conversation: r.conversation } });
        }
      }).catch((e) => diag('summary: ' + scrub(e)));
    } catch (e) { diag('summary: ' + scrub(e)); }
  };

  const uploadAvatar = (convId, avatar) => {
    if (!avatar || !avatar.data || !S.api) return;
    try {
      const raw = atob(avatar.data);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      // The compose's file: a JPEG blob named like `blobToFile` names it.
      const file = new Blob([bytes], { type: 'image/jpeg' });
      file.name = 'change-avatar.jpg'; file.lastModifiedDate = new Date();
      const stamp = safe(() => S.time.getFullTimeFromMilisecond(Date.now()), '') || String(Date.now());
      Promise.resolve(S.api.updateAvatar(convId, AVATAR_SIZE, myId() + stamp, file, avatar.width || 257, avatar.height || 257))
        .then(() => diag('avatar ok'), (e) => diag('avatar: ' + scrub(e)));
    } catch (e) { diag('avatar: ' + scrub(e)); }
  };

  // What the compose does once the server answered (`late`: Swift stopped waiting, so nothing is opened under it).
  const finish = async (res, avatar, late) => {
    const conv = res && res.conv;
    const convId = conv && conv.userId ? String(conv.userId) : '';
    if (!convId) return { status: 'failed', text: TEXT.fail };
    if (!late) {
      try { await within(S.opener.openConversation(convId, S.convParam.fromGroupCompose(conv)), OPEN_WAIT); } catch (e) { diag('open: ' + scrub(e)); }
      // The list and chat read the conversation from the store: give the official open a moment to put it there.
      for (let i = 0; i < STORE_WAIT / 100 && !safe(() => window.__zaloStore.getState().conversations.alls[convId], null); i++) await sleep(100);
    }
    addSummary(convId, res.errorInfo, res.successMembers);
    uploadAvatar(convId, avatar);
    const failed = [];
    for (const ids of Object.values(res.errorInfo || {})) if (Array.isArray(ids)) for (const id of ids) if (!failed.includes(String(id))) failed.push(String(id));
    return res.isExistGroup ? { status: 'exists', convId, text: TEXT.exists, failed } : { status: 'created', convId, failed };
  };

  let busy = false;
  window[NAME] = {
    async info() {
      if (!(await ready())) return { status: 'not-ready' };
      const blocked = [], officialAccounts = [];
      for (const [id, p] of friendMap()) {
        if (isBlocked(id)) blocked.push(id);
        if (isOA(p)) officialAccounts.push(id);
      }
      return { status: 'ok', maxMembers: maxMembers(), maxNameLength: maxNameLength(), nameRegex: nameRegex(), blocked, officialAccounts };
    },

    async create(input) {
      if (busy) return { status: 'busy', text: TEXT.busy };
      busy = true;
      const deadline = Date.now() + CREATE_WAIT;
      try {
        if (!(await ready())) return { status: 'not-ready', text: TEXT.notReady };
        input = input && typeof input === 'object' ? input : {};
        const me = myId();
        const friends = friendMap();
        const ids = [], blocked = [], gone = [];
        for (const raw of Array.isArray(input.members) ? input.members : []) {
          const id = String(raw);
          if (!id || id === me || ids.includes(id)) continue;
          if (!friends.has(id)) gone.push(id);
          else if (isBlocked(id)) blocked.push(id);
          else ids.push(id);
        }
        if (blocked.length) return { status: 'invalid', text: TEXT.blocked, dropped: blocked };
        if (gone.length) return { status: 'invalid', text: TEXT.notFriend, dropped: gone };
        if (ids.length < 2) return { status: 'invalid', text: TEXT.tooFew };
        if (ids.length > maxMembers()) return { status: 'invalid', text: TEXT.tooMany(maxMembers()) };
        let typed = str(input.name).trim();
        if (typed && new RegExp(nameRegex(), 'g').test(typed)) return { status: 'invalid', text: TEXT.nameInvalid };
        if (typed.length > maxNameLength()) typed = typed.substring(0, maxNameLength()).trim();

        try {
          await S.privacy.checkCreateCondition(GROUP_NORMAL);
        } catch (e) {
          const limitCode = safe(() => S.consts.GROUP_MEMBER_ERROR.REACHED_LIMIT_GROUP, undefined);
          if (e && limitCode !== undefined && e.error_code === limitCode) {
            return { status: 'failed', title: TEXT.limitTitle, text: str(safe(() => e.data.error_message_localize, '')) || TEXT.limit(''), close: true };
          }
          diag('check: ' + scrub(e));
          return { status: 'failed', text: TEXT.privacyError, close: true };
        }

        const picked = ids.map((id) => friends.get(id));
        const members = picked.map((p) => ({ id: String(p.userId), avatar: p.avatar, dName: str(p.zaloName) || str(p.displayName) }));
        const types = ids.map(() => safe(() => S.consts.MEMBERS_TRACKING_SOURCE.friend, -1));
        const name = groupName(typed, picked);
        const avatar = input.avatar && typeof input.avatar === 'object' ? input.avatar : null;
        let timedOut = false;
        const call = Promise.resolve(S.fetcher.createGroupV2(name, members, me, S.clientId.next(), types, !!typed, null, null, GROUP_NORMAL));
        // An answer after Swift stopped waiting still gets the summary and the avatar.
        call.then((res) => { if (timedOut) finish(res, avatar, true); }, (e) => { if (timedOut) diag('late failure: ' + scrub(e)); });
        const res = await Promise.race([call, sleep(Math.max(0, deadline - Date.now())).then(() => { timedOut = true; return null; })]);
        if (timedOut) return { status: 'pending', text: TEXT.noReply };
        return await finish(res, avatar, false);
      } catch (e) {
        diag('create: ' + scrub(e));
        return { status: 'failed', text: errorText(e) };
      } finally {
        busy = false;
      }
    },
  };
})();
