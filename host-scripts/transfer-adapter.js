// Olaz transfer adapter: phone -> PC message transfer ("Dong bo tin nhan"), driven entirely by
// the official client's own controller/services. Exposes `window.__zaloTransfer` (see ChatModels.swift).
// index.html (main window) only.
//
// ---------------------------------------------------------------------------------------------
// Official flow this adapter observes (all DI singletons of the renderer; nothing is re-implemented)
//   * Trigger (first login): the login response carries `needSyncMsg`/`sync_msg_info`; login stores
//     localStorage `z_needSyncMsg`, and `checkFirstLogin` calls transfer controller `needTransferMessages()`.
//     ~3 s after application-ready the controller runs `checkTransferMessagesSuggestionOnApplicationReady`
//     -> `canShowFirstTimeLoginTransferMessageModal()` -> `showTransferMessagesModal()` which flips
//     UIManager.UIState.transfer_modal.isDisplayed (the hidden official modal "TransferMessagesModal").
//   * Modal buttons (PC build):  "Dong bo ngay" -> controller.hideTransferMessagesModal();
//                                controller.callTransferMessages(TRANSFER_MODAL = 6)
//                                -> (sync v2) sync-messages-v2 module .sync(FIRST_TIME_LOGIN)
//                                "De sau" / close -> controller.hideTransferMessagesModal()
//     (hideTransferMessagesModal also records `setLastCloseFirstLoginTransferModal(now)` bookkeeping.)
//   * Progress: the sync-v2 state machine drives the `sync-ui-service` state (`screen`, `error`,
//     `progressSyncPreviewMessages`, `progressSyncOtherMessages`, ...). Screens: SyncGuideOpenMobile /
//     SyncGuideConfirmMobile (waiting for the phone), SyncingConversationList ->
//     SyncingPreviewAndRecentMessages -> SyncingOtherMessages, SyncSuccess, Error.
//     Phone confirmation arrives over realtime control commands handled inside the official machine.
//   * Lifecycle events on the sync-v2 module: onstart, onsyncing (phone confirmed), onresume,
//     onsuccess, onfailed(errorCode). Legacy v1 module (`sync-message-ui`) is supported as a fallback.
//   * Cancel: sync-v2 module `cancelSyncIfRunning('USER_CANCELLED')` (what `cancelSync` calls after its
//     confirm dialog); retry: `sync(RETRY_ON_FAILED_POPUP)` (what the official error popup calls).
//
// TransferJSON  (posted as {page:'main', transfer: TransferJSON | null}; null = nothing to show)
//   phase:                 'offer' | 'waitingForPhone' | 'transferring' | 'finished' | 'failed'
//   stage:                 'modal' | 'suggestion'                       (phase offer)
//                          'openMobile' | 'confirmMobile' | 'waitForBackup' (phase waitingForPhone)
//                          'conversationList' | 'messages' | 'otherMessages' | 'downloading' | 'decrypting'
//                          | 'restoring'                                 (phase transferring)
//   stageIndex/stageCount: number|null  position of the current transfer stage (v2: 1..3)
//   progress:              number|null  0...1 overall estimate (stage index + stage progress); null = indeterminate
//   stageProgress:         number|null  0...1 official progress of the current stage; null = indeterminate
//   syncedConversations:   number       official `numOfSyncedConv` (legacy v1 only, else 0)
//   receivedMessages:      number|null  v2 "other messages" stage: messages stored so far (official sync client report
//                          `stats.inserted`). That stage's official progress counts finished conversation ranges only, so a
//                          long conversation keeps the bar still for minutes while this number keeps growing.
//   totalConversations:    null         the official client does not expose a total
//   message:               string|null  official text when the client provides one (offer description)
//   officialTitle / officialDescription / officialSuggestion: string|null   Vietnamese texts of the
//                          official first-login modal (server-driven content), phase offer only
//   errorCode:             number|null  official sync error code (phase failed)
//   errorName:             string|null  official error enum name, e.g. "MOBILE_BUSY"
//   source:                string|null  official sync source name, e.g. "FIRST_TIME_LOGIN"
//   canRetry:              bool         phase failed: respond(true) retries
//
// window.__zaloTransfer
//   respond(accept: Bool, expectedPhase?: String)  (expectedPhase = phase the user saw; mismatch -> no-op + resync)
//                          offer: accept -> same call as the official "Dong bo ngay"; decline -> "De sau".
//                          failed: accept -> retry (official error popup), decline -> dismiss.
//                          waitingForPhone/transferring: decline -> cancel the running sync.
//   dismiss(expectedPhase?: String)  offer -> decline; waiting/transferring -> hide (sync continues in background);
//                          finished/failed -> clear the official UI state.
//   start()                manual start (Settings > "Dong bo tin nhan" in official Zalo PC): v2
//                          m2.sync(SyncSource.SETTING=6), v1 m1.sync(SETTING), guarded by the same
//                          canSync(SETTING)===OK checks. Refusals are logged and re-posted via availability.
//   state()                current TransferJSON (debug).
//
// Availability (separate post, only when it changes):  {page:'main', transferAvailable:{canStart:Bool, reason:String|null}}
//   reason (when !canStart): DISABLED | SYNC_RUNNING | DB_MIGRATING | WORKER_NOT_READY | MOBILE_NOT_SUPPORT |
//   SYNC_SRC_DISABLED | INVALID_STATE | NO_PERMISSION | ERROR  (official canSync result names)
(() => {
  'use strict';
  if (window.__zaloTransfer) return;
  if (location.pathname.split('/').pop() !== 'index.html') return;

  const post = (msg) => { try { window.webkit.messageHandlers.zstate.postMessage(msg); } catch {} };
  const diag = (s) => { try { window.webkit.messageHandlers.zlog.postMessage('[transfer] ' + s); } catch {} };
  const safe = (fn, d) => { try { const v = fn(); return v === undefined ? d : v; } catch { return d; } };

  // Official constants (enum values verified against the shipped bundle).
  const TRANSFER_MODAL_SOURCE = 6;        // tO.j.TRANSFER_MODAL (CTA entry point)
  const SOURCE_SETTING = 6;               // v2 SyncSource.SETTING (Settings > Sao luu & dong bo > Dong bo tin nhan)
  const CODE_USER_CANCELLED = 1006;       // Wle.c.PC_USER_CANCELS_SYNC
  const SRC = { FIRST_TIME_LOGIN: 3, RETRY_ON_FAILED_POPUP: 9 };
  // Background syncs the official UI runs on its own; they never get our overlay.
  const SILENT_SOURCES = new Set(['AUTO_REQUEST_SYNC', 'OVERFLOW', 'LONG_INACTIVE', 'SEARCH', 'E2EE_MISSING_MESSAGE', 'SYNC_ON_DEMAND']);
  const FINISHED_HOLD_MS = 20000;

  // ---- sync-v2: PC user id -> global noised id, for users without a mini profile ------------------
  // Sync-v2's `GET_GLOBAL_NOISED_IDS` task (main renderer) maps a 1-1 conversation's user id to the
  // global noised id the phone's backup is keyed by, using ONLY `getGlobalIdsFromUserIds`, i.e. the
  // `getminiprofiles` API. That API answers "Successful." with an EMPTY map for users it will not
  // return a profile for (observed: 12 of a user's 1-1 conversations, all valid accounts), so the
  // task returns nothing -> PC_GET_NOISED_ID_FAILED -> each failure counts towards `max_batch_fail`
  // -> EXCEEDED_MAX_BATCH_FAIL (1116) and the whole sync aborts. (Official Zalo avoids this in the
  // normal first sync only because the conversation phase already put pc<->global in the worker's
  // in-memory id cache; resuming ranges persisted by an earlier run, as here, has no such cache.)
  // DEVIATION FROM OFFICIAL: `OfficialClientHost.patchSyncGlobalIdResolver` makes that resolver ask
  // this hook for the ids it could not map. The hook uses the official global-id service
  // (`getGlobalId` -> `/api/gid/encrypt`, the same server mapping the conversation phase inverts with
  // `/api/gid/decrypt`; verified identical to the profile `globalId` for resolvable users and
  // round-tripping for the unresolvable ones). Nothing is invented: ids the server cannot map stay
  // unmapped and fail exactly as before.
  let gidSvc = null;
  const findGidSvc = () => {
    if (gidSvc) return gidSvc;
    const req = window.__zaloRequire;
    if (!req || typeof window.__zaloEachExport !== 'function') return null;
    window.__zaloEachExport(req, (ex) => {
      if (gidSvc || !ex || typeof ex !== 'object') return;
      try {
        // Shape: the singleton with the pc<->global caches and the server fetchers (module `wcaV` in 26.10.20).
        if (ex._userIdMap instanceof Map && ex._globalIdMap instanceof Map && typeof ex.getGlobalId === 'function' && typeof ex.getGlobalIdFromServer === 'function') gidSvc = ex;
      } catch {}
    });
    return gidSvc;
  };
  window.__swzGlobalIdFallback = async (uids) => {
    const svc = findGidSvc();
    const ids = Array.isArray(uids) ? [...new Set(uids.filter((u) => typeof u === 'string' && u && !u.startsWith('g')))] : [];
    const out = {};
    if (!svc || !ids.length) return out;
    for (let i = 0; i < ids.length; i += 100) {
      const part = ids.slice(i, i + 100);
      const m = await svc.getGlobalId(part);
      for (const id of part) if (m && typeof m[id] === 'string' && m[id]) out[id] = m[id];
    }
    diag('sync global-id fallback: ' + Object.keys(out).length + '/' + ids.length + ' resolved via gid/encrypt');
    return out;
  };

  const sess = { visible: false, minimized: false, held: null, heldTimer: null, confirmed: false };
  let enums = null;
  let missingEnums = null;
  let ctl = null, ui2 = null, ui1 = null, m2 = null, m1 = null;
  let lastKey = null, pending = null;

  // ---- enums by shape (names -> values) ------------------------------------------------------
  const findEnums = (req) => {
    const out = {};
    window.__zaloEachExport(req, (ex) => {
      if (!ex || typeof ex !== 'object' || Array.isArray(ex)) return;
      try {
        if (ex.SyncGuideConfirmMobile !== undefined && ex.SyncingOtherMessages !== undefined) out.screen2 = ex;
        else if (ex.WaitForBackup !== undefined && ex.SyncInProgress !== undefined) out.screen1 = ex;
        else if (ex.SETTING !== undefined && ex.CSC_LIST !== undefined && ex.FIRST_TIME_LOGIN !== undefined) out.src1 = ex;   // v1 sync source enum
        else if (ex.FIRST_TIME_LOGIN !== undefined && ex.MANUAL !== undefined && ex.AUTO_SYNC !== undefined) out.source = ex;
        else if (ex.OK === 0 && ex.INVALID_STATE !== undefined && ex.WORKER_NOT_READY !== undefined) out.canSync = ex;
        else if (ex.PC_LOW_STORAGE !== undefined && ex.NO_ERROR !== undefined && ex.USER_DONT_CONFIRM !== undefined) out.error = ex;
        else if (ex.ON_START !== undefined && ex.ON_FAILED !== undefined && ex.ON_SUCCESS !== undefined) out.events = ex;
        else if (ex.USER_CANCELLED !== undefined && ex.PC_USER_LOGOUT !== undefined) out.cancel = ex;
      } catch {}
    });
    return out;
  };
  const nameOf = (en, v) => (en && typeof v === 'number' && typeof en[v] === 'string') ? en[v] : null;

  // ---- DI lookup ------------------------------------------------------------------------------
  const resolve = () => {
    const regs = window.__zaloDI(window.__zaloRequire);
    const pick = (pred) => { for (const r of regs) { const i = r.instance; if (i && typeof i === 'object') { try { if (pred(i)) return i; } catch {} } } return null; };
    const c = pick((i) => typeof i.needTransferMessages === 'function' && typeof i.callTransferMessages === 'function' && !!i.UIManager);
    if (!c) return false;
    const u2 = pick((i) => i.name === 'sync-ui-service' && typeof i.showSyncGuideOpenMobile === 'function');
    const u1 = pick((i) => i.name === 'sync-message-ui' && typeof i.showSyncGuide === 'function');
    if (!u2 && !u1) return false;
    ctl = c; ui2 = u2; ui1 = u1;
    m2 = safe(() => c.syncMessagesV2Module, null);
    m1 = safe(() => c.syncMessagesModule, null);
    return true;
  };

  // ---- state derivation -----------------------------------------------------------------------
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const pct = (v) => (typeof v === 'number' && isFinite(v)) ? clamp01(v / 100) : null;
  const currentSource = () => {
    const info = safe(() => m2.machine.getCurrentSyncMachineInfo(), null);
    return info ? nameOf(enums.source, info.syncSource) : null;
  };
  const modalTexts = () => {
    const t = safe(() => ctl.UIManager.dataState.content.transfer_modal, null) || {};
    const first = (k) => { const a = t[k] && t[k].pc; const s = Array.isArray(a) && a[0] && a[0].text; return typeof s === 'string' && s ? s : null; };
    return { officialTitle: first('title'), officialDescription: first('desc'), officialSuggestion: first('suggestion') };
  };
  const base = (phase, stage, extra) => Object.assign({
    phase, stage, stageIndex: null, stageCount: null, progress: null, stageProgress: null,
    syncedConversations: 0, totalConversations: null, receivedMessages: null, message: null,
    officialTitle: null, officialDescription: null, officialSuggestion: null,
    errorCode: null, errorName: null, source: null, canRetry: false,
  }, extra || {});
  const failedState = (code) => base('failed', null, {
    errorCode: typeof code === 'number' ? code : null, errorName: nameOf(enums.error, code), source: currentSource(), canRetry: true,
  });

  const compute = () => {
    const modal = !!safe(() => ctl.UIManager.UIState.transfer_modal.isDisplayed, false);
    if (modal) {
      const t = modalTexts();
      return base('offer', 'modal', Object.assign({ message: t.officialDescription }, t));
    }
    if (sess.held) return sess.held;
    const v2 = !!safe(() => ctl.isSyncV2Enabled(), true) && ui2 && m2;
    let out = v2 ? computeV2() : computeV1();
    const running = !!safe(() => (v2 ? m2 : m1).isSyncRunning(), false);
    if (!out && running && sess.visible) {
      // The official UI mode hides the progress screens; the sync the user started is still running.
      out = base('transferring', 'conversationList', { source: v2 ? currentSource() : null });
    }
    if (out && (out.phase === 'waitingForPhone' || out.phase === 'transferring')) {
      if (SILENT_SOURCES.has(out.source || '')) return null;
      sess.visible = true;
      if (sess.minimized) return null;
    } else if (!out && !running) {
      sess.visible = false;
      sess.minimized = false;
    }
    return out;
  };

  // The official sync client of the "other messages" stage (DI singleton holding `syncOtherMessageClient`): its report counts
  // the messages stored so far. Read only.
  let syncClient = null;
  const receivedMessages = () => {
    if (!syncClient) {
      for (const r of safe(() => window.__zaloDI(window.__zaloRequire), [])) {
        const i = r && r.instance;
        if (i && typeof i === 'object' && safe(() => 'syncOtherMessageClient' in i && typeof i.syncOtherMessages === 'function', false)) { syncClient = i; break; }
      }
    }
    const n = safe(() => syncClient.syncOtherMessageClient.report.stats.inserted, null);
    return typeof n === 'number' && isFinite(n) && n > 0 ? n : null;
  };

  const computeV2 = () => {
    const st = ui2.state || {};
    const sc = nameOf(enums.screen2, st.screen);
    const source = currentSource();
    switch (sc) {
      case 'SuggestNewSync':
        return st.popupVisible ? base('offer', 'suggestion', { source }) : null;
      case 'SyncGuideOpenMobile':
        return base('waitingForPhone', 'openMobile', { source });
      case 'SyncGuideConfirmMobile':
        return base('waitingForPhone', 'confirmMobile', { source });
      case 'SyncingConversationList':
        return base('transferring', 'conversationList', { stageIndex: 1, stageCount: 3, progress: 0, stageProgress: null, source });
      case 'SyncingPreviewAndRecentMessages': {
        const p = pct(st.progressSyncPreviewAndRecentMessages);
        return base('transferring', 'messages', { stageIndex: 2, stageCount: 3, stageProgress: p, progress: (1 + (p || 0)) / 3, source });
      }
      case 'SyncingOtherMessages': {
        const p = pct(st.progressSyncOtherMessages);
        return base('transferring', 'otherMessages', { stageIndex: 3, stageCount: 3, stageProgress: p, progress: (2 + (p || 0)) / 3, source, receivedMessages: receivedMessages() });
      }
      case 'SyncSuccess':
        return sess.visible ? base('finished', null, { progress: 1, stageProgress: 1, source }) : null;
      case 'WaitForNetwork':
        return sess.visible ? failedState(1106 /* NO_NETWORK */) : null;
      case 'Error':
        return sess.visible ? failedState(st.error) : null;
      default:
        return null;
    }
  };

  const computeV1 = () => {
    if (!ui1) return null;
    const st = ui1.state || {};
    const sc = nameOf(enums.screen1, st.screen);
    const synced = st.numOfSyncedConv || 0;
    const stage = (name, idx) => base('transferring', name, {
      stageIndex: idx, stageCount: 3, syncedConversations: synced,
      progress: pct(st.totalProgress), stageProgress: pct(st.progress),
    });
    switch (sc) {
      case 'SuggestNewSync': return st.popupVisible ? base('offer', 'suggestion') : null;
      case 'SyncGuide': case 'WaitForBackup': case 'MobileIdleInBackup': return base('waitingForPhone', 'waitForBackup');
      case 'DownloadingBackup': return stage('downloading', 1);
      case 'DecryptingBackup': return stage('decrypting', 2);
      case 'SyncInProgress': return stage('restoring', 3);
      case 'SyncSuccess': return sess.visible ? base('finished', null, { progress: 1, syncedConversations: synced }) : null;
      case 'WaitForNetwork': return sess.visible ? failedState(1106) : null;
      case 'Error': return sess.visible ? failedState(st.error) : null;
      default: return null;
    }
  };

  // ---- publishing ------------------------------------------------------------------------------
  // Manual start availability: exactly the guards of the official Settings card
  // (Cai dat > Sao luu & dong bo > "Dong bo tin nhan"): feature on for SETTING, no data migration,
  // no sync running, module.canSync(SETTING) === OK (also covers WORKER_NOT_READY / mobile unsupported).
  const availability = () => {
    const okCode = enums.canSync ? enums.canSync.OK : 0;
    const why = (code) => (enums.canSync && enums.canSync[code]) || ('CODE_' + code);
    const regs = window.__zaloDI(window.__zaloRequire);
    let migrating = false;
    for (const r of regs) {
      const i = r.instance;
      if (i && typeof i === 'object' && typeof i.getActiveProcesses === 'function') {
        migrating = !!safe(() => i.getActiveProcesses().some((p) => p.kind === 'db-migrate'), false);
        break;
      }
    }
    if (migrating) return { canStart: false, reason: 'DB_MIGRATING' };
    if (v2()) {
      if (!safe(() => m2.isFeatureEnabledBySyncSource(SOURCE_SETTING), false)) return { canStart: false, reason: 'DISABLED' };
      if (safe(() => m2.isSyncRunning(), false)) return { canStart: false, reason: 'SYNC_RUNNING' };
      const c = safe(() => m2.canSync(SOURCE_SETTING), -1);
      return c === okCode ? { canStart: true, reason: null } : { canStart: false, reason: why(c) };
    }
    if (!m1 || !enums.src1 || !safe(() => m1.isEnable(), false)) return { canStart: false, reason: 'DISABLED' };
    if (safe(() => m1.isThisSessionSyncing(), false)) return { canStart: false, reason: 'SYNC_RUNNING' };
    const c = safe(() => m1.canSync(enums.src1.SETTING), -1);
    return c === okCode ? { canStart: true, reason: null } : { canStart: false, reason: why(c) };
  };
  let lastAvail = null;
  const publishAvailability = () => {
    const a = safe(availability, { canStart: false, reason: 'ERROR' });
    const key = JSON.stringify(a);
    if (key === lastAvail) return;
    lastAvail = key;
    post({ page: 'main', transferAvailable: a });
  };

  const publish = () => {
    pending = null;
    if (!ctl || !enums) return;
    publishAvailability();
    let s = null;
    try { s = compute(); } catch (e) { diag('compute failed: ' + (e && e.message)); return; }
    // A held result is only shown after the user saw the flow; guard against stale holds.
    const key = JSON.stringify(s);
    if (key === lastKey) return;
    lastKey = key;
    post({ page: 'main', transfer: s });
    if (s) diag('transfer ' + s.phase + (s.stage ? '/' + s.stage : '') + (s.progress != null ? ' ' + Math.round(s.progress * 100) + '%' : '') + (s.errorName ? ' ' + s.errorName : ''));
    else diag('transfer cleared');
  };
  const schedule = () => { if (!pending) pending = setTimeout(publish, 40); };

  const hold = (state) => {
    clearTimeout(sess.heldTimer);
    sess.held = state;
    if (state && state.phase === 'finished') {
      sess.heldTimer = setTimeout(() => { sess.held = null; sess.visible = false; schedule(); }, FINISHED_HOLD_MS);
    }
    schedule();
  };
  const resetSession = () => { clearTimeout(sess.heldTimer); sess.held = null; sess.visible = false; sess.minimized = false; sess.confirmed = false; };

  // ---- hooks -----------------------------------------------------------------------------------
  const wrap = (obj, name) => {
    const original = obj && obj[name];
    if (typeof original !== 'function' || original.__olaz) return;
    const wrapped = function (...args) { const r = original.apply(this, args); schedule(); return r; };
    wrapped.__olaz = true;
    obj[name] = wrapped;
  };
  const errorCodeOf = (ev) => safe(() => (typeof ev.getErrorCode === 'function' ? ev.getErrorCode() : ev.errorCode), undefined);
  const listen = (mod, version) => {
    if (!mod || typeof mod.addEventListener !== 'function' || mod.__olazTransfer) return;
    mod.__olazTransfer = true;
    const E = enums.events;
    mod.addEventListener(E.ON_START, () => {
      // A new sync run: drop any previous result.
      clearTimeout(sess.heldTimer); sess.held = null; sess.confirmed = false; sess.minimized = false;
      schedule();
    });
    if (E.ON_SYNCING) mod.addEventListener(E.ON_SYNCING, () => { sess.confirmed = true; schedule(); });
    mod.addEventListener(E.ON_SUCCESS, () => {
      if (!sess.visible) { schedule(); return; }
      hold(base('finished', null, { progress: 1, stageProgress: 1, source: version === 2 ? currentSource() : null }));
    });
    mod.addEventListener(E.ON_FAILED, (ev) => {
      const code = errorCodeOf(ev);
      if (code === CODE_USER_CANCELLED) { resetSession(); schedule(); return; }  // user cancelled: nothing to show
      if (!sess.visible) { schedule(); return; }                                    // silent background failure
      hold(failedState(code));
    });
  };

  const install = () => {
    // Services first (cheap); the enum modules load with them, but never trust a partial scan:
    // re-scan on every attempt until every required enum is present.
    if (!resolve()) return false;
    const found = findEnums(window.__zaloRequire);
    if (!found.events || !found.source || !found.screen2 || !found.error) {
      missingEnums = ['events', 'source', 'screen2', 'error'].filter((k) => !found[k]).join(',');
      return false;
    }
    if (ui1 && !found.screen1) { missingEnums = 'screen1'; return false; }
    enums = found;
    missingEnums = null;
    if (ctl.UIManager) wrap(ctl.UIManager, 'setUIState');
    if (ui2) wrap(ui2, 'setState');
    if (ui1) wrap(ui1, 'setState');
    listen(m2, 2);
    listen(m1, 1);
    // Safety net for state changes that bypass setState wrappers.
    setInterval(publish, 1500);
    diag('installed (sync v' + (safe(() => ctl.isSyncV2Enabled(), true) ? 2 : 1) + ', shouldTransfer=' + safe(() => ctl.shouldTransferMessages(), '?') + ')');
    publish();
    return true;
  };

  // ---- Swift -> JS -----------------------------------------------------------------------------
  const run = (label, fn) => { try { return fn(); } catch (e) { diag(label + ' failed: ' + (e && e.message)); } };
  const v2 = () => !!safe(() => ctl.isSyncV2Enabled(), true) && !!m2;
  const syncModule = () => (v2() ? m2 : m1);

  const decline = (s) => {
    if (s && s.stage === 'suggestion') {
      if (v2()) run('closeSuggestNewSyncBanner', () => m2.closeSuggestNewSyncBanner());
      else run('reset', () => m1.reset());   // v1 popup "bo qua" button -> SyncMessageController.reset()
    } else {
      // Official "De sau" / close: hides the modal and records the close time.
      run('hideTransferMessagesModal', () => ctl.hideTransferMessagesModal());
    }
  };
  const cancelRunning = () => {
    const m = syncModule();
    const reason = (enums.cancel && enums.cancel.USER_CANCELLED) ?? 'USER_CANCELLED';
    resetSession();
    run('cancel', () => {
      if (m && typeof m.cancelSyncIfRunning === 'function') m.cancelSyncIfRunning(reason);
      else if (m && typeof m.cancel === 'function') m.cancel();   // v1
    });
    schedule();
  };

  // The card the user clicked may be stale: act only if the current phase is the one they saw,
  // otherwise re-post the real state so the native card catches up.
  const stillCurrent = (s, expectedPhase) => {
    const actual = s ? s.phase : null;
    if (expectedPhase === undefined || expectedPhase === null || expectedPhase === actual) return !!s;
    diag('stale action for phase ' + expectedPhase + ' (now ' + actual + '); resync');
    lastKey = null;
    schedule();
    return false;
  };

  window.__zaloTransfer = {
    respond(accept, expectedPhase) {
      if (!ctl) return;
      const s = compute();
      if (!stillCurrent(s, expectedPhase)) return;
      accept = !!accept;
      switch (s.phase) {
        case 'offer':
          if (!accept) { decline(s); break; }
          if (s.stage === 'suggestion') {
            // The suggestion popup (popupVisible) only exists for the first-login suggestion.
            if (v2()) run('sync', () => m2.sync(SRC.FIRST_TIME_LOGIN));
            else run('sync', () => m1.sync());
          } else {
            // Same two calls as the official modal's "Dong bo ngay" button (PC build).
            run('hideTransferMessagesModal', () => ctl.hideTransferMessagesModal());
            run('callTransferMessages', () => ctl.callTransferMessages(TRANSFER_MODAL_SOURCE));
          }
          break;
        case 'failed':
          if (accept) {
            resetSession();
            run('retry', () => (v2() ? m2.sync(SRC.RETRY_ON_FAILED_POPUP) : (m1.retry ? m1.retry() : m1.sync())));
          } else { this.dismiss(); }
          break;
        case 'waitingForPhone':
        case 'transferring':
          if (!accept) cancelRunning();
          break;
        default: break;
      }
      schedule();
    },
    dismiss(expectedPhase) {
      if (!ctl) return;
      const s = compute();
      if (!stillCurrent(s, expectedPhase)) return;
      switch (s.phase) {
        case 'offer': decline(s); break;
        case 'waitingForPhone':
        case 'transferring':
          // Official "minimize": the sync keeps running, the overlay goes away.
          sess.minimized = true;
          run('hidePopup', () => ui2 && ui2.hidePopup && ui2.hidePopup());
          break;
        default: // finished / failed
          resetSession();
          run('clear', () => { if (ui2 && ui2.clearErrorAndHideAllUI) ui2.clearErrorAndHideAllUI(); else if (ui1 && ui1.hideAllUI) ui1.hideAllUI(); });
          break;
      }
      schedule();
    },
    // Manual start: the same call as the official Settings card "Dong bo tin nhan"
    // (v2: syncMessagesV2Module.sync(SyncSource.SETTING = 6); v1: syncMessagesModule.sync(SETTING)).
    // The state machine then drives the overlay (waitingForPhone -> transferring -> finished/failed).
    start() {
      if (!ctl) return 'not-installed';
      const a = safe(availability, { canStart: false, reason: 'ERROR' });
      if (!a.canStart) { diag('start refused: ' + a.reason); lastAvail = null; schedule(); return 'refused:' + a.reason; }
      resetSession();
      sess.visible = true;   // a manual run is user-facing: never filtered out as a silent background sync
      run('start', () => (v2() ? m2.sync(SOURCE_SETTING) : m1.sync(enums.src1.SETTING)));
      schedule();
      return 'started';
    },
    availability() { return safe(availability, null); },
    state() { return safe(compute, null); },
  };

  // The renderer boots asynchronously; wait for the DI container + services.
  let tries = 0;
  const boot = () => {
    if (!window.__zaloRequire || !window.__zaloDI || !window.__zaloEachExport) return false;
    return safe(install, false) === true;
  };
  const t = setInterval(() => {
    tries++;
    if (boot()) { clearInterval(t); return; }
    if (tries > 600) {
      clearInterval(t);
      diag('gave up installing after ' + tries + ' attempts' + (missingEnums ? ' (missing enums: ' + missingEnums + ')' : ' (services not found)'));
    }
  }, 500);
})();
