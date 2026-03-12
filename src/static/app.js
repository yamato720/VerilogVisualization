/**
 * app.js — Verilog Visualizer front-end: file browser, design management,
 * pan/zoom, export, interactive module drag/resize, wire waypoints, layout persistence.
 */

// ─── Layout persistence helpers ─────────────────────────────────────────

const STORAGE_KEY_PREFIX = 'vviz_layout_';
const STORAGE_COLLAPSED_KEY = 'vviz_collapsed';
const STORAGE_WIRE_KEY_PREFIX = 'vviz_wires_';
const STORAGE_VIEW_KEY_PREFIX = 'vviz_view_';

function saveLayout(designName, layoutData) {
  try { localStorage.setItem(STORAGE_KEY_PREFIX + designName, JSON.stringify(layoutData)); }
  catch (e) { console.warn('Failed to save layout', e); }
}
function loadLayout(designName) {
  try { const d = localStorage.getItem(STORAGE_KEY_PREFIX + designName); return d ? JSON.parse(d) : {}; }
  catch (e) { return {}; }
}
function saveWireWaypoints(designName, data) {
  try { localStorage.setItem(STORAGE_WIRE_KEY_PREFIX + designName, JSON.stringify(data)); }
  catch (e) {}
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
function saveViewState(designName, view) {
  try { localStorage.setItem(STORAGE_VIEW_KEY_PREFIX + designName, JSON.stringify(view)); }
  catch (e) {}
}
function loadViewState(designName) {
  try { const d = localStorage.getItem(STORAGE_VIEW_KEY_PREFIX + designName); return d ? JSON.parse(d) : null; }
  catch (e) { return null; }
}

const STORAGE_HIDE_CLK_RST = 'vviz_hide_clk_rst';
const STORAGE_CUSTOM_PREFIX = 'vviz_custom_';

function saveHideClockReset(val) {
  try { localStorage.setItem(STORAGE_HIDE_CLK_RST, JSON.stringify(val)); } catch(e) {}
}
function loadHideClockReset() {
  try { const d = localStorage.getItem(STORAGE_HIDE_CLK_RST); return d !== null ? JSON.parse(d) : true; }
  catch(e) { return true; }
}

// Customization: { modules: { instName: { color, rename, comment } }, wires: { wireKey: { color } } }
function saveCustomizations(designName, data) {
  try { localStorage.setItem(STORAGE_CUSTOM_PREFIX + designName, JSON.stringify(data)); } catch(e) {}
}
function loadCustomizations(designName) {
  try { const d = localStorage.getItem(STORAGE_CUSTOM_PREFIX + designName); return d ? JSON.parse(d) : { modules: {}, wires: {} }; }
  catch(e) { return { modules: {}, wires: {} }; }
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
function loadCommentPopupSize() {
  try { const d = localStorage.getItem(STORAGE_COMMENT_POPUP_SIZE); return d ? JSON.parse(d) : { w: 340, h: 260 }; }
  catch(e) { return { w: 340, h: 260 }; }
}

// ─── State ──────────────────────────────────────────────────────────────

const state = {
  designs: {},          // designName -> { modules, top_modules, hierarchy }
  openTabs: [],         // [{ name, module }]
  activeTab: null,      // designName
  activeDesign: null,   // currently selected design in sidebar list
  expandedModules: {},  // designName -> Set(modName)
  collapsedState: loadCollapsedState(),   // "modName:side:groupLabel" -> bool (true = expanded)
  // Layout overrides per design: { instName: { x, y, width?, height? } }
  layoutOverrides: {},  // designName -> { instName: {...} }
  // Wire waypoints per design: { wireKey: [{x, y}, ...] }
  wireWaypoints: {},    // designName -> { wireKey: [{x,y},...] }
  // Pan & zoom
  pan: { x: 0, y: 0 },
  zoom: 1,
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
  // Customizations per design: { modules: {}, wires: {} }
  customizations: {},
  // Settings modal context
  settingsTarget: null,  // { type: 'module'|'wire', key: instName|wireKey }
  // Undo/Redo
  undoStack: [],     // array of { layoutOverrides, wireWaypoints } snapshots
  redoStack: [],
  maxUndoHistory: 50,
  // Guard: set true after drag ends to prevent background click from deselecting
  justFinishedDrag: false,
  // Box selection state
  boxSelection: null,       // { items: Set<instName>, waypoints: [{wireKey, idx}] } or null
  boxSelecting: false,      // true while rubber-band is active
  boxSelectStart: null,     // { x, y } in design coords
  boxSelectCurrent: null,   // { x, y } in design coords
  // Canvas background color ('transparent' = show default but export transparently)
  canvasBgColor: loadCanvasBgColor(),
};

// ─── DOM helpers ────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

function getSVG() { return $('main-svg'); }
function getSVGRoot() { return $('svg-root'); }

// ─── Initialisation ─────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initPanZoom();
  loadDesignList();

  // Update clock/reset toggle button text on load
  const clkBtn = $('btn-toggle-clk-rst');
  if (clkBtn) clkBtn.textContent = state.hideClockReset ? '🕐 显示时钟/复位' : '🕐 隐藏时钟/复位';

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
window.toggleFullscreen = toggleFullscreen;
window.refreshDesign = refreshDesign;
window.openSettingsPanel = openSettingsPanel;
window.closeSettingsModal = closeSettingsModal;
window.applySettings = applySettings;
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
  // Update button text
  const btn = $('btn-toggle-clk-rst');
  if (btn) btn.textContent = state.hideClockReset ? '🕐 显示时钟/复位' : '🕐 隐藏时钟/复位';
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
  const isCollapsed = sidebar.classList.toggle('collapsed');
  if (expandBtn) expandBtn.style.display = isCollapsed ? '' : 'none';
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
}

async function refreshDesign() {
  const name = state.activeTab;
  if (!name) { showToast('没有打开的设计', 'warn'); return; }
  showToast(`正在刷新 ${name}...`, 'info');
  try {
    const res = await fetch('/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (data.error) { showToast('刷新失败: ' + data.error, 'error'); return; }
    // Re-open the design to reload data
    await openDesign(data.saved_as || name);
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
    status.textContent = `✓ ${data.saved_as}`;
    await loadDesignList();
    openDesign(data.saved_as);
  } catch (err) {
    status.className = 'status-msg error';
    status.textContent = '分析失败: ' + err.message;
  }
}

async function loadDesignList() {
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
          <button title="删除" data-action="delete">🗑</button>
        </span>`;
      item.querySelector('.name').addEventListener('click', () => openDesign(d.name));
      item.querySelector('[data-action="delete"]').addEventListener('click', e => {
        e.stopPropagation();
        deleteDesign(d.name);
      });
      listDiv.appendChild(item);
    });
  } catch (err) {
    console.error('Failed to load designs', err);
  }
}

async function openDesign(name) {
  showToast(`加载 ${name}...`, 'info');
  try {
    const res = await fetch(`/api/design/${name}`);
    const data = await res.json();
    if (data.error) { showToast('加载失败: ' + data.error, 'error'); return; }

    state.designs[name] = data;
    state.activeDesign = name;
    if (!state.expandedModules[name]) {
      state.expandedModules[name] = new Set();
    }

    // Select first top module to expand
    if (data.top_modules && data.top_modules.length > 0) {
      state.expandedModules[name].add(data.top_modules[0]);
    }

    // Load persisted layout overrides and wire waypoints from localStorage
    state.layoutOverrides[name] = loadLayout(name);
    state.wireWaypoints[name] = loadWireWaypoints(name);
    state.customizations[name] = loadCustomizations(name);

    // Load persisted view state (pan/zoom)
    const savedView = loadViewState(name);
    if (savedView) {
      state.pan = savedView.pan;
      state.zoom = savedView.zoom;
    } else {
      state.pan = { x: 0, y: 0 };
      state.zoom = 1;
    }

    // Add tab
    if (!state.openTabs.find(t => t.name === name)) {
      state.openTabs.push({ name, module: data.top_modules?.[0] || Object.keys(data.modules)[0] });
    }
    state.activeTab = name;

    // Show sections
    $('module-tree-section').style.display = '';
    $('export-section').style.display = '';
    $('welcome-screen').style.display = 'none';
    getSVG().style.display = '';

    renderTabs();
    renderSidebar(name);
    renderCanvas();
    loadDesignList();  // update highlight

    showToast(`已加载: ${name}`, 'success');
  } catch (err) {
    showToast('加载失败: ' + err.message, 'error');
  }
}

async function deleteDesign(name) {
  if (!name) return;
  if (!confirm(`确定删除 "${name}"?`)) return;
  try {
    await fetch(`/api/delete/${name}`, { method: 'DELETE' });
    delete state.designs[name];
    delete state.expandedModules[name];
    state.openTabs = state.openTabs.filter(t => t.name !== name);
    if (state.activeTab === name) {
      state.activeTab = state.openTabs[0]?.name || null;
      state.activeDesign = state.activeTab;
    }
    renderTabs();
    loadDesignList();
    renderCanvas();
    if (!state.activeTab) {
      $('welcome-screen').style.display = '';
      getSVG().style.display = 'none';
      $('module-tree-section').style.display = 'none';
      $('export-section').style.display = 'none';
    }
    showToast(`已删除: ${name}`, 'success');
  } catch (err) {
    showToast('删除失败: ' + err.message, 'error');
  }
}

// ─── Tabs ───────────────────────────────────────────────────────────────

function renderTabs() {
  const bar = $('tab-bar');
  bar.innerHTML = '';
  state.openTabs.forEach(tab => {
    const div = document.createElement('div');
    div.className = 'tab' + (tab.name === state.activeTab ? ' active' : '');
    div.innerHTML = `<span>${tab.name}</span><span class="close-tab">&times;</span>`;
    div.querySelector('span:first-child').addEventListener('click', () => {
      state.activeTab = tab.name;
      state.activeDesign = tab.name;
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

function renderSidebar(designName) {
  const tree = $('module-tree');
  tree.innerHTML = '';
  const design = state.designs[designName];
  if (!design) return;

  const modules = design.modules;
  const topModules = design.top_modules || [];

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
      if (!query || modName.toLowerCase().includes(query)) {
        label.style.display = '';
      } else {
        label.style.display = 'none';
      }
    });
  });
  searchRow.appendChild(searchInput);
  tree.appendChild(searchRow);

  const createNode = (modName, depth) => {
    const mod = modules[modName];
    if (!mod) return;

    const label = document.createElement('div');
    label.className = 'tree-node-label';
    label.setAttribute('data-mod-name', modName);
    label.style.paddingLeft = (depth * 16 + 4) + 'px';

    const expanded = state.expandedModules[designName]?.has(modName);
    const hasChildren = mod.instances && mod.instances.length > 0;
    const isTop = topModules.includes(modName);

    // Check if this is the active module in the canvas
    const tab = state.openTabs.find(t => t.name === designName);
    const isViewing = tab && tab.module === modName;
    if (isViewing) label.classList.add('selected');

    label.innerHTML = `
      <span class="icon">${hasChildren ? (expanded ? '▼' : '▶') : '·'}</span>
      <span style="${isTop ? 'color:#58a6ff;font-weight:600;' : ''}">${modName}</span>
      <span style="color:#484f58;font-size:11px;margin-left:auto;">${mod.ports?.length || 0}p</span>`;

    label.addEventListener('click', () => {
      // Single click: navigate to the module — if visible, pan to it; if not, enter its view
      const tab2 = state.openTabs.find(t => t.name === designName);
      const svgRoot = getSVGRoot();
      const boxes = svgRoot.querySelectorAll(`.module-box[data-module="${modName}"]`);
      if (boxes.length > 0) {
        // Module is visible in current view: just pan to it
        navigateToModule(designName, modName);
      } else if (hasChildren) {
        // Module has instances: switch to its own internal view
        if (tab2) tab2.module = modName;
        if (!state.expandedModules[designName].has(modName)) {
          state.expandedModules[designName].add(modName);
        }
        renderSidebar(designName);
        renderCanvas();
        setTimeout(() => fitToView(), 50);
      } else {
        // Leaf module (no instances): navigate to the parent that contains it,
        // then pan/highlight the module instance box within that view
        const parentModName = findParentModule(designName, modName);
        if (parentModName && tab2) {
          tab2.module = parentModName;
          if (!state.expandedModules[designName].has(parentModName)) {
            state.expandedModules[designName].add(parentModName);
          }
          renderSidebar(designName);
          renderCanvas();
          setTimeout(() => navigateToModule(designName, modName), 100);
        } else if (modules[modName]) {
          // Fallback: no parent found (it's already a top-level module), just open it
          if (tab2) tab2.module = modName;
          renderSidebar(designName);
          renderCanvas();
          setTimeout(() => fitToView(), 50);
        }
      }
    });

    if (hasChildren) {
      label.addEventListener('dblclick', (e) => {
        e.preventDefault();
        // Double click on expandable: toggle expand/collapse in sidebar tree only
        const exp = state.expandedModules[designName];
        if (exp.has(modName)) exp.delete(modName);
        else exp.add(modName);
        renderSidebar(designName);
      });
    }

    tree.appendChild(label);

    // Children
    if (expanded && mod.instances) {
      const seen = new Set();
      mod.instances.forEach(inst => {
        if (!seen.has(inst.module_type)) {
          seen.add(inst.module_type);
          createNode(inst.module_type, depth + 1);
        }
      });
    }
  };

  if (topModules.length > 0) {
    topModules.forEach(t => createNode(t, 0));
  } else {
    Object.keys(modules).forEach(m => createNode(m, 0));
  }
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

  // Clear & render
  svgRoot.innerHTML = '';
  const rootG = renderDesignView(topMod, modules, expanded, state.collapsedState, layoutOvr, wireWps, {
    hideClockReset: state.hideClockReset,
    selectedWireKey: state.selectedWireKey,
    customizations: state.customizations[tab.name] || { modules: {}, wires: {} },
  });
  svgRoot.appendChild(rootG);

  // Apply current transform
  applyTransform();

  // ── Attach click handlers for expanding/collapsing modules ──
  svgRoot.querySelectorAll('.module-box').forEach(box => {
    const modName = box.getAttribute('data-module');
    const instName = box.getAttribute('data-instance');

    // Double-click to expand/collapse module internals
    box.addEventListener('dblclick', e => {
      e.stopPropagation();
      if (expanded.has(modName)) expanded.delete(modName);
      else expanded.add(modName);
      renderCanvas();
    });

    // Right-click: show floating module info popup with settings entry
    box.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      if (!instName) return;
      state.settingsTarget = { type: 'module', key: instName };
      const customs = state.customizations[tab.name] || { modules: {} };
      const modCustom = customs.modules?.[instName] || {};
      const mod = modules[modName];
      const inP = mod?.ports?.filter(p => p.direction === 'input').length || 0;
      const outP = mod?.ports?.filter(p => p.direction === 'output').length || 0;
      showModuleInfoPopup(instName, modName, modCustom, inP, outP, e.clientX, e.clientY);
    });

    // Left-click: show comment popup (if comment exists)
    box.addEventListener('click', e => {
      if (state.justFinishedDrag) return;
      e.stopPropagation();
      const customs = state.customizations[tab.name] || { modules: {} };
      const modCustom = customs.modules?.[instName] || {};
      if (modCustom.comment) {
        showCommentPopup(instName, modName, modCustom.comment, e.clientX, e.clientY);
      } else {
        closeCommentPopup();
      }
    });
  });

  // ── Attach module drag handlers (mousedown on header area) ──
  svgRoot.querySelectorAll('.module-box').forEach(box => {
    const instName = box.getAttribute('data-instance');
    if (!instName) return; // skip top-level (no instName)

    // Drag: mousedown on module header
    const headerRect = box.querySelector('rect:nth-child(2)'); // header background
    if (headerRect) {
      headerRect.style.cursor = 'move';
      headerRect.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
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
      const key = pg.getAttribute('data-group-key');
      state.collapsedState[key] = false; // false = collapsed
      saveCollapsedState(state.collapsedState);
      renderCanvas();
    });
  });

  // ── Click on background to deselect wire ──
  getSVG().addEventListener('click', e => {
    if (state.justFinishedDrag) return; // Don't deselect after drag operations
    if (e.target === getSVG() || e.target.id === 'svg-root') {
      // Don't clear box selection on background click — use close button
      if (state.selectedWireKey) {
        state.selectedWireKey = null;
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
      if (!wireKey) return;
      if (state.selectedWireKey === wireKey) {
        state.selectedWireKey = null;
      } else {
        state.selectedWireKey = wireKey;
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
      const pt = svgToDesignCoords(e.clientX, e.clientY);
      if (!pt) return;
      pushUndoSnapshot();
      if (!state.wireWaypoints[tab.name]) state.wireWaypoints[tab.name] = {};
      if (!state.wireWaypoints[tab.name][wireKey]) state.wireWaypoints[tab.name][wireKey] = [];
      state.wireWaypoints[tab.name][wireKey].push({ x: pt.x, y: pt.y });
      // Sort waypoints by x (left to right)
      state.wireWaypoints[tab.name][wireKey].sort((a, b) => a.x - b.x);
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
      const wireKey = wp.getAttribute('data-wire-key');
      const wpIdx = parseInt(wp.getAttribute('data-wp-index'));
      startWaypointDrag(e, wireKey, wpIdx, wp);
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

  // Auto-fit on first render (or restore saved view)
  const savedView = loadViewState(tab.name);
  if (savedView && state.pan.x === 0 && state.pan.y === 0 && state.zoom === 1) {
    state.pan = savedView.pan;
    state.zoom = savedView.zoom;
    applyTransform();
  } else if (state.pan.x === 0 && state.pan.y === 0 && state.zoom === 1) {
    setTimeout(fitToView, 50);
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
    startDesignX: pt.x,
    startDesignY: pt.y,
    origX, origY,
    boxEl,
  };
  $('canvas-container').style.cursor = 'move';
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
}

function onModuleDragEnd(e) {
  const t = state.editTarget;
  if (!t) return;

  const pt = svgToDesignCoords(e.clientX, e.clientY);
  if (pt) {
    pushUndoSnapshot();
    const dx = pt.x - t.startDesignX;
    const dy = pt.y - t.startDesignY;
    const newX = t.origX + dx;
    const newY = t.origY + dy;

    // Save position to layout overrides (offset by parent internal offset of 50,50)
    const designName = state.activeTab;
    if (!state.layoutOverrides[designName]) state.layoutOverrides[designName] = {};
    const ovr = state.layoutOverrides[designName][t.instName] || {};
    ovr.x = newX - 50; // subtract internal renderModuleInternal offset
    ovr.y = newY - 50;
    state.layoutOverrides[designName][t.instName] = ovr;
    saveLayout(designName, state.layoutOverrides[designName]);
  }

  state.editMode = null;
  state.editTarget = null;
  $('canvas-container').style.cursor = 'grab';
  state.justFinishedDrag = true;
  setTimeout(() => { state.justFinishedDrag = false; }, 50);
  renderCanvas(); // re-render with wires reconnected
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
    const ovr = state.layoutOverrides[designName][t.instName] || {};
    ovr.width = newW;
    ovr.height = newH;
    state.layoutOverrides[designName][t.instName] = ovr;
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
  const pt = svgToDesignCoords(e.clientX, e.clientY);
  if (!pt) return;

  state.editMode = 'drag-waypoint';
  state.editTarget = {
    wireKey, wpIdx, wpEl,
    startDesignX: pt.x,
    startDesignY: pt.y,
    origX: parseFloat(wpEl.getAttribute('cx')),
    origY: parseFloat(wpEl.getAttribute('cy')),
  };
  $('canvas-container').style.cursor = 'move';
}

function onWaypointDragMove(e) {
  const t = state.editTarget;
  const pt = svgToDesignCoords(e.clientX, e.clientY);
  if (!pt || !t) return;

  const dx = pt.x - t.startDesignX;
  const dy = pt.y - t.startDesignY;
  t.wpEl.setAttribute('cx', t.origX + dx);
  t.wpEl.setAttribute('cy', t.origY + dy);
}

function onWaypointDragEnd(e) {
  const t = state.editTarget;
  if (!t) return;

  const pt = svgToDesignCoords(e.clientX, e.clientY);
  if (pt) {
    pushUndoSnapshot();
    const dx = pt.x - t.startDesignX;
    const dy = pt.y - t.startDesignY;
    const newX = t.origX + dx;
    const newY = t.origY + dy;

    const designName = state.activeTab;
    if (state.wireWaypoints[designName]?.[t.wireKey]?.[t.wpIdx]) {
      state.wireWaypoints[designName][t.wireKey][t.wpIdx] = { x: newX, y: newY };
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

  // Count waypoints
  const tab = state.openTabs.find(t => t.name === state.activeTab);
  const wpCount = tab ? (state.wireWaypoints[tab.name]?.[wireKey]?.length || 0) : 0;

  content.innerHTML = `
    <span class="label">🔌 线路:</span> <span class="value" style="color:#4fc3f7">${signal || wireKey}</span> &nbsp;
    <span class="label">源:</span> <span class="value" style="color:#ef5350">${srcInst}</span>.<span class="value">${srcPort}</span> &nbsp;
    <span class="label">→ 目标:</span> <span class="value" style="color:#81c784">${dstInst}</span>.<span class="value">${dstPort}</span>
    &nbsp;<span class="label">拐点:</span> <span class="value">${wpCount}</span>
    &nbsp;<span style="color:#484f58;font-size:11px;">| 双击添加拐点 | 右键拐点删除 | 单击空白取消选中</span>`;
}

function closeInfoPanel() {
  $('info-panel').style.display = 'none';
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
    if (state.editMode === 'drag-box-selection') { onBoxSelectionDragMove(e); return; }
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
    if (state.editMode === 'drag-box-selection') { onBoxSelectionDragEnd(e); return; }
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
    }
  });
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
  });

  const snapshot = state.undoStack.pop();
  state.layoutOverrides[name] = snapshot.layoutOverrides;
  state.wireWaypoints[name] = snapshot.wireWaypoints;
  saveLayout(name, state.layoutOverrides[name]);
  saveWireWaypoints(name, state.wireWaypoints[name]);
  renderCanvas();
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
  });

  const snapshot = state.redoStack.pop();
  state.layoutOverrides[name] = snapshot.layoutOverrides;
  state.wireWaypoints[name] = snapshot.wireWaypoints;
  saveLayout(name, state.layoutOverrides[name]);
  saveWireWaypoints(name, state.wireWaypoints[name]);
  renderCanvas();
  showToast('已重做', 'info');
}

// ─── Settings / Customization Modal ─────────────────────────────────────

function openSettingsPanel() {
  const target = state.settingsTarget;
  if (!target || !state.activeTab) return;

  const customs = state.customizations[state.activeTab] || { modules: {}, wires: {} };
  const content = $('settings-content');
  content.innerHTML = '';

  if (target.type === 'module') {
    const existing = customs.modules?.[target.key] || {};
    content.innerHTML = `
      <h4 style="color:#c9d1d9;margin-bottom:12px;">模块设置: ${target.key}</h4>
      <div class="settings-row">
        <label>颜色</label>
        <input type="color" id="set-mod-color" value="${existing.color || '#1c2333'}" />
        <button class="btn-secondary" onclick="document.getElementById('set-mod-color').value='#1c2333'" style="padding:4px 8px;font-size:11px;">重置</button>
      </div>
      <div class="settings-row">
        <label>重命名</label>
        <input type="text" id="set-mod-rename" placeholder="自定义显示名称..." value="${existing.rename || ''}" />
      </div>
      <div class="settings-row">
        <label>注释</label>
        <div style="flex:1;display:flex;flex-direction:column;gap:6px;">
          <textarea id="set-mod-comment" placeholder="支持 Markdown 格式...">${existing.comment || ''}</textarea>
          <button class="btn-secondary" onclick="document.getElementById('comment-file-input').click()" style="align-self:flex-start;padding:4px 10px;font-size:11px;">📂 导入 .md 文件</button>
        </div>
      </div>`;
  } else if (target.type === 'wire') {
    const existing = customs.wires?.[target.key] || {};
    content.innerHTML = `
      <h4 style="color:#c9d1d9;margin-bottom:12px;">线路设置: ${target.key}</h4>
      <div class="settings-row">
        <label>颜色</label>
        <input type="color" id="set-wire-color" value="${existing.color || '#4fc3f7'}" />
        <button class="btn-secondary" onclick="document.getElementById('set-wire-color').value='#4fc3f7'" style="padding:4px 8px;font-size:11px;">重置</button>
      </div>`;
  }

  $('settings-overlay').style.display = 'flex';
}

function closeSettingsModal() {
  $('settings-overlay').style.display = 'none';
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
    const textarea = $('set-mod-comment');
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
    state.customizations[state.activeTab] = { modules: {}, wires: {} };
  }
  const customs = state.customizations[state.activeTab];

  if (target.type === 'module') {
    const color = $('set-mod-color')?.value;
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
    const color = $('set-wire-color')?.value;
    if (!customs.wires) customs.wires = {};
    if (color && color !== '#4fc3f7') {
      customs.wires[target.key] = { color };
    } else {
      delete customs.wires[target.key];
    }
  }

  saveCustomizations(state.activeTab, customs);
  closeSettingsModal();
  renderCanvas();
  showToast('设置已应用', 'success');
}

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
    const instName = box.getAttribute('data-instance');
    if (!instName) return;
    const transform = box.getAttribute('transform');
    const match = transform?.match(/translate\(\s*([\d.e+-]+)\s*,\s*([\d.e+-]+)\s*\)/);
    if (!match) return;
    const mx = parseFloat(match[1]);
    const my = parseFloat(match[2]);
    const mRect = box.querySelector('.module-rect');
    const mw = mRect ? parseFloat(mRect.getAttribute('width')) : 150;
    const mh = mRect ? parseFloat(mRect.getAttribute('height')) : 100;

    // Check if module center is within selection
    const cx = mx + mw / 2;
    const cy = my + mh / 2;
    if (cx >= selX1 && cx <= selX2 && cy >= selY1 && cy <= selY2) {
      selectedModules.add(instName);
    }
  });

  svgRoot.querySelectorAll('.wire-waypoint').forEach(wp => {
    const wxc = parseFloat(wp.getAttribute('cx'));
    const wyc = parseFloat(wp.getAttribute('cy'));
    if (wxc >= selX1 && wxc <= selX2 && wyc >= selY1 && wyc <= selY2) {
      selectedWaypoints.push({
        wireKey: wp.getAttribute('data-wire-key'),
        idx: parseInt(wp.getAttribute('data-wp-index')),
      });
    }
  });

  if (selectedModules.size === 0 && selectedWaypoints.length === 0) {
    clearBoxSelection();
    return;
  }

  state.boxSelection = { items: selectedModules, waypoints: selectedWaypoints };
  renderBoxSelectionHighlight();
}

function renderBoxSelectionHighlight() {
  if (!state.boxSelection) return;
  const svgRoot = getSVGRoot();

  // Highlight selected modules
  svgRoot.querySelectorAll('.module-box').forEach(box => {
    const instName = box.getAttribute('data-instance');
    if (state.boxSelection.items.has(instName)) {
      box.classList.add('box-selected');
    } else {
      box.classList.remove('box-selected');
    }
  });

  // Highlight selected waypoints
  svgRoot.querySelectorAll('.wire-waypoint').forEach(wp => {
    const wk = wp.getAttribute('data-wire-key');
    const idx = parseInt(wp.getAttribute('data-wp-index'));
    const isSelected = state.boxSelection.waypoints.some(w => w.wireKey === wk && w.idx === idx);
    if (isSelected) {
      wp.setAttribute('fill', '#ffeb3b');
      wp.setAttribute('r', 7);
    }
  });

  // Add close button overlay
  removeBoxSelectionCloseBtn();
  const designRoot = getSVGRoot().querySelector('#design-root');
  if (!designRoot) return;

  // Find bounding box of selected items
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  svgRoot.querySelectorAll('.module-box.box-selected').forEach(box => {
    const transform = box.getAttribute('transform');
    const match = transform?.match(/translate\(\s*([\d.e+-]+)\s*,\s*([\d.e+-]+)\s*\)/);
    if (!match) return;
    const mx = parseFloat(match[1]);
    const my = parseFloat(match[2]);
    const mRect = box.querySelector('.module-rect');
    const mw = mRect ? parseFloat(mRect.getAttribute('width')) : 150;
    const mh = mRect ? parseFloat(mRect.getAttribute('height')) : 100;
    minX = Math.min(minX, mx);
    minY = Math.min(minY, my);
    maxX = Math.max(maxX, mx + mw);
    maxY = Math.max(maxY, my + mh);
  });

  state.boxSelection.waypoints.forEach(wpRef => {
    const wps = state.wireWaypoints[state.activeTab]?.[wpRef.wireKey];
    if (wps?.[wpRef.idx]) {
      const wp = wps[wpRef.idx];
      minX = Math.min(minX, wp.x - 10);
      minY = Math.min(minY, wp.y - 10);
      maxX = Math.max(maxX, wp.x + 10);
      maxY = Math.max(maxY, wp.y + 10);
    }
  });

  if (minX === Infinity) return;

  // Draw selection bounding box
  const pad = 10;
  const selBorder = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  selBorder.id = 'box-selection-border';
  selBorder.setAttribute('x', minX - pad);
  selBorder.setAttribute('y', minY - pad);
  selBorder.setAttribute('width', maxX - minX + pad * 2);
  selBorder.setAttribute('height', maxY - minY + pad * 2);
  selBorder.setAttribute('fill', 'none');
  selBorder.setAttribute('stroke', '#58a6ff');
  selBorder.setAttribute('stroke-width', 2 / state.zoom);
  selBorder.setAttribute('stroke-dasharray', `${6/state.zoom},${3/state.zoom}`);
  selBorder.setAttribute('rx', 4);
  selBorder.setAttribute('pointer-events', 'none');
  designRoot.appendChild(selBorder);

  // Close button (X) at top-right of selection box
  const closeBtnSize = 18 / state.zoom;
  const closeG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  closeG.id = 'box-selection-close';
  closeG.style.cursor = 'pointer';

  const closeBg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  closeBg.setAttribute('cx', maxX + pad);
  closeBg.setAttribute('cy', minY - pad);
  closeBg.setAttribute('r', closeBtnSize / 2);
  closeBg.setAttribute('fill', '#da3633');
  closeBg.setAttribute('stroke', '#0d1117');
  closeBg.setAttribute('stroke-width', 1.5 / state.zoom);
  closeG.appendChild(closeBg);

  const closeTxt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  closeTxt.setAttribute('x', maxX + pad);
  closeTxt.setAttribute('y', minY - pad + closeBtnSize * 0.15);
  closeTxt.setAttribute('text-anchor', 'middle');
  closeTxt.setAttribute('fill', '#fff');
  closeTxt.setAttribute('font-size', closeBtnSize * 0.7);
  closeTxt.setAttribute('font-weight', 'bold');
  closeTxt.setAttribute('pointer-events', 'none');
  closeTxt.textContent = '✕';
  closeG.appendChild(closeTxt);

  closeG.addEventListener('click', (e) => {
    e.stopPropagation();
    clearBoxSelection();
  });

  designRoot.appendChild(closeG);

  // Make the selection border draggable for group move
  selBorder.setAttribute('pointer-events', 'all');
  selBorder.style.cursor = 'move';
  selBorder.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    startBoxSelectionDrag(e);
  });
}

function removeBoxSelectionCloseBtn() {
  const border = document.getElementById('box-selection-border');
  if (border) border.remove();
  const closeBtn = document.getElementById('box-selection-close');
  if (closeBtn) closeBtn.remove();
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
    state.boxSelection.items.forEach(instName => {
      const box = svgRoot.querySelector(`.module-box[data-instance="${instName}"]`);
      if (box) {
        const transform = box.getAttribute('transform');
        const match = transform?.match(/translate\(\s*([\d.e+-]+)\s*,\s*([\d.e+-]+)\s*\)/);
        if (match) {
          state.editTarget.origPositions[instName] = { x: parseFloat(match[1]), y: parseFloat(match[2]), boxEl: box };
        }
      }
    });
    state.boxSelection.waypoints.forEach(wpRef => {
      const key = `${wpRef.wireKey}:${wpRef.idx}`;
      const wps = state.wireWaypoints[state.activeTab]?.[wpRef.wireKey];
      if (wps?.[wpRef.idx]) {
        state.editTarget.origWaypoints[key] = { ...wps[wpRef.idx], wireKey: wpRef.wireKey, idx: wpRef.idx };
      }
    });
  }
  $('canvas-container').style.cursor = 'move';
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
  }
  // Move all selected waypoints visually
  const svgRoot = getSVGRoot();
  for (const [key, orig] of Object.entries(t.origWaypoints)) {
    const wp = svgRoot.querySelector(`.wire-waypoint[data-wire-key="${orig.wireKey}"][data-wp-index="${orig.idx}"]`);
    if (wp) {
      wp.setAttribute('cx', orig.x + dx);
      wp.setAttribute('cy', orig.y + dy);
    }
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
    for (const [instName, orig] of Object.entries(t.origPositions)) {
      const ovr = state.layoutOverrides[designName][instName] || {};
      ovr.x = orig.x + dx - 50;
      ovr.y = orig.y + dy - 50;
      state.layoutOverrides[designName][instName] = ovr;
    }
    saveLayout(designName, state.layoutOverrides[designName]);

    // Persist waypoint positions
    for (const [key, orig] of Object.entries(t.origWaypoints)) {
      if (state.wireWaypoints[designName]?.[orig.wireKey]?.[orig.idx]) {
        state.wireWaypoints[designName][orig.wireKey][orig.idx] = { x: orig.x + dx, y: orig.y + dy };
      }
    }
    saveWireWaypoints(designName, state.wireWaypoints[designName]);
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
