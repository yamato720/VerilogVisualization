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
function saveHideClockReset(val) {
  try { localStorage.setItem(STORAGE_HIDE_CLK_RST, JSON.stringify(val)); } catch(e) {}
}
function loadHideClockReset() {
  try { const d = localStorage.getItem(STORAGE_HIDE_CLK_RST); return d !== null ? JSON.parse(d) : true; }
  catch(e) { return true; }
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
      // Single click: navigate to the module instance position in the current canvas
      navigateToModule(designName, modName);
    });

    if (hasChildren) {
      label.addEventListener('dblclick', (e) => {
        e.preventDefault();
        // Double click on expandable: toggle expand/collapse in sidebar tree
        const exp = state.expandedModules[designName];
        if (exp.has(modName)) exp.delete(modName);
        else exp.add(modName);
        // Also set as viewed module and expand in canvas
        if (tab) tab.module = modName;
        renderSidebar(designName);
        renderCanvas();
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
    if (e.target === getSVG() || e.target.id === 'svg-root') {
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
    // Normal pan end
    if (state.dragging) {
      state.dragging = false;
      $('canvas-container').style.cursor = 'grab';
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

  // Build standalone SVG
  const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vbX} ${vbY} ${vbW} ${vbH}" width="${vbW}" height="${vbH}" style="background:#0d1117;">
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
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, canvasW, canvasH);

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
