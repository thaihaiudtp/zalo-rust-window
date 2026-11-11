// Olaz call adapter (index.html only): voice / video calls through the official "zcall-v2" client.
//
// Who does what (same split as the official Zalo PC client):
//   * The official renderer's call helper (webpack module "OU7N", `A.default` export `d`) owns the call
//     logic: it relays call signalling between the realtime connection and the native call helper
//     (`ZaloCall`, a Qt app inside Zalo.app) through `$zcall` / `$zsub.$zcall`, and asks the native helper to
//     ring / dial. The renderer decides whether calls are available from the server config
//     (`enable_mac_call`, `enable_ipc_call`, `settings.chat.enable_call`, `enable_video_call`) — nothing is
//     overridden here.
//   * Swift (`CallBridge`) plays the Electron main process: it hosts the two sockets, starts `ZaloCall`
//     and relays the (encrypted) messages. The helper draws the call window and handles mic / camera.
//
// This script:
//   1. Preload-side `$zcall.sendDataToNative` / `$zcall.initCall`: serialise the message exactly as the
//      main process would (`JSON.stringify`, dropping undefined) and strip `_optional` as main does, then
//      hand `[json, optional]` to Swift on the IPC channels `call-send-to-native` / `call-init`. (The
//      table-driven members would pass structured objects; JSON text keeps the helper's input byte-exact.)
//      Also notes incoming-call requests on their way to the helper so the app can alert the user.
//   2. Legacy `$znode.nativelibs.zcall().getListDevices()` (only used by the settings page when
//      `enable_ipc_call` is off): an empty device list.
//   3. `window.__zaloCall` for Swift.
//
// Group calls (video only, like the official header which has no group voice button):
//   * Header gate = the chat header's own rule (`fl` in the header module): `isSupport()`, then the remote "call"
//     config `visibility.group_member_threshold` / `community_member_threshold` against the group's `totalMember`
//     (-2 = shown but disabled, -1 / below = hidden). `makeCall` itself needs `enable_group_call_for_user`.
//   * The click is the header's own `chatBoxController.makeCall(true)` (`_videoCall`), which opens the renderer's
//     GROUP_CALL modal (participant picker, `OU7N`-sibling module "Sh/d"). That modal is invisible here, so
//     `ModalManagerV2.openModal` is wrapped: a GROUP_CALL open is handed to Swift as a native picker instead
//     ({kind:'picker'}); every other modal opens as before. The member list is the modal's `loadData` (group
//     `topMember` minus me / bots / hidden-member rules, through the official profile service), the limit is its
//     `max_mem = maxUsers - 1` (or 10 without `maxUsers`), there is no select-all.
//   * Confirm runs the modal's own `onConfirm`: `callHelper.makeCall(ids, isVideo, true, cb→generateCallMessage, {id,
//     name, avatar, maxUsers})`. The native helper's `addUser` / `addFriend` request (`_processAddUserToGroupCall`)
//     opens the same modal with `isAddUser`; confirm / cancel answer it with `callHelper.sendAddUserResponse(groupId,
//     [{userId, avatar}])` exactly as the modal does. Closing the modal (the call ended) closes the native picker.
//
// Swift → JS : start(uid, video, seq)      the chat header's own action: `chatBoxController.canMakeCallAgain()`
//                                          then `.makeCall(video)` (module "OVGF"-era `Mt` in the chat box view);
//                                          groups: header gate above, then `.makeCall(true)` → picker
//              pickerConfirm(token, ids) → 'started'|'sent'|'stale'|'invalid'|'busy'|'offline'|'unsupported'|'error'
//              pickerCancel(token)       (add-user: answers the helper with an empty list)
//              refresh()
// JS → Swift (`zstate`): {page:'main', call:{kind:'status', ready, supported, video, busy, conv:{id, can}|null}}
//                        {…{kind:'result', seq, video, result: 'started'|'unsupported'|'busy'|'offline'|'not-ready'|'not-open'|'unavailable'|'error'}}
//                        {…{kind:'open', uid}}   the call is allowed: show that conversation (the chat box action needs it open)
//                        {…{kind:'incoming', uid, name, caller, avatar, group, busy}}   (group: name = group name when known)
//                        {…{kind:'picker', token, add, video, group:{id,name,avatar}, max, existing:[uid], note,
//                           members:[{id,name,avatar}]}}   the GROUP_CALL modal opened     {…{kind:'pickerClosed', token}}
(() => {
  'use strict';
  if (window.__zaloCall) return;
  if (location.pathname.split('/').pop() !== 'index.html') return;

  const post = (call) => { try { window.webkit.messageHandlers.zstate.postMessage({ page: 'main', call }); } catch {} };
  const diag = (s) => { try { window.webkit.messageHandlers.zlog.postMessage('[call] ' + s); } catch {} };
  const safe = (fn, d) => { try { const v = fn(); return v === undefined ? d : v; } catch { return d; } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = safe(fn, null); if (v) return v; await sleep(80); } return null; };

  // ---------------------------------------------------------------------------------------------
  // 1. Preload shims
  // ---------------------------------------------------------------------------------------------
  const sendIPC = (channel, args) => {
    try {
      const p = window.webkit.messageHandlers.zbridge.postMessage({ kind: 'send', channel, args });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {}
  };
  // main: `t._optional ? delete t._optional : startNative()` — a falsy `_optional` stays in the payload.
  const packed = (message) => {
    const optional = !!(message && message._optional);
    let body = message;
    if (optional) { body = Object.assign({}, message); delete body._optional; }
    const json = JSON.stringify(body === undefined ? null : body);
    return [json === undefined ? 'null' : json, optional];
  };

  let lastIncomingAt = 0;
  const noteOutgoing = (message) => {
    try {
      const control = message && message.type === 'control' ? message.data : null;
      if (!control || control.act_type !== 'voip') return;
      if (control.act !== 'request' && control.act !== 'group_request') return;
      // The helper rings; this only lets the app show a banner / notification. Throttle duplicates.
      // Only when the helper will ring: the call helper must be running with the IPC transport on.
      const h = helperRef;
      if (!h || !safe(() => h.canUseIpcCall() && h.isSupport(), false)) return;
      if (Date.now() - lastIncomingAt < 2000) return;
      lastIncomingAt = Date.now();
      const data = control.data && typeof control.data === 'object' ? control.data : {};
      const uid = String(data.uidN || data.fromUid || data.uid || '');
      const core = chatCore();
      const group = control.act === 'group_request';
      const person = (id) => (id && core && safe(() => core.nameOf(id), '')) || '';
      const meta = group ? incomingGroupMeta(data, uid) : null;
      post({
        kind: 'incoming',
        uid,
        // A group call is announced by the group's name (who started it goes in `caller`).
        name: meta ? meta.name : person(uid),
        caller: meta ? person(meta.callerId) : '',
        avatar: meta && meta.avatar ? meta.avatar : (!group && uid && core && safe(() => core.avatarOf(uid), '')) || '',
        group,
        busy: !!control.inCallStatus,
      });
    } catch {}
  };

  // The control event of a group call carries the group in fields the native helper reads (`groupName`, `groupAvatar`,
  // `groupId`, `uidN`); the layout of the optional nested `data` JSON is not documented, so every spot is tried and the
  // official group service has the last word. Nothing from here is ever logged.
  const asObject = (v) => {
    if (v && typeof v === 'object') return v;
    if (typeof v === 'string' && v.trim().startsWith('{')) { try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : {}; } catch {} }
    return {};
  };
  const firstString = (objs, keys) => {
    for (const o of objs) for (const k of keys) { const v = o && o[k]; if (typeof v === 'string' && v.trim()) return v.trim(); if (typeof v === 'number') return String(v); }
    return '';
  };
  function incomingGroupMeta(data, uid) {
    const objs = [data, asObject(data.data), asObject(data.extendData), asObject(data.groupInfo)];
    let name = firstString(objs, ['groupName', 'gName', 'grName', 'groupname', 'name']);
    let avatar = firstString(objs, ['groupAvatar', 'gAvatar', 'grAvatar', 'groupavatar']);
    let gid = firstString(objs, ['groupId', 'gid', 'grid', 'groupID']);
    let callerId = firstString(objs, ['callerId', 'fromUid', 'hostCall']) || uid;
    const svc = groupSvc();
    const asGroup = (id) => {
      if (!id || !svc) return null;
      const conv = String(id).startsWith('g') ? String(id) : 'g' + id;
      const g = safe(() => svc.getGroupByIdSync(conv), null);
      return g ? { id: conv, g } : null;
    };
    // `uidN` is the conversation the call belongs to: the group itself for a group call.
    const found = asGroup(gid) || (String(uid).startsWith('g') ? asGroup(uid) : null);
    if (found) {
      gid = found.id;
      name = name || safe(() => svc.getDName(found.id), '') || String(found.g.displayName || '');
      avatar = avatar || safe(() => svc.getAvatarGroup(found.id), '') || String(found.g.avatar || '');
      if (callerId === uid && String(uid).startsWith('g')) callerId = firstString(objs, ['callerId', 'fromUid', 'hostCall']);
    }
    return { name, avatar, callerId };
  }

  const local = window.__zaloLocal || (window.__zaloLocal = {});
  local['$zcall.sendDataToNative'] = (message) => {
    noteOutgoing(message);
    sendIPC('call-send-to-native', packed(message));
  };
  local['$zcall.initCall'] = (message) => {
    sendIPC('call-init', packed(message));
  };
  // Legacy node addon (`zcall.node`): the settings page parses a JSON device list.
  local['$znode.nativelibs.zcallAddon'] = { getListDevices: () => '[]' };

  // ---------------------------------------------------------------------------------------------
  // 2. Official call helper
  // ---------------------------------------------------------------------------------------------
  let helperRef = null, lastScan = 0, scans = 0;
  const fitsHelper = (o) => !!o && typeof o === 'object' && typeof o.startListeners === 'function' && typeof o.canUseIpcCall === 'function'
    && typeof o.makeCall === 'function' && typeof o.isSupport === 'function' && typeof o.isCalling === 'function';
  const helper = () => {
    if (helperRef) return helperRef;
    // Module scans walk every loaded export: poll often at first, then back off.
    if (Date.now() - lastScan < (scans < 10 ? 1500 : 6000) || typeof window.__zaloEachExport !== 'function' || !window.__zaloRequire) return null;
    lastScan = Date.now(); scans++;
    safe(() => window.__zaloEachExport(window.__zaloRequire, (ex) => {
      if (helperRef || !ex || typeof ex !== 'object') return;
      try { if (fitsHelper(ex.d)) helperRef = ex.d; else if (fitsHelper(ex)) helperRef = ex; } catch {}
    }), null);
    return helperRef;
  };
  const chatCore = () => safe(() => window.__zaloChat && window.__zaloChat.__core, null);
  // Official modules by webpack id (the bundle is pinned): the module cache first, loading the module only for the
  // pure helper modules. `null` when absent — callers then refuse rather than guess.
  const modExports = (id, load) => {
    const req = window.__zaloRequire;
    if (!req) return null;
    try { const m = req.c && req.c[id]; if (m && m.exports) return m.exports; } catch {}
    if (load) { try { return req(id); } catch {} }
    return null;
  };
  const defaultOf = (m) => (m && m.default) || m;
  // Group service (`Gm1y`: getGroupsListSync / getGroupByIdSync / getDName), profile service (`UiPd`: getProfileFriendSync /
  // isZaloBot / getDName), config (`NDmK`), group settings helper (`UDME`), id helper (`z0WU`).
  const groupSvc = () => {
    const d = defaultOf(modExports('Gm1y'));
    if (d && typeof d.getGroupsListSync === 'function' && typeof d.getGroupByIdSync === 'function') return d;
    const g = safe(() => chatCore().S.groups, null);
    return g && typeof g.getGroupByIdSync === 'function' ? g : null;
  };
  const profileSvc = () => {
    const d = defaultOf(modExports('UiPd'));
    return d && typeof d.getProfileFriendSync === 'function' && typeof d.getDName === 'function' ? d : null;
  };
  const officialConfig = () => {
    const d = defaultOf(modExports('NDmK'));
    if (d && typeof d === 'object' && 'group_call_max_users' in d) return d;
    const c = safe(() => chatCore().S.cfg, null);
    return c && typeof c === 'object' ? c : (d && typeof d === 'object' ? d : {});
  };
  const groupSettings = () => { const m = modExports('UDME'); return m && m.GroupSettingHelper ? m.GroupSettingHelper : null; };
  const userIdOf = (e) => {
    if (!e) return '';
    if (typeof e === 'string') return e;
    if (typeof e === 'number') return String(e);
    return String(e.id || e.uid || e.userId || '');
  };
  const isCommunityInfo = (info) => {
    const m = modExports('A9no', true);
    return !!(m && typeof m.isCommunityFromInfo === 'function' && safe(() => m.isCommunityFromInfo(info), false));
  };
  // The renderer's remote config "call" (header module: `go`, defaults {group_member_threshold: 20,
  // community_member_threshold: -1}); the live value is the remote-configs cache entry when the server sent one.
  let remoteCache = null;
  const callVisibility = () => {
    let group = 20, community = -1;
    if (!remoteCache) {
      const req = window.__zaloRequire;
      if (req && typeof window.__zaloDI === 'function') {
        try {
          for (const reg of window.__zaloDI(req)) {
            const i = reg.instance;
            if (i && typeof i === 'object' && typeof i.getCache === 'function' && typeof i.setCache === 'function' && typeof i.getAllCache === 'function') { remoteCache = i; break; }
          }
        } catch {}
      }
    }
    const v = remoteCache ? safe(() => remoteCache.getCache('call').visibility, null) : null;
    if (v && typeof v === 'object') {
      // `getGroupMemberThreshold`: a value that is not a number reads as -1 (hidden).
      const num = (x) => (typeof x === 'number' && !Number.isNaN(x) ? x : -1);
      group = num(v.group_member_threshold);
      community = num(v.community_member_threshold);
    }
    return { group, community };
  };
  // Header rule for a group (`fl`): → null (no button) | {disabled, feature, max}. Video only: the header has no group voice button.
  const groupCallGate = (convId) => {
    const h = helper();
    if (!h || !safe(() => h.isSupport(), false)) return null;
    const svc = groupSvc();
    const info = svc && safe(() => svc.getGroupByIdSync(convId), null);
    if (!info) return null;
    const cfg = officialConfig();
    const vis = callVisibility();
    const threshold = isCommunityInfo(info) ? vis.community : vis.group;
    const total = Number(info.totalMember) || Number(safe(() => svc.getTotalMember(convId), 0)) || 0;
    let show, disabled = false;
    if (threshold === -2) { show = true; disabled = true; } else show = threshold >= 0 && total <= threshold;
    if (!show) return null;
    return { disabled, feature: !!cfg.enable_group_call_for_user };
  };

  // ---------------------------------------------------------------------------------------------
  // 3. Status for the native UI
  // ---------------------------------------------------------------------------------------------
  let lastStatus = '';
  let modalHooked = false;
  const convStatus = (cc) => {
    const id = String(cc.convId);
    const out = { id, can: safe(() => !!cc.canMakeCallAgain(), false) };
    // Groups: the header's own rule (see `groupCallGate`); absent = no call button for this group.
    if (id.startsWith('g')) { const gate = groupCallGate(id); if (gate) out.group = gate; }
    return out;
  };
  const publish = (force) => {
    if (!modalHooked) hookModals();
    const h = helper();
    const core = chatCore();
    const cc = core && safe(() => core.controller(), null);
    const status = {
      kind: 'status',
      ready: !!h,
      // `isSupport()` = enable_mac_call && enableCall && macOS >= 10.13; calls also need the IPC transport.
      supported: !!h && safe(() => !!h.isSupport() && !!h.canUseIpcCall(), false),
      video: !!h && safe(() => !!h.isSupportVideoCall(), false),
      busy: !!h && safe(() => !!h.isCalling(), false),
      // Official visibility rule of the header buttons: friends only, not OA / "Cloud của tôi", group calls by config.
      conv: cc && cc.convId ? convStatus(cc) : null,
    };
    const key = JSON.stringify(status);
    if (force || key !== lastStatus) { lastStatus = key; post(status); }
  };
  const poll = setInterval(() => publish(false), 1200);
  setTimeout(() => publish(true), 500);

  // ---------------------------------------------------------------------------------------------
  // 4. Placing a call — what the chat header / call-log "Gọi lại" do
  // ---------------------------------------------------------------------------------------------
  // Official `canMakeCallAgain()` for a 1-1 conversation without a chat box: calls enabled, not an OA
  // (`type >= 1`), not "Cloud của tôi", and a friend (`isFr`). Groups are not supported here.
  const eligibility = (core, uid) => {
    if (uid.startsWith('g')) {
      // Header rule for groups: video only, thresholds from the remote config, and `makeCall` needs `enable_group_call_for_user`.
      const gate = groupCallGate(uid);
      return gate && !gate.disabled && gate.feature && safe(() => helper().isSupportVideoCall(), false) ? 'ok' : 'unavailable';
    }
    const cfg = safe(() => core.S.cfg, null);
    if (cfg && String(cfg.sendToMeId) === uid) return 'unavailable';
    const friends = safe(() => core.S.friends, null);
    const profile = friends ? safe(() => friends.getProfileFriendByIdSync(uid), null) : null;
    if (!profile) return 'unavailable';
    if (Number(profile.type) >= 1) return 'unavailable';
    if (!(profile.isFr === 1 || profile.isFr === true)) return 'unavailable';
    return 'ok';
  };
  const startNow = async (uid, video) => {
    const h = helper();
    if (!h) return 'not-ready';
    if (!safe(() => h.isSupport(), false) || !safe(() => h.canUseIpcCall(), false)) return 'unsupported';
    if (safe(() => h.isCalling(), false)) return 'busy';
    if (navigator.onLine === false) return 'offline';
    const core = chatCore();
    if (!core) return 'not-ready';
    // Eligibility first, from local data only (the chat box's `canMakeCallAgain` needs the conversation open,
    // and opening marks it read): the conversation is opened only if the call will actually be placed.
    const pre = eligibility(core, uid);
    if (pre !== 'ok') return pre;
    // Without the wrapper the renderer's own (invisible) participant modal would open: never place the request then.
    if (uid.startsWith('g') && !hookModals()) return 'not-ready';
    // The call is made by the chat box controller of that conversation (`le.makeCall` in the view), so the
    // conversation has to be the open one; the app opens it before asking.
    const matches = () => { const cc = core.controller(); return cc && String(cc.convId) === uid ? cc : null; };
    let cc = matches();
    if (!cc) {
      post({ kind: 'open', uid });
      await waitFor(matches, 6000);
      cc = matches();
      if (!cc) { safe(() => core.repairController(uid, false), false); cc = matches(); }
    }
    if (!cc) return 'not-open';
    if (typeof cc.makeCall !== 'function') return 'unsupported';
    // `Mt`: `le.canMakeCallAgain() && le.makeCall(video)`. The group header button calls `makeCall(true)` directly
    // (`canMakeCallAgain` still uses the older `enable_group_call_entry_for_group` flags): it opens the participant picker.
    const isGroup = uid.startsWith('g');
    if (isGroup && !video) return 'unavailable';
    if (!isGroup && typeof cc.canMakeCallAgain === 'function' && !cc.canMakeCallAgain()) return 'unavailable';
    const pending = cc.makeCall(!!video);
    if (pending && typeof pending.catch === 'function') pending.catch((e) => diag('makeCall failed: ' + String(e && e.name || e).slice(0, 60)));
    return 'started';
  };

  // ---------------------------------------------------------------------------------------------
  // 5. Group calls: the GROUP_CALL modal (participant picker) as a native sheet
  // ---------------------------------------------------------------------------------------------
  // Module "Sh/d" is the modal (class `g`, extends the contact-list base "jlVM"). Opened by the chat box controller's
  // `_videoCall` {conversation, data:{isVideo, generateCallMessage, maxUsers}} and by the call helper's
  // `_processAddUserToGroupCall` {conversation, data:{existingCalleeIds, isAddUser, isAddUserFromFriendList, maxUsers}}.
  let picker = null; // {token, add, conv, data, contacts, candidates:Set, max, fromFriendList}
  const newToken = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const viSort = (nameOf) => (a, b) => nameOf(a).localeCompare(nameOf(b), 'vi', { sensitivity: 'accent' });

  // The modal's `loadData`, verbatim in effect: members of the group (`topMember` of the group list entry) except me,
  // bots and — with the hidden-member privacy switch — everyone but the owner / deputies; only those the profile
  // service knows; sorted by display name.
  const pickerMembers = (conv, data) => {
    const svc = groupSvc(), prof = profileSvc(), cfg = officialConfig(), gsh = groupSettings();
    if (!prof) return null;
    let g = conv;
    const list = svc && safe(() => svc.getGroupsListSync(), null);
    const entries = Array.isArray(list) ? list : list && typeof list === 'object' ? Object.values(list) : [];
    if (conv && conv.userId) for (const e of entries) if (e && e.userId === conv.userId) { g = e; break; }
    const top = g && Array.isArray(g.topMember) ? g.topMember : [];
    const gid = g && g.userId;
    const me = (chatCore() && safe(() => chatCore().meNow(), '')) || safe(() => String(window.__zaloStore.getState().user.userId || ''), '');
    const locked = !!(gsh && safe(() => gsh.isLockViewMember(gid), false));
    const hideEnabled = !!safe(() => cfg.group_privacy.hide_member.enable, false);
    const adminOnly = hideEnabled && locked && !(gsh && safe(() => gsh.isMeOwnerAdmin(gid), false));
    const rows = [];
    const seen = new Set();
    for (const m of top) {
      if (!m) continue;
      const uid = userIdOf(m);
      if (!uid || uid === me || seen.has(uid)) continue;
      if (safe(() => prof.isZaloBot(m.id), false)) continue;
      if (adminOnly && !(gsh && safe(() => gsh.isOwnerAdmin(gid, uid), false))) continue;
      const p = safe(() => prof.getProfileFriendSync(uid), null);
      if (!p) continue;
      seen.add(uid);
      rows.push({ uid, member: m, profile: p, name: safe(() => prof.getDName(uid), '') || p.displayName || p.dName || m.dName || '' });
    }
    // Hidden chats (PIN-protected conversations) must not be listed: the modal's own `filterHiddenChat` (base class
    // "jlVM" `d`, which asks `EFQ6.enableHiddenChat() && isThreadHidden(uid)`). Fail closed when it cannot be asked.
    const base = safe(() => modExports('jlVM').d, null);
    const hidden = safe(() => defaultOf(modExports('EFQ6')), null);
    let visible = null;
    if (base && base.prototype && typeof base.prototype.filterHiddenChat === 'function') {
      visible = safe(() => base.prototype.filterHiddenChat.call({ isHiddenItem: base.prototype.isHiddenItem }, rows.map((r) => ({ userId: r.uid, row: r }))), null);
    } else if (hidden && typeof hidden.enableHiddenChat === 'function' && typeof hidden.isThreadHidden === 'function') {
      visible = safe(() => rows.filter((r) => !(hidden.enableHiddenChat() && hidden.isThreadHidden(r.uid))).map((r) => ({ userId: r.uid, row: r })), null);
    }
    if (!Array.isArray(visible)) return null;
    const shown = visible.map((x) => x.row);
    rows.length = 0;
    rows.push(...shown);
    rows.sort(viSort((r) => r.name));
    const note = hideEnabled && locked
      ? (isCommunityInfo(g) ? 'Bạn chỉ có thể gọi cho trưởng/phó cộng đồng.' : 'Bạn chỉ có thể gọi cho trưởng/phó nhóm.')
      : '';
    return { rows, note, gid };
  };

  const openPicker = (opts) => {
    const params = (opts && opts.params) || {};
    const conv = params.conversation || {};
    const data = params.data || {};
    const add = !!data.isAddUser;
    const h = helper();
    // A new request replaces a pending one, as the official modal would. The older one is dropped without an answer
    // (responses carry no request id: an empty answer could be taken as the reply to the new request).
    picker = null;
    const answerNothing = () => { if (add && h) safe(() => h.sendAddUserResponse(conv.userId, []), null); };
    const built = pickerMembers(conv, data);
    if (!built) { answerNothing(); diag('picker: services not ready'); return; }
    const max = data.maxUsers ? data.maxUsers - 1 : 10; // `this.max_mem = s ? s - 1 : 10`
    const svc = groupSvc();
    const gid = String(conv.userId || '');
    const token = newToken();
    const contacts = {};
    for (const r of built.rows) contacts[r.uid] = r.profile;
    const existing = (Array.isArray(data.existingCalleeIds) ? data.existingCalleeIds : []).map(String);
    // Members already in the call are shown ticked and disabled: never selectable.
    picker = { token, add, conv, data, contacts, members: built.rows, candidates: new Set(built.rows.map((r) => r.uid).filter((u) => !existing.includes(u))), max, fromFriendList: !!data.isAddUserFromFriendList };
    post({
      kind: 'picker', token, add, video: add ? null : !!data.isVideo, // the running call's video state is not known to the renderer
      group: {
        id: gid,
        name: String(conv.displayName || (svc && safe(() => svc.getDName(gid), '')) || ''),
        avatar: String(conv.avatar || (svc && safe(() => svc.getAvatarGroup(gid), '')) || ''),
      },
      max, existing, note: built.note,
      members: built.rows.map((r) => ({ id: r.uid, name: r.name, avatar: String(r.profile.avatar || r.member.avatar || '') })),
    });
    diag(`picker open (${add ? 'add' : 'start'}) ${built.rows.length} members`);
  };

  const hookModals = () => {
    if (modalHooked) return true;
    const mgr = safe(() => modExports('h0sc').ModalManagerV2, null);
    if (!mgr || typeof mgr.openModal !== 'function' || typeof mgr.closeModal !== 'function' || mgr.__olazCall) return !!(mgr && mgr.__olazCall);
    const open = mgr.openModal, close = mgr.closeModal;
    mgr.openModal = function (opts) {
      if (opts && opts.name === 'GROUP_CALL') {
        try { openPicker(opts); } catch (e) { diag('picker: ' + String(e && e.name || e).slice(0, 40)); }
        return undefined; // the renderer's own (invisible) modal is not opened
      }
      return open.apply(this, arguments);
    };
    mgr.closeModal = function (opts) {
      if (opts && opts.name === 'GROUP_CALL' && picker) { const token = picker.token; picker = null; post({ kind: 'pickerClosed', token }); }
      return close.apply(this, arguments);
    };
    mgr.__olazCall = true;
    modalHooked = true;
    diag('modal hook installed');
    return true;
  };
  // Hooked from `publish()` (every 1.2 s until it works); `start` also needs it.
  hookModals();

  // The modal's `onConfirm`.
  const confirmPicker = async (token, ids) => {
    const p = picker;
    if (!p || p.token !== token) return 'stale';
    picker = null; // answered once
    const h = helper();
    const selected = [];
    for (const id of Array.isArray(ids) ? ids : []) { const uid = String(id); if (p.candidates.has(uid) && !selected.includes(uid)) selected.push(uid); }
    const decline = () => { if (p.add && h) safe(() => h.sendAddUserResponse(p.conv.userId, []), null); };
    if (!h || !selected.length || selected.length > p.max) { decline(); return 'invalid'; }
    if (p.add) {
      let calleeIds = [];
      if (p.fromFriendList) {
        for (const uid of selected) { const c = p.contacts[uid]; if (c) calleeIds.push({ userId: uid, avatar: c.avatar }); }
      } else {
        const top = Array.isArray(p.conv.topMember) ? p.conv.topMember : [];
        for (const m of top) { const uid = userIdOf(m); if (m && selected.includes(uid)) calleeIds.push({ userId: uid, avatar: m.avatar }); }
      }
      try { h.sendAddUserResponse(p.conv.userId, calleeIds); } catch (e) { diag('addUser: ' + String(e && e.name || e).slice(0, 40)); return 'error'; }
      return 'sent';
    }
    if (!safe(() => h.isSupport() && h.canUseIpcCall(), false)) return 'unsupported';
    if (safe(() => h.isCalling(), false)) return 'busy';
    if (navigator.onLine === false) return 'offline';
    if (!safe(() => !!officialConfig().enable_group_call_for_user, false)) return 'unsupported'; // `makeCall` refuses silently otherwise
    const a = p.conv;
    const gen = p.data.generateCallMessage;
    const info = { lastSmsLocalId: a.lastSmsLocalId, displayName: a.displayName, userId: a.userId };
    const group = { id: String(a.userId).slice(1), name: a.displayName, avatar: a.avatar, maxUsers: p.data.maxUsers };
    try {
      h.makeCall(selected, !!p.data.isVideo, true, (e) => { if (typeof gen === 'function') gen(info, e); }, group);
    } catch (e) { diag('group makeCall: ' + String(e && e.name || e).slice(0, 40)); return 'error'; }
    return 'started';
  };
  const cancelPicker = (token) => {
    const p = picker;
    if (!p || p.token !== token) return 'stale';
    picker = null;
    // `onCancel`: an add-user request is answered with nobody.
    if (p.add) { const h = helper(); if (h) safe(() => h.sendAddUserResponse(p.conv.userId, []), null); }
    return 'cancelled';
  };

  window.__zaloCall = {
    async pickerConfirm(token, ids) {
      let result = 'error';
      try { result = await confirmPicker(String(token), ids); } catch (e) { diag('pickerConfirm: ' + String(e && e.name || e).slice(0, 60)); }
      diag('picker confirm → ' + result);
      setTimeout(() => publish(true), 300);
      return result;
    },
    pickerCancel(token) { return cancelPicker(String(token)); },
    async start(uid, video, seq) {
      uid = String(uid);
      let result = 'error';
      try { result = await startNow(uid, !!video); } catch (e) { diag('start: ' + String(e && e.name || e).slice(0, 60)); }
      diag(`start ${video ? 'video' : 'audio'} → ${result}`);
      post({ kind: 'result', seq: seq || 0, video: !!video, result, group: uid.startsWith('g') });
      setTimeout(() => publish(true), 300);
      return result;
    },
    refresh() { publish(true); },
  };
  void poll;
})();
