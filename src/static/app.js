/**
 * app.js — Verilog Visualizer front-end: file browser, design management,
 * pan/zoom, export, interactive module drag/resize, wire waypoints, layout persistence.
 */

// ─── Layout persistence helpers ─────────────────────────────────────────

const STORAGE_KEY_PREFIX = 'vviz_layout_';
const STORAGE_COLLAPSED_KEY = 'vviz_collapsed';
const STORAGE_WIRE_KEY_PREFIX = 'vviz_wires_';
const STORAGE_VIEW_KEY_PREFIX = 'vviz_view_';
const STORAGE_INLINE_EXPANDED_KEY_PREFIX = 'vviz_inline_expanded_';
const STORAGE_CUSTOM_PREFIX = 'vviz_custom_';
const STORAGE_LOCAL_META_PREFIX = 'vviz_local_meta_';
const STORAGE_LAST_DESIGN_KEY = 'vviz_last_design';
const DEFAULT_SERVER_SYNC_ENABLED = true;
const LOCAL_PERSISTED_FIELDS = [
  'layout',
  'wire_waypoints',
  'view_state',
  'customizations',
  'inline_expanded_paths',
];

const LOCAL_STORAGE_FIELD_KEYS = {
  layout: STORAGE_KEY_PREFIX,
  wire_waypoints: STORAGE_WIRE_KEY_PREFIX,
  view_state: STORAGE_VIEW_KEY_PREFIX,
  customizations: STORAGE_CUSTOM_PREFIX,
  inline_expanded_paths: STORAGE_INLINE_EXPANDED_KEY_PREFIX,
};

function saveLastDesign(designName) {
  if (!designName) return;
  try { localStorage.setItem(STORAGE_LAST_DESIGN_KEY, designName); } catch (e) {}
}

function loadLastDesign() {
  try { return localStorage.getItem(STORAGE_LAST_DESIGN_KEY) || ''; }
  catch (e) { return ''; }
}

function clearLastDesign() {
  try { localStorage.removeItem(STORAGE_LAST_DESIGN_KEY); } catch (e) {}
}

function getLayoutOverrideForInstance(designName, layoutKey, instanceName = '') {
  const overrides = state.layoutOverrides[designName] || {};
  const fallbackKey = instanceName || String(layoutKey || '').split('::').pop();
  return {
    ...(fallbackKey ? (overrides[fallbackKey] || {}) : {}),
    ...(layoutKey ? (overrides[layoutKey] || {}) : {}),
  };
}

function saveLayout(designName, layoutData, { sync = true, dirty = sync } = {}) {
  try { localStorage.setItem(STORAGE_KEY_PREFIX + designName, JSON.stringify(layoutData)); }
  catch (e) { console.warn('Failed to save layout', e); }
  if (dirty) markLocalStateDirty(designName, 'layout');
  if (sync) scheduleSyncToServer(designName);
}
function loadLayout(designName) {
  try { const d = localStorage.getItem(STORAGE_KEY_PREFIX + designName); return d ? JSON.parse(d) : {}; }
  catch (e) { return {}; }
}
function saveWireWaypoints(designName, data, { sync = true, dirty = sync } = {}) {
  try { localStorage.setItem(STORAGE_WIRE_KEY_PREFIX + designName, JSON.stringify(data)); }
  catch (e) {}
  if (dirty) markLocalStateDirty(designName, 'wire_waypoints');
  if (sync) scheduleSyncToServer(designName);
}
function loadWireWaypoints(designName) {
  try { const d = localStorage.getItem(STORAGE_WIRE_KEY_PREFIX + designName); return d ? JSON.parse(d) : {}; }
  catch (e) { return {}; }
}
function saveCollapsedState(cs) {
  try { localStorage.setItem(STORAGE_COLLAPSED_KEY, JSON.stringify(cs)); }
  catch (e) {}
}
function loadCollapsedState() {
  try { const d = localStorage.getItem(STORAGE_COLLAPSED_KEY); return d ? JSON.parse(d) : {}; }
  catch (e) { return {}; }
}
function saveViewState(designName, view, { sync = true, dirty = sync } = {}) {
  try { localStorage.setItem(STORAGE_VIEW_KEY_PREFIX + designName, JSON.stringify(view)); }
  catch (e) {}
  if (dirty) markLocalStateDirty(designName, 'view_state');
  if (sync) scheduleSyncToServer(designName);
}
function loadViewState(designName) {
  try { const d = localStorage.getItem(STORAGE_VIEW_KEY_PREFIX + designName); return d ? JSON.parse(d) : null; }
  catch (e) { return null; }
}
function saveInlineExpanded(designName, paths, { sync = true, dirty = sync } = {}) {
  try {
    localStorage.setItem(
      STORAGE_INLINE_EXPANDED_KEY_PREFIX + designName,
      JSON.stringify([...paths])
    );
  } catch (e) {}
  if (dirty) markLocalStateDirty(designName, 'inline_expanded_paths');
  if (sync) scheduleSyncToServer(designName);
}
function loadInlineExpanded(designName) {
  try {
    const data = localStorage.getItem(STORAGE_INLINE_EXPANDED_KEY_PREFIX + designName);
    return new Set(data ? JSON.parse(data) : []);
  } catch (e) {
    return new Set();
  }
}

const STORAGE_HIDE_CLK_RST = 'vviz_hide_clk_rst';

function saveHideClockReset(val) {
  try { localStorage.setItem(STORAGE_HIDE_CLK_RST, JSON.stringify(val)); } catch(e) {}
}
function loadHideClockReset() {
  try { const d = localStorage.getItem(STORAGE_HIDE_CLK_RST); return d !== null ? JSON.parse(d) : true; }
  catch(e) { return true; }
}

// Customization: { modules: { instName: { color, rename, comment } }, wires: { wireKey: { color } }, commentBlocks: { id: { x, y, width, height, markdown } } }
function saveCustomizations(designName, data, { dirty = true } = {}) {
  try { localStorage.setItem(STORAGE_CUSTOM_PREFIX + designName, JSON.stringify(data)); } catch(e) {}
  if (dirty) markLocalStateDirty(designName, 'customizations');
}
function loadCustomizations(designName) {
  try { const d = localStorage.getItem(STORAGE_CUSTOM_PREFIX + designName); return normalizeCustomizations(d ? JSON.parse(d) : {}); }
  catch(e) { return normalizeCustomizations({}); }
}
function normalizeCustomizations(data) {
  return {
    modules: data?.modules || {},
    wires: data?.wires || {},
    commentBlocks: data?.commentBlocks || {},
  };
}

function normalizePersistedField(field, value) {
  if (field === 'layout' || field === 'wire_waypoints') {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }
  if (field === 'view_state') {
    if (!value || typeof value !== 'object' || !value.pan) return null;
    const x = Number(value.pan.x);
    const y = Number(value.pan.y);
    const zoom = Number(value.zoom);
    if (![x, y, zoom].every(Number.isFinite)) return null;
    return { pan: { x, y }, zoom };
  }
  if (field === 'customizations') return normalizeCustomizations(value || {});
  if (field === 'inline_expanded_paths') {
    return Array.isArray(value)
      ? [...new Set(value.filter(path => typeof path === 'string'))].sort()
      : [];
  }
  return null;
}

function normalizePersistedSnapshot(source = {}) {
  const snapshot = {};
  LOCAL_PERSISTED_FIELDS.forEach(field => {
    snapshot[field] = normalizePersistedField(field, source[field]);
  });
  return snapshot;
}

function stableStateValue(value) {
  if (Array.isArray(value)) return value.map(stableStateValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableStateValue(value[key]);
    return result;
  }, {});
}

function persistedStateSignature(value) {
  const text = JSON.stringify(stableStateValue(value));
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

function persistedStateEqual(left, right) {
  return persistedStateSignature(left) === persistedStateSignature(right);
}

function readLocalJson(key) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return { present: false, value: null };
    return { present: true, value: JSON.parse(raw) };
  } catch (e) {
    return { present: true, value: null };
  }
}

function loadLocalPersistedState(designName) {
  const result = {};
  LOCAL_PERSISTED_FIELDS.forEach(field => {
    const stored = readLocalJson(LOCAL_STORAGE_FIELD_KEYS[field] + designName);
    result[field] = {
      present: stored.present,
      value: stored.present ? normalizePersistedField(field, stored.value) : null,
    };
  });
  return result;
}

function loadLocalSyncMeta(designName) {
  const stored = readLocalJson(STORAGE_LOCAL_META_PREFIX + designName);
  const value = stored.value && typeof stored.value === 'object' ? stored.value : {};
  const dirtyFields = Array.isArray(value.dirty_fields)
    ? value.dirty_fields.filter(field => LOCAL_PERSISTED_FIELDS.includes(field))
    : [];
  const signatures = value.server_signatures && typeof value.server_signatures === 'object'
    ? value.server_signatures
    : {};
  return {
    dirty: value.dirty === true,
    dirtyFields: [...new Set(dirtyFields)],
    revision: Number.isFinite(Number(value.revision)) ? Number(value.revision) : 0,
    updatedAt: Number.isFinite(Number(value.updated_at)) ? Number(value.updated_at) : 0,
    serverLayoutRevision: Number.isFinite(Number(value.server_layout_revision))
      ? Number(value.server_layout_revision)
      : 0,
    serverSignatures: { ...signatures },
  };
}

function saveLocalSyncMeta(designName, meta) {
  try {
    localStorage.setItem(STORAGE_LOCAL_META_PREFIX + designName, JSON.stringify({
      version: 1,
      dirty: meta.dirty === true,
      dirty_fields: [...new Set(meta.dirtyFields || [])],
      revision: meta.revision || 0,
      updated_at: meta.updatedAt || Date.now(),
      server_layout_revision: meta.serverLayoutRevision || 0,
      server_signatures: meta.serverSignatures || {},
    }));
  } catch (e) {}
}

function snapshotSignatures(snapshot) {
  const normalized = normalizePersistedSnapshot(snapshot);
  return LOCAL_PERSISTED_FIELDS.reduce((result, field) => {
    result[field] = persistedStateSignature(normalized[field]);
    return result;
  }, {});
}

function markLocalStateDirty(designName, field) {
  if (!designName || !LOCAL_PERSISTED_FIELDS.includes(field)) return;
  const meta = loadLocalSyncMeta(designName);
  meta.dirty = true;
  if (!meta.dirtyFields.includes(field)) meta.dirtyFields.push(field);
  meta.revision += 1;
  meta.updatedAt = Date.now();
  saveLocalSyncMeta(designName, meta);
}

function hasPendingLocalChanges(designName) {
  return Boolean(designName && loadLocalSyncMeta(designName).dirty);
}

function recordLocalServerSnapshot(designName, snapshot, {
  preserveDirty = true,
  serverLayoutRevision,
} = {}) {
  const meta = loadLocalSyncMeta(designName);
  const nextSignatures = snapshotSignatures(snapshot);
  if (preserveDirty && meta.dirtyFields.length > 0) {
    meta.serverSignatures = {
      ...nextSignatures,
      ...Object.fromEntries(meta.dirtyFields.map(field => [
        field,
        meta.serverSignatures[field] || nextSignatures[field],
      ])),
    };
  } else {
    meta.serverSignatures = nextSignatures;
    meta.dirty = false;
    meta.dirtyFields = [];
  }
  if (Number.isFinite(Number(serverLayoutRevision))) {
    meta.serverLayoutRevision = Number(serverLayoutRevision);
  }
  meta.updatedAt = Date.now();
  saveLocalSyncMeta(designName, meta);
}

function markLocalStateSynced(designName, revision, snapshot) {
  const meta = loadLocalSyncMeta(designName);
  if (revision !== undefined && meta.revision !== revision) return;
  recordLocalServerSnapshot(designName, snapshot, { preserveDirty: false });
}

function resolveLocalPersistedState(designName, serverData) {
  const serverState = normalizePersistedSnapshot(serverData);
  const localState = loadLocalPersistedState(designName);
  const meta = loadLocalSyncMeta(designName);
  const resolved = { ...serverState };
  const usedLocalFields = [];
  const allFieldsExplicitlyDirty = meta.dirty && meta.dirtyFields.length === 0;
  const serverLayoutRevision = Number(serverData.layout_revision);
  const remoteLayoutRevisionAdvanced = Number.isFinite(serverLayoutRevision)
    && serverLayoutRevision > meta.serverLayoutRevision;

  LOCAL_PERSISTED_FIELDS.forEach(field => {
    const local = localState[field];
    if (!local.present) return;
    const baselineSignature = meta.serverSignatures[field];
    const changedSinceBaseline = baselineSignature
      ? persistedStateSignature(local.value) !== baselineSignature
      : !persistedStateEqual(local.value, serverState[field]);
    const intentionalRemoteLayout = field === 'layout'
      && remoteLayoutRevisionAdvanced
      && !meta.dirtyFields.includes('layout')
      && !allFieldsExplicitlyDirty;
    const preferLocal = !intentionalRemoteLayout && (allFieldsExplicitlyDirty
      || meta.dirtyFields.includes(field)
      || changedSinceBaseline);
    if (preferLocal) {
      resolved[field] = local.value;
      usedLocalFields.push(field);
    }
  });

  if (usedLocalFields.length > 0) {
    meta.dirty = true;
    meta.dirtyFields = [...new Set([...meta.dirtyFields, ...usedLocalFields])];
    if (Object.keys(meta.serverSignatures).length === 0) {
      meta.serverSignatures = snapshotSignatures(serverState);
    }
    if (meta.revision === 0) meta.revision = 1;
    meta.updatedAt = Date.now();
    saveLocalSyncMeta(designName, meta);
  } else if (!meta.dirty) {
    recordLocalServerSnapshot(designName, serverState, {
      preserveDirty: false,
      serverLayoutRevision,
    });
  }

  return { state: resolved, usedLocalFields, serverLayoutRevision };
}

const STORAGE_CANVAS_BG = 'vviz_canvas_bg';
function saveCanvasBgColor(color) {
  try { localStorage.setItem(STORAGE_CANVAS_BG, color); } catch(e) {}
}
function loadCanvasBgColor() {
  try { return localStorage.getItem(STORAGE_CANVAS_BG) || '#0d1117'; }
  catch(e) { return '#0d1117'; }
}

const STORAGE_COMMENT_POPUP_SIZE = 'vviz_comment_popup_size';
function saveCommentPopupSize(w, h) {
  try { localStorage.setItem(STORAGE_COMMENT_POPUP_SIZE, JSON.stringify({ w, h })); } catch(e) {}
}

const STORAGE_SETTINGS_MODAL_SIZE = 'vviz_settings_modal_size';
function saveSettingsModalSize(w, h) {
  try { localStorage.setItem(STORAGE_SETTINGS_MODAL_SIZE, JSON.stringify({ w, h })); } catch(e) {}
}
function loadSettingsModalSize() {
  try { const d = localStorage.getItem(STORAGE_SETTINGS_MODAL_SIZE); return d ? JSON.parse(d) : { w: 500, h: 420 }; }
  catch(e) { return { w: 500, h: 420 }; }
}
function loadCommentPopupSize() {
  try { const d = localStorage.getItem(STORAGE_COMMENT_POPUP_SIZE); return d ? JSON.parse(d) : { w: 340, h: 260 }; }
  catch(e) { return { w: 340, h: 260 }; }
}

// ─── 服务器状态同步（防抖） ─────────────────────────────────────────────
const _syncTimers = {};
const _syncControllers = {};

function isServerSyncEnabled(designName) {
  if (!designName) return DEFAULT_SERVER_SYNC_ENABLED;
  return state.serverSyncEnabled[designName] ?? DEFAULT_SERVER_SYNC_ENABLED;
}

function cancelScheduledServerSync(designName) {
  const timer = _syncTimers[designName];
  if (timer) clearTimeout(timer);
  delete _syncTimers[designName];

  const controller = _syncControllers[designName];
  if (controller) controller.abort();
  delete _syncControllers[designName];
}

function scheduleSyncToServer(designName) {
  if (!designName || !isServerSyncEnabled(designName)) return;
  cancelScheduledServerSync(designName);
  _syncTimers[designName] = setTimeout(() => {
    delete _syncTimers[designName];
    syncStateToServer(designName).catch(() => {});
  }, 1500);
}

function syncStateToServer(designName, { force = false } = {}) {
  if (!designName || (!force && !isServerSyncEnabled(designName))) return Promise.resolve(null);
  const sentRevision = loadLocalSyncMeta(designName).revision;
  const viewState = (state.activeTab === designName && state.pan)
    ? { pan: { ...state.pan }, zoom: state.zoom }
    : (loadViewState(designName) || undefined);
  const payload = {
    name: designName,
    layout: state.layoutOverrides?.[designName] || {},
    wire_waypoints: state.wireWaypoints?.[designName] || {},
    customizations: normalizeCustomizations(state.customizations?.[designName] || {}),
    tree_expanded: state.treeExpanded?.[designName] ? [...state.treeExpanded[designName]] : [],
    inline_expanded_paths: state.inlineExpanded?.[designName] ? [...state.inlineExpanded[designName]] : [],
    sidebar_ui: (() => {
      const sb = $('sidebar');
      if (!sb) return undefined;
      return {
        collapsed:     sb.classList.contains('collapsed'),
        tree_fullscreen: sb.classList.contains('tree-fullscreen'),
        width:         sb.dataset.savedWidth || (sb.classList.contains('collapsed') ? null : sb.style.width) || null,
      };
    })(),
    canvas_controls: {
      wasd_step:      state.canvasControls.wasdStep,
      zoom_key_in:    state.canvasControls.zoomKeyIn,
      zoom_key_out:   state.canvasControls.zoomKeyOut,
      zoom_step_pct:  state.canvasControls.zoomStepPct,
      help_key:       state.canvasControls.helpKey,
      fit_key:        state.canvasControls.fitKey,
      sidebar_key:    state.canvasControls.sidebarKey,
      tree_full_key:  state.canvasControls.treeFullKey,
      fullscreen_key: state.canvasControls.fullscreenKey,
    },
    server_sync_enabled: isServerSyncEnabled(designName),
  };
  if (viewState) payload.view_state = viewState;
  const controller = new AbortController();
  _syncControllers[designName] = controller;
  return fetch('/api/save_state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: controller.signal,
  }).then(async response => {
    if (!response.ok) throw new Error(`保存失败 (${response.status})`);
    const result = await response.json();
    // 只有请求期间没有新的本地编辑时，才能清除待同步标记。
    markLocalStateSynced(designName, sentRevision, payload);
    updateServerSyncControls();
    return result;
  }).finally(() => {
    if (_syncControllers[designName] === controller) delete _syncControllers[designName];
  });
}

function updateServerSyncControls() {
  const toggle = $('server-sync-toggle');
  const saveButton = $('btn-save-design-state');
  const designName = state.activeTab;
  const enabled = isServerSyncEnabled(designName);
  if (toggle) {
    toggle.checked = enabled;
    toggle.disabled = !designName;
    toggle.parentElement.title = !designName
      ? '打开设计后可设置实时同步'
      : hasPendingLocalChanges(designName)
        ? '检测到本地未同步修改；开启同步会以当前本地状态写入设计 JSON'
        : '开启时保存当前状态，并将后续编辑写入设计 JSON';
  }
  if (saveButton) saveButton.disabled = !designName;
}

async function setServerSyncEnabled(enabled) {
  const designName = state.activeTab;
  if (!designName) {
    updateServerSyncControls();
    return;
  }

  const previous = isServerSyncEnabled(designName);
  state.serverSyncEnabled[designName] = Boolean(enabled);
  cancelScheduledServerSync(designName);
  updateServerSyncControls();

  try {
    let response;
    if (enabled) {
      // 开启同步时先提交当前内存状态，避免旧服务端布局覆盖尚未手动保存的编辑。
      await syncStateToServer(designName, { force: true });
    } else {
      // 关闭同步只写开关，不能把过期坐标一起写回服务端。
      response = await fetch('/api/save_state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: designName, server_sync_enabled: false }),
      });
    }
    if (!response && enabled) response = { ok: true };
    if (!response.ok) throw new Error(`保存失败 (${response.status})`);
    showToast(
      enabled ? '实时同步已开启' : '实时同步已关闭，后续编辑不会写入 JSON',
      enabled ? 'info' : 'success'
    );
  } catch (error) {
    state.serverSyncEnabled[designName] = previous;
    updateServerSyncControls();
    showToast('同步设置保存失败: ' + error.message, 'error');
  }
}

async function saveCurrentDesignState() {
  const designName = state.activeTab;
  if (!designName) { showToast('没有打开的设计', 'warn'); return; }
  cancelScheduledServerSync(designName);
  try {
    await syncStateToServer(designName, { force: true });
    showToast('已保存到设计 JSON', 'success');
  } catch (error) {
    if (error.name !== 'AbortError') showToast('保存失败: ' + error.message, 'error');
  }
}

// ─── State ──────────────────────────────────────────────────────────────

const state = {
  designs: {},          // designName -> { modules, top_modules, hierarchy }
  openTabs: [],         // [{ name, module }]
  activeTab: null,      // designName
  activeDesign: null,   // currently selected design in sidebar list
  serverSyncEnabled: {}, // 设计名 -> 是否启用实时同步
  expandedModules: {},  // designName -> Set(modName)
  inlineExpanded: {},   // designName -> Set(concrete render paths)
  collapsedState: loadCollapsedState(),   // "modName:side:groupLabel" -> bool (true = expanded)
  // Layout overrides per design: { instName: { x, y, width?, height? } }
  layoutOverrides: {},  // designName -> { instName: {...} }
  // Wire waypoints per design: { wireKey: [{x, y}, ...] }
  wireWaypoints: {},    // designName -> { wireKey: [{x,y},...] }
  // Pan & zoom
  pan: { x: 0, y: 0 },
  zoom: 1,
  autoFitPending: {},  // 设计名 -> 打开后是否需要自动适配画布
  dragging: false,
  dragStart: { x: 0, y: 0 },
  panStart: { x: 0, y: 0 },
  // Interactive editing state
  editMode: null,       // null | 'drag-module' | 'resize-module' | 'drag-waypoint'
  editTarget: null,     // context for current edit operation
  // Clock/reset visibility
  hideClockReset: loadHideClockReset(),
  // Wire selection
  selectedWireKey: null,
  selectedWireSignal: null,   // signal name for the currently selected wire
  // Customizations per design: { modules: {}, wires: {}, commentBlocks: {} }
  customizations: {},
  activeCommentBlockId: null,
  // Settings modal context
  settingsTarget: null,  // { type: 'module'|'wire', key: instName|wireKey }
  // Undo/Redo
  undoStack: [],     // array of { layoutOverrides, wireWaypoints } snapshots
  redoStack: [],
  maxUndoHistory: 50,
  // Guard: set true after drag ends to prevent background click from deselecting
  justFinishedDrag: false,
  // View navigation history (session-only, not persisted to JSON)
  viewHistoryBack: [],   // stack of {name, module} — modules visited before current
  viewHistoryFwd: [],    // stack of {name, module} — modules after current (for redo)
  // Sidebar tree expansion state (separate from canvas expandedModules)
  treeExpanded: {},      // designName -> Set(modName)
  // Box selection state
  boxSelection: null,       // { items: Set<instName>, waypoints: [{wireKey, idx}] } or null
  boxSelecting: false,      // true while rubber-band is active
  boxSelectStart: null,     // { x, y } in design coords
  boxSelectCurrent: null,   // { x, y } in design coords
  // Canvas background color ('transparent' = show default but export transparently)
  canvasBgColor: loadCanvasBgColor(),
  // Keyboard / interaction controls (persisted per-design in JSON)
  canvasControls: {
    wasdStep:    20,   // px per frame for pan/nudge
    zoomKeyIn:   '[',  // key to zoom in
    zoomKeyOut:  ']',  // key to zoom out
    zoomStepPct: 5,    // zoom increment percent per frame
    helpKey:      'h',  // key to toggle shortcut help modal
    fitKey:        'y',  // key to fit-to-view
    sidebarKey:    'c',  // key to collapse/expand sidebar
    treeFullKey:   'x',  // key to toggle tree fullscreen
    fullscreenKey: 'z',  // key to toggle app fullscreen
  },
};

// ─── DOM helpers ────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

function getSVG() { return $('main-svg'); }
function getSVGRoot() { return $('svg-root'); }

// ─── Initialisation ─────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initPanZoom();
  initTreeKeyboardNav();
  initSidebarResize();
  updateServerSyncControls();
  loadDesignList({ restoreLast: true });

  // Update clock/reset toggle button text on load
  const clkBtn = $('btn-toggle-clk-rst');
  if (clkBtn) clkBtn.title = state.hideClockReset ? '显示时钟/复位' : '隐藏时钟/复位';

  // Apply saved canvas background color and sync UI
  applyCanvasBgColor(state.canvasBgColor);
  // Use setCanvasBgColor to sync preset highlight + picker (no-op side effects fine at init)
  // Defer until DOM is fully ready for preset buttons to exist
  setTimeout(() => setCanvasBgColor(state.canvasBgColor), 0);

  // Close comment popup and module-info-popup on canvas click
  const container = $('canvas-container');
  if (container) {
    container.addEventListener('click', e => {
      const commentPopup = $('comment-popup');
      if (commentPopup && commentPopup.style.display !== 'none' && !commentPopup.contains(e.target)) {
        closeCommentPopup();
      }
      const infoPopup = $('module-info-popup');
      if (infoPopup && infoPopup.style.display !== 'none' && !infoPopup.contains(e.target)) {
        closeModuleInfoPopup();
      }
    });
  }

  // Pre-init resize handle so it's ready before first popup open
  const popup = $('comment-popup');
  if (popup) initCommentPopupResize(popup);

  // Path input — enter to analyze
  $('path-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') doAnalyze();
  });

  // Analyze button
  $('btn-analyze').addEventListener('click', doAnalyze);
});

// Make functions available to inline onclick handlers in HTML
window.openFileBrowser = openFileBrowser;
window.closeFileBrowser = closeFileBrowser;
window.fbGoUp = fbGoUp;
window.fbGoHome = fbGoHome;
window.fbNavigateTo = fbNavigateTo;
window.fbSelectCurrentFolder = fbSelectCurrentFolder;
window.fbConfirmSelection = fbConfirmSelection;
window.closeInfoPanel = closeInfoPanel;
window.exportSVG = () => doExport('svg');
window.exportPNG = () => doExportPNG();
window.exportHTML = () => doExport('html');
window.resetLayout = resetLayout;
window.fitView = () => { state.pan = { x: 0, y: 0 }; state.zoom = 1; fitToView(); };
window.toggleClockReset = toggleClockReset;
window.toggleSidebar = toggleSidebar;
window.toggleTreeFullscreen = toggleTreeFullscreen;
window.toggleExportGroup = toggleExportGroup;
window.toggleViewOpsGroup = toggleViewOpsGroup;
window.toggleFullscreen = toggleFullscreen;
window.refreshDesign = refreshDesign;
window.setServerSyncEnabled = setServerSyncEnabled;
window.saveCurrentDesignState = saveCurrentDesignState;
window.openSettingsPanel = openSettingsPanel;
window.closeSettingsModal = closeSettingsModal;
window.applySettings = applySettings;
window.vvSwitchSettingsTab = vvSwitchSettingsTab;
window.vvFilterTable = vvFilterTable;
window.closeCommentPopup = closeCommentPopup;
window.handleCommentFileImport = handleCommentFileImport;
window.setCanvasBgColor = setCanvasBgColor;
window.closeModuleInfoPopup = closeModuleInfoPopup;
window.openSettingsFromInfoPopup = openSettingsFromInfoPopup;
window.openCommentFromInfoPopup = openCommentFromInfoPopup;

/**
 * Apply the canvas background color to the canvas container.
 * 'transparent' shows the default dark background on canvas,
 * but exports with a transparent background.
 */
function applyCanvasBgColor(color) {
  const container = $('canvas-container');
  if (!container) return;
  if (color === 'transparent') {
    // Transparent: show default dark color in canvas, export transparently
    container.style.background = '';
  } else {
    container.style.background = color;
  }
}

/**
 * Change the canvas background color.
 * Pass 'transparent' for transparent export (default dark shown on canvas).
 */
function setCanvasBgColor(color) {
  state.canvasBgColor = color;
  saveCanvasBgColor(color);
  applyCanvasBgColor(color);
  // Update color picker value (skip for transparent)
  const picker = $('canvas-bg-color');
  if (picker && color !== 'transparent') picker.value = color;
  // Update active highlight on preset buttons
  const presetMap = {
    '#0d1117': 'bg-preset-default',
    '#ffffff': 'bg-preset-white',
    '#1c2333': 'bg-preset-gray',
    'transparent': 'bg-preset-transparent',
  };
  ['bg-preset-default','bg-preset-white','bg-preset-gray','bg-preset-transparent'].forEach(id => {
    const btn = $(id);
    if (btn) btn.classList.remove('active');
  });
  const activeId = presetMap[color];
  if (activeId) {
    const btn = $(activeId);
    if (btn) btn.classList.add('active');
  }
}

