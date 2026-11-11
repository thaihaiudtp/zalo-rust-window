// Olaz poll adapter (group polls, MSG_POLL 26), index.html only. Exposes `window.__zaloPoll` and posts
// {page:'main', poll:{…}} via `zstate`. Everything goes through the official client's own poll service, the one
// the official poll card / "Bình chọn" popup / "Tạo bình chọn" popup use (v3 UI, `groupPoll.enable_poll_v3`):
//
//   GroupPollManager   DI singleton, token "group-poll-manager" (module "C8zZ".GroupPollManager → "lT2C"), class in
//                      lazy chunk main-startup (~1130000). Resolved with `ModuleContainer.resolve(token)` like the UI does.
//     getPollDetail(pollId, fromServer)  memory cache → poll DB (`poll` store of zdb_<uid>) → server `/api/poll/detail`
//     getPollDetailFromServer(pollId, groupId)   forced read (shared fetch queue, retries, fills the cache)
//     votePoll({groupId, pollId, newOptions:[{voted,content}], votedOptionIds})   `/api/poll/vote` or
//                      `/api/poll/option/add` (when newOptions is not empty) — the confirm button of the vote popup
//     lockPoll(pollId) `/api/poll/end` · sharePollInGroup(pollId) `/api/poll/share`
//     createPoll({windowId, groupId, pollData, src})   `/api/poll/create`, optional pin after creation
//     isEnableClose(groupId, creator) · isEnablePin(groupId) · isAdmin(groupId, uid) · updatePollCache(pollId, data)
//   Live updates      the official sync handler (`_onMessageVoteEvent`, ~5194700) refreshes the manager's cache with
//                     `updatePollCache` for every create / vote / update / close event: that method is wrapped here
//                     (always calls the original) to re-post the snapshot of watched polls.
//   Names / avatars   profile service (module "UiPd".default `getMiniInfo` + `getProfileFriendByIds(uids,
//                     SRC_GET_PROFILE.FETCH_MINI_INFO)`) — what the official voter list ("Chi tiết bình chọn") uses.
//   Config            `NDmK.default.groupPoll` (min/max options, lengths, anonymous / hide-preview switches).
//
// WRITE ACTIONS (vote, lock, share, create, pin, unpin) run only when Swift calls them from an explicit user click. Reads
// (`watch`, `refresh`, `voters`, `capabilities`) are the same calls the official card makes when it is on screen.
//
// Swift → JS : watch(pollId, convId) refresh(pollId, ifStale) voters(pollId) → {restricted, groups:[…]} | null
//              capabilities(convId) → {ready, canCreate, canPin, config:{…}} · vote(convId, pollId, newOptions, votedIds) →
//              {ok, error?} · lock(convId, pollId) · share(convId, pollId) · create(convId, spec) → {ok, error?}
//              pinState(convId, pollId) → {ready, canPin, pinned, limit} (read: the group's board topics) · pin(convId, pollId, confirmRef?) →
//              {ok, error?, ...} · unpin(convId, pollId) → {ok, error?}   (board topics: see "pin / unpin" below)
// JS → Swift : {poll:{id, detail:PollJSON}} | {poll:{id, error:'unavailable'|'fetch'}}
//   PollJSON: { id, groupId, question, creator, creatorName, created (ms|0), expired (ms|0), closed, joined, multi,
//               allowAdd, anonymous, hidePreview, voters (people), canClose,
//               options:[{id, content, votes, voted}] }          (ids are strings; the raw ids are kept here for the calls)
//   Errors: 'closed' (server 166 / poll closed) · 'expired' · 'network' · 'unavailable' · 'duplicate' · 'invalid' · 'failed'
//   Pin errors: 'forbidden' · 'unavailable' · 'network' · 'failed' · 'limit' (board full, more than one pin would have to go) · 'partial' (oldest
//   pin removed, new pin not confirmed) · 'confirm' ({limit, ref, replace:{kind,title}}: ask the user, then call pin again with confirmRef = ref)
(() => {
  'use strict';
  const NAME = window.__zaloPollTestName || '__zaloPoll';
  if (window[NAME]) return;
  if (location.pathname.split('/').pop() !== 'index.html') return;

  const post = (poll) => {
    if (window.__zaloPollTestName && typeof window.__zaloPollTestSink === 'function') { window.__zaloPollTestSink(poll); return; }
    try { window.webkit.messageHandlers.zstate.postMessage({ page: 'main', poll }); } catch {}
  };
  const diag = (s) => { try { window.webkit.messageHandlers.zlog.postMessage('[poll] ' + s); } catch {} };
  const safe = (fn, d) => { try { const v = fn(); return v === undefined ? d : v; } catch { return d; } };
  const str = (v) => (typeof v === 'string' ? v : '');
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const ms = (v) => { const n = num(v); return n > 0 && n < 1e11 ? n * 1000 : n; };
  const errCode = (e) => {
    if (!e || typeof e !== 'object') return '';
    const d = e.data && typeof e.data === 'object' ? e.data : null;
    return String(e.error_code ?? e.code ?? (d && d.error_code) ?? e.status ?? '');
  };
  const scrub = (e) => String((e && (e.name || e.message)) || e).replace(/\d{5,}/g, '<id>').slice(0, 60);
  // The official UI passes the poll id as the JSON number found in `message.params` (cache and DB are keyed by it).
  const rawId = (s) => { const t = String(s); return /^\d+$/.test(t) && Number.isSafeInteger(Number(t)) ? Number(t) : t; };

  // ---- services ----
  const S = {};
  let lastResolve = 0, tries = 0;
  const mod = (id) => { try { const m = window.__zaloRequire && window.__zaloRequire.c[id]; return m ? m.exports : null; } catch { return null; } };
  const isMgr = (m) => !!m && typeof m === 'object' && ['getPollDetail', 'getPollDetailFromServer', 'votePoll', 'lockPoll', 'createPoll', 'sharePollInGroup', 'isEnableClose', 'isEnablePin', 'updatePollCache', 'getPollDetailSync'].every((k) => typeof m[k] === 'function');
  const fitsProfile = (o) => !!o && typeof o.getMiniInfo === 'function' && typeof o.getProfileFriendByIds === 'function';

  const hookCache = (mgr) => {
    const orig = mgr.updatePollCache;
    if (orig.__olaz) return;
    const wrapped = function (id, data) {
      const r = orig.apply(this, arguments);
      try { const k = String(id); touched.set(k, Date.now()); if (watched.has(k)) scheduleEmit(k); } catch {}
      return r;
    };
    wrapped.__olaz = true;
    mgr.updatePollCache = wrapped;
  };
  let lastProf = 0, profTries = 0;
  const resolveAux = () => {
    if (S.prof && S.codes && S.groups && S.cfgMod) return;
    if (Date.now() - lastProf < 3000 || profTries >= 20) return;
    lastProf = Date.now(); profTries++;
    const req = window.__zaloRequire;
    if (!S.prof) {
      const p = safe(() => mod('UiPd').default, null);
      if (fitsProfile(p)) S.prof = p;
      else window.__zaloEachExport(req, (ex) => { if (!S.prof && ex && (typeof ex === 'object' || typeof ex === 'function')) { if (fitsProfile(ex.default)) S.prof = ex.default; else if (fitsProfile(ex)) S.prof = ex; } });
    }
    if (!S.codes) S.codes = safe(() => mod('1pet').SRC_GET_PROFILE, null);
    if (!S.groups) { const g = safe(() => mod('Gm1y').default, null); if (g && typeof g.getGroupByIdSync === 'function') S.groups = g; }
    if (!S.cfgMod) S.cfgMod = safe(() => mod('NDmK').default, null);
  };
  const resolve = () => {
    const req = window.__zaloRequire;
    if (!req || !window.__zaloStore || typeof window.__zaloDI !== 'function') return false;
    if (S.mgr) { resolveAux(); return true; }
    if (Date.now() - lastResolve < (tries < 240 ? 500 : 15000)) return false;
    lastResolve = Date.now(); tries++;
    const token = safe(() => mod('C8zZ').GroupPollManager, null), mc = safe(() => mod('jDHv').ModuleContainer, null);
    let inst = token && mc ? safe(() => mc.resolve(token), null) : null;
    if (!isMgr(inst)) {
      inst = null;
      for (const reg of window.__zaloDI(req)) { const i = reg.instance; if (isMgr(i)) { inst = i; break; } }
    }
    if (isMgr(inst)) { S.mgr = inst; hookCache(inst); diag('manager resolved'); }
    resolveAux();
    return !!S.mgr;
  };
  const ready = async (timeout = 8000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (resolve()) return S.mgr; await new Promise((r) => setTimeout(r, 400)); }
    return null;
  };
  const myId = () => str(safe(() => window.__zaloStore.getState().user.userId, ''));

  // ---- names ----
  const miniName = (m) => (m && (str(m.dName) || str(m.displayName) || str(m.zaloName) || str(m.zName))) || '';
  const nameOf = (uid) => {
    if (!uid) return '';
    const mini = safe(() => S.prof && S.prof.getMiniInfo(uid), null);
    return miniName(mini) || safe(() => str(S.prof && S.prof.getDName && S.prof.getDName(uid)), '');
  };
  const profTried = new Set();
  const ensureProfiles = async (uids) => {
    if (!S.prof) return;
    // Missing name → fetch; a profile that merely lacks an avatar is fetched once.
    const lacks = uids.filter((u) => { const m = safe(() => S.prof.getMiniInfo(u), null); return !m || !miniName(m) || (!m.avatar && !profTried.has(u)); });
    lacks.forEach((u) => profTried.add(u));
    if (profTried.size > 5000) profTried.clear();
    if (!lacks.length) return;
    const src = safe(() => S.codes.FETCH_MINI_INFO, undefined);
    try { await S.prof.getProfileFriendByIds(lacks, src); } catch (e) { diag('profiles: ' + scrub(e)); }
  };

  // ---- snapshot ----
  const watched = new Set();          // poll ids shown on screen (Swift called watch)
  const convOf = new Map();           // poll id → conversation id ("g…")
  const touched = new Map();          // poll id → last `updatePollCache` time
  const latest = new Map();           // poll id → last raw detail (to translate ids back for the calls)
  const triedCreators = new Set();    // creators already handed to the profile fetch
  const lastPosted = new Map();       // poll id → JSON string last posted

  const snapshot = (d, convId) => {
    const me = myId();
    const opts = (Array.isArray(d.options) ? d.options : []).filter((o) => o && typeof o === 'object');
    const options = opts.map((o) => {
      const voters = Array.isArray(o.voters) ? o.voters.map(String) : [];
      return { id: String(o.option_id), content: str(o.content), votes: Math.max(0, num(o.votes)), voted: o.voted === true || o.voted === 1 || (!!me && voters.includes(me)) };
    });
    const people = num(d.num_vote) || new Set(opts.flatMap((o) => (Array.isArray(o.voters) ? o.voters.map(String) : []))).size;
    const creator = String(d.creator ?? '');
    return {
      id: String(d.poll_id), groupId: convId || '', question: str(d.question), creator, creatorName: creator === me ? 'Bạn' : nameOf(creator),
      created: ms(d.created_time), expired: ms(d.expired_time), closed: !!d.closed, joined: d.joined === true || d.joined === 1 || options.some((o) => o.voted),
      multi: !!d.allow_multi_choices, allowAdd: !!d.allow_add_new_option,
      anonymous: !!d.is_anonymous, hidePreview: !!d.is_hide_vote_preview, voters: people,
      canClose: !!convId && safe(() => S.mgr.isEnableClose(convId, creator), false) === true, options,
    };
  };
  const emit = (key, detail) => {
    if (!detail || typeof detail !== 'object' || detail.poll_id === undefined) return;
    latest.set(key, detail);
    const snap = snapshot(detail, convOf.get(key) || str(detail.group_id));
    const json = JSON.stringify(snap);
    if (lastPosted.get(key) === json) return;
    lastPosted.set(key, json);
    post({ id: key, detail: snap });
    if (snap.creator && !snap.creatorName && !triedCreators.has(snap.creator)) {
      triedCreators.add(snap.creator);
      ensureProfiles([snap.creator]).then(() => { const d = latest.get(key); if (d) emit(key, d); });
    }
  };
  const timers = new Map();
  const scheduleEmit = (key) => {
    if (timers.has(key)) return;
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      const d = safe(() => S.mgr.getPollDetailSync(rawId(key)), null);
      if (d) emit(key, d);
    }, 120));
  };

  // ---- reads ----
  const prune = () => {
    while (watched.size > 500) {
      const old = watched.values().next().value;
      for (const m of [convOf, touched, latest, lastPosted]) m.delete(old);
      watched.delete(old);
    }
  };
  const watch = async (pollId, convId) => {
    const key = String(pollId);
    if (convId) convOf.set(key, String(convId));
    watched.add(key);
    prune();
    const mgr = await ready(20000);
    if (!mgr) { post({ id: key, error: 'unavailable' }); return false; }
    try {
      const d = await mgr.getPollDetail(rawId(key), true);
      if (d) emit(key, d); else post({ id: key, error: 'fetch' });
      return !!d;
    } catch (e) { diag('detail: ' + scrub(e)); post({ id: key, error: 'fetch' }); return false; }
  };
  // Forced server read (what the official sync does after a vote event). `ifStale`: skipped when the official sync
  // refreshed the cache a moment ago.
  const refresh = async (pollId, ifStale) => {
    const key = String(pollId);
    if (ifStale && Date.now() - (touched.get(key) || 0) < 4000) return false;
    const mgr = await ready(3000);
    if (!mgr) return false;
    try {
      const d = await mgr.getPollDetailFromServer(rawId(key), (convOf.get(key) || '').replace(/^g/, '') || undefined);
      if (d) { emit(key, d); return true; }
    } catch (e) { diag('refresh: ' + scrub(e)); }
    return false;
  };

  const voters = async (pollId) => {
    const key = String(pollId);
    const mgr = await ready(3000);
    if (!mgr) return null;
    let d = latest.get(key);
    if (!d) { try { d = await mgr.getPollDetail(rawId(key), false); } catch { return null; } }
    if (!d) return null;
    const joined = d.joined === true || d.joined === 1 || (d.options || []).some((o) => o && o.voted);
    if (d.is_anonymous || (d.is_hide_vote_preview && !joined)) return { restricted: true, groups: [] };
    const opts = (d.options || []).filter((o) => o && num(o.votes) > 0 && Array.isArray(o.voters));
    const all = [...new Set(opts.flatMap((o) => o.voters.map(String)))];
    await ensureProfiles(all);
    const me = myId();
    return {
      restricted: false,
      groups: opts.map((o) => ({
        optionId: String(o.option_id), content: str(o.content), votes: num(o.votes),
        users: o.voters.map(String).map((uid) => {
          const mini = safe(() => S.prof && S.prof.getMiniInfo(uid), null);
          return { uid, name: uid === me ? (miniName(mini) || 'Bạn') : (miniName(mini) || 'Người dùng Zalo'), avatar: str(mini && mini.avatar), isMe: uid === me };
        }),
      })),
    };
  };

  const DEFAULTS = { minOptions: 2, maxOptions: 30, maxQuestion: 200, maxOption: 120, enableAnonymous: true, enableHidePreview: true, displayOptions: 3 };
  const config = () => {
    const c = safe(() => S.cfgMod.groupPoll, null) || {};
    const pick = (k, d) => (Number.isFinite(Number(c[k])) && Number(c[k]) > 0 ? Number(c[k]) : d);
    return {
      minOptions: pick('min_options', DEFAULTS.minOptions), maxOptions: pick('max_options', DEFAULTS.maxOptions),
      maxQuestion: pick('max_question_length', DEFAULTS.maxQuestion), maxOption: pick('max_option_length', DEFAULTS.maxOption),
      enableAnonymous: c.enable_anonymous_vote === undefined ? DEFAULTS.enableAnonymous : !!c.enable_anonymous_vote,
      enableHidePreview: c.enable_hide_vote_preview === undefined ? DEFAULTS.enableHidePreview : !!c.enable_hide_vote_preview,
      displayOptions: pick('display_options_msg_poll', DEFAULTS.displayOptions),
    };
  };
  // Official chat bar item (`CREATE_POLL_ITEM`, ~5448994): allowed when `setting.lockCreatePoll === 0` or I am owner / deputy.
  // Anything unknown (manager, group, setting) is `ready:false`: nothing is offered on a guess.
  const capabilities = async (convId) => {
    const mgr = await ready(3000);
    const off = { ready: false, canCreate: false, canPin: false, config: config() };
    if (!mgr) return off;
    const g = safe(() => S.groups && S.groups.getGroupByIdSync(convId), null);
    const lock = safe(() => g.setting.lockCreatePoll, undefined);
    const admin = safe(() => mgr.isAdmin(convId, myId()), null);
    if (!g || admin === null || (lock === undefined && admin !== true)) return off;
    return { ready: true, canCreate: admin === true || lock === 0, canPin: safe(() => mgr.isEnablePin(convId), false) === true, config: config() };
  };

  // ---- writes (explicit user actions only) ----
  const failure = (e, fallback) => {
    const code = errCode(e);
    if (code === '166') return 'closed';
    if (code === 'ERR_NO_NETWORK' || code === 'NETWORK_ERROR' || code === 'ERR_CONNECTION_TIMED_OUT') return 'network';
    if (e && e.error_code !== undefined) diag('server error ' + code);
    return fallback || 'failed';
  };
  const cached = (key) => latest.get(key) || safe(() => S.mgr.getPollDetailSync(rawId(key)), null);
  const expiredNow = (d) => !!d && num(d.expired_time) > 0 && num(d.expired_time) < Date.now();
  const dupContents = (list) => new Set(list.map((c) => c.trim())).size !== list.length;

  const vote = async (convId, pollId, newOptions, votedIds) => {
    const key = String(pollId);
    const mgr = await ready(3000);
    if (!mgr) return { ok: false, error: 'unavailable' };
    const d = cached(key);
    if (d && d.closed) return { ok: false, error: 'closed' };
    if (expiredNow(d)) return { ok: false, error: 'expired' };
    const add = (Array.isArray(newOptions) ? newOptions : []).map((o) => ({ voted: !!(o && o.voted), content: str(o && o.content).trim() })).filter((o) => o.content);
    // Ids go back with their raw type (the detail's own `option_id`).
    const known = d && Array.isArray(d.options) ? new Map(d.options.map((o) => [String(o.option_id), o.option_id])) : null;
    const ids = (Array.isArray(votedIds) ? votedIds : []).map(String);
    if (known && ids.some((i) => !known.has(i))) return { ok: false, error: 'invalid' };
    if (d && !d.allow_add_new_option && add.length) return { ok: false, error: 'invalid' };
    if (dupContents([...(d ? d.options.map((o) => str(o.content)) : []), ...add.map((o) => o.content)])) return { ok: false, error: 'duplicate' };
    try {
      await mgr.votePoll({ groupId: String(convId), pollId: rawId(key), newOptions: add, votedOptionIds: known ? ids.map((i) => known.get(i)) : ids.map(rawId) });
    } catch (e) { return { ok: false, error: failure(e, 'failed') }; }
    refresh(key, false).catch(() => {});   // not awaited: offline the official fetch queue pauses; live updates fill in
    return { ok: true };
  };

  const lock = async (convId, pollId) => {
    const key = String(pollId);
    const mgr = await ready(3000);
    if (!mgr) return { ok: false, error: 'unavailable' };
    const d = cached(key);
    if (d && d.closed) return { ok: true };
    if (d && safe(() => mgr.isEnableClose(String(convId), String(d.creator)), false) !== true) return { ok: false, error: 'forbidden' };
    try { await mgr.lockPoll(rawId(key)); } catch (e) { return { ok: false, error: failure(e, 'failed') }; }
    // The official call resolves even when the server refused: read the poll again (bounded) and report what it says.
    const unverified = await Promise.race([refresh(key, false).then((ok) => !ok, () => true), new Promise((r) => setTimeout(() => r(true), 8000))]);
    const after = cached(key);
    if (after && after.closed) return { ok: true };
    return { ok: false, error: unverified ? 'unknown' : 'failed' };
  };

  const share = async (convId, pollId) => {
    const mgr = await ready(3000);
    if (!mgr) return { ok: false, error: 'unavailable' };
    try { await mgr.sharePollInGroup(rawId(String(pollId))); return { ok: true }; } catch (e) { return { ok: false, error: failure(e, 'failed') }; }
  };

  // spec: {question, options:[string], expired (ms|0), pin, multi, allowAdd, hidePreview, anonymous}; official create popup
  // (~17510208): trimmed unique non-empty options, ≥ min_options, future deadline, "add option" off while results are hidden.
  const create = async (convId, spec) => {
    const mgr = await ready(3000);
    if (!mgr) return { ok: false, error: 'unavailable' };
    const cfg = config(), s = spec && typeof spec === 'object' ? spec : {};
    const question = str(s.question).trim();
    const options = [...new Set((Array.isArray(s.options) ? s.options : []).map((o) => str(o).trim()).filter(Boolean))];
    const expired = num(s.expired);
    if (!question || question.length > cfg.maxQuestion || options.length < cfg.minOptions || options.length > cfg.maxOptions || options.some((o) => o.length > cfg.maxOption)) return { ok: false, error: 'invalid' };
    if (expired && expired <= Date.now()) return { ok: false, error: 'expired' };
    const caps = await capabilities(String(convId));
    if (!caps.ready) return { ok: false, error: 'unavailable' };
    if (!caps.canCreate) return { ok: false, error: 'forbidden' };
    const hide = !!s.hidePreview && cfg.enableHidePreview;
    // Official create → `pinPoll` → `checkPinTopic`; on a full board that opens the (invisible here) "Cập nhật danh sách ghim" dialog and
    // drops the pin, leaving its state open. So the pin is only requested when the board is known to have room; otherwise the poll is
    // created unpinned and the user pins it from its menu (native replace dialog).
    let wantPin = !!s.pin && caps.canPin, pinSkipped = false;
    if (wantPin) {
      const room = await pinRoom(String(convId));
      if (!room) { wantPin = false; pinSkipped = true; }
    }
    const pollData = {
      question, options, expiredTime: expired > 0 ? expired : 0, pinAct: wantPin, allowMultiChoices: s.multi === undefined ? true : !!s.multi,
      allowAddNewOption: (s.allowAdd === undefined ? true : !!s.allowAdd) && !hide, isHideVotePreview: hide, isAnonymous: !!s.anonymous && cfg.enableAnonymous, pollType: 0,
    };
    try {
      await mgr.createPoll({ windowId: safe(() => mod('3xbP').c, '1'), groupId: String(convId), pollData, src: safe(() => mod('1pet').CREATE_POLL_SRC_CHAT_BAR, 1) });
      return pinSkipped ? { ok: true, pinSkipped: true } : { ok: true };
    } catch (e) { return { ok: false, error: failure(e, 'failed') }; }
  };

  // ---- pin / unpin (board topics) ----
  // Official poll "more" menu (compact-app-pc ~8421796): `v = mgr.isEnablePin(groupId)`; pinned = `hasTopicInConversation(groupId, pollId.toString(),
  // POLL_TOPIC)`; pinned → "Bỏ ghim bình chọn" = `mgr.unpinPoll(pollId, groupId)`, else "Ghim lên đầu trò chuyện" = `mgr.pinPoll(pollId, groupId, question)`.
  // Both go through `pinFromBoard` / `unpinFromBoard` (module "wmCV" ~19231521) to the board-topic manager of the conversation
  // (module "jnJr".a.getInstance(convId), class ~15833725): `checkPinTopic` → `_checkUserAllowance` (owner / deputy, or `setting.setTopicOnly === 0` = `isEnablePin`),
  // then, when `group_topics.enable_pin_limit` and the board already holds `pinLimit` topics, `_onOpenLimitModal` (a React dialog "Cập nhật danh sách ghim":
  // the OLDEST topic is ticked; its confirm = `unpinMultiTopics(conv, [oldest])` then `callCreateOrPinTopic`); else `callCreateOrPinTopic` →
  // `pinBoardItem(conv, pollId, POLL_TOPIC)`. Unpin = `callUnpinTopic(conv, {id, type})` (no confirmation). The dialogs are invisible here, so the
  // confirmation is native (Swift) and this file runs the same official calls: nothing is sent without a click, and the replace step only with the
  // user's confirmation of that exact oldest topic. With `group_topics.enable` off the official client uses the legacy single-notice board (a confirm
  // dialog, no topic list to read the pinned state from): not offered. Reminders are not pinned from the active (v2) reminder detail, only from the
  // legacy one, so they are not handled here.
  const groupTopics = () => safe(() => S.cfgMod.group_topics, null);
  const topicsEnabled = () => { const g = groupTopics(); return !!(g && g.enable); };
  const pinLimitEnabled = () => { const g = groupTopics(); return !!(g && g.enable_pin_limit); };
  const pollTopicType = () => safe(() => mod('1pet').POLL_TOPIC, undefined);
  const isBoard = (b) => !!b && typeof b === 'object' && !!b.topicStore && ['loadTopics', 'callCreateOrPinTopic', 'callUnpinTopic', 'unpinMultiTopics'].every((k) => typeof b[k] === 'function')
    && ['hasGroup', 'getTopics'].every((k) => typeof b.topicStore[k] === 'function');
  const boardOf = (convId) => {
    const q = safe(() => mod('jnJr').a, null);
    const inst = q && typeof q.getInstance === 'function' ? safe(() => q.getInstance(convId), null) : null;
    return isBoard(inst) ? inst : null;
  };
  const topicList = (board, convId) => { const l = safe(() => board.topicStore.getTopics(convId), []); return Array.isArray(l) ? l.filter((t) => t && typeof t === 'object') : []; };
  const pollTopic = (board, convId, pollId) => { const T = pollTopicType(); return topicList(board, convId).find((t) => String(t.id) === String(pollId) && t.type === T) || null; };
  const topicRef = (t) => String(t.type) + ':' + String(t.id);
  // Short description of a topic for the "replace the oldest pin" confirmation.
  const topicSummary = (t) => {
    const C = safe(() => mod('1pet'), {}) || {};
    const kind = t.type === C.POLL_TOPIC ? 'poll' : t.type === C.REMINDER_TOPIC ? 'reminder' : t.type === C.MSG_TOPIC ? 'message' : 'note';
    const p = t.params && typeof t.params === 'object' ? t.params : {};
    const pick = [p.question, p.title, p.text, p.msg, p.message, p.content].find((v) => typeof v === 'string' && v.trim()) || '';
    return { kind, title: pick.trim().slice(0, 120) };
  };
  // Board topics of a group are read once (official `loadTopics`: local DB, server when stale — what opening the group does).
  const topicLoads = new Map();
  const ensureTopics = async (board, convId) => {
    const has = () => safe(() => board.topicStore.hasGroup(convId), false) === true;
    if (has()) return true;
    if (!topicLoads.has(convId)) {
      // `loadTopics` may never settle (no DB row: only a fetch is started; stale DB copy: it resolves after the fetch at best), so it is bounded.
      const p = (async () => {
        try { await withTimeout(board.loadTopics(convId), 8000); } catch (e) { diag('topics: ' + scrub(e)); }
        await waitFor(has, 8000);
      })();
      topicLoads.set(convId, p);
      // A failed read is retried later (not at once); a good one is kept by the board itself.
      p.finally(() => setTimeout(() => { if (topicLoads.get(convId) === p) topicLoads.delete(convId); }, has() ? 0 : 15000));
    }
    await topicLoads.get(convId);
    return has();
  };
  const pinFailure = (e) => {
    const code = errCode(e);
    if (code === '166' || code === '164') return 'forbidden';
    if (code === 'ERR_NO_NETWORK' || code === 'NETWORK_ERROR' || code === 'ERR_CONNECTION_TIMED_OUT') return 'network';
    if (e && e.error_code !== undefined) diag('pin server error ' + code);
    return 'failed';
  };
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (cond, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await sleepMs(250); } return cond(); };
  const isTimeout = (e) => !!e && e.message === 'timeout';
  const withTimeout = (p, ms) => Promise.race([Promise.resolve(p), sleepMs(ms).then(() => { throw new Error('timeout'); })]);

  // Official `checkPinTopic._checkUserAllowance(PIN_MESSAGES)`: `isUserHavingAllowance(me, "PIN_MESSAGES")` = (owner / deputy, from the group's
  // `topMember`, with `setting` present) or `setting.setTopicOnly === 0`. Read from the same group data (the manager's own copy reads the conversation
  // its window shows). null = group data not available.
  const allowsPin = (mgr, convId) => {
    const g = safe(() => S.groups && S.groups.getGroupByIdSync(convId), null);
    if (!g || !g.setting || typeof g.setting !== 'object') return null;
    const admin = safe(() => mgr.isAdmin(convId, myId()), null);
    if (admin === null) return null;
    return admin === true || g.setting.setTopicOnly === 0;
  };

  // → {ready, canPin, pinned, limit}. `ready:false`: groups only; needs the manager, the topic board and the group's topic list (nothing is guessed).
  const pinState = async (convId, pollId) => {
    const off = { ready: false, canPin: false, pinned: false, limit: 0 };
    convId = String(convId);
    if (!/^g\d+$/.test(convId)) return off;
    const mgr = await ready(3000);
    if (!mgr || !topicsEnabled() || pollTopicType() === undefined) return off;
    const board = boardOf(convId);
    const can = safe(() => mgr.isEnablePin(convId), null), allowed = allowsPin(mgr, convId);
    if (!board || can === null || allowed === null || !(await ensureTopics(board, convId))) return off;
    return { ready: true, canPin: can === true && allowed === true, pinned: !!pollTopic(board, convId, pollId), limit: Math.max(0, num(board.pinLimit)) };
  };

  // confirmRef: the `ref` of the topic the user agreed to replace (from a previous {error:'confirm'} answer).
  const pin = async (convId, pollId, confirmRef) => {
    convId = String(convId);
    const key = String(pollId);
    const st = await pinState(convId, key);
    if (!st.ready) return { ok: false, error: 'unavailable' };
    if (!st.canPin) return { ok: false, error: 'forbidden' };
    if (st.pinned) return { ok: true };
    const board = boardOf(convId), T = pollTopicType();
    const topics = topicList(board, convId);
    const limit = st.limit;
    let oldest = null;
    if (pinLimitEnabled() && limit > 0 && topics.length >= limit) {
      if (topics.length - limit + 1 > 1) return { ok: false, error: 'limit', limit };   // the official dialog lets the user choose several to drop
      oldest = topics[topics.length - 1];
      if (str(confirmRef) !== topicRef(oldest)) return { ok: false, error: 'confirm', limit, ref: topicRef(oldest), replace: topicSummary(oldest) };
    }
    const d = cached(key);
    const rid = rawId(key);
    // The topic object `pinFromBoard` hands to `checkPinTopic` (a poll: `pollData` carries the question and `pinAct`).
    const topic = { poll_id: rid, isPoll: true, question: str(d && d.question), pinAct: 1, topicId: rid, type: T, isCreated: false, needUnpin: true };
    topic.pollData = { poll_id: rid, isPoll: true, question: topic.question, pinAct: 1 };
    if (oldest) {
      // `unpinMultiTopics` never settles on a server error, and the official client retries a stale board version in the background: whatever
      // happens, look at the board before going on. Gone → continue with the pin; a definite server answer → that error; otherwise unknown.
      const gone = () => !topicList(board, convId).some((t) => topicRef(t) === topicRef(oldest));
      let failed = null;
      try { await withTimeout(board.unpinMultiTopics(convId, [oldest]), 20000); } catch (e) { failed = e; }
      if (!gone() && !(await waitFor(gone, failed ? 4000 : 2500))) {
        if (failed && errCode(failed) !== '' && !isTimeout(failed)) return { ok: false, error: pinFailure(failed) };
        return { ok: false, error: 'unknown' };
      }
    }
    const sent = await new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      try { board.callCreateOrPinTopic(convId, topic, null, () => done({ ok: true }), (e) => done({ ok: false, e }), undefined); } catch (e) { done({ ok: false, e }); }
      setTimeout(() => done({ ok: false, e: null, late: true }), 20000);
    });
    // The board is updated by the sync event; an answer callback that threw after the server accepted still counts once the topic shows up.
    const there = () => !!pollTopic(board, convId, key);
    if (sent.ok || await waitFor(there, sent.late ? 6000 : 2500)) return { ok: true, replaced: !!oldest };
    // Late = no answer at all: the pin may still land, so the result is unknown rather than failed.
    return { ok: false, error: oldest ? 'partial' : sent.late ? 'unknown' : pinFailure(sent.e) };
  };

  const unpin = async (convId, pollId) => {
    convId = String(convId);
    const key = String(pollId);
    const st = await pinState(convId, key);
    if (!st.ready) return { ok: false, error: 'unavailable' };
    if (!st.canPin) return { ok: false, error: 'forbidden' };
    const board = boardOf(convId);
    const topic = pollTopic(board, convId, key);
    if (!topic) return { ok: true };
    try { await withTimeout(board.callUnpinTopic(convId, { id: topic.id, type: topic.type }), 20000); } catch (e) {
      // Look at the board instead of guessing: gone = done; a definite server answer = that error; no answer = unknown.
      if (!(await waitFor(() => !pollTopic(board, convId, key), isTimeout(e) ? 6000 : 2000))) {
        return { ok: false, error: errCode(e) !== '' && !isTimeout(e) ? pinFailure(e) : isTimeout(e) ? 'unknown' : pinFailure(e) };
      }
    }
    return { ok: true };
  };

  // True when a new pin fits without replacing one (all of: topic board readable, allowance, below the limit). Read-only.
  const pinRoom = async (convId) => {
    const st = await pinState(convId, '0');
    if (!st.ready || !st.canPin) return false;
    const board = boardOf(convId);
    return !(pinLimitEnabled() && st.limit > 0 && topicList(board, convId).length >= st.limit);
  };

  // New session: forget what was read for the previous account.
  const reset = () => { topicLoads.clear(); watched.clear(); convOf.clear(); touched.clear(); latest.clear(); lastPosted.clear(); triedCreators.clear(); profTried.clear(); return true; };

  window[NAME] = { reset, watch, refresh, voters, capabilities, vote, lock, share, create, pinState, pin, unpin };
})();