function toggleClockReset() {
  state.hideClockReset = !state.hideClockReset;
  saveHideClockReset(state.hideClockReset);
  const btn = $('btn-toggle-clk-rst');
  if (btn) btn.title = state.hideClockReset ? '显示时钟/复位' : '隐藏时钟/复位';
  renderCanvas();
}

function resetLayout() {
  const name = state.activeTab;
  if (!name) { showToast('没有打开的设计', 'warn'); return; }
  if (!confirm('确定重置布局？将清除所有模块位置和线路编辑。')) return;
  state.layoutOverrides[name] = {};
  state.wireWaypoints[name] = {};
  saveLayout(name, {});
  saveWireWaypoints(name, {});
  state.pan = { x: 0, y: 0 };
  state.zoom = 1;
  renderCanvas();
  setTimeout(fitToView, 50);
  showToast('布局已重置', 'success');
}

function toggleSidebar() {
  const sidebar = $('sidebar');
  const expandBtn = $('btn-expand-sidebar');
  const willCollapse = !sidebar.classList.contains('collapsed');
  if (willCollapse) {
    // Inline styles from drag-resize override CSS class rules — clear them first
    // so that .collapsed { width: 0; min-width: 0 } can take effect.
    sidebar.dataset.savedWidth = sidebar.style.width;
    sidebar.dataset.savedMinWidth = sidebar.style.minWidth;
    sidebar.style.width = '';
    sidebar.style.minWidth = '';
  }
  const isCollapsed = sidebar.classList.toggle('collapsed');
  if (!isCollapsed) {
    // Restore the custom drag-resized width (if any)
    if (sidebar.dataset.savedWidth) sidebar.style.width = sidebar.dataset.savedWidth;
    if (sidebar.dataset.savedMinWidth) sidebar.style.minWidth = sidebar.dataset.savedMinWidth;
  }
  if (expandBtn) expandBtn.style.display = isCollapsed ? '' : 'none';
  _updateResizeHandlePos();
  if (!isCollapsed) {
    // Sidebar transitions from width:0 — re-position handle after animation ends
    sidebar.addEventListener('transitionend', function onExpand(e) {
      if (e.propertyName !== 'width') return;
      sidebar.removeEventListener('transitionend', onExpand);
      _updateResizeHandlePos();
    });
  }
}

function toggleExportGroup() {
  const panel = $('export-expand-panel');
  if (!panel) return;
  const nowOpen = panel.style.display === 'none' || panel.style.display === '';
  panel.style.display = nowOpen ? 'flex' : 'none';
  const btn = $('btn-export-group');
  if (btn) btn.classList.toggle('ctb-active', nowOpen);
}

function toggleViewOpsGroup() {
  const panel = $('view-ops-panel');
  if (!panel) return;
  const nowOpen = panel.style.display === 'none' || panel.style.display === '';
  panel.style.display = nowOpen ? 'flex' : 'none';
  const btn = $('btn-view-ops');
  if (btn) btn.classList.toggle('ctb-active', nowOpen);
}

function toggleTreeFullscreen() {
  const sidebar = $('sidebar');
  const btn = $('btn-tree-fullscreen');
  if (!sidebar) return;

  const isFullscreen = sidebar.classList.toggle('tree-fullscreen');
  // Hide/show all sections except module-tree-section
  ['sidebar-header'].forEach(id => {
    const el = $(id);
    if (el) el.style.display = isFullscreen ? 'none' : '';
  });
  // sidebar-section elements that are NOT module-tree-section
  sidebar.querySelectorAll('.sidebar-section:not(#module-tree-section)').forEach(el => {
    el.style.display = isFullscreen ? 'none' : '';
  });

  if (btn) { btn.textContent = isFullscreen ? '⊡' : '⛶'; btn.title = isFullscreen ? '恢复' : '全屏'; }
  _updateResizeHandlePos();
}

function _updateResizeHandlePos() {
  const handle = $('sidebar-resize-handle');
  const sidebar = $('sidebar');
  if (!handle || !sidebar) return;
  if (sidebar.classList.contains('collapsed')) {
    handle.style.display = 'none';
    return;
  }
  handle.style.display = '';
  handle.style.left = sidebar.offsetWidth + 'px';
}

function initSidebarResize() {
  const handle = $('sidebar-resize-handle');
  const sidebar = $('sidebar');
  if (!handle || !sidebar) return;

  // Capture the natural CSS width as the minimum (do it after layout).
  // Double-rAF ensures layout is fully computed before reading offsetWidth.
  let naturalMinWidth = 0;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    naturalMinWidth = sidebar.offsetWidth;
    _updateResizeHandlePos();
  }));

  // Also update once the full page load is done (images, fonts, etc.)
  window.addEventListener('load', _updateResizeHandlePos, { once: true });

  let resizing = false;
  let startX = 0;
  let startWidth = 0;

  handle.addEventListener('mousedown', (e) => {
    resizing = true;
    startX = e.clientX;
    startWidth = sidebar.offsetWidth;
    handle.classList.add('dragging');
    sidebar.classList.add('resizing');
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    const dx = e.clientX - startX;
    const minW = naturalMinWidth || 240;
    const maxW = window.innerWidth - 200;
    const newW = Math.max(minW, Math.min(maxW, startWidth + dx));
    sidebar.style.width = newW + 'px';
    sidebar.style.minWidth = newW + 'px';
    handle.style.left = newW + 'px';
  });

  window.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = false;
    handle.classList.remove('dragging');
    sidebar.classList.remove('resizing');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  // Keep resize handle aligned when viewport resizes
  window.addEventListener('resize', () => _updateResizeHandlePos());
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
}

function clonePersistedValue(value) {
  if (value === undefined) return undefined;
  try { return JSON.parse(JSON.stringify(value)); }
  catch (e) { return value; }
}

function captureRefreshState(designName) {
  const sidebar = $('sidebar');
  const viewState = state.activeTab === designName && state.pan
    ? { pan: { ...state.pan }, zoom: state.zoom }
    : loadViewState(designName);
  return {
    layout: clonePersistedValue(state.layoutOverrides?.[designName] || {}),
    wire_waypoints: clonePersistedValue(state.wireWaypoints?.[designName] || {}),
    view_state: clonePersistedValue(viewState),
    customizations: clonePersistedValue(
      normalizeCustomizations(state.customizations?.[designName] || {})
    ),
    inline_expanded_paths: state.inlineExpanded?.[designName]
      ? [...state.inlineExpanded[designName]]
      : [],
    tree_expanded: state.treeExpanded?.[designName]
      ? [...state.treeExpanded[designName]]
      : undefined,
    sidebar_ui: sidebar ? {
      collapsed: sidebar.classList.contains('collapsed'),
      tree_fullscreen: sidebar.classList.contains('tree-fullscreen'),
      width: sidebar.dataset.savedWidth
        || (sidebar.classList.contains('collapsed') ? null : sidebar.style.width)
        || null,
    } : undefined,
    canvas_controls: {
      wasd_step:      state.canvasControls.wasdStep,
      zoom_key_in:    state.canvasControls.zoomKeyIn,
      zoom_key_out:   state.canvasControls.zoomKeyOut,
      zoom_step_pct:  state.canvasControls.zoomStepPct,
      help_key:       state.canvasControls.helpKey,
      fit_key:        state.canvasControls.fitKey,
      sidebar_key:    state.canvasControls.sidebarKey,
      tree_full_key:  state.canvasControls.treeFullKey,
      fullscreen_key: state.canvasControls.fullscreenKey,
    },
    server_sync_enabled: isServerSyncEnabled(designName),
  };
}

async function refreshDesign() {
  const name = state.activeTab;
  if (!name) { showToast('没有打开的设计', 'warn'); return; }
  const refreshState = captureRefreshState(name);
  cancelScheduledServerSync(name);
  showToast(`正在刷新 ${name}...`, 'info');
  try {
    const res = await fetch('/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (data.error) { showToast('刷新失败: ' + data.error, 'error'); return; }
    // 重新解析只更新 RTL 数据，当前内存中的布局和视图状态必须原样保留。
    await openDesign(data.saved_as || name, { refreshState });
    showToast(`已刷新: ${name}`, 'success');
  } catch (err) {
    showToast('刷新失败: ' + err.message, 'error');
  }
}

// ─── File Browser ───────────────────────────────────────────────────────

let fbCurrentPath = '/';
let fbSelectedPath = '';

function openFileBrowser() {
  $('fb-overlay').style.display = 'flex';
  const current = $('path-input').value.trim();
  if (current) {
    const parts = current.replace(/\/$/, '').split('/');
    parts.pop();
    fbCurrentPath = parts.join('/') || '/';
  } else {
    fbCurrentPath = '/home';
  }
  fbSelectedPath = '';
  $('fb-selected-path').textContent = '（无）';
  $('fb-btn-confirm').disabled = true;
  fbNavigateTo(fbCurrentPath);
}

function closeFileBrowser() {
  $('fb-overlay').style.display = 'none';
}

async function fbNavigateTo(dirPath) {
  if (typeof dirPath !== 'string') dirPath = fbCurrentPath;
  dirPath = dirPath.trim();
  if (!dirPath) dirPath = '/';
  fbCurrentPath = dirPath;
  $('fb-path-input').value = dirPath;
  updateBreadcrumb(dirPath);

  try {
    const res = await fetch('/api/browse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: dirPath }),
    });
    const data = await res.json();
    if (data.error) {
      showToast('浏览失败: ' + data.error, 'error');
      return;
    }
    fbCurrentPath = data.current;
    $('fb-path-input').value = data.current;
    updateBreadcrumb(data.current);
    renderFileList(data.entries, data.current);
  } catch (err) {
    showToast('请求失败: ' + err.message, 'error');
  }
}

function updateBreadcrumb(dirPath) {
  const bc = $('fb-breadcrumb');
  bc.innerHTML = '';
  const parts = dirPath.split('/').filter(Boolean);
  let acc = '';

  const rootSpan = document.createElement('span');
  rootSpan.className = 'fb-crumb';
  rootSpan.textContent = '🏠 /';
  rootSpan.addEventListener('click', () => fbNavigateTo('/'));
  bc.appendChild(rootSpan);

  parts.forEach(part => {
    acc += '/' + part;
    const sep = document.createElement('span');
    sep.className = 'fb-crumb-sep';
    sep.textContent = ' / ';
    bc.appendChild(sep);

    const btn = document.createElement('span');
    btn.className = 'fb-crumb';
    btn.textContent = part;
    const target = acc;
    btn.addEventListener('click', () => fbNavigateTo(target));
    bc.appendChild(btn);
  });
}

function renderFileList(entries, currentPath) {
  const list = $('fb-file-list');
  list.innerHTML = '';

  // Parent directory entry
  if (currentPath !== '/') {
    const parentPath = currentPath.replace(/\/[^/]+\/?$/, '') || '/';
    const row = document.createElement('div');
    row.className = 'fb-entry';
    row.innerHTML = `<span class="fb-icon">📁</span><span class="fb-name">..</span>`;
    row.addEventListener('click', () => fbNavigateTo(parentPath));
    list.appendChild(row);
  }

  entries.forEach(entry => {
    const row = document.createElement('div');
    row.className = 'fb-entry';

    let icon = '📄';
    let badge = '';
    if (entry.is_dir) {
      icon = '📁';
      if (entry.has_verilog) badge = '<span class="fb-badge verilog">V</span>';
    } else if (entry.is_verilog) {
      icon = '📝';
    }

    row.innerHTML = `<span class="fb-icon">${icon}</span><span class="fb-name">${entry.name}</span>${badge}`;
    const fullPath = currentPath.replace(/\/$/, '') + '/' + entry.name;

    if (entry.is_dir) {
      row.addEventListener('dblclick', () => fbNavigateTo(fullPath));
      row.addEventListener('click', () => fbSelectEntry(fullPath, row));
    } else {
      row.addEventListener('click', () => fbSelectEntry(fullPath, row));
      row.addEventListener('dblclick', () => {
        fbSelectEntry(fullPath, row);
        fbConfirmSelection();
      });
    }

    list.appendChild(row);
  });
}

function fbSelectEntry(path, rowEl) {
  fbSelectedPath = path;
  $('fb-selected-path').textContent = path;
  $('fb-btn-confirm').disabled = false;

  // Highlight
  document.querySelectorAll('#fb-file-list .fb-entry.selected').forEach(el => el.classList.remove('selected'));
  if (rowEl) rowEl.classList.add('selected');
}

function fbSelectCurrentFolder() {
  fbSelectedPath = fbCurrentPath;
  $('fb-selected-path').textContent = fbCurrentPath;
  $('fb-btn-confirm').disabled = false;
}

function fbConfirmSelection() {
  if (!fbSelectedPath) return;
  $('path-input').value = fbSelectedPath;
  closeFileBrowser();
  doAnalyze();
}

function fbGoUp() {
  const parent = fbCurrentPath.replace(/\/[^/]+\/?$/, '') || '/';
  fbNavigateTo(parent);
}

function fbGoHome() {
  fbNavigateTo('/home');
}

// ─── Design Management ──────────────────────────────────────────────────

async function doAnalyze() {
  const path = $('path-input').value.trim();
  if (!path) { showToast('请先选择文件或文件夹', 'warn'); return; }

  const status = $('analyze-status');
  status.className = 'status-msg loading';
  status.textContent = '正在分析...';

  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    const data = await res.json();
    if (data.error) {
      status.className = 'status-msg error';
      status.textContent = '分析失败: ' + data.error;
      return;
    }
    status.className = 'status-msg success';
    status.textContent = data.analysis_notice
      ? `✓ ${data.saved_as}（${data.analysis_notice}）`
      : `✓ ${data.saved_as}`;
    await loadDesignList();
    openDesign(data.saved_as);
  } catch (err) {
    status.className = 'status-msg error';
    status.textContent = '分析失败: ' + err.message;
  }
}

async function loadDesignList({ restoreLast = false } = {}) {
  try {
    const res = await fetch('/api/designs');
    const designs = await res.json();  // array of { name, top_modules, module_count, source_path }
    const listDiv = $('design-list');
    listDiv.innerHTML = '';

    if (!designs || designs.length === 0) {
      listDiv.innerHTML = '<div style="color:#484f58;font-size:12px;padding:8px;">暂无设计</div>';
      return;
    }

    designs.forEach(d => {
      const item = document.createElement('div');
      item.className = 'design-item' + (d.name === state.activeDesign ? ' active' : '');
      item.innerHTML = `
        <span class="name">${d.name}</span>
        <span style="color:#484f58;font-size:11px;">${d.module_count}m</span>
        <span class="actions">
          <button title="重命名" data-action="rename">✏️</button>
          <button title="删除" data-action="delete">🗑</button>
        </span>`;
      item.querySelector('.name').addEventListener('click', () => openDesign(d.name));
      item.querySelector('[data-action="rename"]').addEventListener('click', e => {
        e.stopPropagation();
        renameDesign(d.name);
      });
      item.querySelector('[data-action="delete"]').addEventListener('click', e => {
        e.stopPropagation();
        deleteDesign(d.name);
      });
      listDiv.appendChild(item);
    });

    // 启动时恢复最近打开的设计；设计已被删除时清理过期指针。
    if (restoreLast && !state.activeTab) {
      const lastDesign = loadLastDesign();
      if (lastDesign && designs.some(design => design.name === lastDesign)) {
        await openDesign(lastDesign);
      } else if (lastDesign && designs.length > 0) {
        clearLastDesign();
      }
    }
  } catch (err) {
    console.error('Failed to load designs', err);
  }
}

function nextFrame() {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function runWhenIdle(fn, timeout = 1200) {
  if ('requestIdleCallback' in window) {
    requestIdleCallback(fn, { timeout });
  } else {
    setTimeout(fn, 250);
  }
}

let _fitToViewTimer = null;
function scheduleFitToView(delay = 300) {
  clearTimeout(_fitToViewTimer);
  _fitToViewTimer = setTimeout(() => {
    runWhenIdle(() => {
      if (!state.dragging && !state.editMode) fitToView();
    }, 1500);
  }, delay);
}

function ensureLoadProgressEl() {
  let overlay = $('load-progress-overlay');
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.id = 'load-progress-overlay';
  overlay.innerHTML = `
    <div class="load-progress-card">
      <div class="load-progress-title" id="load-progress-title"></div>
      <div class="load-progress-message" id="load-progress-message"></div>
      <div class="load-progress-track"><div class="load-progress-bar" id="load-progress-bar"></div></div>
      <div class="load-progress-percent" id="load-progress-percent">0%</div>
    </div>`;
  document.body.appendChild(overlay);
  return overlay;
}

function showLoadProgress(title, pct = 0, message = '') {
  const overlay = ensureLoadProgressEl();
  overlay.style.display = 'flex';
  $('load-progress-title').textContent = title || '加载中';
  updateLoadProgress(pct, message);
}

function updateLoadProgress(pct, message) {
  const overlay = ensureLoadProgressEl();
  if (overlay.style.display === 'none') overlay.style.display = 'flex';
  const safePct = Math.max(0, Math.min(100, Math.round(pct)));
  const bar = $('load-progress-bar');
  const percent = $('load-progress-percent');
  const msg = $('load-progress-message');
  if (bar) bar.style.width = safePct + '%';
  if (percent) percent.textContent = safePct + '%';
  if (msg && message != null) msg.textContent = message;
}

function hideLoadProgress() {
  const overlay = $('load-progress-overlay');
  if (overlay) overlay.style.display = 'none';
}

async function openDesign(name, { refreshState = null } = {}) {
  showToast(`加载 ${name}...`, 'info');
  showLoadProgress(`加载 ${name}`, 4, '获取设计 JSON...');
  await nextFrame();
  try {
    updateLoadProgress(8, '正在下载设计 JSON...');
    const res = await fetch(`/api/design/${name}`);
    updateLoadProgress(18, '正在解析设计数据...');
    await nextFrame();
    let data = await res.json();
    if (data.error) { hideLoadProgress(); showToast('加载失败: ' + data.error, 'error'); return; }
    const localResolution = resolveLocalPersistedState(name, data);
    if (localResolution.usedLocalFields.length > 0) {
      // 本地缓存有未同步编辑时，只覆盖对应字段，避免远端旧状态吞掉本地调整。
      data = {
        ...data,
        layout: localResolution.state.layout,
        wire_waypoints: localResolution.state.wire_waypoints,
        view_state: localResolution.state.view_state,
        customizations: localResolution.state.customizations,
        inline_expanded_paths: localResolution.state.inline_expanded_paths,
      };
    }
    if (refreshState) {
      // 刷新设计不等同于重新打开：模块定义可以来自新 RTL，但 UI 状态来自刷新前的画布。
      [
        'layout', 'wire_waypoints', 'view_state', 'customizations',
        'inline_expanded_paths', 'tree_expanded', 'sidebar_ui',
        'canvas_controls', 'server_sync_enabled',
      ].forEach(field => {
        if (refreshState[field] !== undefined) {
          data[field] = clonePersistedValue(refreshState[field]);
        }
      });
    }
    const moduleCount = Object.keys(data.modules || {}).length;
    const instCount = Object.values(data.modules || {}).reduce((sum, mod) => sum + (mod.instances?.length || 0), 0);
    updateLoadProgress(26, `读取完成：${moduleCount} 个模块，${instCount} 个实例`);
    await nextFrame();

    state.designs[name] = data;
    state.activeDesign = name;
    state.serverSyncEnabled[name] = data.server_sync_enabled !== false;
    if (!state.expandedModules[name]) {
      state.expandedModules[name] = new Set();
    }
    state.inlineExpanded[name] = new Set(
      Array.isArray(data.inline_expanded_paths) ? data.inline_expanded_paths : []
    );
    saveInlineExpanded(name, state.inlineExpanded[name], { sync: false, dirty: false });

    // Select first top module to expand (canvas view)
    if (data.top_modules && data.top_modules.length > 0) {
      state.expandedModules[name].add(data.top_modules[0]);
    }

    // Initialize sidebar tree expansion: load from server JSON, or pre-expand all modules with instances
    updateLoadProgress(36, `初始化模块树：${moduleCount} 个模块`);
    if (!state.treeExpanded[name]) {
      if (data.tree_expanded && Array.isArray(data.tree_expanded)) {
        state.treeExpanded[name] = new Set(data.tree_expanded);
      } else {
        state.treeExpanded[name] = new Set();
        for (const [modName, mod] of Object.entries(data.modules)) {
          if (mod.instances && mod.instances.length > 0) {
            state.treeExpanded[name].add(modName);
          }
        }
      }
    }

    // 服务端是默认来源；本地有待同步字段时，resolveLocalPersistedState 已提前保留本地值。
    updateLoadProgress(48, '恢复布局、连线和注释块...');
    const serverLayout = data.layout || {};
    const localLayout = loadLayout(name);
    const hasServerLayout = Object.keys(serverLayout).length > 0;
    if (hasServerLayout) {
      state.layoutOverrides[name] = serverLayout;
      saveLayout(name, state.layoutOverrides[name], { sync: false });
    } else if (Object.keys(localLayout).length > 0) {
      state.layoutOverrides[name] = localLayout;
    } else {
      state.layoutOverrides[name] = {};
    }

    // 恢复已展开的内联模块时，先为其子实例固定初始坐标，避免首次拉伸触发自动重排。
    for (const renderPath of [...state.inlineExpanded[name]].sort((left, right) => (
      left.split('/').length - right.split('/').length
    ))) {
      const moduleName = moduleNameForRenderPath(name, renderPath);
      if (moduleName) ensureModuleLayout(name, moduleName, { sync: false });
    }

    const serverWaypoints = data.wire_waypoints || {};
    const localWaypoints = loadWireWaypoints(name);
    const hasServerWp = Object.keys(serverWaypoints).length > 0;
    if (hasServerWp) {
      state.wireWaypoints[name] = serverWaypoints;
      saveWireWaypoints(name, state.wireWaypoints[name], { sync: false });
    } else if (Object.keys(localWaypoints).length > 0) {
      state.wireWaypoints[name] = localWaypoints;
    } else {
      state.wireWaypoints[name] = {};
    }
    // customizations 与布局使用同一套本地优先规则，避免旧缓存覆盖当前设计。
    const serverCustom = normalizeCustomizations(data.customizations || {});
    const localCustom = loadCustomizations(name);
    const hasServer = Object.keys(serverCustom.modules || {}).length > 0
      || Object.keys(serverCustom.wires || {}).length > 0
      || Object.keys(serverCustom.commentBlocks || {}).length > 0;
    const hasLocal = Object.keys(localCustom.modules || {}).length > 0
      || Object.keys(localCustom.wires || {}).length > 0
      || Object.keys(localCustom.commentBlocks || {}).length > 0;
    if (hasServer) {
      state.customizations[name] = serverCustom;
      saveCustomizations(name, state.customizations[name], { dirty: false });
    } else if (hasLocal) {
      state.customizations[name] = localCustom;
    } else {
      state.customizations[name] = normalizeCustomizations({});
    }

    // Pre-populate layout overrides for any module not yet positioned, so that
    // dragging one module never causes other unpositioned modules to jump around.
    updateLoadProgress(62, `计算模块位置：${instCount} 个实例`);
    await nextFrame();
    const topModName = data.top_modules?.[0] || Object.keys(data.modules)[0];
    if (topModName && typeof computeInitialLayout === 'function') {
      const initial = computeInitialLayout(
        topModName, data.modules, state.collapsedState,
        state.layoutOverrides[name], state.hideClockReset
      );
      let added = false;
      for (const [key, pos] of Object.entries(initial)) {
        const existing = state.layoutOverrides[name][key] || {};
        if (existing.x === undefined || existing.y === undefined) {
          state.layoutOverrides[name][key] = { ...existing, ...pos };
          added = true;
        }
      }
      if (added) saveLayout(name, state.layoutOverrides[name], { sync: false });
    }

    // 没有本地待同步视图时才使用 JSON 中的视图状态。
    const savedView = data.view_state || null;
    state.autoFitPending[name] = !savedView;
    if (savedView) {
      state.pan = savedView.pan;
      state.zoom = savedView.zoom;
      saveViewState(name, savedView, { sync: false });
    } else {
      state.pan = { x: 0, y: 0 };
      state.zoom = 1;
    }

    // 记录本次打开看到的服务端快照；本地待同步字段保留原基线，后续仍优先本地。
    recordLocalServerSnapshot(name, {
      layout: state.layoutOverrides[name],
      wire_waypoints: state.wireWaypoints[name],
      view_state: data.view_state || null,
      customizations: state.customizations[name],
      inline_expanded_paths: [...state.inlineExpanded[name]],
    }, { serverLayoutRevision: localResolution.serverLayoutRevision });

    // Add tab
    if (!state.openTabs.find(t => t.name === name)) {
      state.openTabs.push({ name, module: data.top_modules?.[0] || Object.keys(data.modules)[0] });
    }
    state.activeTab = name;
    saveLastDesign(name);
    updateServerSyncControls();

    // Show sections
    updateLoadProgress(74, '渲染模块树...');
    await nextFrame();
    $('module-tree-section').style.display = '';
    const expSec = $('export-section'); if (expSec) expSec.style.display = '';
    $('welcome-screen').style.display = 'none';
    getSVG().style.display = '';

    renderTabs();
    renderSidebar(name);
    updateLoadProgress(86, `渲染画布：${moduleCount} 个模块`);
    await nextFrame();
    renderCanvas();
    updateLoadProgress(96, '完成画布初始化...');
    await nextFrame();
    loadDesignList();  // update highlight

    // Restore sidebar UI state from JSON
    const sui = data.sidebar_ui;
    if (sui) {
      const sb = $('sidebar');
      if (sb) {
        // Apply width without transition so handle pos can be read immediately
        if (sui.width) {
          sb.classList.add('resizing');   // disables transition
          sb.style.width    = sui.width;
          sb.style.minWidth = sui.width;
          void sb.offsetWidth;            // force reflow
          sb.classList.remove('resizing');
        }
        if (sui.collapsed && !sb.classList.contains('collapsed')) toggleSidebar();
        else if (!sui.collapsed && sb.classList.contains('collapsed')) toggleSidebar();
        if (sui.tree_fullscreen !== sb.classList.contains('tree-fullscreen')) toggleTreeFullscreen();
        _updateResizeHandlePos();
      }
    }

    // Restore canvas controls from JSON
    const cc = data.canvas_controls;
    if (cc) {
      if (cc.wasd_step     != null) state.canvasControls.wasdStep    = cc.wasd_step;
      if (cc.zoom_key_in   != null) state.canvasControls.zoomKeyIn   = cc.zoom_key_in;
      if (cc.zoom_key_out  != null) state.canvasControls.zoomKeyOut  = cc.zoom_key_out;
      if (cc.zoom_step_pct != null) state.canvasControls.zoomStepPct = cc.zoom_step_pct;
      if (cc.help_key      != null) state.canvasControls.helpKey     = cc.help_key;
      if (cc.fit_key       != null) state.canvasControls.fitKey      = cc.fit_key;
      if (cc.sidebar_key    != null) state.canvasControls.sidebarKey    = cc.sidebar_key;
      if (cc.tree_full_key  != null) state.canvasControls.treeFullKey   = cc.tree_full_key;
      if (cc.fullscreen_key != null) state.canvasControls.fullscreenKey = cc.fullscreen_key;
    }

    updateLoadProgress(100, '加载完成');
    setTimeout(hideLoadProgress, 250);
    showToast(
      localResolution.usedLocalFields.length > 0
        ? `已加载: ${name}（已优先恢复本地未同步修改）`
        : `已加载: ${name}`,
      localResolution.usedLocalFields.length > 0 ? 'info' : 'success'
    );
  } catch (err) {
    hideLoadProgress();
    showToast('加载失败: ' + err.message, 'error');
  }
}

async function renameDesign(oldName) {
  if (!oldName) return;
  const newName = prompt(`将 "${oldName}" 重命名为：`, oldName);
  if (!newName || newName.trim() === oldName) return;
  const trimmed = newName.trim();
  cancelScheduledServerSync(oldName);
  try {
    const res = await fetch('/api/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ old_name: oldName, new_name: trimmed }),
    });
    const data = await res.json();
    if (data.error) { showToast('重命名失败: ' + data.error, 'error'); return; }
    // ── Migrate all localStorage keys from oldName → trimmed ──
    const lsKeys = [
      [STORAGE_KEY_PREFIX,        loadLayout,           saveLayout          ],
      [STORAGE_WIRE_KEY_PREFIX,   loadWireWaypoints,    saveWireWaypoints   ],
      [STORAGE_VIEW_KEY_PREFIX,   loadViewState,        saveViewState       ],
      [STORAGE_CUSTOM_PREFIX,     loadCustomizations,   saveCustomizations  ],
    ];
    state.serverSyncEnabled[trimmed] = isServerSyncEnabled(oldName);
    delete state.serverSyncEnabled[oldName];
    lsKeys.forEach(([, loader, saver]) => {
      const val = loader(oldName);
      if (val && Object.keys(val).length > 0) {
        saver(trimmed, val, { sync: false, dirty: false });
      }
      try { localStorage.removeItem(STORAGE_KEY_PREFIX.replace(/layout/, lsKeys[0][0]) + oldName); } catch(e) {}
    });
    const inlinePaths = loadInlineExpanded(oldName);
    if (inlinePaths.size > 0) {
      saveInlineExpanded(trimmed, inlinePaths, { sync: false, dirty: false });
    }
    const localMeta = readLocalJson(STORAGE_LOCAL_META_PREFIX + oldName);
    if (localMeta.present) {
      try {
        localStorage.setItem(STORAGE_LOCAL_META_PREFIX + trimmed, JSON.stringify(localMeta.value));
      } catch (e) {}
    }
    // Remove old keys explicitly
    [STORAGE_KEY_PREFIX, STORAGE_WIRE_KEY_PREFIX, STORAGE_VIEW_KEY_PREFIX, STORAGE_CUSTOM_PREFIX,
      STORAGE_INLINE_EXPANDED_KEY_PREFIX, STORAGE_LOCAL_META_PREFIX].forEach(pfx => {
      try { localStorage.removeItem(pfx + oldName); } catch(e) {}
    });
    // Update in-memory state
    if (state.designs[oldName]) {
      state.designs[trimmed] = state.designs[oldName];
      delete state.designs[oldName];
    }
    if (state.layoutOverrides[oldName]) {
      state.layoutOverrides[trimmed] = state.layoutOverrides[oldName];
      delete state.layoutOverrides[oldName];
    }
    if (state.wireWaypoints[oldName]) {
      state.wireWaypoints[trimmed] = state.wireWaypoints[oldName];
      delete state.wireWaypoints[oldName];
    }
    if (state.customizations[oldName]) {
      state.customizations[trimmed] = state.customizations[oldName];
      delete state.customizations[oldName];
    }
    if (state.inlineExpanded[oldName]) {
      state.inlineExpanded[trimmed] = state.inlineExpanded[oldName];
      delete state.inlineExpanded[oldName];
    }
    state.openTabs = state.openTabs.map(t => t.name === oldName ? { ...t, name: trimmed } : t);
    if (state.activeTab === oldName) state.activeTab = trimmed;
    if (state.activeDesign === oldName) state.activeDesign = trimmed;
    if (loadLastDesign() === oldName) saveLastDesign(trimmed);
    if (state.expandedModules[oldName]) {
      state.expandedModules[trimmed] = state.expandedModules[oldName];
      delete state.expandedModules[oldName];
    }
    renderTabs();
    loadDesignList();
    renderCanvas();
    showToast(`已重命名: ${trimmed}`, 'success');
  } catch (err) {
    showToast('重命名失败: ' + err.message, 'error');
  }
}

async function deleteDesign(name) {
  if (!name) return;
  if (!confirm(`确定删除 "${name}"?`)) return;
  try {
    cancelScheduledServerSync(name);
    await fetch(`/api/delete/${name}`, { method: 'DELETE' });
    delete state.designs[name];
    delete state.expandedModules[name];
    delete state.inlineExpanded[name];
    delete state.layoutOverrides[name];
    delete state.wireWaypoints[name];
    delete state.customizations[name];
    delete state.treeExpanded[name];
    delete state.serverSyncEnabled[name];
    [
      STORAGE_KEY_PREFIX,
      STORAGE_WIRE_KEY_PREFIX,
      STORAGE_VIEW_KEY_PREFIX,
      STORAGE_CUSTOM_PREFIX,
      STORAGE_INLINE_EXPANDED_KEY_PREFIX,
      STORAGE_LOCAL_META_PREFIX,
    ].forEach(prefix => {
      try { localStorage.removeItem(prefix + name); } catch (e) {}
    });
    state.openTabs = state.openTabs.filter(t => t.name !== name);
    if (state.activeTab === name) {
      state.activeTab = state.openTabs[0]?.name || null;
      state.activeDesign = state.activeTab;
      if (state.activeTab) saveLastDesign(state.activeTab);
      else clearLastDesign();
    }
    renderTabs();
    loadDesignList();
    renderCanvas();
    if (!state.activeTab) {
      $('welcome-screen').style.display = '';
      getSVG().style.display = 'none';
      $('module-tree-section').style.display = 'none';
      const expSec2 = $('export-section'); if (expSec2) expSec2.style.display = 'none';
    }
    showToast(`已删除: ${name}`, 'success');
  } catch (err) {
    showToast('删除失败: ' + err.message, 'error');
  }
}

// ─── Tabs ───────────────────────────────────────────────────────────────

function renderTabs() {
  updateServerSyncControls();
  const bar = $('tab-bar');
  bar.innerHTML = '';
  state.openTabs.forEach(tab => {
    const div = document.createElement('div');
    div.className = 'tab' + (tab.name === state.activeTab ? ' active' : '');
    div.innerHTML = `<span>${tab.name}</span><span class="close-tab">&times;</span>`;
    div.querySelector('span:first-child').addEventListener('click', () => {
      state.activeTab = tab.name;
      state.activeDesign = tab.name;
      saveLastDesign(tab.name);
      renderTabs();
      renderSidebar(tab.name);
      renderCanvas();
    });
    div.querySelector('.close-tab').addEventListener('click', e => {
      e.stopPropagation();
      state.openTabs = state.openTabs.filter(t => t.name !== tab.name);
      if (state.activeTab === tab.name) {
        state.activeTab = state.openTabs[0]?.name || null;
        state.activeDesign = state.activeTab;
        if (state.activeTab) saveLastDesign(state.activeTab);
        else clearLastDesign();
      }
      renderTabs();
      renderCanvas();
      if (!state.activeTab) {
        $('welcome-screen').style.display = '';
        getSVG().style.display = 'none';
      }
    });
    bar.appendChild(div);
  });
}

// ─── Sidebar: Module Tree ───────────────────────────────────────────────

/**
 * Find the parent module that contains childModName as an instance.
 * Returns the module name of the parent, or null if not found.
 */
function findParentModule(designName, childModName) {
  const design = state.designs[designName];
  if (!design) return null;
  for (const [modName, mod] of Object.entries(design.modules)) {
    if (mod.instances?.some(inst => inst.module_type === childModName)) {
      return modName;
    }
  }
  return null;
}

/**
 * Build the ancestor path from the top module to `targetMod` within a design.
 * Returns an array [top, ..., parentOfTarget, targetMod], or [targetMod] if no parent.
 */
function buildModulePath(designName, targetMod) {
  const design = state.designs[designName];
  if (!design) return [targetMod];
  // Walk up the parent chain
  const path = [];
  let cur = targetMod;
  const visited = new Set();
  while (cur && !visited.has(cur)) {
    path.unshift(cur);
    visited.add(cur);
    cur = findParentModule(designName, cur);
  }
  return path;
}

/**
 * Ensure initial layout positions are computed for a module's direct instances.
 * Only fills in positions for instances not yet in layoutOverrides.
 */
function ensureModuleLayout(designName, modName, { sync = true } = {}) {
  const design = state.designs[designName];
  if (!design) return;
  if (typeof computeInitialLayout !== 'function') return;
  const initial = computeInitialLayout(
    modName, design.modules, state.collapsedState,
    state.layoutOverrides[designName], state.hideClockReset
  );
  let added = false;
  for (const [key, pos] of Object.entries(initial)) {
    const existing = state.layoutOverrides[designName][key] || {};
    if (existing.x === undefined || existing.y === undefined) {
      state.layoutOverrides[designName][key] = { ...existing, ...pos };
      added = true;
    }
  }
  if (added) saveLayout(designName, state.layoutOverrides[designName], { sync });
}

/**
 * Push the current module view to the navigation history stack.
 * Call this BEFORE changing tab.module.
 */
function pushViewHistory(designName, currentModule) {
  state.viewHistoryBack.push({ name: designName, module: currentModule });
  state.viewHistoryFwd = []; // new navigation clears forward history
  updateNavButtons();
}

/** Navigate to a module view and push the source view to history. */
function navigateToModuleView(designName, modName) {
  const tab = state.openTabs.find(t => t.name === designName);
  if (!tab) return;
  const prev = tab.module;
  if (prev === modName) return;
  pushViewHistory(designName, prev);
  _gotoModuleView(designName, modName);
}

/**
 * Internal: navigate to a module without touching history stacks.
 * Used by viewHistoryBack / viewHistoryForward.
 */
function _gotoModuleView(designName, modName) {
  const tab = state.openTabs.find(t => t.name === designName);
  if (!tab) return;
  tab.module = modName;
  if (!state.expandedModules[designName]) state.expandedModules[designName] = new Set();
  const moduleDef = state.designs[designName]?.modules?.[modName];
  if (moduleDef?.instances?.length) {
    state.expandedModules[designName].add(modName);
  } else {
    state.expandedModules[designName].delete(modName);
  }
  ensureModuleLayout(designName, modName);
  if (designName !== state.activeTab) {
    state.activeTab = designName;
    renderTabs();
  }
  renderSidebar(designName);
  renderCanvas();
  setTimeout(() => fitToView(), 50);
}

function viewHistoryBack() {
  if (!state.viewHistoryBack.length) return;
  // Save current view to forward stack
  const tab = state.openTabs.find(t => t.name === state.activeTab);
  if (tab) state.viewHistoryFwd.push({ name: tab.name, module: tab.module });
  const entry = state.viewHistoryBack.pop();
  _gotoModuleView(entry.name, entry.module);
  updateNavButtons();
}

function viewHistoryForward() {
  if (!state.viewHistoryFwd.length) return;
  // Save current view to back stack
  const tab = state.openTabs.find(t => t.name === state.activeTab);
  if (tab) state.viewHistoryBack.push({ name: tab.name, module: tab.module });
  const entry = state.viewHistoryFwd.pop();
  _gotoModuleView(entry.name, entry.module);
  updateNavButtons();
}

function viewHistoryUp() {
  if (!state.activeTab) return;
  const tab = state.openTabs.find(t => t.name === state.activeTab);
  if (!tab) return;
  const parent = findParentModule(state.activeTab, tab.module);
  if (!parent) { showToast('已是顶层模块', 'info'); return; }
  navigateToModuleView(state.activeTab, parent);
}

/** Update enabled/disabled state of nav buttons. */
function updateNavButtons() {
  const navBar = $('view-nav-bar');
  const btnBack = $('btn-nav-back');
  const btnFwd = $('btn-nav-fwd');
  const btnUp = $('btn-nav-up');
  if (!state.activeTab) {
    if (navBar) navBar.style.display = 'none';
    return;
  }
  if (navBar) navBar.style.display = '';
  if (btnBack) btnBack.disabled = state.viewHistoryBack.length === 0;
  if (btnFwd) btnFwd.disabled = state.viewHistoryFwd.length === 0;
  if (btnUp) {
    const tab = state.openTabs.find(t => t.name === state.activeTab);
    const hasParent = tab ? !!findParentModule(state.activeTab, tab.module) : false;
    btnUp.disabled = !hasParent;
  }
  // Update module breadcrumb
  updateModuleBreadcrumb();
}

/** Update the module path breadcrumb (canvas overlay). */
function updateModuleBreadcrumb() {
  const el = $('module-breadcrumb');
  if (!el || !state.activeTab) { if (el) el.textContent = ''; return; }
  const tab = state.openTabs.find(t => t.name === state.activeTab);
  if (!tab) { el.textContent = ''; return; }
  const path = buildModulePath(state.activeTab, tab.module);
  el.innerHTML = path.map((m, i) => {
    if (i < path.length - 1) {
      return `<span class="breadcrumb-link" onclick="navigateToModuleView('${state.activeTab}', '${m}')">${m}</span>`;
    }
    return `<span class="breadcrumb-current">${m}</span>`;
  }).join('<span class="breadcrumb-sep"> › </span>');
}

let _treeSingleClickTimer = null;
let _treeHighlightTimer = null;

function focusCanvasModuleBox(box) {
  if (!box) return false;
  const bbox = box.getBBox();
  const offset = getNestedSvgOffset(box);
  const centerX = offset.x + bbox.x + bbox.width / 2;
  const centerY = offset.y + bbox.y + bbox.height / 2;
  const container = $('canvas-container');
  if (!container) return false;

  state.zoom = Math.min(Math.max(state.zoom, 0.5), 2);
  state.pan.x = container.clientWidth / 2 - centerX * state.zoom;
  state.pan.y = container.clientHeight / 2 - centerY * state.zoom;
  applyTransform();
  if (state.activeTab) {
    saveViewState(state.activeTab, { pan: { ...state.pan }, zoom: state.zoom });
  }

  box.classList.add('highlighted');
  box.style.transition = 'filter 0.3s';
  box.style.filter = 'brightness(1.5) drop-shadow(0 0 10px #ffeb3b)';
  setTimeout(() => {
    box.style.filter = '';
    setTimeout(() => {
      box.classList.remove('highlighted');
      box.style.transition = '';
    }, 2000);
  }, 500);
  return true;
}

function highlightTreeTarget(designName, modName, instName, renderPath, label) {
  const tree = $('module-tree');
  tree?.querySelectorAll('.tree-node-label.located').forEach(node => {
    node.classList.remove('located');
  });
  label?.classList.add('located');
  if (_treeHighlightTimer) clearTimeout(_treeHighlightTimer);
  _treeHighlightTimer = setTimeout(() => {
    label?.classList.remove('located');
    _treeHighlightTimer = null;
  }, 2200);

  const svgRoot = getSVGRoot();
  let box = renderPath ? getModuleBoxByPath(renderPath) : null;
  if (!box && instName) {
    box = [...svgRoot.querySelectorAll(`.module-box[data-instance="${CSS.escape(instName)}"]`)]
      .find(candidate => candidate.getAttribute('data-module') === modName) || null;
  }
  if (!box && !instName) {
    box = svgRoot.querySelector(`.module-box[data-module="${CSS.escape(modName)}"]`);
  }
  if (!focusCanvasModuleBox(box)) {
    showToast(`模块 "${instName || modName}" 在当前视图中不可见；双击可进入`, 'info');
  }
}

function migrateTreeExpandedPaths(designName, modules, topModules) {
  const expanded = state.treeExpanded[designName];
  const legacyModuleNames = [...expanded].filter(key => Object.hasOwn(modules, key));
  if (legacyModuleNames.length === 0) return;

  const pathsByModule = new Map(legacyModuleNames.map(name => [name, []]));
  const visit = (modName, renderPath, ancestry, depth) => {
    if (pathsByModule.has(modName)) pathsByModule.get(modName).push(renderPath);
    if (depth >= 32 || ancestry.has(modName)) return;
    const nextAncestry = new Set(ancestry);
    nextAncestry.add(modName);
    (modules[modName]?.instances || []).forEach(inst => {
      const childPath = renderPath.endsWith('::')
        ? `${renderPath}${inst.instance_name}`
        : `${renderPath}/${inst.instance_name}`;
      visit(inst.module_type, childPath, nextAncestry, depth + 1);
    });
  };

  const roots = topModules.length > 0 ? topModules : Object.keys(modules);
  roots.forEach(modName => visit(modName, `${modName}::`, new Set(), 0));
  legacyModuleNames.forEach(modName => {
    expanded.delete(modName);
    pathsByModule.get(modName).forEach(renderPath => expanded.add(renderPath));
  });
  scheduleSyncToServer(designName);
}

function hasTreeTextSelection(node) {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  return node.contains(selection.anchorNode) || node.contains(selection.focusNode);
}

function renderSidebar(designName) {
  const tree = $('module-tree');
  tree.innerHTML = '';
  const design = state.designs[designName];
  if (!design) return;

  const modules = design.modules;
  const topModules = design.top_modules || [];

  // Ensure treeExpanded is initialised for this design
  if (!state.treeExpanded[designName]) {
    state.treeExpanded[designName] = new Set();
    // Pre-expand all modules that have instances
    for (const [modName, mod] of Object.entries(modules)) {
      if (mod.instances && mod.instances.length > 0) {
        state.treeExpanded[designName].add(modName);
      }
    }
  }
  migrateTreeExpandedPaths(designName, modules, topModules);

  // ── Search input ──
  const searchRow = document.createElement('div');
  searchRow.style.cssText = 'display:flex;gap:4px;margin-bottom:8px;';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = '搜索模块...';
  searchInput.id = 'module-search-input';
  searchInput.style.cssText = 'flex:1;padding:4px 8px;background:#0d1117;border:1px solid #30363d;border-radius:4px;color:#c9d1d9;font-size:12px;outline:none;';
  searchInput.addEventListener('input', () => {
    const query = searchInput.value.trim().toLowerCase();
    tree.querySelectorAll('.tree-node-label').forEach(label => {
      const modName = label.getAttribute('data-mod-name') || '';
      const instName = label.getAttribute('data-inst-name') || '';
      if (!query || modName.toLowerCase().includes(query) || instName.toLowerCase().includes(query)) {
        label.style.display = '';
      } else {
        label.style.display = 'none';
      }
    });
  });
  searchRow.appendChild(searchInput);
  tree.appendChild(searchRow);

  // createNode(modName, depth, instName, renderPath, parentTreeKey)
  //   modName  — the module type (used for children lookup, expansion state, canvas navigation)
  //   depth    — indentation level
  //   instName — the specific instance name to display (null for top-level type entries)
  const createNode = (modName, depth, instName = null, renderPath = `${modName}::`, parentTreeKey = '') => {
    const mod = modules[modName];
    if (!mod) return;

    const label = document.createElement('div');
    label.className = 'tree-node-label';
    label.setAttribute('data-mod-name', modName);
    if (instName) label.setAttribute('data-inst-name', instName);
    label.setAttribute('data-tree-key', renderPath);
    if (parentTreeKey) label.setAttribute('data-parent-tree-key', parentTreeKey);
    label.setAttribute('tabindex', '0');
    label.setAttribute('role', 'treeitem');
    label.style.paddingLeft = (depth * 16 + 4) + 'px';

    // Use treeExpanded (sidebar tree state) for showing children
    const treeExp = state.treeExpanded[designName]?.has(renderPath);
    const hasChildren = mod.instances && mod.instances.length > 0;
    const isTop = !instName && topModules.includes(modName);

    // Check if this is the active module in the canvas
    const tab = state.openTabs.find(t => t.name === designName);
    const isViewing = tab && tab.module === modName;
    if (isViewing) label.classList.add('selected');

    // Primary label = instName (when sub-instance) or modName (top-level type)
    const displayName = instName || modName;
    const typeHint = (instName && instName !== modName)
      ? `<span class="tree-type-hint">:${modName}</span>` : '';

    const toggleMarkup = hasChildren
      ? `<button type="button" class="tree-node-toggle" aria-label="${treeExp ? '收起' : '展开'} ${displayName}" aria-expanded="${treeExp ? 'true' : 'false'}" title="${treeExp ? '收起' : '展开'}"><span aria-hidden="true">${treeExp ? '▼' : '▶'}</span></button>`
      : '<span class="tree-node-toggle-placeholder" aria-hidden="true">·</span>';
    label.innerHTML = `
      ${toggleMarkup}
      <span class="tree-node-main" title="单击高亮，双击进入模块">
        <span class="tree-node-name" style="${isTop ? 'color:#58a6ff;font-weight:600;' : ''}">${displayName}</span>
        ${typeHint}
        <span class="tree-node-port-count">${mod.ports?.length || 0}p</span>
      </span>`;

    const toggle = label.querySelector('.tree-node-toggle');
    if (toggle) {
      const activateToggle = e => {
        e.preventDefault();
        e.stopPropagation();
        if (_treeSingleClickTimer) {
          clearTimeout(_treeSingleClickTimer);
          _treeSingleClickTimer = null;
        }
        const treeExp2 = state.treeExpanded[designName];
        if (treeExp2.has(renderPath)) treeExp2.delete(renderPath);
        else treeExp2.add(renderPath);
        scheduleSyncToServer(designName);
        renderSidebar(designName);
        requestAnimationFrame(() => {
          const nextToggle = tree.querySelector(
            `.tree-node-label[data-tree-key="${CSS.escape(renderPath)}"] .tree-node-toggle`
          );
          nextToggle?.focus();
        });
      };
      toggle.addEventListener('mousedown', e => e.stopPropagation());
      toggle.addEventListener('click', activateToggle);
      toggle.addEventListener('dblclick', e => {
        e.preventDefault();
        e.stopPropagation();
      });
    }

    const nodeMain = label.querySelector('.tree-node-main');
    nodeMain.addEventListener('click', e => {
      e.stopPropagation();
      if (hasTreeTextSelection(nodeMain)) {
        if (_treeSingleClickTimer) {
          clearTimeout(_treeSingleClickTimer);
          _treeSingleClickTimer = null;
        }
        return;
      }
      if (_treeSingleClickTimer) clearTimeout(_treeSingleClickTimer);
      _treeSingleClickTimer = setTimeout(() => {
        _treeSingleClickTimer = null;
        highlightTreeTarget(designName, modName, instName, renderPath, label);
      }, 240);
    });
    nodeMain.addEventListener('dblclick', e => {
      e.preventDefault();
      e.stopPropagation();
      if (_treeSingleClickTimer) {
        clearTimeout(_treeSingleClickTimer);
        _treeSingleClickTimer = null;
      }
      navigateToModuleView(designName, modName);
    });
    label.addEventListener('click', e => {
      if (e.target === label) nodeMain.click();
    });
    label.addEventListener('dblclick', e => {
      if (e.target !== label) return;
      e.preventDefault();
      e.stopPropagation();
      if (_treeSingleClickTimer) {
        clearTimeout(_treeSingleClickTimer);
        _treeSingleClickTimer = null;
      }
      navigateToModuleView(designName, modName);
    });
    label.addEventListener('keydown', e => {
      if (e.target !== label) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        nodeMain.click();
      }
    });

    if (hasChildren) {
      label.setAttribute('aria-expanded', treeExp ? 'true' : 'false');
    }

    tree.appendChild(label);

    // Children: show ALL instances by instance_name (no type deduplication)
    // Expansion is controlled by concrete tree path so repeated module types stay independent.
    if (treeExp && mod.instances) {
      mod.instances.forEach(inst => {
        const childPath = renderPath.endsWith('::')
          ? `${renderPath}${inst.instance_name}`
          : `${renderPath}/${inst.instance_name}`;
        createNode(inst.module_type, depth + 1, inst.instance_name, childPath, renderPath);
      });
    }
  };

  // Top-level modules use type name only (no instName)
  if (topModules.length > 0) {
    topModules.forEach(t => createNode(t, 0, null, `${t}::`));
  } else {
    Object.keys(modules).forEach(m => createNode(m, 0, null, `${m}::`));
  }

}

// ── One-time keyboard navigation for module tree ──
// Attached once here instead of inside renderSidebar to prevent stacked listeners.
function initTreeKeyboardNav() {
  const tree = $('module-tree');
  if (!tree) return;
  tree.addEventListener('keydown', (e) => {
    const focused = document.activeElement;
    if (!focused || !focused.classList.contains('tree-node-label')) return;

    const designName = state.activeTab;
    if (!designName) return;
    const modules = state.designs[designName]?.modules;
    if (!modules) return;

    const allLabels = [...tree.querySelectorAll('.tree-node-label')].filter(l => l.style.display !== 'none');
    const idx = allLabels.indexOf(focused);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (idx < allLabels.length - 1) allLabels[idx + 1].focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (idx > 0) allLabels[idx - 1].focus();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      const mod = focused.getAttribute('data-mod-name');
      const treeKey = focused.getAttribute('data-tree-key');
      if (mod && modules[mod]?.instances?.length > 0) {
        if (!state.treeExpanded[designName].has(treeKey)) {
          state.treeExpanded[designName].add(treeKey);
          scheduleSyncToServer(designName);
          renderSidebar(designName);
          const newLabel = tree.querySelector(
            `.tree-node-label[data-tree-key="${CSS.escape(treeKey)}"]`
          );
          if (newLabel) newLabel.focus();
        }
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const mod = focused.getAttribute('data-mod-name');
      const treeKey = focused.getAttribute('data-tree-key');
      if (mod && state.treeExpanded[designName].has(treeKey)) {
        state.treeExpanded[designName].delete(treeKey);
        scheduleSyncToServer(designName);
        renderSidebar(designName);
        const newLabel = tree.querySelector(
          `.tree-node-label[data-tree-key="${CSS.escape(treeKey)}"]`
        );
        if (newLabel) newLabel.focus();
      } else {
        const parentTreeKey = focused.getAttribute('data-parent-tree-key');
        const parentLabel = parentTreeKey
          ? tree.querySelector(`.tree-node-label[data-tree-key="${CSS.escape(parentTreeKey)}"]`)
          : null;
        parentLabel?.focus();
      }
    }
  });
}

/**
 * Navigate to a specific INSTANCE box in the canvas by instance name.
 */
function navigateToInstance(designName, instName) {
  const svgRoot = getSVGRoot();
  const box = svgRoot.querySelector(`.module-box[data-instance="${instName}"]`);
  if (!box) {
    showToast(`实例 "${instName}" 在当前视图中不可见`, 'warn');
    return;
  }
  focusCanvasModuleBox(box);
}

/**
 * Navigate to a module instance in the canvas: find the SVG element,
 * pan/zoom to center it, and add a temporary highlight animation.
 */
function navigateToModule(designName, modName) {
  const svgRoot = getSVGRoot();
  // Find a module-box with data-module matching modName
  const boxes = svgRoot.querySelectorAll(`.module-box[data-module="${modName}"]`);
  if (boxes.length === 0) {
    // Module not visible in current view — try to expand its parent first
    const design = state.designs[designName];
    if (!design) return;
    const tab = state.openTabs.find(t => t.name === designName);
    if (!tab) return;
    // Find which top module contains this module as an instance
    const topMod = tab.module || design.top_modules?.[0];
    const parentMod = design.modules[topMod];
    if (parentMod) {
      // Check if any instance of parentMod has this module_type
      const hasInst = parentMod.instances?.some(inst => inst.module_type === modName);
      if (hasInst) {
        // Make sure parent is expanded
        if (!state.expandedModules[designName].has(topMod)) {
          state.expandedModules[designName].add(topMod);
          renderCanvas();
          // Try again after re-render
          setTimeout(() => navigateToModule(designName, modName), 100);
          return;
        }
      }
    }
    showToast(`模块 "${modName}" 在当前视图中不可见`, 'warn');
    return;
  }

  const box = boxes[0];
  const designRoot = getSVGRoot().querySelector('#design-root');
  if (!designRoot) return;

  // Get the module's position in design coordinates
  const transform = box.getAttribute('transform');
  const match = transform?.match(/translate\(\s*([\d.e+-]+)\s*,\s*([\d.e+-]+)\s*\)/);
  if (!match) return;
  const modX = parseFloat(match[1]);
  const modY = parseFloat(match[2]);

  // Get module size from its rect
  const rect = box.querySelector('.module-rect');
  const modW = rect ? parseFloat(rect.getAttribute('width')) : 150;
  const modH = rect ? parseFloat(rect.getAttribute('height')) : 100;

  // Center of the module
  const centerX = modX + modW / 2;
  const centerY = modY + modH / 2;

  // Calculate pan to center this module in the viewport
  const container = $('canvas-container');
  const cw = container.clientWidth;
  const ch = container.clientHeight;

  // Zoom to fit the module nicely (at least 0.5, at most 2)
  const targetZoom = Math.min(Math.max(state.zoom, 0.5), 2);
  state.zoom = targetZoom;
  state.pan.x = cw / 2 - centerX * state.zoom;
  state.pan.y = ch / 2 - centerY * state.zoom;
  applyTransform();

  // Save view state
  if (state.activeTab) {
    saveViewState(state.activeTab, { pan: { ...state.pan }, zoom: state.zoom });
  }

  // Highlight animation: flash the module box
  box.classList.add('highlighted');
  // Also add a pulse animation class
  box.style.transition = 'filter 0.3s';
  box.style.filter = 'brightness(1.5) drop-shadow(0 0 10px #ffeb3b)';
  setTimeout(() => {
    box.style.filter = '';
    setTimeout(() => {
      box.classList.remove('highlighted');
      box.style.transition = '';
    }, 2000);
  }, 500);
}

// ─── Canvas Rendering ───────────────────────────────────────────────────

function toggleInlineExpansion(designName, renderPath) {
  if (!designName || !renderPath) return;
  if (!state.inlineExpanded[designName]) state.inlineExpanded[designName] = new Set();
  const box = getModuleBoxByPath(renderPath);
  const moduleName = box?.getAttribute('data-module');
  if (moduleName) ensureModuleLayout(designName, moduleName);
  pushUndoSnapshot();
  const paths = state.inlineExpanded[designName];
  if (paths.has(renderPath)) {
    paths.delete(renderPath);
  } else {
    paths.add(renderPath);
  }
  saveInlineExpanded(designName, paths);
  renderCanvas();
}

function moduleNameForRenderPath(designName, renderPath) {
  const design = state.designs[designName];
  if (!design || !renderPath) return null;
  const separator = renderPath.indexOf('::');
  if (separator < 0) return null;
  let moduleName = renderPath.slice(0, separator);
  const segments = renderPath.slice(separator + 2).split('/').filter(Boolean);
  for (const instanceName of segments) {
    const instance = design.modules[moduleName]?.instances?.find(item => (
      item.instance_name === instanceName
    ));
    if (!instance) return null;
    moduleName = instance.module_type;
  }
  return moduleName;
}

let _moduleSingleClickTimer = null;

function renderCanvas() {
  const svgRoot = getSVGRoot();
  const tab = state.openTabs.find(t => t.name === state.activeTab);

  if (!tab || !state.designs[tab.name]) {
    svgRoot.innerHTML = '';
    if ($('welcome-screen')) $('welcome-screen').style.display = '';
    if (getSVG()) getSVG().style.display = 'none';
    return;
  }

  const design = state.designs[tab.name];
  const modules = design.modules;
  const expanded = state.expandedModules[tab.name] || new Set();
  const topMod = tab.module || (design.top_modules?.[0]) || Object.keys(modules)[0];

  // Load layout overrides from state (populated from localStorage on openDesign)
  const layoutOvr = state.layoutOverrides[tab.name] || {};
  const wireWps = state.wireWaypoints[tab.name] || {};
  const inlineExpandedPaths = state.inlineExpanded[tab.name] || new Set();
  state.customizations[tab.name] = normalizeCustomizations(state.customizations[tab.name] || {});

  // Clear & render
  svgRoot.innerHTML = '';
  const rootG = renderDesignView(topMod, modules, expanded, state.collapsedState, layoutOvr, wireWps, {
    hideClockReset: state.hideClockReset,
    selectedWireKey: state.selectedWireKey,
    customizations: state.customizations[tab.name] || { modules: {}, wires: {} },
    inlineExpandedPaths,
  });
  svgRoot.appendChild(rootG);
  renderCommentBlocks(rootG, tab.name);

  // Apply current transform
  applyTransform();

  // Update navigation buttons and breadcrumb
  updateNavButtons();

  // ── Attach click handlers for expanding/collapsing modules ──
  svgRoot.querySelectorAll('.module-box').forEach(box => {
    const modName = box.getAttribute('data-module');
    const instName = box.getAttribute('data-instance');
    const renderPath = box.getAttribute('data-render-path');

    const expandControl = box.querySelector(':scope > .expand-indicator');
    if (expandControl) {
      const activate = e => {
        e.preventDefault();
        e.stopPropagation();
        if (expandControl.getAttribute('data-expansion-blocked') === 'true') return;
        toggleInlineExpansion(tab.name, renderPath);
      };
      expandControl.addEventListener('mousedown', e => {
        e.preventDefault();
        e.stopPropagation();
      });
      expandControl.addEventListener('click', activate);
      expandControl.addEventListener('dblclick', e => {
        e.preventDefault();
        e.stopPropagation();
      });
      expandControl.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') activate(e);
      });
    }

    // Double-click on a sub-module box: navigate INTO that module's internal view
    box.addEventListener('dblclick', e => {
      e.stopPropagation();
      if (_moduleSingleClickTimer) {
        clearTimeout(_moduleSingleClickTimer);
        _moduleSingleClickTimer = null;
      }
      clearActiveCommentBlock();
      if (!instName) return; // top-level bounding box, no instance
      if (!modName || !modules[modName]?.instances?.length) return; // leaf module
      clearBoxSelection();
      navigateToModuleView(tab.name, modName);
    });

    // Right-click: show comment popup (if comment exists), otherwise do nothing
    box.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      clearActiveCommentBlock();
      if (!instName) return;
      const customs = state.customizations[tab.name] || { modules: {} };
      const modCustom = customs.modules?.[instName] || {};
      if (modCustom.comment) {
        showCommentPopup(instName, modName, modCustom.comment, e.clientX, e.clientY);
      }
    });

    // Click on ⚙ settings icon → open settings panel directly
    const gearIcon = box.querySelector('.module-settings-icon');
    if (gearIcon) {
      gearIcon.addEventListener('click', e => {
        e.stopPropagation();
        clearActiveCommentBlock();
        if (!instName) return;
        state.settingsTarget = { type: 'module', key: instName, modName };
        openSettingsPanel();
      });
    }

    // Left-click: show comment popup (if comment exists)
    box.addEventListener('click', e => {
      if (state.justFinishedDrag) return;
      e.stopPropagation();
      if (_moduleSingleClickTimer) clearTimeout(_moduleSingleClickTimer);
      const clickInfo = {
        shiftKey: e.shiftKey,
        additive: e.ctrlKey || e.metaKey,
        clientX: e.clientX,
        clientY: e.clientY,
      };
      _moduleSingleClickTimer = setTimeout(() => {
        _moduleSingleClickTimer = null;
        clearActiveCommentBlock();
        if (instName) {
          updateModuleClickSelection(renderPath, clickInfo.shiftKey, clickInfo.additive);
        }
        if (clickInfo.shiftKey || clickInfo.additive) {
          closeCommentPopup();
          return;
        }
        const customs = state.customizations[tab.name] || { modules: {} };
        const modCustom = customs.modules?.[instName] || {};
        if (modCustom.comment) {
          showCommentPopup(
            instName,
            modName,
            modCustom.comment,
            clickInfo.clientX,
            clickInfo.clientY,
          );
        } else {
          closeCommentPopup();
        }
      }, 220);
    });
  });

  // ── Attach module drag handlers (mousedown on header area) ──
  svgRoot.querySelectorAll('.module-box').forEach(box => {
    const instName = box.getAttribute('data-instance');
    if (!instName) return; // skip top-level (no instName)

    // Drag: mousedown on module header
    const headerRect = box.querySelector(':scope > .module-header-primary');
    if (headerRect) {
      headerRect.style.cursor = 'move';
      headerRect.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        clearActiveCommentBlock();
        startModuleDrag(e, instName, box);
      });
    }

    // Also allow drag from the header text area
    const titleText = box.querySelector('.module-title');
    if (titleText) {
      titleText.style.cursor = 'move';
      titleText.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        clearActiveCommentBlock();
        startModuleDrag(e, instName, box);
      });
    }
  });

  // ── Attach resize handles ──
  svgRoot.querySelectorAll('.resize-handle').forEach(rh => {
    rh.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      clearActiveCommentBlock();
      const instName = rh.getAttribute('data-instance');
      if (!instName) return;
      startModuleResize(e, instName, rh.closest('.module-box'));
    });
  });

  // ── Attach handlers for collapsible port groups (collapsed -> expand) ──
  svgRoot.querySelectorAll('.port-group-collapsed').forEach(pg => {
    pg.style.cursor = 'pointer';
    pg.addEventListener('click', e => {
      e.stopPropagation();
      clearActiveCommentBlock();
      const key = pg.getAttribute('data-group-key');
      state.collapsedState[key] = true; // true = expanded
      saveCollapsedState(state.collapsedState);
      renderCanvas();
    });
  });

  // ── Attach handlers for expanded port group headers (expand -> collapse) ──
  svgRoot.querySelectorAll('.port-group-expanded-header').forEach(pg => {
    pg.style.cursor = 'pointer';
    pg.addEventListener('click', e => {
      e.stopPropagation();
      clearActiveCommentBlock();
      const key = pg.getAttribute('data-group-key');
      state.collapsedState[key] = false; // false = collapsed
      saveCollapsedState(state.collapsedState);
      renderCanvas();
    });
  });

  // ── Click on background to deselect wire ──
  getSVG().addEventListener('click', e => {
    if (state.justFinishedDrag) return; // Don't deselect after drag operations
    if (!e.target.closest?.('.comment-block')) {
      clearActiveCommentBlock();
    }
    if (e.target === getSVG() || e.target.id === 'svg-root') {
      // Don't clear box selection on background click — use close button
      if (state.selectedWireKey) {
        state.selectedWireKey = null;
        state.selectedWireSignal = null;
        svgRoot.querySelectorAll('.wire-path.selected').forEach(p => p.classList.remove('selected'));
        svgRoot.querySelectorAll('.wire-selected').forEach(w => w.classList.remove('wire-selected'));
        updateInfoPanel(topMod, modules);
      }
    }
  });

  // ── Wire interactions ──
  svgRoot.querySelectorAll('.wire-group').forEach(wg => {
    const signal = wg.getAttribute('data-signal');
    const wireKey = wg.getAttribute('data-wire-key');

    // Apply persistent highlight if this wire is selected
    if (wireKey && wireKey === state.selectedWireKey) {
      wg.querySelectorAll('.wire-path').forEach(p => p.classList.add('selected'));
      wg.classList.add('wire-selected');
    }

    // Hover highlight
    wg.addEventListener('mouseenter', () => {
      wg.querySelectorAll('.wire-path').forEach(p => p.classList.add('highlighted'));
      showWireTooltip(wg, signal);
    });
    wg.addEventListener('mouseleave', () => {
      wg.querySelectorAll('.wire-path').forEach(p => {
        p.classList.remove('highlighted');
      });
      hideWireTooltip();
    });

    // Single click: toggle persistent selection
    wg.addEventListener('click', e => {
      e.stopPropagation();
      clearActiveCommentBlock();
      if (!wireKey) return;
      if (state.selectedWireKey === wireKey) {
        state.selectedWireKey = null;
        state.selectedWireSignal = null;
      } else {
        state.selectedWireKey = wireKey;
        state.selectedWireSignal = signal;
      }
      // Update all wire highlights without full re-render
      svgRoot.querySelectorAll('.wire-group').forEach(wg2 => {
        const wk = wg2.getAttribute('data-wire-key');
        const isSelected = wk && wk === state.selectedWireKey;
        wg2.querySelectorAll('.wire-path').forEach(p => {
          p.classList.toggle('selected', isSelected);
        });
        wg2.classList.toggle('wire-selected', isSelected);
      });
      // Show wire info in the info panel
      if (state.selectedWireKey) {
        showWireInfoPanel(state.selectedWireKey, signal);
      } else {
        updateInfoPanel(topMod, modules);
      }
    });

    // Double-click on wire to add a waypoint
    wg.querySelector('.wire-path')?.addEventListener('dblclick', e => {
      e.stopPropagation();
      e.preventDefault();
      if (!wireKey) return;
      const localPt = svgToElementCoords(wg, e.clientX, e.clientY);
      if (!localPt) return;
      const originX = parseFloat(wg.getAttribute('data-waypoint-origin-x')) || 0;
      const originY = parseFloat(wg.getAttribute('data-waypoint-origin-y')) || 0;
      const pt = { x: localPt.x - originX, y: localPt.y - originY };
      pushUndoSnapshot();
      if (!state.wireWaypoints[tab.name]) state.wireWaypoints[tab.name] = {};
      if (!state.wireWaypoints[tab.name][wireKey]) state.wireWaypoints[tab.name][wireKey] = [];
      const arr = state.wireWaypoints[tab.name][wireKey];
      const newWp = { x: pt.x, y: pt.y };
      // Insert at the position along the existing waypoint sequence that minimises
      // total path length change (nearest insertion gap).
      if (arr.length === 0) {
        arr.push(newWp);
      } else {
        // Build ordered vertex list: start → ...waypoints... → end
        // We don't have src/dst here, so just find the nearest segment gap
        // among existing waypoints by checking proximity to each gap midpoint.
        let bestIdx = arr.length; // default: append at end
        let bestDist = Infinity;
        for (let k = 0; k <= arr.length; k++) {
          const a = k === 0 ? null : arr[k - 1];
          const b = k === arr.length ? null : arr[k];
          // Use midpoint of the gap as a heuristic for nearest insertion
          const mx = a && b ? (a.x + b.x) / 2 : (a ? a.x : b.x);
          const my = a && b ? (a.y + b.y) / 2 : (a ? a.y : b.y);
          const dist = Math.hypot(pt.x - mx, pt.y - my);
          if (dist < bestDist) { bestDist = dist; bestIdx = k; }
        }
        arr.splice(bestIdx, 0, newWp);
      }
      saveWireWaypoints(tab.name, state.wireWaypoints[tab.name]);
      renderCanvas();
    });
  });

  // ── Wire waypoint drag handlers ──
  svgRoot.querySelectorAll('.wire-waypoint').forEach(wp => {
    wp.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      clearActiveCommentBlock();
      const wireKey = wp.getAttribute('data-wire-key');
      const wpIdx = parseInt(wp.getAttribute('data-wp-index'));
      startWaypointDrag(e, wireKey, wpIdx, wp);
    });

    // Single click on waypoint: select its wire and auto-expand the waypoint panel
    wp.addEventListener('click', e => {
      e.stopPropagation();
      clearActiveCommentBlock();
      const wireKey = wp.getAttribute('data-wire-key');
      const wg = svgRoot.querySelector(`.wire-group[data-wire-key="${CSS.escape(wireKey)}"]`);
      const signal = wg ? wg.getAttribute('data-signal') : wireKey;
      state.selectedWireKey = wireKey;
      state.selectedWireSignal = signal;
      // Update wire highlight
      svgRoot.querySelectorAll('.wire-group').forEach(wg2 => {
        const wk = wg2.getAttribute('data-wire-key');
        const isSel = wk === wireKey;
        wg2.querySelectorAll('.wire-path').forEach(p => p.classList.toggle('selected', isSel));
        wg2.classList.toggle('wire-selected', isSel);
      });
      showWireInfoPanel(wireKey, signal);
      // Auto-expand the waypoint panel
      if (!wpPanelExpanded) {
        wpPanelExpanded = true;
        const arrow = $('wp-panel-arrow');
        const body = $('wp-panel-body');
        if (arrow) arrow.textContent = '▼';
        if (body) body.style.display = '';
        renderWaypointList(wireKey, signal);
      }
    });

    // Right-click to delete waypoint
    wp.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      const wireKey = wp.getAttribute('data-wire-key');
      const wpIdx = parseInt(wp.getAttribute('data-wp-index'));
      if (state.wireWaypoints[tab.name]?.[wireKey]) {
        pushUndoSnapshot();
        state.wireWaypoints[tab.name][wireKey].splice(wpIdx, 1);
        if (state.wireWaypoints[tab.name][wireKey].length === 0) {
          delete state.wireWaypoints[tab.name][wireKey];
        }
        saveWireWaypoints(tab.name, state.wireWaypoints[tab.name]);
        renderCanvas();
      }
    });
  });

  // Update info
  updateInfoPanel(topMod, modules);

  // If a wire was selected, restore the wire info panel (updateInfoPanel hides it)
  if (state.selectedWireKey) {
    showWireInfoPanel(state.selectedWireKey, state.selectedWireSignal);
  }

  // Highlight the currently viewed module in the canvas
  const currentTab = state.openTabs.find(t => t.name === state.activeTab);
  if (currentTab?.module) {
    svgRoot.querySelectorAll('.module-box').forEach(box => {
      const modName = box.getAttribute('data-module');
      if (modName === currentTab.module) {
        box.classList.add('highlighted');
      }
    });
  }

  // 仅在打开没有保存视图的新设计时自动适配一次。
  if (state.autoFitPending[tab.name]) {
    state.autoFitPending[tab.name] = false;
    scheduleFitToView(450);
  }

  // Re-apply box selection highlights if active
  if (state.boxSelection) {
    setTimeout(() => renderBoxSelectionHighlight(), 20);
  }
}

// ─── SVG coordinate helpers ─────────────────────────────────────────────

/**
 * Convert screen (client) coordinates to SVG design-root coordinates,
 * accounting for pan/zoom transform.
 */
function svgToDesignCoords(clientX, clientY) {
  const svg = getSVG();
  if (!svg) return null;
  const rect = svg.getBoundingClientRect();
  const svgX = clientX - rect.left;
  const svgY = clientY - rect.top;
  // Reverse the transform: translate(pan) scale(zoom)
  return {
    x: (svgX - state.pan.x) / state.zoom,
    y: (svgY - state.pan.y) / state.zoom,
  };
}

// ─── Persistent Comment Blocks ─────────────────────────────────────────

function getActiveCommentBlock() {
  const id = state.activeCommentBlockId;
  if (!id || !state.activeTab) return null;
  const block = state.customizations[state.activeTab]?.commentBlocks?.[id];
  return block ? { id, block } : null;
}

function clearActiveCommentBlock() {
  if (!state.activeCommentBlockId) return;
  state.activeCommentBlockId = null;
  const svgRoot = getSVGRoot();
  svgRoot?.querySelectorAll('.comment-block.active').forEach(g => g.classList.remove('active'));
  svgRoot?.querySelectorAll('.comment-block-handles').forEach(g => g.remove());
}

function renderMarkdownHtml(markdown) {
  const md = markdown || '';
  if (window.marked) return window.marked.parse(md);
  return escHtml(md)
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

function getCommentBlockTitle(block) {
  if (block?.title) return block.title;
  const firstText = (block?.markdown || '').split('\n').find(line => line.trim());
  return firstText ? firstText.replace(/^#+\s*/, '').trim() : '注释块';
}

function renderCommentBlocks(rootG, designName) {
  const customs = normalizeCustomizations(state.customizations[designName] || {});
  const blocks = customs.commentBlocks || {};
  if (Object.keys(blocks).length === 0) return;

  const layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  layer.id = 'comment-block-layer';

  for (const [id, block] of Object.entries(blocks)) {
    if (!block.title) block.title = getCommentBlockTitle(block);
    const width = Math.max(80, block.width || 220);
    const height = Math.max(50, block.height || 120);
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.classList.add('comment-block');
    if (state.activeCommentBlockId === id) g.classList.add('active');
    g.setAttribute('data-comment-block-id', id);
    g.setAttribute('transform', `translate(${block.x || 0}, ${block.y || 0})`);

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('class', 'comment-block-rect');
    rect.setAttribute('x', 0);
    rect.setAttribute('y', 0);
    rect.setAttribute('width', width);
    rect.setAttribute('height', height);
    rect.setAttribute('rx', 12);
    rect.setAttribute('ry', 12);
    rect.style.cursor = 'move';
    g.appendChild(rect);

    const fo = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
    fo.setAttribute('x', 8);
    fo.setAttribute('y', 8);
    fo.setAttribute('width', Math.max(20, width - 16));
    fo.setAttribute('height', Math.max(14, height - 16));
    fo.setAttribute('pointer-events', 'none');
    const body = document.createElement('div');
    body.className = 'comment-block-body';
    body.textContent = getCommentBlockTitle(block);
    fo.appendChild(body);
    g.appendChild(fo);

    if (state.activeCommentBlockId === id) {
      appendCommentBlockResizeHandles(g, id, width, height);
    }

    g.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      startCommentBlockDrag(e, id);
    });
    g.addEventListener('click', e => {
      e.stopPropagation();
      state.activeCommentBlockId = id;
      renderCanvas();
    });
    g.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      state.activeCommentBlockId = id;
      state.settingsTarget = { type: 'commentBlock', key: id };
      openSettingsPanel();
    });

    layer.appendChild(g);
  }

  rootG.insertBefore(layer, rootG.firstChild);
}

function appendCommentBlockResizeHandles(g, id, width, height) {
  const handlesG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  handlesG.classList.add('comment-block-handles');
  const hs = 3.5 / state.zoom;
  const points = [
    { role: 'nw', x: 0, y: 0, cursor: 'nw-resize' },
    { role: 'n', x: width / 2, y: 0, cursor: 'n-resize' },
    { role: 'ne', x: width, y: 0, cursor: 'ne-resize' },
    { role: 'e', x: width, y: height / 2, cursor: 'e-resize' },
    { role: 'se', x: width, y: height, cursor: 'se-resize' },
    { role: 's', x: width / 2, y: height, cursor: 's-resize' },
    { role: 'sw', x: 0, y: height, cursor: 'sw-resize' },
    { role: 'w', x: 0, y: height / 2, cursor: 'w-resize' },
  ];
  points.forEach(h => {
    const hr = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    hr.setAttribute('class', 'comment-block-handle');
    hr.setAttribute('data-role', h.role);
    hr.setAttribute('x', h.x - hs);
    hr.setAttribute('y', h.y - hs);
    hr.setAttribute('width', hs * 2);
    hr.setAttribute('height', hs * 2);
    hr.setAttribute('rx', 1 / state.zoom);
    hr.style.cursor = h.cursor;
    hr.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      startCommentBlockResize(e, id, h.role);
    });
    handlesG.appendChild(hr);
  });
  g.appendChild(handlesG);
}

function startCommentBlockDrag(e, id) {
  const pt = svgToDesignCoords(e.clientX, e.clientY);
  const block = state.customizations[state.activeTab]?.commentBlocks?.[id];
  if (!pt || !block) return;
  state.activeCommentBlockId = id;
  state.editMode = 'drag-comment-block';
  state.editTarget = {
    id,
    startX: pt.x,
    startY: pt.y,
    origX: block.x || 0,
    origY: block.y || 0,
    moveContents: e.shiftKey,
    origPositions: {},
    origWaypoints: {},
  };
  if (e.shiftKey) collectCommentBlockContents(block, state.editTarget);
  $('canvas-container').style.cursor = 'move';
}

function onCommentBlockDragMove(e) {
  const t = state.editTarget;
  const pt = svgToDesignCoords(e.clientX, e.clientY);
  if (!t || !pt) return;
  const g = getSVGRoot()?.querySelector(`.comment-block[data-comment-block-id="${CSS.escape(t.id)}"]`);
  if (g) g.setAttribute('transform', `translate(${t.origX + pt.x - t.startX}, ${t.origY + pt.y - t.startY})`);
  if (t.moveContents) {
    const dx = pt.x - t.startX;
    const dy = pt.y - t.startY;
    for (const orig of Object.values(t.origPositions)) {
      orig.boxEl?.setAttribute('transform', `translate(${orig.x + dx}, ${orig.y + dy})`);
    }
    for (const orig of Object.values(t.origWaypoints)) {
      const wp = orig.wpEl;
      if (wp) {
        wp.setAttribute('cx', orig.x + dx);
        wp.setAttribute('cy', orig.y + dy);
      }
    }
  }
}

function onCommentBlockDragEnd(e) {
  const t = state.editTarget;
  const pt = svgToDesignCoords(e.clientX, e.clientY);
  const block = state.customizations[state.activeTab]?.commentBlocks?.[t?.id];
  if (t && pt && block) {
    block.x = t.origX + pt.x - t.startX;
    block.y = t.origY + pt.y - t.startY;
    saveCustomizations(state.activeTab, state.customizations[state.activeTab]);
    scheduleSyncToServer(state.activeTab);
    if (t.moveContents) persistMovedCommentBlockContents(t, pt.x - t.startX, pt.y - t.startY);
  }
  state.editMode = null;
  state.editTarget = null;
  $('canvas-container').style.cursor = 'grab';
  state.justFinishedDrag = true;
  setTimeout(() => { state.justFinishedDrag = false; }, 50);
  renderCanvas();
}

function collectCommentBlockContents(block, target) {
  const x1 = block.x || 0;
  const y1 = block.y || 0;
  const x2 = x1 + Math.max(80, block.width || 220);
  const y2 = y1 + Math.max(50, block.height || 120);
  const svgRoot = getSVGRoot();
  svgRoot.querySelectorAll('.module-box').forEach(box => {
    const renderPath = box.getAttribute('data-render-path');
    if (!renderPath || !box.getAttribute('data-instance')) return;
    const m = box.getAttribute('transform')?.match(/translate\(\s*([\d.e+-]+)\s*,\s*([\d.e+-]+)\s*\)/);
    if (!m) return;
    const bounds = getModuleBoxBounds(renderPath);
    if (!bounds) return;
    const cx = bounds.x + bounds.width / 2;
    const cy = bounds.y + bounds.height / 2;
    if (cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2) {
      target.origPositions[renderPath] = {
        x: parseFloat(m[1]),
        y: parseFloat(m[2]),
        boxEl: box,
        layoutKey: box.getAttribute('data-layout-key') || box.getAttribute('data-instance'),
        instanceName: box.getAttribute('data-instance') || '',
        originX: parseFloat(box.getAttribute('data-layout-origin-x')) || 0,
        originY: parseFloat(box.getAttribute('data-layout-origin-y')) || 0,
      };
    }
  });
  svgRoot.querySelectorAll('.wire-waypoint').forEach(wp => {
    const designPoint = getWaypointDesignPoint(wp);
    const x = parseFloat(wp.getAttribute('cx'));
    const y = parseFloat(wp.getAttribute('cy'));
    if (designPoint.x >= x1 && designPoint.x <= x2
        && designPoint.y >= y1 && designPoint.y <= y2) {
      const wireKey = wp.getAttribute('data-wire-key');
      const idx = parseInt(wp.getAttribute('data-wp-index'));
      const saved = state.wireWaypoints[state.activeTab]?.[wireKey]?.[idx];
      const renderPath = wp.getAttribute('data-render-path') || wireKey;
      if (saved) {
        target.origWaypoints[`${renderPath}:${idx}`] = {
          x,
          y,
          savedX: saved.x,
          savedY: saved.y,
          wireKey,
          idx,
          wpEl: wp,
        };
      }
    }
  });
}

function persistMovedCommentBlockContents(target, dx, dy) {
  const designName = state.activeTab;
  if (!designName) return;
  const hasModules = Object.keys(target.origPositions || {}).length > 0;
  const hasWaypoints = Object.keys(target.origWaypoints || {}).length > 0;
  if (hasModules || hasWaypoints) pushUndoSnapshot();
  if (hasModules) {
    if (!state.layoutOverrides[designName]) state.layoutOverrides[designName] = {};
    for (const orig of Object.values(target.origPositions)) {
      const ovr = getLayoutOverrideForInstance(designName, orig.layoutKey, orig.instanceName);
      ovr.x = orig.x + dx - orig.originX;
      ovr.y = orig.y + dy - orig.originY;
      state.layoutOverrides[designName][orig.layoutKey] = ovr;
    }
    saveLayout(designName, state.layoutOverrides[designName]);
  }
  if (hasWaypoints) {
    for (const orig of Object.values(target.origWaypoints)) {
      if (state.wireWaypoints[designName]?.[orig.wireKey]?.[orig.idx]) {
        state.wireWaypoints[designName][orig.wireKey][orig.idx] = {
          x: orig.savedX + dx,
          y: orig.savedY + dy,
        };
      }
    }
    saveWireWaypoints(designName, state.wireWaypoints[designName]);
  }
}

function computeCommentBlockResize(orig, handle, dx, dy) {
  let x1 = orig.x, y1 = orig.y, x2 = orig.x + orig.width, y2 = orig.y + orig.height;
  if (handle.includes('w')) x1 += dx;
  if (handle.includes('e')) x2 += dx;
  if (handle.includes('n')) y1 += dy;
  if (handle.includes('s')) y2 += dy;
  const minW = 80, minH = 50;
  if (x2 - x1 < minW) handle.includes('w') ? x1 = x2 - minW : x2 = x1 + minW;
  if (y2 - y1 < minH) handle.includes('n') ? y1 = y2 - minH : y2 = y1 + minH;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

function updateCommentBlockVisual(id, rect) {
  const g = getSVGRoot()?.querySelector(`.comment-block[data-comment-block-id="${CSS.escape(id)}"]`);
  if (!g) return;
  g.setAttribute('transform', `translate(${rect.x}, ${rect.y})`);
  const r = g.querySelector('.comment-block-rect');
  if (r) {
    r.setAttribute('width', rect.width);
    r.setAttribute('height', rect.height);
  }
  const fo = g.querySelector('foreignObject');
  if (fo) {
    fo.setAttribute('width', Math.max(20, rect.width - 16));
    fo.setAttribute('height', Math.max(14, rect.height - 16));
  }
  const handles = g.querySelector('.comment-block-handles');
  if (handles) {
    handles.remove();
    appendCommentBlockResizeHandles(g, id, rect.width, rect.height);
  }
}

function startCommentBlockResize(e, id, handle) {
  const pt = svgToDesignCoords(e.clientX, e.clientY);
  const block = state.customizations[state.activeTab]?.commentBlocks?.[id];
  if (!pt || !block) return;
  state.activeCommentBlockId = id;
  state.editMode = 'resize-comment-block';
  state.editTarget = {
    id,
    handle,
    startX: pt.x,
    startY: pt.y,
    orig: {
      x: block.x || 0,
      y: block.y || 0,
      width: Math.max(80, block.width || 220),
      height: Math.max(50, block.height || 120),
    },
  };
  $('canvas-container').style.cursor = e.currentTarget?.style?.cursor || 'crosshair';
}

function onCommentBlockResizeMove(e) {
  const t = state.editTarget;
  const pt = svgToDesignCoords(e.clientX, e.clientY);
  if (!t || !pt) return;
  updateCommentBlockVisual(t.id, computeCommentBlockResize(t.orig, t.handle, pt.x - t.startX, pt.y - t.startY));
}

function onCommentBlockResizeEnd(e) {
  const t = state.editTarget;
  const pt = svgToDesignCoords(e.clientX, e.clientY);
  const block = state.customizations[state.activeTab]?.commentBlocks?.[t?.id];
  if (t && block) {
    const rect = pt ? computeCommentBlockResize(t.orig, t.handle, pt.x - t.startX, pt.y - t.startY) : t.orig;
    Object.assign(block, rect);
    saveCustomizations(state.activeTab, state.customizations[state.activeTab]);
    scheduleSyncToServer(state.activeTab);
  }
  state.editMode = null;
  state.editTarget = null;
  $('canvas-container').style.cursor = 'grab';
  renderCanvas();
}

// ─── Module drag ────────────────────────────────────────────────────────

function startModuleDrag(e, instName, boxEl) {
  const pt = svgToDesignCoords(e.clientX, e.clientY);
  if (!pt) return;

  // Get current module position from the transform attribute
  const transform = boxEl.getAttribute('transform');
  const match = transform?.match(/translate\(\s*([\d.e+-]+)\s*,\s*([\d.e+-]+)\s*\)/);
  const origX = match ? parseFloat(match[1]) : 0;
  const origY = match ? parseFloat(match[2]) : 0;

  state.editMode = 'drag-module';
  state.editTarget = {
    instName,
    renderPath: boxEl.getAttribute('data-render-path') || instName,
    layoutKey: boxEl.getAttribute('data-layout-key') || instName,
    layoutOriginX: parseFloat(boxEl.getAttribute('data-layout-origin-x')) || 0,
    layoutOriginY: parseFloat(boxEl.getAttribute('data-layout-origin-y')) || 0,
    startDesignX: pt.x,
    startDesignY: pt.y,
    origX, origY,
    boxEl,
  };
  $('canvas-container').style.cursor = 'move';
}

function svgToElementCoords(element, clientX, clientY) {
  const svg = getSVG();
  if (!svg || !element?.getScreenCTM) return null;
  const matrix = element.getScreenCTM();
  if (!matrix) return null;
  const point = svg.createSVGPoint();
  point.x = clientX;
  point.y = clientY;
  try {
    return point.matrixTransform(matrix.inverse());
  } catch (error) {
    return null;
  }
}

let _inlineAncestorFitFrame = null;
const _inlineAncestorFitBoxes = new Set();

function fitInlineAncestorsAround(boxEl) {
  let child = boxEl;
  let ancestor = child.parentElement?.closest?.('.module-box.inline-expanded');
  while (ancestor) {
    const match = child.getAttribute('transform')?.match(
      /translate\(\s*([\d.e+-]+)\s*,\s*([\d.e+-]+)\s*\)/
    );
    const childRect = child.querySelector(':scope > .module-rect');
    const ancestorRect = ancestor.querySelector(':scope > .module-rect');
    if (match && childRect && ancestorRect) {
      const childRectX = parseFloat(childRect.getAttribute('x')) || 0;
      const childRectY = parseFloat(childRect.getAttribute('y')) || 0;
      const childLeft = parseFloat(match[1]) + childRectX;
      const childTop = parseFloat(match[2]) + childRectY;
      const childRight = childLeft + parseFloat(childRect.getAttribute('width'));
      const childBottom = childTop + parseFloat(childRect.getAttribute('height'));
      const currentLeft = parseFloat(ancestorRect.getAttribute('x')) || 0;
      const currentTop = parseFloat(ancestorRect.getAttribute('y')) || 0;
      const currentRight = currentLeft + parseFloat(ancestorRect.getAttribute('width'));
      const currentBottom = currentTop + parseFloat(ancestorRect.getAttribute('height'));
      const nextLeft = Math.min(
        currentLeft,
        childLeft - LAYOUT.INLINE_CONTENT_X
      );
      const nextTop = Math.min(
        currentTop,
        childTop - LAYOUT.MODULE_HEADER_H - LAYOUT.INLINE_CONTENT_Y
      );
      const nextRight = Math.max(
        currentRight,
        childRight + LAYOUT.INLINE_PAD_RIGHT
      );
      const nextBottom = Math.max(
        currentBottom,
        childBottom + LAYOUT.INLINE_PAD_BOTTOM
      );
      ancestorRect.setAttribute('x', nextLeft);
      ancestorRect.setAttribute('y', nextTop);
      ancestorRect.setAttribute('width', nextRight - nextLeft);
      ancestorRect.setAttribute('height', nextBottom - nextTop);
    }
    child = ancestor;
    ancestor = ancestor.parentElement?.closest?.('.module-box.inline-expanded');
  }
}

function scheduleInlineAncestorFit(boxEl) {
  if (!boxEl) return;
  _inlineAncestorFitBoxes.add(boxEl);
  if (_inlineAncestorFitFrame) return;
  _inlineAncestorFitFrame = requestAnimationFrame(() => {
    _inlineAncestorFitFrame = null;
    const boxes = [..._inlineAncestorFitBoxes];
    _inlineAncestorFitBoxes.clear();
    boxes.forEach(fitInlineAncestorsAround);
  });
}

function onModuleDragMove(e) {
  const t = state.editTarget;
  const pt = svgToDesignCoords(e.clientX, e.clientY);
  if (!pt || !t) return;

  const dx = pt.x - t.startDesignX;
  const dy = pt.y - t.startDesignY;
  const newX = t.origX + dx;
  const newY = t.origY + dy;

  // Live preview: move the SVG group
  t.boxEl.setAttribute('transform', `translate(${newX}, ${newY})`);
  scheduleInlineAncestorFit(t.boxEl);
}

function onModuleDragEnd(e) {
  const t = state.editTarget;
  if (!t) return;

  const pt = svgToDesignCoords(e.clientX, e.clientY);
  let didMove = false;
  if (pt) {
    const dx = pt.x - t.startDesignX;
    const dy = pt.y - t.startDesignY;
    didMove = Math.hypot(dx, dy) >= 1;
    if (didMove) pushUndoSnapshot();
    const newX = t.origX + dx;
    const newY = t.origY + dy;

    if (didMove) {
      const designName = state.activeTab;
      if (!state.layoutOverrides[designName]) state.layoutOverrides[designName] = {};
      const ovr = getLayoutOverrideForInstance(designName, t.layoutKey, t.instName);
      ovr.x = newX - t.layoutOriginX;
      ovr.y = newY - t.layoutOriginY;
      state.layoutOverrides[designName][t.layoutKey] = ovr;
      saveLayout(designName, state.layoutOverrides[designName]);
    }
  }

  state.editMode = null;
  state.editTarget = null;
  $('canvas-container').style.cursor = 'grab';
  if (didMove) {
    state.justFinishedDrag = true;
    setTimeout(() => { state.justFinishedDrag = false; }, 50);
    renderCanvas(); // re-render with wires reconnected
  }
}

// ─── Module resize ──────────────────────────────────────────────────────

function startModuleResize(e, instName, boxEl) {
  const pt = svgToDesignCoords(e.clientX, e.clientY);
  if (!pt) return;

  // Get current module size from the main rect
  const mainRect = boxEl.querySelector('.module-rect');
  const origW = parseFloat(mainRect.getAttribute('width'));
  const origH = parseFloat(mainRect.getAttribute('height'));

  state.editMode = 'resize-module';
  state.editTarget = {
    instName,
    layoutKey: boxEl.getAttribute('data-layout-key') || instName,
    startDesignX: pt.x,
    startDesignY: pt.y,
    origW, origH,
    boxEl,
  };
  $('canvas-container').style.cursor = 'nwse-resize';
}

function onModuleResizeMove(e) {
  const t = state.editTarget;
  const pt = svgToDesignCoords(e.clientX, e.clientY);
  if (!pt || !t) return;

  const dw = pt.x - t.startDesignX;
  const dh = pt.y - t.startDesignY;
  const newW = Math.max(LAYOUT.MODULE_MIN_WIDTH, t.origW + dw);
  const newH = Math.max(LAYOUT.MODULE_HEADER_H + 30, t.origH + dh);

  // Live preview: resize the main rect
  const mainRect = t.boxEl.querySelector('.module-rect');
  if (mainRect) {
    mainRect.setAttribute('width', newW);
    mainRect.setAttribute('height', newH);
  }
}

function onModuleResizeEnd(e) {
  const t = state.editTarget;
  if (!t) return;

  const pt = svgToDesignCoords(e.clientX, e.clientY);
  if (pt) {
    pushUndoSnapshot();
    const dw = pt.x - t.startDesignX;
    const dh = pt.y - t.startDesignY;
    const newW = Math.max(LAYOUT.MODULE_MIN_WIDTH, t.origW + dw);
    const newH = Math.max(LAYOUT.MODULE_HEADER_H + 30, t.origH + dh);

    const designName = state.activeTab;
    if (!state.layoutOverrides[designName]) state.layoutOverrides[designName] = {};
    const ovr = getLayoutOverrideForInstance(designName, t.layoutKey, t.instName);
    ovr.width = newW;
    ovr.height = newH;
    state.layoutOverrides[designName][t.layoutKey] = ovr;
    saveLayout(designName, state.layoutOverrides[designName]);
  }

  state.editMode = null;
  state.editTarget = null;
  $('canvas-container').style.cursor = 'grab';
  state.justFinishedDrag = true;
  setTimeout(() => { state.justFinishedDrag = false; }, 50);
  renderCanvas();
}

// ─── Wire waypoint drag ────────────────────────────────────────────────

function startWaypointDrag(e, wireKey, wpIdx, wpEl) {
  const pt = svgToElementCoords(wpEl.closest('.module-internal') || wpEl, e.clientX, e.clientY);
  if (!pt) return;

  state.editMode = 'drag-waypoint';
  state.editTarget = {
    wireKey, wpIdx, wpEl,
    startDesignX: pt.x,
    startDesignY: pt.y,
    origX: parseFloat(wpEl.getAttribute('cx')),
    origY: parseFloat(wpEl.getAttribute('cy')),
    originX: parseFloat(wpEl.getAttribute('data-waypoint-origin-x')) || 0,
    originY: parseFloat(wpEl.getAttribute('data-waypoint-origin-y')) || 0,
    coordinateElement: wpEl.closest('.module-internal') || wpEl,
  };
  $('canvas-container').style.cursor = 'move';
}

function onWaypointDragMove(e) {
  const t = state.editTarget;
  const pt = svgToElementCoords(t.coordinateElement, e.clientX, e.clientY);
  if (!pt || !t) return;

  const dx = pt.x - t.startDesignX;
  const dy = pt.y - t.startDesignY;
  t.wpEl.setAttribute('cx', t.origX + dx);
  t.wpEl.setAttribute('cy', t.origY + dy);
}

function onWaypointDragEnd(e) {
  const t = state.editTarget;
  if (!t) return;

  const pt = svgToElementCoords(t.coordinateElement, e.clientX, e.clientY);
  if (pt) {
    pushUndoSnapshot();
    const dx = pt.x - t.startDesignX;
    const dy = pt.y - t.startDesignY;
    const newX = t.origX + dx;
    const newY = t.origY + dy;

    const designName = state.activeTab;
    if (state.wireWaypoints[designName]?.[t.wireKey]?.[t.wpIdx]) {
      state.wireWaypoints[designName][t.wireKey][t.wpIdx] = {
        x: newX - t.originX,
        y: newY - t.originY,
      };
      saveWireWaypoints(designName, state.wireWaypoints[designName]);
    }
  }

  state.editMode = null;
  state.editTarget = null;
  $('canvas-container').style.cursor = 'grab';
  state.justFinishedDrag = true;
  setTimeout(() => { state.justFinishedDrag = false; }, 50);
  renderCanvas();
}

// ─── Wire tooltip ──────────────────────────────────────────────────────

let wireTooltipEl = null;
function showWireTooltip(el, signal) {
  if (!signal) return;
  if (!wireTooltipEl) {
    wireTooltipEl = document.createElement('div');
    wireTooltipEl.style.cssText = `
      position: fixed; background: #21262d; color: #4fc3f7; border: 1px solid #30363d;
      padding: 4px 8px; border-radius: 6px; font-size: 12px; pointer-events: none;
      z-index: 500; font-family: 'JetBrains Mono', monospace; box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    `;
    document.body.appendChild(wireTooltipEl);
  }
  wireTooltipEl.textContent = signal;
  wireTooltipEl.style.display = 'block';
  document.addEventListener('mousemove', moveWireTooltip);
}
function moveWireTooltip(e) {
  if (wireTooltipEl) {
    wireTooltipEl.style.left = (e.clientX + 12) + 'px';
    wireTooltipEl.style.top = (e.clientY - 20) + 'px';
  }
}
function hideWireTooltip() {
  if (wireTooltipEl) wireTooltipEl.style.display = 'none';
  document.removeEventListener('mousemove', moveWireTooltip);
}

function updateInfoPanel(modName, modules) {
  const panel = $('info-panel');
  const content = $('info-content');
  const mod = modules[modName];
  if (!mod) { panel.style.display = 'none'; return; }

  panel.style.display = '';
  // Hide settings button for default info view
  const settingsBtn = $('info-settings');
  if (settingsBtn) settingsBtn.style.display = 'none';
  state.settingsTarget = null;

  panel.style.display = '';
  const inP = mod.ports.filter(p => p.direction === 'input').length;
  const outP = mod.ports.filter(p => p.direction === 'output').length;
  const ioP = mod.ports.filter(p => p.direction === 'inout').length;

  content.innerHTML = `
    <span class="label">模块:</span> <span class="value">${modName}</span> &nbsp;
    <span class="label">输入:</span> <span class="value" style="color:#81c784">${inP}</span> &nbsp;
    <span class="label">输出:</span> <span class="value" style="color:#ef5350">${outP}</span>
    ${ioP > 0 ? ` &nbsp;<span class="label">双向:</span> <span class="value" style="color:#ffb74d">${ioP}</span>` : ''}
    &nbsp;<span class="label">子实例:</span> <span class="value">${mod.instances?.length || 0}</span>
    &nbsp;<span class="label">线网:</span> <span class="value">${mod.wires?.length || 0}</span>
    &nbsp;<span style="color:#484f58;font-size:11px;">| 单击线选中 | 双击线添加拐点 | 右键拐点删除 | 拖拽标题移动 | 右下角调整大小 | 滚轮缩放</span>`;
  // Hide waypoint panel when viewing module info
  const wpPanel = $('wp-panel');
  if (wpPanel) wpPanel.style.display = 'none';
}

function showWireInfoPanel(wireKey, signal) {
  const panel = $('info-panel');
  const content = $('info-content');
  panel.style.display = '';

  // Show settings button for wire customization
  const settingsBtn = $('info-settings');
  if (settingsBtn) settingsBtn.style.display = '';
  state.settingsTarget = { type: 'wire', key: wireKey };

  // Parse wireKey: "inst.port→inst.port"
  const parts = wireKey.split('→');
  const srcParts = parts[0]?.split('.') || [];
  const dstParts = parts[1]?.split('.') || [];
  const srcInst = srcParts[0] || '?';
  const srcPort = srcParts.slice(1).join('.') || '?';
  const dstInst = dstParts[0] || '?';
  const dstPort = dstParts.slice(1).join('.') || '?';

  const tab = state.openTabs.find(t => t.name === state.activeTab);
  const wps = tab ? (state.wireWaypoints[tab.name]?.[wireKey] || []) : [];

  content.innerHTML = `
    <span class="label">🔌 线路:</span> <span class="value" style="color:#4fc3f7">${signal || wireKey}</span> &nbsp;
    <span class="label">源:</span> <span class="value" style="color:#ef5350">${srcInst}</span>.<span class="value">${srcPort}</span> &nbsp;
    <span class="label">→ 目标:</span> <span class="value" style="color:#81c784">${dstInst}</span>.<span class="value">${dstPort}</span>
    &nbsp;<span class="label">拐点:</span> <span class="value">${wps.length}</span>
    &nbsp;<span style="color:#484f58;font-size:11px;">| 双击添加拐点 | 右键拐点删除 | 单击空白取消选中</span>`;

  updateWaypointPanel(wireKey, signal);
}

// ─── Waypoint management panel ──────────────────────────────────────────

let wpPanelExpanded = false;

function updateWaypointPanel(wireKey, signal) {
  const wpPanel = $('wp-panel');
  const wpBody = $('wp-panel-body');
  const wpTitle = $('wp-panel-title');
  const wpArrow = $('wp-panel-arrow');
  if (!wpPanel) return;

  if (!wireKey) { wpPanel.style.display = 'none'; return; }
  wpPanel.style.display = '';

  const tab = state.openTabs.find(t => t.name === state.activeTab);
  const wps = tab ? (state.wireWaypoints[tab.name]?.[wireKey] || []) : [];
  wpTitle.textContent = `拐点 (${wps.length})`;
  wpArrow.textContent = wpPanelExpanded ? '▼' : '▶';
  wpBody.style.display = wpPanelExpanded ? '' : 'none';

  // Setup toggle  
  const header = $('wp-panel-header');
  header.onclick = () => {
    wpPanelExpanded = !wpPanelExpanded;
    wpArrow.textContent = wpPanelExpanded ? '▼' : '▶';
    wpBody.style.display = wpPanelExpanded ? '' : 'none';
    if (wpPanelExpanded) renderWaypointList(wireKey, signal);
  };

  if (wpPanelExpanded) renderWaypointList(wireKey, signal);
}

function renderWaypointList(wireKey, signal) {
  const wpBody = $('wp-panel-body');
  if (!wpBody || !wireKey) return;

  const tab = state.openTabs.find(t => t.name === state.activeTab);
  const wps = tab ? (state.wireWaypoints[tab.name]?.[wireKey] || []) : [];
  const svgRoot = getSVGRoot();

  // Clear highlight on all waypoints
  svgRoot.querySelectorAll('.wire-waypoint').forEach(el => el.style.outline = '');

  if (wps.length === 0) {
    wpBody.innerHTML = '<span style="color:#484f58;font-size:11px;">暂无拐点，双击线添加</span>';
    return;
  }

  wpBody.innerHTML = '';
  wps.forEach((wp, i) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:4px;padding:2px 0;border-bottom:1px solid #21262d;';
    row.innerHTML = `
      <span style="color:#ffb74d;font-size:11px;min-width:18px;text-align:right;">${i + 1}</span>
      <span style="color:#8b949e;font-size:11px;flex:1;">(${wp.x.toFixed(1)}, ${wp.y.toFixed(1)})</span>
      <button data-act="up"   title="上移" style="background:none;border:none;color:#8b949e;cursor:pointer;padding:0 2px;font-size:12px;${i === 0 ? 'opacity:0.25;cursor:default;' : ''}" ${i === 0 ? 'disabled' : ''}>▲</button>
      <button data-act="down" title="下移" style="background:none;border:none;color:#8b949e;cursor:pointer;padding:0 2px;font-size:12px;${i === wps.length - 1 ? 'opacity:0.25;cursor:default;' : ''}" ${i === wps.length - 1 ? 'disabled' : ''}>▼</button>
      <button data-act="del"  title="删除" style="background:none;border:none;color:#ef5350;cursor:pointer;padding:0 2px;font-size:12px;">✕</button>`;

    // Highlight corresponding circle on hover
    row.addEventListener('mouseenter', () => {
      const circle = svgRoot.querySelector(`.wire-waypoint[data-wire-key="${CSS.escape(wireKey)}"][data-wp-index="${i}"]`);
      if (circle) { circle.setAttribute('r', LAYOUT?.WAYPOINT_R ? LAYOUT.WAYPOINT_R * 1.8 : 9); circle.style.fill = '#ffeb3b'; }
    });
    row.addEventListener('mouseleave', () => {
      const circle = svgRoot.querySelector(`.wire-waypoint[data-wire-key="${CSS.escape(wireKey)}"][data-wp-index="${i}"]`);
      if (circle) { circle.setAttribute('r', LAYOUT?.WAYPOINT_R || 5); circle.style.fill = ''; }
    });

    // Click to pan/zoom to waypoint
    row.querySelector('span:nth-child(2)').style.cursor = 'pointer';
    row.querySelector('span:nth-child(2)').addEventListener('click', () => {
      const container = $('canvas-container');
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      state.pan.x = cw / 2 - wp.x * state.zoom;
      state.pan.y = ch / 2 - wp.y * state.zoom;
      applyTransform();
      if (state.activeTab) saveViewState(state.activeTab, { pan: { ...state.pan }, zoom: state.zoom });
    });

    row.querySelector('[data-act="up"]').addEventListener('click', () => {
      if (i === 0) return;
      pushUndoSnapshot();
      const arr = state.wireWaypoints[tab.name][wireKey];
      [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
      saveWireWaypoints(tab.name, state.wireWaypoints[tab.name]);
      renderCanvas();
      renderWaypointList(wireKey, signal);
    });
    row.querySelector('[data-act="down"]').addEventListener('click', () => {
      if (i >= wps.length - 1) return;
      pushUndoSnapshot();
      const arr = state.wireWaypoints[tab.name][wireKey];
      [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
      saveWireWaypoints(tab.name, state.wireWaypoints[tab.name]);
      renderCanvas();
      renderWaypointList(wireKey, signal);
    });
    row.querySelector('[data-act="del"]').addEventListener('click', () => {
      pushUndoSnapshot();
      state.wireWaypoints[tab.name][wireKey].splice(i, 1);
      if (state.wireWaypoints[tab.name][wireKey].length === 0)
        delete state.wireWaypoints[tab.name][wireKey];
      saveWireWaypoints(tab.name, state.wireWaypoints[tab.name]);
      renderCanvas();
      // Refresh wire info after delete
      showWireInfoPanel(wireKey, signal);
    });

    // Drag-to-reorder row via HTML5 drag
    row.draggable = true;
    row.dataset.idx = i;
    row.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', i); row.style.opacity = '0.5'; });
    row.addEventListener('dragend', () => { row.style.opacity = ''; });
    row.addEventListener('dragover', e => { e.preventDefault(); row.style.background = '#30363d'; });
    row.addEventListener('dragleave', () => { row.style.background = ''; });
    row.addEventListener('drop', e => {
      e.preventDefault(); row.style.background = '';
      const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
      const toIdx = i;
      if (fromIdx === toIdx) return;
      pushUndoSnapshot();
      const arr = state.wireWaypoints[tab.name][wireKey];
      const [moved] = arr.splice(fromIdx, 1);
      arr.splice(toIdx, 0, moved);
      saveWireWaypoints(tab.name, state.wireWaypoints[tab.name]);
      renderCanvas();
      renderWaypointList(wireKey, signal);
    });

    wpBody.appendChild(row);
  });
}

function closeInfoPanel() {
  $('info-panel').style.display = 'none';
  const wpPanel = $('wp-panel');
  if (wpPanel) wpPanel.style.display = 'none';
  const settingsBtn = $('info-settings');
  if (settingsBtn) settingsBtn.style.display = 'none';
  state.settingsTarget = null;
}

// ─── Pan & Zoom ─────────────────────────────────────────────────────────

function initPanZoom() {
  const container = $('canvas-container');
  const svg = getSVG();

  container.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    // If we're already in an edit mode, don't start panning
    if (state.editMode) return;
    // Only pan on background clicks
    const tag = e.target.tagName.toLowerCase();
    if (tag === 'svg' || e.target === container || e.target.id === 'main-svg') {
      clearActiveCommentBlock();
      // Shift+click starts box selection
      if (e.shiftKey) {
        const pt = svgToDesignCoords(e.clientX, e.clientY);
        if (pt) {
          state.boxSelecting = true;
          state.boxSelectStart = pt;
          state.boxSelectCurrent = pt;
          container.style.cursor = 'crosshair';
          e.preventDefault();
          return;
        }
      }
      state.dragging = true;
      state.dragStart = { x: e.clientX, y: e.clientY };
      state.panStart = { ...state.pan };
      container.style.cursor = 'grabbing';
      e.preventDefault();
    }
  });

  window.addEventListener('mousemove', e => {
    // Route to edit mode handlers
    if (state.editMode === 'drag-module') { onModuleDragMove(e); return; }
    if (state.editMode === 'resize-module') { onModuleResizeMove(e); return; }
    if (state.editMode === 'drag-waypoint') { onWaypointDragMove(e); return; }
    if (state.editMode === 'drag-comment-block') { onCommentBlockDragMove(e); return; }
    if (state.editMode === 'resize-comment-block') { onCommentBlockResizeMove(e); return; }
    if (state.editMode === 'drag-box-selection') { onBoxSelectionDragMove(e); return; }
    if (state.editMode === 'resize-box-selection') { onBoxSelectionResizeMove(e); return; }
    // Box selecting (rubber-band)
    if (state.boxSelecting) {
      const pt = svgToDesignCoords(e.clientX, e.clientY);
      if (pt) {
        state.boxSelectCurrent = pt;
        drawBoxSelectionRect();
      }
      return;
    }
    // Normal pan
    if (!state.dragging) return;
    state.pan.x = state.panStart.x + (e.clientX - state.dragStart.x);
    state.pan.y = state.panStart.y + (e.clientY - state.dragStart.y);
    applyTransform();
  });

  window.addEventListener('mouseup', e => {
    // Route to edit mode end handlers
    if (state.editMode === 'drag-module') { onModuleDragEnd(e); return; }
    if (state.editMode === 'resize-module') { onModuleResizeEnd(e); return; }
    if (state.editMode === 'drag-waypoint') { onWaypointDragEnd(e); return; }
    if (state.editMode === 'drag-comment-block') { onCommentBlockDragEnd(e); return; }
    if (state.editMode === 'resize-comment-block') { onCommentBlockResizeEnd(e); return; }
    if (state.editMode === 'drag-box-selection') { onBoxSelectionDragEnd(e); return; }
    if (state.editMode === 'resize-box-selection') { onBoxSelectionResizeEnd(e); return; }
    // Box selection end
    if (state.boxSelecting) {
      finalizeBoxSelection();
      return;
    }
    // Normal pan end
    if (state.dragging) {
      state.dragging = false;
      $('canvas-container').style.cursor = 'grab';
      state.justFinishedDrag = true;
      setTimeout(() => { state.justFinishedDrag = false; }, 50);
      // Save view state
      if (state.activeTab) {
        saveViewState(state.activeTab, { pan: { ...state.pan }, zoom: state.zoom });
      }
    }
  });

  container.addEventListener('wheel', e => {
    e.preventDefault();
    const scale = e.deltaY < 0 ? 1.1 : 0.9;
    const newZoom = Math.max(0.05, Math.min(8, state.zoom * scale));

    const rect = getSVG().getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    state.pan.x = cx - (cx - state.pan.x) * (newZoom / state.zoom);
    state.pan.y = cy - (cy - state.pan.y) * (newZoom / state.zoom);
    state.zoom = newZoom;
    applyTransform();
    // Save view state
    if (state.activeTab) {
      saveViewState(state.activeTab, { pan: { ...state.pan }, zoom: state.zoom });
    }
  }, { passive: false });

  // ── Keyboard shortcuts: Ctrl+Z undo, Ctrl+Y / Ctrl+Shift+Z redo ──
  document.addEventListener('keydown', e => {
    // Don't intercept if user is typing in an input/textarea
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      doUndo();
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
      e.preventDefault();
      doRedo();
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'Z') {
      e.preventDefault();
      doRedo();
    } else if (e.altKey && e.key === 'ArrowLeft') {
      e.preventDefault();
      viewHistoryBack();
    } else if (e.altKey && e.key === 'ArrowRight') {
      e.preventDefault();
      viewHistoryForward();
    } else if (e.altKey && e.key === 'ArrowUp') {
      e.preventDefault();
      viewHistoryUp();
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey &&
               e.key.toLowerCase() === (state.canvasControls.helpKey || 'h').toLowerCase()) {
      e.preventDefault();
      const _helpOverlay = $('shortcut-help-overlay');
      if (_helpOverlay && _helpOverlay.style.display !== 'none') closeShortcutHelp();
      else showShortcutHelp();
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey &&
               e.key.toLowerCase() === (state.canvasControls.fitKey || 'y').toLowerCase()) {
      e.preventDefault();
      fitToView();
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey &&
               e.key.toLowerCase() === (state.canvasControls.sidebarKey || 'c').toLowerCase()) {
      e.preventDefault();
      toggleSidebar();
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey &&
               e.key.toLowerCase() === (state.canvasControls.treeFullKey || 'x').toLowerCase()) {
      e.preventDefault();
      toggleTreeFullscreen();
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey &&
               e.key.toLowerCase() === (state.canvasControls.fullscreenKey || 'z').toLowerCase()) {
      e.preventDefault();
      toggleFullscreen();
    }
  });

  // ── WASD pan / nudge  +  configurable zoom keys ─────────────────────
  const _heldKeys = new Set();
  let _rafId = null;

  const _tickKeys = () => {
    if (_heldKeys.size === 0) { _rafId = null; return; }
    const cc = state.canvasControls;
    const hasW = _heldKeys.has('w'), hasS = _heldKeys.has('s');
    const hasA = _heldKeys.has('a'), hasD = _heldKeys.has('d');
    const keyIn  = (cc.zoomKeyIn  || '[').toLowerCase();
    const keyOut = (cc.zoomKeyOut || ']').toLowerCase();
    const hasIn  = _heldKeys.has(keyIn);
    const hasOut = _heldKeys.has(keyOut);
    let didSomething = false;

    if (hasIn || hasOut) {
      const factor = hasIn ? (1 + cc.zoomStepPct / 100) : (1 - cc.zoomStepPct / 100);
      const container = $('canvas-container');
      const cx = container ? container.clientWidth / 2 : 0;
      const cy = container ? container.clientHeight / 2 : 0;
      const newZoom = Math.max(0.05, Math.min(10, state.zoom * factor));
      state.pan.x = cx - (cx - state.pan.x) * (newZoom / state.zoom);
      state.pan.y = cy - (cy - state.pan.y) * (newZoom / state.zoom);
      state.zoom = newZoom;
      applyTransform();
      didSomething = true;
    }

    const dx = (hasD ? 1 : 0) - (hasA ? 1 : 0);
    const dy = (hasS ? 1 : 0) - (hasW ? 1 : 0);
    if (dx !== 0 || dy !== 0) {
      const step = cc.wasdStep;
      const sel = state.boxSelection?.items;
      const activeBlock = getActiveCommentBlock();
      if (sel && sel.size > 0) {
        const designName = state.activeTab;
        if (designName && state.layoutOverrides[designName]) {
          const svgRoot = getSVGRoot();
          sel.forEach(renderPath => {
            const box = svgRoot?.querySelector(
              `.module-box[data-render-path="${CSS.escape(renderPath)}"]`
            );
            if (!box) return;
            const m = box.getAttribute('transform')?.match(/translate\(\s*([\d.e+-]+)\s*,\s*([\d.e+-]+)\s*\)/);
            if (!m) return;
            const layoutKey = box.getAttribute('data-layout-key') || box.getAttribute('data-instance');
            const instanceName = box.getAttribute('data-instance') || '';
            const originX = parseFloat(box.getAttribute('data-layout-origin-x')) || 0;
            const originY = parseFloat(box.getAttribute('data-layout-origin-y')) || 0;
            const ovr = getLayoutOverrideForInstance(designName, layoutKey, instanceName);
            ovr.x = parseFloat(m[1]) + dx * step - originX;
            ovr.y = parseFloat(m[2]) + dy * step - originY;
            state.layoutOverrides[designName][layoutKey] = ovr;
          });
          if (state.boxSelection?.queryRect) {
            const qr = state.boxSelection.queryRect;
            state.boxSelection.queryRect = {
              x1: qr.x1 + dx * step,
              y1: qr.y1 + dy * step,
              x2: qr.x2 + dx * step,
              y2: qr.y2 + dy * step,
            };
          }
          renderCanvas();
          saveLayout(designName, state.layoutOverrides[designName]);
        }
      } else if (activeBlock) {
        activeBlock.block.x += dx * step;
        activeBlock.block.y += dy * step;
        saveCustomizations(state.activeTab, state.customizations[state.activeTab]);
        scheduleSyncToServer(state.activeTab);
        renderCanvas();
      } else {
        state.pan.x -= dx * step;
        state.pan.y -= dy * step;
        applyTransform();
        if (state.activeTab) saveViewState(state.activeTab, { pan: { ...state.pan }, zoom: state.zoom });
      }
      didSomething = true;
    }

    if (didSomething || _heldKeys.size > 0) _rafId = requestAnimationFrame(_tickKeys);
    else _rafId = null;
  };

  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    const cc = state.canvasControls;
    const validKeys = ['w','a','s','d',
      (cc.zoomKeyIn  || '[').toLowerCase(),
      (cc.zoomKeyOut || ']').toLowerCase()];
    if (validKeys.includes(k)) {
      e.preventDefault();
      _heldKeys.add(k);
      if (!_rafId) _rafId = requestAnimationFrame(_tickKeys);
    }
  });

  document.addEventListener('keyup', e => {
    _heldKeys.delete(e.key.toLowerCase());
  });
}

function _saveCanvasControls() {
  if (state.activeTab) scheduleSyncToServer(state.activeTab);
}

function showShortcutHelp() {
  const overlay = $('shortcut-help-overlay');
  if (!overlay) return;
  const cc = state.canvasControls;
  const kbdStyle     = 'background:#21262d;border:1px solid #30363d;border-radius:4px;padding:2px 7px;font-family:monospace;font-size:12px;';
  const thStyle      = 'text-align:left;color:#8b949e;font-weight:500;padding:4px 8px 8px 0;border-bottom:1px solid #30363d;';
  const th2Style     = 'text-align:left;color:#8b949e;font-weight:500;padding:4px 0 8px 8px;border-bottom:1px solid #30363d;';
  const tdStyle      = 'padding:6px 8px 6px 0;vertical-align:top;white-space:nowrap;';
  const td2Style     = 'padding:6px 0 6px 8px;vertical-align:top;';
  const bindBtnStyle = `${kbdStyle}cursor:pointer;color:#58a6ff;min-width:32px;text-align:center;`;
  const sectionHead  = txt =>
    `<div style="color:#6e7681;font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;margin:0 0 8px;">${txt}</div>`;
  const sliderRow = (idSlider, idNum, min, max, val, unit) =>
    `<div style="display:flex;align-items:center;gap:6px;margin-top:5px;">
      <input type="range" id="${idSlider}" min="${min}" max="${max}" value="${val}"
        style="flex:1;accent-color:#58a6ff;cursor:pointer;">
      <input type="number" id="${idNum}" min="${min}" max="${max}" value="${val}"
        style="width:46px;background:#0d1117;border:1px solid #30363d;border-radius:4px;color:#c9d1d9;font-size:12px;padding:2px 4px;text-align:center;">
      ${unit ? `<span style="color:#8b949e;font-size:11px;">${unit}</span>` : ''}
    </div>`;

  overlay.innerHTML = `
    <div style="background:#161b22;border:1px solid #30363d;border-radius:10px;padding:24px 28px;min-width:420px;max-width:540px;color:#c9d1d9;font-size:13px;max-height:90vh;overflow-y:auto;scrollbar-gutter:stable;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;">
        <h3 style="margin:0;color:#e6edf3;font-size:15px;">⌨ 快捷键说明</h3>
        <button onclick="closeShortcutHelp()" style="background:none;border:none;color:#8b949e;font-size:18px;cursor:pointer;padding:0 4px;line-height:1;" title="关闭">✕</button>
      </div>
      ${sectionHead('⚙ 可自定义按键')}
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
        <tbody>
          <tr>
            <td style="${tdStyle}"><kbd style="${kbdStyle}">W A S D</kbd></td>
            <td style="${td2Style}">移动画布 / 微调选中模块位置
              ${sliderRow('cc-wasd-slider', 'cc-wasd-num', 5, 40, cc.wasdStep, '速度')}
            </td>
          </tr>
          <tr>
            <td style="${tdStyle}"><button id="cc-key-in-btn" style="${bindBtnStyle}" title="点击重新绑定">${escHtml(cc.zoomKeyIn)}</button></td>
            <td style="${td2Style}">放大视图 <span style="color:#484f58;font-size:11px;">（点击按键重新绑定）</span></td>
          </tr>
          <tr>
            <td style="${tdStyle}"><button id="cc-key-out-btn" style="${bindBtnStyle}" title="点击重新绑定">${escHtml(cc.zoomKeyOut)}</button></td>
            <td style="${td2Style}">缩小视图 <span style="color:#484f58;font-size:11px;">（点击按键重新绑定）</span>
              ${sliderRow('cc-zoom-slider', 'cc-zoom-num', 3, 10, cc.zoomStepPct, '%/帧')}
            </td>
          </tr>
          <tr>
            <td style="${tdStyle}"><button id="cc-key-help-btn" style="${bindBtnStyle}" title="点击重新绑定">${escHtml(cc.helpKey)}</button></td>
            <td style="${td2Style}">打开/关闭快捷键说明 <span style="color:#484f58;font-size:11px;">（点击按键重新绑定）</span></td>
          </tr>
          <tr>
            <td style="${tdStyle}"><button id="cc-key-fit-btn" style="${bindBtnStyle}" title="点击重新绑定">${escHtml(cc.fitKey)}</button></td>
            <td style="${td2Style}">适应视图 <span style="color:#484f58;font-size:11px;">（点击按键重新绑定）</span></td>
          </tr>
          <tr>
            <td style="${tdStyle}"><button id="cc-key-sidebar-btn" style="${bindBtnStyle}" title="点击重新绑定">${escHtml(cc.sidebarKey)}</button></td>
            <td style="${td2Style}">收起/展开侧边栏 <span style="color:#484f58;font-size:11px;">（点击按键重新绑定）</span></td>
          </tr>
          <tr>
            <td style="${tdStyle}"><button id="cc-key-treefull-btn" style="${bindBtnStyle}" title="点击重新绑定">${escHtml(cc.treeFullKey)}</button></td>
            <td style="${td2Style}">模块树全屏/取消全屏 <span style="color:#484f58;font-size:11px;">（点击按键重新绑定）</span></td>
          </tr>
          <tr>
            <td style="${tdStyle}"><button id="cc-key-fullscreen-btn" style="${bindBtnStyle}" title="点击重新绑定">${escHtml(cc.fullscreenKey)}</button></td>
            <td style="${td2Style}">应用全屏/取消全屏 <span style="color:#484f58;font-size:11px;">（点击按键重新绑定）</span></td>
          </tr>
        </tbody>
      </table>
      ${sectionHead('📋 快捷键一览')}
      <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
        <thead><tr><th style="${thStyle}">按键</th><th style="${th2Style}">功能</th></tr></thead>
        <tbody>
          <tr><td style="${tdStyle}"><kbd style="${kbdStyle}">W A S D</kbd></td><td style="${td2Style}">移动画布 / 微调选中模块位置</td></tr>
          <tr><td style="${tdStyle}"><kbd style="${kbdStyle}">单击模块</kbd></td><td style="${td2Style}">选中单个模块，用 W/A/S/D 微调</td></tr>
          <tr><td style="${tdStyle}"><kbd style="${kbdStyle}">Shift + 单击模块</kbd></td><td style="${td2Style}">连续增删多个选中模块，一起微调</td></tr>
          <tr><td style="${tdStyle}"><kbd style="${kbdStyle}">Ctrl + 单击模块</kbd></td><td style="${td2Style}">用当前选区和目标模块拟合外框，并自动选中框内模块/拐点</td></tr>
          <tr><td style="${tdStyle}"><kbd style="${kbdStyle}">Shift + 空白拖拽</kbd></td><td style="${td2Style}">框选模块和线拐点</td></tr>
          <tr><td style="${tdStyle}"><kbd style="${kbdStyle}">Shift + 拖拽注释块</kbd></td><td style="${td2Style}">移动注释块及其框内模块/拐点</td></tr>
          <tr><td style="${tdStyle}"><kbd style="${kbdStyle}">${escHtml(cc.zoomKeyIn)}</kbd></td><td style="${td2Style}">放大视图</td></tr>
          <tr><td style="${tdStyle}"><kbd style="${kbdStyle}">${escHtml(cc.zoomKeyOut)}</kbd></td><td style="${td2Style}">缩小视图</td></tr>
          <tr><td style="${tdStyle}"><kbd style="${kbdStyle}">${escHtml(cc.helpKey)}</kbd></td><td style="${td2Style}">打开/关闭快捷键说明</td></tr>
          <tr><td style="${tdStyle}"><kbd style="${kbdStyle}">${escHtml(cc.fitKey)}</kbd></td><td style="${td2Style}">适应视图</td></tr>
          <tr><td style="${tdStyle}"><kbd style="${kbdStyle}">${escHtml(cc.sidebarKey)}</kbd></td><td style="${td2Style}">收起/展开侧边栏</td></tr>
          <tr><td style="${tdStyle}"><kbd style="${kbdStyle}">${escHtml(cc.treeFullKey)}</kbd></td><td style="${td2Style}">模块树全屏/取消全屏</td></tr>
          <tr><td style="${tdStyle}"><kbd style="${kbdStyle}">${escHtml(cc.fullscreenKey)}</kbd></td><td style="${td2Style}">应用全屏/取消全屏</td></tr>
          <tr><td style="${tdStyle}"><kbd style="${kbdStyle}">Ctrl+Z</kbd></td><td style="${td2Style}">撤销</td></tr>
          <tr><td style="${tdStyle}"><kbd style="${kbdStyle}">Ctrl+Y / Ctrl+Shift+Z</kbd></td><td style="${td2Style}">重做</td></tr>
          <tr><td style="${tdStyle}"><kbd style="${kbdStyle}">Alt + ← →</kbd></td><td style="${td2Style}">视图历史 前进/后退</td></tr>
          <tr><td style="${tdStyle}"><kbd style="${kbdStyle}">Alt + ↑</kbd></td><td style="${td2Style}">跳转到上级模块</td></tr>
          <tr><td style="${tdStyle}"><kbd style="${kbdStyle}">滚轮</kbd></td><td style="${td2Style}">缩放（以鼠标为中心）</td></tr>
          <tr><td style="${tdStyle}"><kbd style="${kbdStyle}">中键拖拽</kbd></td><td style="${td2Style}">平移画布</td></tr>
          <tr><td style="${tdStyle}"><kbd style="${kbdStyle}">框选 + 拖拽</kbd></td><td style="${td2Style}">批量选中并移动模块</td></tr>
          <tr><td style="${tdStyle}"><kbd style="${kbdStyle}">框选 + 注</kbd></td><td style="${td2Style}">转换为永久注释块</td></tr>
          <tr><td style="${tdStyle}"><kbd style="${kbdStyle}">双击模块</kbd></td><td style="${td2Style}">进入子模块视图</td></tr>
          <tr><td style="${tdStyle}"><kbd style="${kbdStyle}">右键模块</kbd></td><td style="${td2Style}">显示注释（如有）</td></tr>
          <tr><td style="${tdStyle}"><kbd style="${kbdStyle}">⚙ 图标</kbd></td><td style="${td2Style}">打开模块设置（颜色/注释/端口/寄存器）</td></tr>
        </tbody>
      </table>
      <div style="text-align:right;">
        <button onclick="closeShortcutHelp()" style="background:#21262d;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;padding:6px 16px;cursor:pointer;font-size:13px;">关闭</button>
      </div>
    </div>`;

  overlay.style.display = 'flex';

  // ── Bind sliders + number inputs ──
  const syncPair = (sliderId, numId, min, max, setter) => {
    const sl = document.getElementById(sliderId);
    const nm = document.getElementById(numId);
    if (!sl || !nm) return;
    const clamp = v => Math.max(min, Math.min(max, v));
    sl.addEventListener('input', () => { const v = clamp(parseInt(sl.value)); nm.value = v; setter(v); _saveCanvasControls(); });
    nm.addEventListener('change', () => { const v = clamp(parseInt(nm.value) || min); sl.value = v; nm.value = v; setter(v); _saveCanvasControls(); });
  };
  syncPair('cc-wasd-slider', 'cc-wasd-num', 5, 40, v => state.canvasControls.wasdStep    = v);
  syncPair('cc-zoom-slider', 'cc-zoom-num', 3, 10, v => state.canvasControls.zoomStepPct = v);

  // ── Rebind keys ──
  const makeRebindBtn = (btnId, which) => {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener('click', () => {
      btn.textContent = '…';
      btn.style.color = '#f0883e';
      const handler = e => {
        e.preventDefault();
        e.stopPropagation();
        const key = e.key;
        if (key === 'Escape') { btn.textContent = escHtml(state.canvasControls[which]); btn.style.color = '#58a6ff'; }
        else {
          state.canvasControls[which] = key;
          btn.textContent = escHtml(key);
          btn.style.color = '#58a6ff';
          _saveCanvasControls();
        }
        document.removeEventListener('keydown', handler, true);
      };
      document.addEventListener('keydown', handler, true);
    });
  };
  makeRebindBtn('cc-key-in-btn',      'zoomKeyIn');
  makeRebindBtn('cc-key-out-btn',     'zoomKeyOut');
  makeRebindBtn('cc-key-help-btn',    'helpKey');
  makeRebindBtn('cc-key-fit-btn',     'fitKey');
  makeRebindBtn('cc-key-sidebar-btn',    'sidebarKey');
  makeRebindBtn('cc-key-treefull-btn',   'treeFullKey');
  makeRebindBtn('cc-key-fullscreen-btn', 'fullscreenKey');
}
window.showShortcutHelp = showShortcutHelp;

function closeShortcutHelp() {
  const overlay = $('shortcut-help-overlay');
  if (overlay) overlay.style.display = 'none';
}
window.closeShortcutHelp = closeShortcutHelp;

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function applyTransform() {
  const root = getSVGRoot().querySelector('#design-root');
  if (root) {
    root.setAttribute('transform', `translate(${state.pan.x}, ${state.pan.y}) scale(${state.zoom})`);
  }
}

function fitToView() {
  const root = getSVGRoot().querySelector('#design-root');
  if (!root) return;
  try {
    const bbox = root.getBBox();
    if (bbox.width === 0 && bbox.height === 0) return;
    const container = $('canvas-container');
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    const pad = 60;
    const sx = (cw - pad * 2) / (bbox.width || 1);
    const sy = (ch - pad * 2) / (bbox.height || 1);
    state.zoom = Math.min(sx, sy, 2);
    state.pan.x = pad - bbox.x * state.zoom + (cw - bbox.width * state.zoom) / 2 - pad;
    state.pan.y = pad - bbox.y * state.zoom;
    applyTransform();
  } catch (e) {
    // getBBox can throw if element is not rendered
  }
}

// ─── Undo / Redo ────────────────────────────────────────────────────────

function pushUndoSnapshot() {
  const name = state.activeTab;
  if (!name) return;
  const snapshot = {
    layoutOverrides: JSON.parse(JSON.stringify(state.layoutOverrides[name] || {})),
    wireWaypoints: JSON.parse(JSON.stringify(state.wireWaypoints[name] || {})),
    inlineExpandedPaths: [...(state.inlineExpanded[name] || new Set())],
  };
  state.undoStack.push(snapshot);
  if (state.undoStack.length > state.maxUndoHistory) {
    state.undoStack.shift();
  }
  // Clear redo stack on new action
  state.redoStack = [];
}

function doUndo() {
  const name = state.activeTab;
  if (!name || state.undoStack.length === 0) {
    showToast('没有可撤销的操作', 'warn');
    return;
  }
  // Save current state to redo stack
  state.redoStack.push({
    layoutOverrides: JSON.parse(JSON.stringify(state.layoutOverrides[name] || {})),
    wireWaypoints: JSON.parse(JSON.stringify(state.wireWaypoints[name] || {})),
    inlineExpandedPaths: [...(state.inlineExpanded[name] || new Set())],
  });

  const snapshot = state.undoStack.pop();
  state.layoutOverrides[name] = snapshot.layoutOverrides;
  state.wireWaypoints[name] = snapshot.wireWaypoints;
  state.inlineExpanded[name] = new Set(snapshot.inlineExpandedPaths || []);
  saveLayout(name, state.layoutOverrides[name]);
  saveWireWaypoints(name, state.wireWaypoints[name]);
  saveInlineExpanded(name, state.inlineExpanded[name]);
  renderCanvas();
  if (state.selectedWireKey) showWireInfoPanel(state.selectedWireKey, state.selectedWireSignal);
  showToast('已撤销', 'info');
}

function doRedo() {
  const name = state.activeTab;
  if (!name || state.redoStack.length === 0) {
    showToast('没有可重做的操作', 'warn');
    return;
  }
  // Save current state to undo stack
  state.undoStack.push({
    layoutOverrides: JSON.parse(JSON.stringify(state.layoutOverrides[name] || {})),
    wireWaypoints: JSON.parse(JSON.stringify(state.wireWaypoints[name] || {})),
    inlineExpandedPaths: [...(state.inlineExpanded[name] || new Set())],
  });

  const snapshot = state.redoStack.pop();
  state.layoutOverrides[name] = snapshot.layoutOverrides;
  state.wireWaypoints[name] = snapshot.wireWaypoints;
  state.inlineExpanded[name] = new Set(snapshot.inlineExpandedPaths || []);
  saveLayout(name, state.layoutOverrides[name]);
  saveWireWaypoints(name, state.wireWaypoints[name]);
  saveInlineExpanded(name, state.inlineExpanded[name]);
  renderCanvas();
  if (state.selectedWireKey) showWireInfoPanel(state.selectedWireKey, state.selectedWireSignal);
  showToast('已重做', 'info');
}

// ─── Settings / Customization Modal ─────────────────────────────────────

function openSettingsPanel() {
  const target = state.settingsTarget;
  if (!target || !state.activeTab) return;

  const customs = normalizeCustomizations(state.customizations[state.activeTab] || {});
  const content = $('settings-content');
  content.innerHTML = '';

  // Collect unique colors already used in the current design (from module customizations)
  const usedColors = [...new Set(
    Object.values(customs.modules || {}).map(m => m.color).filter(c => c && c !== '#1c2333')
  )];

  // Build color swatch HTML for presets
  function buildSwatches(inputId) {
    if (usedColors.length === 0) return '';
    const swatches = usedColors.map(c =>
      `<span title="${c}" onclick="document.getElementById('${inputId}').value='${c}';document.getElementById('${inputId}-hex').value='${c}'" style="display:inline-block;width:20px;height:20px;border-radius:4px;background:${c};cursor:pointer;border:1px solid #30363d;flex-shrink:0;"></span>`
    ).join('');
    return `<div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;margin-top:4px;">${swatches}</div>`;
  }

  if (target.type === 'module') {
    const existing = customs.modules?.[target.key] || {};
    const modColor = existing.color || '#1c2333';

    // Look up module port info
    const modName = target.modName || '';
    const tab = state.openTabs.find(t => t.name === state.activeTab);
    const design = state.designs[state.activeTab];
    const mod = design?.modules?.[modName];
    const inPorts = mod?.ports?.filter(p => p.direction === 'input') || [];
    const outPorts = mod?.ports?.filter(p => p.direction === 'output') || [];

    // Helper: copy-to-clipboard button for port/reg names
    // Helper: copy-to-clipboard button — text label with checkmark feedback
    const copyBtn = (name) =>
      `<button onclick="navigator.clipboard.writeText('${name}');const b=this;b.textContent='✓';b.style.color='#3fb950';setTimeout(()=>{b.textContent='复制';b.style.color='#484f58'},1500);"
        style="background:none;border:1px solid #30363d;cursor:pointer;color:#484f58;font-size:10px;padding:1px 5px;border-radius:3px;display:inline-block;line-height:1.4;white-space:nowrap;min-width:28px;"
        onmouseover="this.style.borderColor='#8b949e';this.style.color='#c9d1d9'" onmouseout="this.style.borderColor='#30363d';this.style.color='#484f58'">复制</button>`;

    // Numeric-suffix grouping helper shared by port and register builders
    const numSuffixRe = /^(.+?)_(\d+)$/;
    const groupByNumSuffix = (items, nameKey) => {
      const groups = {};
      const ungrouped = [];
      for (const item of items) {
        const m = numSuffixRe.exec(item[nameKey]);
        if (m) {
          const prefix = m[1];
          if (!groups[prefix]) groups[prefix] = [];
          groups[prefix].push(item);
        } else {
          ungrouped.push(item);
        }
      }
      // Singletons fall back to ungrouped
      for (const [, v] of Object.entries(groups)) {
        if (v.length < 2) ungrouped.push(v[0]);
      }
      const groupEntries = Object.entries(groups).filter(([, v]) => v.length >= 2);
      return { ungrouped, groupEntries };
    };

    // Build port info HTML (shown on 端口 tab)
    const buildPortSection = (ports, sectionColor, sectionLabel) => {
      if (!ports.length) return '';
      const { ungrouped, groupEntries } = groupByNumSuffix(ports, 'name');

      const portRow = (p) => {
        const bitW = p.width > 1 ? `[${p.msb ?? p.width - 1}:${p.lsb ?? 0}]` : '1\u00a0bit';
        return `<tr>
          <td style="color:#c9d1d9;font-family:monospace;font-size:11px;padding:2px 4px 2px 0;white-space:nowrap;">${p.name}</td>
          <td style="width:36px;text-align:center;padding:0 2px;">${copyBtn(p.name)}</td>
          <td style="color:#8b949e;font-size:11px;padding:2px 0 2px 4px;white-space:nowrap;text-align:right;">${bitW}</td>
        </tr>`;
      };

      const portGroupBlock = (groupName, items) => {
        const p0 = items[0];
        const bitW = p0.width > 1 ? `[${p0.msb ?? p0.width - 1}:${p0.lsb ?? 0}]` : '1\u00a0bit';
        const uid = 'pgrp_' + CSS.escape(groupName);
        return `<tr class="reg-group-row" data-group="${groupName}">
            <td colspan="3" style="padding:2px 0;">
              <span onclick="const b=document.getElementById('${uid}');const open=b.style.display==='none';b.style.display=open?'':'none';this.textContent=open?'▼':'▶';"
                    style="cursor:pointer;color:#58a6ff;font-family:monospace;font-size:11px;user-select:none;">▶</span>
              <span style="color:#c9d1d9;font-family:monospace;font-size:11px;padding-left:4px;">${groupName}</span>
              <span style="color:#484f58;font-size:10px;padding-left:6px;">${items.length}\u00a0个</span>
              <span style="color:#8b949e;font-size:11px;padding-left:6px;">${bitW}</span>
              ${copyBtn(groupName)}
            </td>
          </tr>
          <tbody id="${uid}" style="display:none;">
            ${items.map(portRow).join('')}
          </tbody>`;
      };

      let rows = ungrouped.map(portRow).join('');
      for (const [gname, items] of groupEntries) rows += portGroupBlock(gname, items);

      return `<div style="margin-bottom:8px;">
        <span style="color:${sectionColor};font-size:11px;font-weight:600;">${sectionLabel} (${ports.length})</span>
        <table style="margin-top:4px;width:100%;border-collapse:collapse;">${rows}</table>
      </div>`;
    };

    let portInfoHtml = '';
    if (inPorts.length || outPorts.length) {
      portInfoHtml = buildPortSection(inPorts, '#81c784', '⬇ 输入')
                   + buildPortSection(outPorts, '#ef5350', '⬆ 输出');
    } else {
      portInfoHtml = `<div style="color:#484f58;font-size:12px;font-style:italic;">此模块没有端口</div>`;
    }

    const hasPorts = inPorts.length + outPorts.length > 0;

    // Build register list HTML (shown on 寄存器 tab)
    const regs = (mod?.wires || []).filter(w => w.is_reg);
    let regInfoHtml = '';
    let regGroupCount = 0;
    if (regs.length) {
      // Group registers: explicit arr_msb/arr_lsb arrays AND Chisel numeric-suffix groups (foo_0, foo_1 …)
      const arrRegs = regs.filter(r => r.arr_msb != null);
      const { ungrouped: chiselUngrouped, groupEntries: chiselGroupEntries } =
        groupByNumSuffix(regs.filter(r => r.arr_msb == null), 'name');
      const nonGrouped = chiselUngrouped;
      // Explicit array regs grouped by name
      const arrGroups = {};
      for (const r of arrRegs) {
        if (!arrGroups[r.name]) arrGroups[r.name] = [];
        arrGroups[r.name].push(r);
      }
      regGroupCount = chiselGroupEntries.length + Object.keys(arrGroups).length;

      const regRow = (r) => {
        const bitW = r.width > 1 ? `[${r.msb}:${r.lsb}]` : '1\u00a0bit';
        return `<tr>
          <td style="color:#c9d1d9;font-family:monospace;font-size:11px;padding:2px 4px 2px 0;white-space:nowrap;">${r.name}</td>
          <td style="width:36px;text-align:center;padding:0 2px;">${copyBtn(r.name)}</td>
          <td style="color:#8b949e;font-size:11px;padding:2px 0 2px 4px;white-space:nowrap;text-align:right;">${bitW}</td>
        </tr>`;
      };

      const makeGroupBlock = (groupName, items, extraLabel) => {
        const r0  = items[0];
        const bitW = r0.width > 1 ? `[${r0.msb}:${r0.lsb}]` : '1\u00a0bit';
        const uid  = 'arrg_' + CSS.escape(groupName);
        const detail = extraLabel || `${items.length}\u00a0items`;
        return `<tr class="reg-group-row" data-group="${groupName}">
            <td colspan="3" style="padding:2px 0;">
              <span onclick="const b=document.getElementById('${uid}');const open=b.style.display==='none';b.style.display=open?'':'none';this.textContent=open?'▼':'▶';"
                    style="cursor:pointer;color:#58a6ff;font-family:monospace;font-size:11px;user-select:none;">▶</span>
              <span style="color:#c9d1d9;font-family:monospace;font-size:11px;padding-left:4px;">${groupName}</span>
              <span style="color:#484f58;font-size:10px;padding-left:6px;">${detail}</span>
              <span style="color:#8b949e;font-size:11px;padding-left:6px;">${bitW}</span>
              ${copyBtn(groupName)}
            </td>
          </tr>
          <tbody id="${uid}" style="display:none;">
            ${items.map(r => regRow(r)).join('')}
          </tbody>`;
      };

      let rows = nonGrouped.map(regRow).join('');
      for (const [gname, items] of chiselGroupEntries) rows += makeGroupBlock(gname, items);
      for (const [gname, items] of Object.entries(arrGroups)) {
        const r0 = items[0];
        rows += makeGroupBlock(gname, items, `[${r0.arr_msb}:${r0.arr_lsb}]`);
      }
      regInfoHtml = `<table style="width:100%;border-collapse:collapse;">${rows}</table>`;
    } else {
      regInfoHtml = `<div style="color:#484f58;font-size:12px;font-style:italic;">此模块没有寄存器</div>`;
    }

    content.innerHTML = `
      <h4 style="color:#c9d1d9;margin-bottom:8px;">模块设置: ${target.key}</h4>
      <div class="bd-cust-tabs" style="margin-bottom:10px;">
        <button class="bd-cust-tab bd-cust-tab-active" onclick="vvSwitchSettingsTab(this,'vv-tab-basic')">基本设置</button>
        <button class="bd-cust-tab" onclick="vvSwitchSettingsTab(this,'vv-tab-ports')">端口信息${hasPorts ? ` (${inPorts.length}/${outPorts.length})` : ''}</button>
        <button class="bd-cust-tab" onclick="vvSwitchSettingsTab(this,'vv-tab-regs')">寄存器${regs.length ? ` (${regGroupCount ? `${regGroupCount}组/` : ''}${regs.length})` : ''}</button>
      </div>
      <div id="vv-tab-basic" style="display:flex;flex-direction:column;flex:1;min-height:0;">
        <div class="settings-row">
          <label>颜色</label>
          <input type="color" id="set-mod-color" value="${modColor}" oninput="document.getElementById('set-mod-color-hex').value=this.value" />
          <input type="text" id="set-mod-color-hex" value="${modColor}" maxlength="7" placeholder="#rrggbb"
            style="width:70px;padding:4px 6px;background:#0d1117;border:1px solid #30363d;border-radius:4px;color:#c9d1d9;font-size:12px;font-family:monospace;"
            oninput="if(/^#[0-9a-fA-F]{6}$/.test(this.value))document.getElementById('set-mod-color').value=this.value" />
          <button class="btn-secondary" onclick="document.getElementById('set-mod-color').value='#1c2333';document.getElementById('set-mod-color-hex').value='#1c2333'" style="padding:4px 8px;font-size:11px;">重置</button>
        </div>
        ${buildSwatches('set-mod-color')}
        <div class="settings-row" style="margin-top:10px;">
          <label>重命名</label>
          <input type="text" id="set-mod-rename" placeholder="自定义显示名称..." value="${existing.rename || ''}" />
        </div>
        <div class="settings-row settings-row-grow">
          <label>注释</label>
          <div style="flex:1;display:flex;flex-direction:column;gap:6px;min-height:0;">
            <textarea id="set-mod-comment" placeholder="支持 Markdown 格式..." style="flex:1;resize:none;min-height:60px;">${existing.comment || ''}</textarea>
            <button class="btn-secondary" onclick="document.getElementById('comment-file-input').click()" style="align-self:flex-start;padding:4px 10px;font-size:11px;">📂 导入 .md 文件</button>
          </div>
        </div>
      </div>
      <div id="vv-tab-ports" style="display:none;overflow-y:auto;flex:1;padding-top:4px;padding-right:8px;">
        <input type="text" placeholder="搜索端口…" oninput="vvFilterTable(this,'vv-tab-ports')"
          style="width:100%;box-sizing:border-box;margin-bottom:6px;padding:4px 8px;background:#0d1117;border:1px solid #30363d;border-radius:4px;color:#c9d1d9;font-size:11px;">
        ${portInfoHtml}
      </div>
      <div id="vv-tab-regs" style="display:none;overflow-y:auto;flex:1;padding-top:4px;padding-right:8px;">
        <input type="text" placeholder="搜索寄存器…" oninput="vvFilterTable(this,'vv-tab-regs')"
          style="width:100%;box-sizing:border-box;margin-bottom:6px;padding:4px 8px;background:#0d1117;border:1px solid #30363d;border-radius:4px;color:#c9d1d9;font-size:11px;">
        ${regInfoHtml}
      </div>`;
  } else if (target.type === 'wire') {
    const existing = customs.wires?.[target.key] || {};
    const wireColor = existing.color || '#4fc3f7';
    content.innerHTML = `
      <h4 style="color:#c9d1d9;margin-bottom:12px;">线路设置: ${target.key}</h4>
      <div class="settings-row">
        <label>颜色</label>
        <input type="color" id="set-wire-color" value="${wireColor}" oninput="document.getElementById('set-wire-color-hex').value=this.value" />
        <input type="text" id="set-wire-color-hex" value="${wireColor}" maxlength="7" placeholder="#rrggbb"
          style="width:70px;padding:4px 6px;background:#0d1117;border:1px solid #30363d;border-radius:4px;color:#c9d1d9;font-size:12px;font-family:monospace;"
          oninput="if(/^#[0-9a-fA-F]{6}$/.test(this.value))document.getElementById('set-wire-color').value=this.value" />
        <button class="btn-secondary" onclick="document.getElementById('set-wire-color').value='#4fc3f7';document.getElementById('set-wire-color-hex').value='#4fc3f7'" style="padding:4px 8px;font-size:11px;">重置</button>
      </div>
      ${buildSwatches('set-wire-color')}`;
  } else if (target.type === 'commentBlock') {
    const existing = customs.commentBlocks?.[target.key] || {};
    const title = getCommentBlockTitle(existing);
    const markdown = existing.markdown || '';
    content.innerHTML = `
      <h4 style="color:#c9d1d9;margin-bottom:8px;">注释块设置</h4>
      <div class="settings-row" style="margin-bottom:10px;">
        <label>标题</label>
        <input type="text" id="set-comment-block-title" class="vv-dark-input" placeholder="注释块标题..." value="${escHtml(title)}" />
      </div>
      <div class="bd-cust-tabs" style="margin-bottom:10px;">
        <button class="bd-cust-tab bd-cust-tab-active" onclick="vvSwitchSettingsTab(this,'vv-tab-comment-preview')">Markdown 预览</button>
        <button class="bd-cust-tab" onclick="vvSwitchSettingsTab(this,'vv-tab-comment-source')">Markdown 源码</button>
      </div>
      <div id="vv-tab-comment-preview" class="markdown-body" style="display:block;overflow:auto;flex:1;min-height:0;padding:10px 12px;background:#0d1117;border:1px solid #30363d;border-radius:6px;">
        <h2>${escHtml(title)}</h2>${renderMarkdownHtml(markdown) || '<span style="color:#484f58;">暂无内容</span>'}
      </div>
      <div id="vv-tab-comment-source" style="display:none;flex-direction:column;gap:8px;flex:1;min-height:0;">
        <textarea id="set-comment-block-markdown" class="vv-dark-textarea" placeholder="支持 Markdown 格式..." style="flex:1;resize:none;min-height:160px;">${escHtml(markdown)}</textarea>
        <div style="display:flex;gap:8px;align-items:center;">
          <button class="btn-secondary" onclick="document.getElementById('comment-file-input').click()" style="padding:4px 10px;font-size:11px;">📂 导入 .md 文件</button>
          <button class="btn-secondary" onclick="deleteCommentBlock('${target.key}')" style="padding:4px 10px;font-size:11px;color:#ff7b72;">删除注释块</button>
        </div>
      </div>`;
  }

  $('settings-overlay').style.display = 'flex';

  // Restore saved size
  const modal = $('settings-overlay').querySelector('.settings-modal');
  if (modal) {
    const saved = loadSettingsModalSize();
    modal.style.width = saved.w + 'px';
    modal.style.height = saved.h + 'px';
    initSettingsModalResize(modal);
  }
}

function closeSettingsModal() {
  $('settings-overlay').style.display = 'none';
}

function vvSwitchSettingsTab(btn, panelId) {
  const content = $('settings-content');
  if (!content) return;
  if (panelId === 'vv-tab-comment-preview') {
    const preview = $('vv-tab-comment-preview');
    const source = $('set-comment-block-markdown');
    const title = $('set-comment-block-title')?.value?.trim();
    if (preview && source) {
      const titleHtml = title ? `<h2>${escHtml(title)}</h2>` : '';
      preview.innerHTML = titleHtml + (renderMarkdownHtml(source.value) || '<span style="color:#484f58;">暂无内容</span>');
    }
  }
  content.querySelectorAll('.bd-cust-tab').forEach(t => t.classList.remove('bd-cust-tab-active'));
  btn.classList.add('bd-cust-tab-active');
  content.querySelectorAll('[id^="vv-tab-"]').forEach(el => {
    const show = el.id === panelId;
    const flexTabs = new Set(['vv-tab-basic', 'vv-tab-comment-source']);
    el.style.display = show ? (flexTabs.has(el.id) ? 'flex' : 'block') : 'none';
  });
}

function vvFilterTable(input, panelId) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  const q = input.value.toLowerCase().trim();

  // Handle group rows (collapsible register groups)
  panel.querySelectorAll('tr.reg-group-row').forEach(groupRow => {
    const tbody = groupRow.nextElementSibling;
    if (!tbody || tbody.tagName !== 'TBODY') return;
    if (!q) {
      groupRow.style.display = '';
      tbody.querySelectorAll('tr').forEach(r => { r.style.display = ''; });
      return;
    }
    const groupText = groupRow.textContent.toLowerCase();
    let anyMatch = groupText.includes(q);
    tbody.querySelectorAll('tr').forEach(r => {
      const match = r.textContent.toLowerCase().includes(q);
      r.style.display = match ? '' : 'none';
      if (match) anyMatch = true;
    });
    groupRow.style.display = anyMatch ? '' : 'none';
    // Auto-expand the group if any child matches
    if (anyMatch && tbody.style.display === 'none') tbody.style.display = '';
  });

  // Handle plain (non-group) rows — skip rows inside group tbodies
  panel.querySelectorAll('table').forEach(tbl => {
    tbl.querySelectorAll('tr:not(.reg-group-row)').forEach(tr => {
      if (tr.closest('tbody') && tr.closest('tbody') !== tr.parentElement) return;
      // Only process rows directly in a plain <tbody> (not a collapsible one)
      const parentTbody = tr.parentElement;
      const isGroupChild = parentTbody && parentTbody.tagName === 'TBODY' &&
        parentTbody.previousElementSibling &&
        parentTbody.previousElementSibling.classList.contains('reg-group-row');
      if (isGroupChild) return; // already handled above
      tr.style.display = (!q || tr.textContent.toLowerCase().includes(q)) ? '' : 'none';
    });
  });
}

// ─── Module Info Popup (right-click) ─────────────────────────────────────

// Track last context for "open comment" button in info popup
let _moduleInfoPopupCtx = null;

function showModuleInfoPopup(instName, modName, modCustom, inP, outP, clientX, clientY) {
  const popup = $('module-info-popup');
  if (!popup) return;
  _moduleInfoPopupCtx = { instName, modName, modCustom };

  const title = $('module-info-popup-title');
  if (title) title.textContent = modCustom.rename ? `${modCustom.rename} (${instName} : ${modName})` : `${instName} : ${modName}`;

  const body = $('module-info-popup-body');
  if (body) {
    body.innerHTML = `<div class="info-row">
      <span class="info-label">输入:</span><span class="info-val" style="color:#81c784">${inP}</span>
      &nbsp;<span class="info-label">输出:</span><span class="info-val" style="color:#ef5350">${outP}</span>
      ${modCustom.color ? `&nbsp;<span class="info-label">颜色:</span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${modCustom.color};vertical-align:middle;"></span>` : ''}
    </div>`;
  }

  // Show "注释" button only if comment exists
  const commentBtn = $('module-info-popup-comment-btn');
  if (commentBtn) commentBtn.style.display = modCustom.comment ? '' : 'none';

  // Position
  popup.style.display = 'block';
  const pw = popup.offsetWidth || 240;
  const ph = popup.offsetHeight || 80;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = clientX + 4;
  let top = clientY + 4;
  if (left + pw > vw - 8) left = clientX - pw - 4;
  if (top + ph > vh - 8) top = vh - ph - 8;
  if (left < 8) left = 8;
  if (top < 8) top = 8;
  popup.style.left = left + 'px';
  popup.style.top = top + 'px';
}

function closeModuleInfoPopup() {
  const popup = $('module-info-popup');
  if (popup) popup.style.display = 'none';
}

function openSettingsFromInfoPopup() {
  closeModuleInfoPopup();
  openSettingsPanel();
}

function openCommentFromInfoPopup() {
  if (!_moduleInfoPopupCtx) return;
  const { instName, modName, modCustom } = _moduleInfoPopupCtx;
  if (!modCustom.comment) return;
  const popup = $('module-info-popup');
  const x = popup ? (parseInt(popup.style.left) || 100) : 100;
  const y = popup ? (parseInt(popup.style.top) || 100) : 100;
  closeModuleInfoPopup();
  showCommentPopup(instName, modName, modCustom.comment, x, y);
}

// ─── Comment Popup ────────────────────────────────────────────────────────

/**
 * Show a floating Markdown comment popup near the clicked module.
 * Uses marked.js for rendering if available, otherwise shows plain text.
 * Size is persisted in localStorage and restored on next open.
 */
function showCommentPopup(instName, modName, commentMd, clientX, clientY) {
  const popup = $('comment-popup');
  if (!popup) return;

  const titleEl = $('comment-popup-title');
  const contentEl = $('comment-popup-content');
  if (titleEl) titleEl.textContent = `${instName} : ${modName}`;

  // Render markdown
  if (contentEl) {
    if (window.marked) {
      contentEl.innerHTML = window.marked.parse(commentMd);
    } else {
      // Fallback: minimal inline renderer (bold, italic, code, headers)
      let html = commentMd
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/^### (.+)$/gm, '<h3>$1</h3>')
        .replace(/^## (.+)$/gm, '<h2>$1</h2>')
        .replace(/^# (.+)$/gm, '<h1>$1</h1>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/^- (.+)$/gm, '<li>$1</li>')
        .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
        .replace(/\n\n/g, '</p><p>')
        .replace(/^(?!<[hul])/gm, '');
      contentEl.innerHTML = `<p>${html}</p>`;
    }
  }

  // Restore saved size
  const savedSize = loadCommentPopupSize();
  popup.style.width = savedSize.w + 'px';
  popup.style.height = savedSize.h + 'px';

  // Position popup near the click, keeping within viewport
  popup.style.display = 'flex';
  const pw = savedSize.w;
  const ph = savedSize.h;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = clientX + 12;
  let top = clientY + 12;
  if (left + pw > vw - 16) left = clientX - pw - 12;
  if (top + ph > vh - 16) top = vh - ph - 16;
  if (left < 8) left = 8;
  if (top < 8) top = 8;
  popup.style.left = left + 'px';
  popup.style.top = top + 'px';

  // Attach resize handle (idempotent)
  initCommentPopupResize(popup);
}

function closeCommentPopup() {
  const popup = $('comment-popup');
  if (popup) popup.style.display = 'none';
}

/**
 * Attach drag-to-resize behavior to the #comment-popup-resize handle.
 * Runs only once (guarded by a flag on the element).
 * Saves final size to localStorage on mouseup.
 */
function initCommentPopupResize(popup) {
  const handle = $('comment-popup-resize');
  if (!handle || handle._resizeAttached) return;
  handle._resizeAttached = true;

  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = popup.offsetWidth;
    const startH = popup.offsetHeight;

    const onMove = (ev) => {
      const newW = Math.max(220, startW + ev.clientX - startX);
      const newH = Math.max(120, startH + ev.clientY - startY);
      popup.style.width = newW + 'px';
      popup.style.height = newH + 'px';
    };
    const onUp = (ev) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const finalW = popup.offsetWidth;
      const finalH = popup.offsetHeight;
      saveCommentPopupSize(finalW, finalH);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

/**
 * Attach drag-to-resize behavior to the settings modal.
 * Runs only once (guarded by a flag). Saves final size to localStorage on mouseup.
 */
function initSettingsModalResize(modal) {
  const handle = $('settings-modal-resize');
  if (!handle || handle._resizeAttached) return;
  handle._resizeAttached = true;

  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();
    window._settingsResizing = true;
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = modal.offsetWidth;
    const startH = modal.offsetHeight;

    const onMove = (ev) => {
      const newW = Math.max(320, startW + ev.clientX - startX);
      const newH = Math.max(200, startH + ev.clientY - startY);
      modal.style.width = newW + 'px';
      modal.style.height = newH + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      saveSettingsModalSize(modal.offsetWidth, modal.offsetHeight);
      setTimeout(() => { window._settingsResizing = false; }, 200);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

/**
 * Handle importing a .md file as module comment.
 * Fills the comment textarea in the settings modal, and saves a copy
 * server-side at data/<design_name>/<inst_name>.md.
 */
function handleCommentFileImport(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const content = e.target.result;
    const textarea = state.settingsTarget?.type === 'commentBlock'
      ? $('set-comment-block-markdown')
      : $('set-mod-comment');
    if (textarea) textarea.value = content;

    // Save to server under data/<designName>/<instName>.md
    const designName = state.activeTab;
    const instName = state.settingsTarget?.key;
    if (designName && instName) {
      fetch('/api/save_comment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ design_name: designName, inst_name: instName, content }),
      })
        .then(r => r.json())
        .then(res => {
          if (res.success) showToast(`已导入并保存 ${file.name}`, 'success');
          else showToast('保存失败: ' + (res.error || ''), 'error');
        })
        .catch(() => showToast(`已导入 ${file.name}（保存失败）`, 'warn'));
    } else {
      showToast(`已导入 ${file.name}`, 'success');
    }
  };
  reader.onerror = () => showToast('文件读取失败', 'error');
  reader.readAsText(file);
  // Reset input so same file can be imported again
  event.target.value = '';
}

function applySettings() {
  const target = state.settingsTarget;
  if (!target || !state.activeTab) return;

  if (!state.customizations[state.activeTab]) {
    state.customizations[state.activeTab] = normalizeCustomizations({});
  }
  const customs = normalizeCustomizations(state.customizations[state.activeTab]);
  state.customizations[state.activeTab] = customs;

  if (target.type === 'module') {
    const hexVal = $('set-mod-color-hex')?.value;
    const color = (/^#[0-9a-fA-F]{6}$/.test(hexVal) ? hexVal : null) || $('set-mod-color')?.value;
    const rename = $('set-mod-rename')?.value?.trim() || '';
    const comment = $('set-mod-comment')?.value?.trim() || '';
    if (!customs.modules) customs.modules = {};
    customs.modules[target.key] = {};
    if (color && color !== '#1c2333') customs.modules[target.key].color = color;
    if (rename) customs.modules[target.key].rename = rename;
    if (comment) customs.modules[target.key].comment = comment;
    // Clean empty entries
    if (Object.keys(customs.modules[target.key]).length === 0) {
      delete customs.modules[target.key];
    }
  } else if (target.type === 'wire') {
    const hexVal = $('set-wire-color-hex')?.value;
    const color = (/^#[0-9a-fA-F]{6}$/.test(hexVal) ? hexVal : null) || $('set-wire-color')?.value;
    if (!customs.wires) customs.wires = {};
    if (color && color !== '#4fc3f7') {
      customs.wires[target.key] = { color };
    } else {
      delete customs.wires[target.key];
    }
  } else if (target.type === 'commentBlock') {
    if (!customs.commentBlocks) customs.commentBlocks = {};
    const block = customs.commentBlocks[target.key];
    if (block) {
      block.title = $('set-comment-block-title')?.value?.trim() || '注释块';
      block.markdown = $('set-comment-block-markdown')?.value || '';
    }
  }

  saveCustomizations(state.activeTab, customs);
  // Persist full state (including customizations) to server JSON
  scheduleSyncToServer(state.activeTab);
  closeSettingsModal();
  renderCanvas();
  showToast('设置已应用', 'success');
}

function deleteCommentBlock(id) {
  if (!state.activeTab) return;
  const customs = normalizeCustomizations(state.customizations[state.activeTab] || {});
  if (customs.commentBlocks?.[id]) {
    delete customs.commentBlocks[id];
    state.customizations[state.activeTab] = customs;
    if (state.activeCommentBlockId === id) state.activeCommentBlockId = null;
    saveCustomizations(state.activeTab, customs);
    scheduleSyncToServer(state.activeTab);
    closeSettingsModal();
    renderCanvas();
    showToast('注释块已删除', 'success');
  }
}
window.deleteCommentBlock = deleteCommentBlock;

// ─── Box Selection ──────────────────────────────────────────────────────

function drawBoxSelectionRect() {
  let rect = document.getElementById('box-select-rect');
  if (!rect) {
    rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.id = 'box-select-rect';
    rect.setAttribute('fill', 'rgba(31,111,235,0.15)');
    rect.setAttribute('stroke', '#58a6ff');
    rect.setAttribute('stroke-width', 1.5 / state.zoom);
    rect.setAttribute('stroke-dasharray', `${4/state.zoom},${3/state.zoom}`);
    rect.setAttribute('pointer-events', 'none');
    const designRoot = getSVGRoot().querySelector('#design-root');
    if (designRoot) designRoot.appendChild(rect);
  }
  const s = state.boxSelectStart;
  const c = state.boxSelectCurrent;
  const x = Math.min(s.x, c.x);
  const y = Math.min(s.y, c.y);
  const w = Math.abs(c.x - s.x);
  const h = Math.abs(c.y - s.y);
  rect.setAttribute('x', x);
  rect.setAttribute('y', y);
  rect.setAttribute('width', w);
  rect.setAttribute('height', h);
}

function getModuleBoxByPath(renderPath) {
  const svgRoot = getSVGRoot();
  return svgRoot?.querySelector(
    `.module-box[data-render-path="${CSS.escape(renderPath)}"]`
  ) || null;
}

function getNestedSvgOffset(element) {
  let x = 0;
  let y = 0;
  let current = element;
  while (current && current.id !== 'design-root') {
    if (current.classList?.contains('module-box')) {
      const match = current.getAttribute('transform')?.match(
        /translate\(\s*([\d.e+-]+)\s*,\s*([\d.e+-]+)\s*\)/
      );
      if (match) {
        x += parseFloat(match[1]);
        y += parseFloat(match[2]);
      }
    }
    current = current.parentElement;
  }
  return { x, y };
}

function getWaypointDesignPoint(waypoint) {
  const offset = getNestedSvgOffset(waypoint);
  return {
    x: offset.x + parseFloat(waypoint.getAttribute('cx')),
    y: offset.y + parseFloat(waypoint.getAttribute('cy')),
  };
}

function getModuleBoxBounds(renderPath) {
  const box = getModuleBoxByPath(renderPath);
  if (!box) return null;
  const { x, y } = getNestedSvgOffset(box);
  const rect = box.querySelector('.module-rect');
  const width = rect ? parseFloat(rect.getAttribute('width')) : 150;
  const height = rect ? parseFloat(rect.getAttribute('height')) : 100;
  return { x, y, width, height };
}

function normalizeSelectedPaths(paths) {
  const ordered = [...paths].filter(Boolean).sort((left, right) => left.length - right.length);
  return new Set(ordered.filter(path => !ordered.some(other => (
    other !== path && path.startsWith(`${other}/`)
  ))));
}

function setModuleSelection(renderPaths) {
  const designName = state.activeTab;
  const items = normalizeSelectedPaths(renderPaths);
  if (!designName || items.size === 0) {
    clearBoxSelection();
    return;
  }

  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  items.forEach(renderPath => {
    const b = getModuleBoxBounds(renderPath);
    if (!b) return;
    x1 = Math.min(x1, b.x);
    y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.width);
    y2 = Math.max(y2, b.y + b.height);
  });
  if (!Number.isFinite(x1)) {
    clearBoxSelection();
    return;
  }

  const snapLayoutOverrides = {};
  items.forEach(renderPath => {
    const layoutKey = getModuleBoxByPath(renderPath)?.getAttribute('data-layout-key');
    if (!layoutKey) return;
    const ovr = state.layoutOverrides[designName]?.[layoutKey];
    snapLayoutOverrides[layoutKey] = ovr ? { ...ovr } : null;
  });

  state.boxSelection = {
    items,
    waypoints: [],
    queryRect: { x1, y1, x2, y2 },
    snapLayoutOverrides,
    snapWireWaypoints: {},
  };
  renderBoxSelectionHighlight();
}

function setSelectionFromQueryRect(queryRect) {
  const designName = state.activeTab;
  if (!designName || !queryRect) {
    clearBoxSelection();
    return;
  }
  const { x1: selX1, y1: selY1, x2: selX2, y2: selY2 } = queryRect;
  const selectedModules = new Set();
  const selectedWaypoints = [];
  const svgRoot = getSVGRoot();

  svgRoot.querySelectorAll('.module-box').forEach(box => {
    const renderPath = box.getAttribute('data-render-path');
    if (!renderPath || !box.getAttribute('data-instance')) return;
    const b = getModuleBoxBounds(renderPath);
    if (!b) return;
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    if (cx >= selX1 && cx <= selX2 && cy >= selY1 && cy <= selY2) {
      selectedModules.add(renderPath);
    }
  });

  svgRoot.querySelectorAll('.wire-waypoint').forEach(wp => {
    const { x, y } = getWaypointDesignPoint(wp);
    if (x >= selX1 && x <= selX2 && y >= selY1 && y <= selY2) {
      selectedWaypoints.push({
        wireKey: wp.getAttribute('data-wire-key'),
        idx: parseInt(wp.getAttribute('data-wp-index')),
        renderPath: wp.getAttribute('data-render-path') || '',
      });
    }
  });

  if (selectedModules.size === 0 && selectedWaypoints.length === 0) {
    clearBoxSelection();
    return;
  }

  const snapLayoutOverrides = {};
  selectedModules.forEach(renderPath => {
    const layoutKey = getModuleBoxByPath(renderPath)?.getAttribute('data-layout-key');
    if (!layoutKey) return;
    const ovr = state.layoutOverrides[designName]?.[layoutKey];
    snapLayoutOverrides[layoutKey] = ovr ? { ...ovr } : null;
  });
  const snapWireWaypoints = {};
  selectedWaypoints.forEach(wpRef => {
    const wps = state.wireWaypoints[designName]?.[wpRef.wireKey];
    if (wps?.[wpRef.idx]) {
      snapWireWaypoints[`${wpRef.wireKey}:${wpRef.idx}`] = {
        x: wps[wpRef.idx].x,
        y: wps[wpRef.idx].y,
        wireKey: wpRef.wireKey,
        idx: wpRef.idx,
      };
    }
  });

  state.boxSelection = {
    items: selectedModules,
    waypoints: selectedWaypoints,
    queryRect: { x1: selX1, y1: selY1, x2: selX2, y2: selY2 },
    snapLayoutOverrides,
    snapWireWaypoints,
  };
  renderBoxSelectionHighlight();
}

function updateModuleClickSelection(renderPath, additive, fillBox) {
  if (fillBox) {
    const clicked = getModuleBoxBounds(renderPath);
    if (!clicked) return;
    const clickedRect = {
      x1: clicked.x,
      y1: clicked.y,
      x2: clicked.x + clicked.width,
      y2: clicked.y + clicked.height,
    };
    const current = state.boxSelection?.queryRect;
    const clickedAlreadySelected = state.boxSelection?.items?.has(renderPath);
    const rect = current
      ? (clickedAlreadySelected ? current : {
          x1: Math.min(current.x1, clickedRect.x1),
          y1: Math.min(current.y1, clickedRect.y1),
          x2: Math.max(current.x2, clickedRect.x2),
          y2: Math.max(current.y2, clickedRect.y2),
        })
      : clickedRect;
    setSelectionFromQueryRect(rect);
    return;
  }
  const selected = additive && state.boxSelection?.items
    ? new Set(state.boxSelection.items)
    : new Set();
  if (additive && selected.has(renderPath)) selected.delete(renderPath);
  else selected.add(renderPath);
  setModuleSelection(selected);
}

function finalizeBoxSelection() {
  state.boxSelecting = false;
  $('canvas-container').style.cursor = 'grab';

  const s = state.boxSelectStart;
  const c = state.boxSelectCurrent;
  const selX1 = Math.min(s.x, c.x);
  const selY1 = Math.min(s.y, c.y);
  const selX2 = Math.max(s.x, c.x);
  const selY2 = Math.max(s.y, c.y);

  // Remove rubber-band rect
  const rect = document.getElementById('box-select-rect');
  if (rect) rect.remove();

  // Too small = just a click, clear selection
  if (Math.abs(selX2 - selX1) < 5 && Math.abs(selY2 - selY1) < 5) {
    clearBoxSelection();
    return;
  }

  // Find modules within the selection rectangle
  const selectedModules = new Set();
  const selectedWaypoints = [];
  const svgRoot = getSVGRoot();

  svgRoot.querySelectorAll('.module-box').forEach(box => {
    const renderPath = box.getAttribute('data-render-path');
    if (!renderPath || !box.getAttribute('data-instance')) return;
    const bounds = getModuleBoxBounds(renderPath);
    if (!bounds) return;
    const cx = bounds.x + bounds.width / 2;
    const cy = bounds.y + bounds.height / 2;
    if (cx >= selX1 && cx <= selX2 && cy >= selY1 && cy <= selY2) {
      selectedModules.add(renderPath);
    }
  });

  svgRoot.querySelectorAll('.wire-waypoint').forEach(wp => {
    const { x: wxc, y: wyc } = getWaypointDesignPoint(wp);
    if (wxc >= selX1 && wxc <= selX2 && wyc >= selY1 && wyc <= selY2) {
      selectedWaypoints.push({
        wireKey: wp.getAttribute('data-wire-key'),
        idx: parseInt(wp.getAttribute('data-wp-index')),
        renderPath: wp.getAttribute('data-render-path') || '',
      });
    }
  });

  if (selectedModules.size === 0 && selectedWaypoints.length === 0) {
    clearBoxSelection();
    return;
  }

  // Snapshot current layout state so cancel can fully revert
  const designName = state.activeTab;
  const snapLayoutOverrides = {};
  normalizeSelectedPaths(selectedModules).forEach(renderPath => {
    const layoutKey = getModuleBoxByPath(renderPath)?.getAttribute('data-layout-key');
    if (!layoutKey) return;
    const ovr = state.layoutOverrides[designName]?.[layoutKey];
    snapLayoutOverrides[layoutKey] = ovr ? { ...ovr } : null;
  });
  const snapWireWaypoints = {};
  selectedWaypoints.forEach(wpRef => {
    const wps = state.wireWaypoints[designName]?.[wpRef.wireKey];
    if (wps?.[wpRef.idx]) {
      snapWireWaypoints[`${wpRef.wireKey}:${wpRef.idx}`] = { x: wps[wpRef.idx].x, y: wps[wpRef.idx].y, wireKey: wpRef.wireKey, idx: wpRef.idx };
    }
  });
  state.boxSelection = {
    items: normalizeSelectedPaths(selectedModules),
    waypoints: selectedWaypoints,
    queryRect: { x1: selX1, y1: selY1, x2: selX2, y2: selY2 },
    snapLayoutOverrides,
    snapWireWaypoints,
  };
  renderBoxSelectionHighlight();
}

function renderBoxSelectionHighlight() {
  if (!state.boxSelection) return;
  const svgRoot = getSVGRoot();

  // Highlight selected modules
  svgRoot.querySelectorAll('.module-box').forEach(box => {
    const renderPath = box.getAttribute('data-render-path');
    if (state.boxSelection.items.has(renderPath)) {
      box.classList.add('box-selected');
    } else {
      box.classList.remove('box-selected');
    }
  });

  // Highlight selected waypoints
  svgRoot.querySelectorAll('.wire-waypoint').forEach(wp => {
    const wk = wp.getAttribute('data-wire-key');
    const idx = parseInt(wp.getAttribute('data-wp-index'));
    const renderPath = wp.getAttribute('data-render-path') || '';
    const isSelected = state.boxSelection.waypoints.some(w => (
      w.wireKey === wk && w.idx === idx && w.renderPath === renderPath
    ));
    if (isSelected) {
      wp.setAttribute('fill', '#ffeb3b');
      wp.setAttribute('r', 7);
    }
  });

  // Add close button and resize handles overlay
  removeBoxSelectionCloseBtn();
  const designRoot = getSVGRoot().querySelector('#design-root');
  if (!designRoot) return;

  // Use the stored queryRect as the selection area boundary
  const qr = state.boxSelection.queryRect;
  if (!qr) return;
  const pad = 10;
  const bx  = qr.x1 - pad;
  const by  = qr.y1 - pad;
  const bx2 = qr.x2 + pad;
  const by2 = qr.y2 + pad;

  // Transparent drag area sits below modules, so selected modules keep click priority.
  const hitArea = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  hitArea.id = 'box-selection-hit-area';
  hitArea.setAttribute('x', bx);
  hitArea.setAttribute('y', by);
  hitArea.setAttribute('width', bx2 - bx);
  hitArea.setAttribute('height', by2 - by);
  hitArea.setAttribute('fill', 'transparent');
  hitArea.setAttribute('stroke', 'none');
  hitArea.setAttribute('pointer-events', 'all');
  hitArea.style.cursor = 'move';
  hitArea.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    startBoxSelectionDrag(e);
  });
  const underModulesAnchor = [...designRoot.children].find(el => el.classList?.contains('module-internal')) || null;
  designRoot.insertBefore(hitArea, underModulesAnchor);

  // Draw selection bounding box
  const selBorder = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  selBorder.id = 'box-selection-border';
  selBorder.setAttribute('x', bx);
  selBorder.setAttribute('y', by);
  selBorder.setAttribute('width', bx2 - bx);
  selBorder.setAttribute('height', by2 - by);
  selBorder.setAttribute('fill', 'none');
  selBorder.setAttribute('stroke', '#58a6ff');
  selBorder.setAttribute('stroke-width', 2 / state.zoom);
  selBorder.setAttribute('stroke-dasharray', `${6/state.zoom},${3/state.zoom}`);
  selBorder.setAttribute('rx', 4);
  selBorder.setAttribute('pointer-events', 'none');
  designRoot.appendChild(selBorder);

  // Convert / Confirm / Cancel buttons centered above the top border
  const ccG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  ccG.id = 'box-selection-confirm-cancel';
  const ccBmx = (bx + bx2) / 2;
  const ccGap = 14 / state.zoom;
  const ccBtnW = 30 / state.zoom;
  const ccBtnH = 22 / state.zoom;
  const ccSpacing = 6 / state.zoom;
  const ccBtnRx = 4 / state.zoom;
  const ccFontSize = 12 / state.zoom;
  const ccBtnTop = by - ccGap - ccBtnH;
  const ccTotalW = ccBtnW * 3 + ccSpacing * 2;

  function _makeCCBtn(x, color, label, action, onClick) {
    const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    r.setAttribute('x', x); r.setAttribute('y', ccBtnTop);
    r.setAttribute('width', ccBtnW); r.setAttribute('height', ccBtnH);
    r.setAttribute('fill', color); r.setAttribute('stroke', '#0d1117');
    r.setAttribute('stroke-width', 1 / state.zoom); r.setAttribute('rx', ccBtnRx);
    r.setAttribute('data-action', action);
    r.style.cursor = 'pointer';
    r.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('x', x + ccBtnW / 2); t.setAttribute('y', ccBtnTop + ccBtnH * 0.68);
    t.setAttribute('text-anchor', 'middle'); t.setAttribute('fill', '#fff');
    t.setAttribute('font-size', ccFontSize); t.setAttribute('pointer-events', 'none');
    t.setAttribute('data-action', action);
    t.textContent = label;
    ccG.appendChild(r); ccG.appendChild(t);
  }
  const ccLeft = ccBmx - ccTotalW / 2;
  _makeCCBtn(ccLeft, '#1f6feb', '注', 'comment', convertBoxSelectionToCommentBlock);
  _makeCCBtn(ccLeft + ccBtnW + ccSpacing, '#2ea44f', '✓', 'confirm', confirmBoxSelection);
  _makeCCBtn(ccLeft + (ccBtnW + ccSpacing) * 2, '#da3633', '✕', 'cancel', cancelBoxSelection);
  designRoot.appendChild(ccG);

  // Resize handles — 8 around the border (corners + edge midpoints)
  const handlesG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  handlesG.id = 'box-selection-handles';
  const bmx = (bx + bx2) / 2;
  const bmy = (by + by2) / 2;
  const hs = 5 / state.zoom; // half-size of handle square
  const handleDefs = [
    { role: 'nw', x: bx,  y: by,  cursor: 'nw-resize' },
    { role: 'n',  x: bmx, y: by,  cursor: 'n-resize'  },
    { role: 'ne', x: bx2, y: by,  cursor: 'ne-resize' },
    { role: 'e',  x: bx2, y: bmy, cursor: 'e-resize'  },
    { role: 'se', x: bx2, y: by2, cursor: 'se-resize' },
    { role: 's',  x: bmx, y: by2, cursor: 's-resize'  },
    { role: 'sw', x: bx,  y: by2, cursor: 'sw-resize' },
    { role: 'w',  x: bx,  y: bmy, cursor: 'w-resize'  },
  ];
  for (const h of handleDefs) {
    const hr = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    hr.setAttribute('data-role', h.role);
    hr.setAttribute('x', h.x - hs);
    hr.setAttribute('y', h.y - hs);
    hr.setAttribute('width', hs * 2);
    hr.setAttribute('height', hs * 2);
    hr.setAttribute('fill', '#58a6ff');
    hr.setAttribute('stroke', '#0d1117');
    hr.setAttribute('stroke-width', 1 / state.zoom);
    hr.setAttribute('rx', 1 / state.zoom);
    hr.style.cursor = h.cursor;
    hr.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      startBoxSelectionResize(e, h.role);
    });
    handlesG.appendChild(hr);
  }
  designRoot.appendChild(handlesG);
}

function removeBoxSelectionCloseBtn() {
  const hitArea = document.getElementById('box-selection-hit-area');
  if (hitArea) hitArea.remove();
  const border = document.getElementById('box-selection-border');
  if (border) border.remove();
  const ccBtns = document.getElementById('box-selection-confirm-cancel');
  if (ccBtns) ccBtns.remove();
  const handles = document.getElementById('box-selection-handles');
  if (handles) handles.remove();
}

function clearBoxSelection() {
  state.boxSelection = null;
  removeBoxSelectionCloseBtn();
  const svgRoot = getSVGRoot();
  svgRoot.querySelectorAll('.module-box.box-selected').forEach(box => {
    box.classList.remove('box-selected');
  });
}

function startBoxSelectionDrag(e) {
  const pt = svgToDesignCoords(e.clientX, e.clientY);
  if (!pt) return;
  state.editMode = 'drag-box-selection';
  state.editTarget = {
    startDesignX: pt.x,
    startDesignY: pt.y,
    origPositions: {},
    origWaypoints: {},
  };

  // Store original positions of all selected modules
  const svgRoot = getSVGRoot();
  if (state.boxSelection) {
    state.boxSelection.items.forEach(renderPath => {
      const box = getModuleBoxByPath(renderPath);
      if (box) {
        const transform = box.getAttribute('transform');
        const match = transform?.match(/translate\(\s*([\d.e+-]+)\s*,\s*([\d.e+-]+)\s*\)/);
        if (match) {
          state.editTarget.origPositions[renderPath] = {
            x: parseFloat(match[1]),
            y: parseFloat(match[2]),
            boxEl: box,
            layoutKey: box.getAttribute('data-layout-key') || box.getAttribute('data-instance'),
            instanceName: box.getAttribute('data-instance') || '',
            originX: parseFloat(box.getAttribute('data-layout-origin-x')) || 0,
            originY: parseFloat(box.getAttribute('data-layout-origin-y')) || 0,
          };
        }
      }
    });
    state.boxSelection.waypoints.forEach(wpRef => {
      const key = `${wpRef.renderPath}:${wpRef.idx}`;
      const wps = state.wireWaypoints[state.activeTab]?.[wpRef.wireKey];
      const wpEl = svgRoot.querySelector(
        `.wire-waypoint[data-render-path="${CSS.escape(wpRef.renderPath)}"][data-wp-index="${wpRef.idx}"]`
      );
      if (wps?.[wpRef.idx] && wpEl) {
        state.editTarget.origWaypoints[key] = {
          x: parseFloat(wpEl.getAttribute('cx')),
          y: parseFloat(wpEl.getAttribute('cy')),
          savedX: wps[wpRef.idx].x,
          savedY: wps[wpRef.idx].y,
          wireKey: wpRef.wireKey,
          renderPath: wpRef.renderPath,
          idx: wpRef.idx,
          wpEl,
        };
      }
    });
  }
  $('canvas-container').style.cursor = 'move';
}

function startBoxSelectionResize(e, role) {
  const pt = svgToDesignCoords(e.clientX, e.clientY);
  if (!pt || !state.boxSelection?.queryRect) return;
  state.editMode = 'resize-box-selection';
  state.editTarget = {
    handle: role,
    startPt: { x: pt.x, y: pt.y },
    origRect: { ...state.boxSelection.queryRect },
  };
  // mirror cursor from the handle element
  $('canvas-container').style.cursor = e.currentTarget?.style?.cursor || 'crosshair';
}

function _computeResizedRect(origRect, handle, dx, dy) {
  let { x1, y1, x2, y2 } = origRect;
  if (handle.includes('w')) x1 += dx;
  if (handle.includes('e')) x2 += dx;
  if (handle.includes('n')) y1 += dy;
  if (handle.includes('s')) y2 += dy;
  return { x1: Math.min(x1, x2), y1: Math.min(y1, y2), x2: Math.max(x1, x2), y2: Math.max(y1, y2) };
}

function _updateResizeBorderVisual(x1, y1, x2, y2) {
  const pad = 10;
  const bx = x1 - pad, by = y1 - pad, bx2 = x2 + pad, by2 = y2 + pad;
  const hitArea = document.getElementById('box-selection-hit-area');
  if (hitArea) {
    hitArea.setAttribute('x', bx);
    hitArea.setAttribute('y', by);
    hitArea.setAttribute('width', bx2 - bx);
    hitArea.setAttribute('height', by2 - by);
  }
  const border = document.getElementById('box-selection-border');
  if (border) {
    border.setAttribute('x', bx);
    border.setAttribute('y', by);
    border.setAttribute('width', bx2 - bx);
    border.setAttribute('height', by2 - by);
  }
  // Update handle positions
  const handlesG = document.getElementById('box-selection-handles');
  if (handlesG) {
    const hs = 5 / state.zoom;
    const bmxH = (bx + bx2) / 2, bmyH = (by + by2) / 2;
    const positions = {
      nw: { x: bx,   y: by   }, n: { x: bmxH, y: by   }, ne: { x: bx2, y: by   },
      e:  { x: bx2,  y: bmyH }, se: { x: bx2,  y: by2  }, s:  { x: bmxH, y: by2  },
      sw: { x: bx,   y: by2  }, w:  { x: bx,   y: bmyH },
    };
    for (const hr of handlesG.querySelectorAll('rect')) {
      const pos = positions[hr.getAttribute('data-role')];
      if (pos) { hr.setAttribute('x', pos.x - hs); hr.setAttribute('y', pos.y - hs); }
    }
  }
  // Update confirm/cancel buttons
  const ccG = document.getElementById('box-selection-confirm-cancel');
  if (ccG) {
    const newBmx = (bx + bx2) / 2;
    const gap = 14 / state.zoom, btnW = 30 / state.zoom, btnH = 22 / state.zoom, sp = 6 / state.zoom;
    const btnTop = by - gap - btnH;
    const totalW = btnW * 3 + sp * 2;
    const left = newBmx - totalW / 2;
    const rects = ccG.querySelectorAll('rect');
    const texts = ccG.querySelectorAll('text');
    rects.forEach((r, i) => {
      r.setAttribute('x', left + i * (btnW + sp));
      r.setAttribute('y', btnTop);
    });
    texts.forEach((t, i) => {
      t.setAttribute('x', left + i * (btnW + sp) + btnW / 2);
      t.setAttribute('y', btnTop + btnH * 0.68);
    });
  }
}

function onBoxSelectionResizeMove(e) {
  const t = state.editTarget;
  const pt = svgToDesignCoords(e.clientX, e.clientY);
  if (!pt || !t) return;
  const dx = pt.x - t.startPt.x;
  const dy = pt.y - t.startPt.y;
  const nr = _computeResizedRect(t.origRect, t.handle, dx, dy);
  _updateResizeBorderVisual(nr.x1, nr.y1, nr.x2, nr.y2);
}

function onBoxSelectionResizeEnd(e) {
  const t = state.editTarget;
  if (!t) return;
  const pt = svgToDesignCoords(e.clientX, e.clientY);
  let newRect = { ...t.origRect };
  if (pt) {
    const dx = pt.x - t.startPt.x;
    const dy = pt.y - t.startPt.y;
    newRect = _computeResizedRect(t.origRect, t.handle, dx, dy);
  }
  state.editMode = null;
  state.editTarget = null;
  $('canvas-container').style.cursor = 'grab';
  reapplyBoxSelection(newRect);
}

function reapplyBoxSelection(queryRect) {
  const { x1: selX1, y1: selY1, x2: selX2, y2: selY2 } = queryRect;
  const selectedModules = new Set();
  const selectedWaypoints = [];
  const svgRoot = getSVGRoot();

  svgRoot.querySelectorAll('.module-box').forEach(box => {
    const renderPath = box.getAttribute('data-render-path');
    if (!renderPath || !box.getAttribute('data-instance')) return;
    const bounds = getModuleBoxBounds(renderPath);
    if (!bounds) return;
    const cx = bounds.x + bounds.width / 2;
    const cy = bounds.y + bounds.height / 2;
    if (cx >= selX1 && cx <= selX2 && cy >= selY1 && cy <= selY2) {
      selectedModules.add(renderPath);
    }
  });

  svgRoot.querySelectorAll('.wire-waypoint').forEach(wp => {
    const { x: wxc, y: wyc } = getWaypointDesignPoint(wp);
    if (wxc >= selX1 && wxc <= selX2 && wyc >= selY1 && wyc <= selY2) {
      selectedWaypoints.push({
        wireKey: wp.getAttribute('data-wire-key'),
        idx: parseInt(wp.getAttribute('data-wp-index')),
        renderPath: wp.getAttribute('data-render-path') || '',
      });
    }
  });

  // Preserve cancel snapshot from the original selection (not from resize changes)
  const prevSnap = state.boxSelection;
  state.boxSelection = {
    items: normalizeSelectedPaths(selectedModules),
    waypoints: selectedWaypoints,
    queryRect,
    snapLayoutOverrides: prevSnap?.snapLayoutOverrides || {},
    snapWireWaypoints:   prevSnap?.snapWireWaypoints   || {},
  };
  renderBoxSelectionHighlight();
}

function onBoxSelectionDragMove(e) {
  const t = state.editTarget;
  const pt = svgToDesignCoords(e.clientX, e.clientY);
  if (!pt || !t) return;
  const dx = pt.x - t.startDesignX;
  const dy = pt.y - t.startDesignY;

  // Move all selected modules
  for (const [instName, orig] of Object.entries(t.origPositions)) {
    orig.boxEl.setAttribute('transform', `translate(${orig.x + dx}, ${orig.y + dy})`);
    scheduleInlineAncestorFit(orig.boxEl);
  }
  // Move all selected waypoints visually
  const svgRoot = getSVGRoot();
  for (const [key, orig] of Object.entries(t.origWaypoints)) {
    const wp = orig.wpEl;
    if (wp) {
      wp.setAttribute('cx', orig.x + dx);
      wp.setAttribute('cy', orig.y + dy);
    }
  }
  // Move the selection border / handles / buttons overlay in real time
  if (state.boxSelection?.queryRect) {
    const qr = state.boxSelection.queryRect;
    _updateResizeBorderVisual(qr.x1 + dx, qr.y1 + dy, qr.x2 + dx, qr.y2 + dy);
  }
}

function onBoxSelectionDragEnd(e) {
  const t = state.editTarget;
  if (!t) return;
  const pt = svgToDesignCoords(e.clientX, e.clientY);
  const designName = state.activeTab;

  if (pt) {
    pushUndoSnapshot();
    const dx = pt.x - t.startDesignX;
    const dy = pt.y - t.startDesignY;

    // Persist module positions
    if (!state.layoutOverrides[designName]) state.layoutOverrides[designName] = {};
    for (const orig of Object.values(t.origPositions)) {
      const ovr = getLayoutOverrideForInstance(designName, orig.layoutKey, orig.instanceName);
      ovr.x = orig.x + dx - orig.originX;
      ovr.y = orig.y + dy - orig.originY;
      state.layoutOverrides[designName][orig.layoutKey] = ovr;
    }
    saveLayout(designName, state.layoutOverrides[designName]);

    // Persist waypoint positions
    for (const [key, orig] of Object.entries(t.origWaypoints)) {
      if (state.wireWaypoints[designName]?.[orig.wireKey]?.[orig.idx]) {
        state.wireWaypoints[designName][orig.wireKey][orig.idx] = {
          x: orig.savedX + dx,
          y: orig.savedY + dy,
        };
      }
    }
    saveWireWaypoints(designName, state.wireWaypoints[designName]);

    // Update queryRect to follow moved items before canvas re-renders
    if (state.boxSelection) {
      const qr = state.boxSelection.queryRect;
      state.boxSelection.queryRect = { x1: qr.x1 + dx, y1: qr.y1 + dy, x2: qr.x2 + dx, y2: qr.y2 + dy };
    }
  }

  state.editMode = null;
  state.editTarget = null;
  $('canvas-container').style.cursor = 'grab';
  state.justFinishedDrag = true;
  setTimeout(() => { state.justFinishedDrag = false; }, 50);
  renderCanvas();
  // Re-highlight selection after re-render
  setTimeout(() => renderBoxSelectionHighlight(), 50);
}

function confirmBoxSelection() {
  clearBoxSelection();
}

function convertBoxSelectionToCommentBlock() {
  if (!state.activeTab || !state.boxSelection?.queryRect) return;
  const qr = state.boxSelection.queryRect;
  const pad = 10;
  const id = `comment_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const customs = normalizeCustomizations(state.customizations[state.activeTab] || {});
  if (!customs.commentBlocks) customs.commentBlocks = {};
  customs.commentBlocks[id] = {
    x: qr.x1 - pad,
    y: qr.y1 - pad,
    width: Math.max(80, qr.x2 - qr.x1 + pad * 2),
    height: Math.max(50, qr.y2 - qr.y1 + pad * 2),
    title: '注释块',
    markdown: '## 注释块\n\n在右键设置中编辑 Markdown 内容。',
  };
  state.customizations[state.activeTab] = customs;
  state.activeCommentBlockId = id;
  saveCustomizations(state.activeTab, customs);
  scheduleSyncToServer(state.activeTab);
  clearBoxSelection();
  renderCanvas();
  showToast('已转换为注释块', 'success');
}

function cancelBoxSelection() {
  if (!state.boxSelection) return;
  const { snapLayoutOverrides, snapWireWaypoints } = state.boxSelection;
  const designName = state.activeTab;
  if (snapLayoutOverrides && Object.keys(snapLayoutOverrides).length > 0) {
    pushUndoSnapshot();
    if (!state.layoutOverrides[designName]) state.layoutOverrides[designName] = {};
    for (const [instName, savedOvr] of Object.entries(snapLayoutOverrides)) {
      if (savedOvr !== null) {
        state.layoutOverrides[designName][instName] = { ...savedOvr };
      } else {
        delete state.layoutOverrides[designName][instName];
      }
    }
    saveLayout(designName, state.layoutOverrides[designName]);
  }
  if (snapWireWaypoints) {
    for (const [, wpSnap] of Object.entries(snapWireWaypoints)) {
      if (state.wireWaypoints[designName]?.[wpSnap.wireKey]) {
        state.wireWaypoints[designName][wpSnap.wireKey][wpSnap.idx] = { x: wpSnap.x, y: wpSnap.y };
      }
    }
    saveWireWaypoints(designName, state.wireWaypoints[designName]);
  }
  clearBoxSelection();
  renderCanvas();
}

// ─── Export ─────────────────────────────────────────────────────────────

/**
 * Build a standalone SVG string containing only the design content
 * (the dashed bounding box area), without pan/zoom transforms.
 */
function buildExportSVG() {
  const designRoot = getSVGRoot().querySelector('#design-root');
  if (!designRoot) return null;

  // Temporarily remove pan/zoom transform to get true bounding box
  const savedTransform = designRoot.getAttribute('transform');
  designRoot.removeAttribute('transform');

  let bbox;
  try {
    bbox = designRoot.getBBox();
  } catch (e) {
    designRoot.setAttribute('transform', savedTransform);
    return null;
  }

  if (bbox.width === 0 && bbox.height === 0) {
    designRoot.setAttribute('transform', savedTransform);
    return null;
  }

  // Add padding around the content
  const pad = 20;
  const vbX = bbox.x - pad;
  const vbY = bbox.y - pad;
  const vbW = bbox.width + pad * 2;
  const vbH = bbox.height + pad * 2;

  // Clone the design-root content (without pan/zoom transform)
  const clonedRoot = designRoot.cloneNode(true);
  clonedRoot.removeAttribute('transform');

  // Also clone the defs (markers, etc.) from the original SVG
  const origDefs = getSVG().querySelector('defs');
  const clonedDefs = origDefs ? origDefs.cloneNode(true) : '';

  // Restore original transform
  designRoot.setAttribute('transform', savedTransform);

  // Background color for export
  const bgColor = state.canvasBgColor;
  const bgRect = (bgColor && bgColor !== 'transparent')
    ? `<rect x="${vbX}" y="${vbY}" width="${vbW}" height="${vbH}" fill="${bgColor}"/>`
    : '';

  // Build standalone SVG
  const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vbX} ${vbY} ${vbW} ${vbH}" width="${vbW}" height="${vbH}">
  <style>
    .module-rect { rx: 6; ry: 6; }
    .module-title { font-family: 'Segoe UI', sans-serif; font-weight: 600; fill: #e6edf3; font-size: 14px; }
    .port-label { font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 11px; }
    .wire-path { fill: none; stroke: #4fc3f7; stroke-width: 1.5; }
    .wire-path.bus { stroke-width: 3; }
    .wire-path.selected { stroke: #ff9800; stroke-width: 3; }
    .expand-indicator { font-size: 12px; fill: #58a6ff; }
    text { font-family: 'Segoe UI', sans-serif; }
  </style>
  ${origDefs ? new XMLSerializer().serializeToString(origDefs) : ''}
  ${bgRect}
  ${new XMLSerializer().serializeToString(clonedRoot)}
</svg>`;

  return { svgStr, vbW, vbH, vbX, vbY };
}

async function doExport(format) {
  if (!state.activeTab) { showToast('没有打开的设计', 'warn'); return; }

  const exportData = buildExportSVG();
  if (!exportData) { showToast('没有可导出的内容', 'warn'); return; }

  const endpoint = format === 'svg' ? '/api/export_svg' : '/api/export_html';
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ svg: exportData.svgStr, name: state.activeTab }),
    });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.activeTab}.${format === 'svg' ? 'svg' : 'html'}`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`已导出 ${format.toUpperCase()}`, 'success');
  } catch (err) {
    showToast('导出失败: ' + err.message, 'error');
  }
}

function doExportPNG() {
  if (!state.activeTab) { showToast('没有打开的设计', 'warn'); return; }

  const exportData = buildExportSVG();
  if (!exportData) { showToast('没有可导出的内容', 'warn'); return; }

  // Scale for high-DPI export (2x)
  const scale = 2;
  const canvasW = Math.ceil(exportData.vbW * scale);
  const canvasH = Math.ceil(exportData.vbH * scale);

  const canvas = document.createElement('canvas');
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext('2d');
  // Fill background if not transparent
  if (state.canvasBgColor && state.canvasBgColor !== 'transparent') {
    ctx.fillStyle = state.canvasBgColor;
    ctx.fillRect(0, 0, canvasW, canvasH);
  }
  // else: transparent (default canvas is transparent)

  const img = new Image();
  const svgBlob = new Blob([exportData.svgStr], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);
  img.onload = () => {
    ctx.drawImage(img, 0, 0, canvasW, canvasH);
    URL.revokeObjectURL(url);
    canvas.toBlob(blob => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${state.activeTab}.png`;
      a.click();
      showToast('已导出 PNG', 'success');
    }, 'image/png');
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    showToast('PNG 导出失败', 'error');
  };
  img.src = url;
}

// ─── Toast notifications ────────────────────────────────────────────────

function showToast(msg, type = 'info') {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    container.style.cssText = 'position:fixed;top:16px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:8px;';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  const colors = { info: '#1f6feb', success: '#238636', error: '#da3633', warn: '#d29922' };
  toast.style.cssText = `
    padding: 10px 18px; border-radius: 8px; font-size: 13px; color: #fff;
    background: ${colors[type] || colors.info}; box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    opacity: 0; transition: opacity 0.3s; max-width: 360px;
  `;
  toast.textContent = msg;
  container.appendChild(toast);
  requestAnimationFrame(() => { toast.style.opacity = '1'; });
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}
