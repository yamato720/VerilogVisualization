/**
 * block_design.js — Block Design mode for Chisel visual editing.
 * Manages: folder browsing, file selection, module tabs, canvas interactions,
 * module drag-from-sidebar, pin editing, wire connections, waypoints.
 */

// ─── Block Design State ─────────────────────────────────────────────────

const BD_STORAGE_PREFIX = 'bd_';

const bdState = {
  folder: '',              // Current Chisel source folder
  scalaFiles: [],          // [{name, path}]
  selectedFile: null,      // Currently checked .scala file path
  selectedFileName: '',    // Currently checked .scala file name
  selectedFileEditable: false, // Whether selected file has // editable marker
  allModules: {},          // moduleName -> module data (from folder)
  fileModules: [],         // modules in the selected file
  activeModule: null,      // Currently active module name in canvas
  // Canvas data per module: { moduleName: { instances: [{id, moduleType, x, y}], wires: [{id, from, to, waypoints}], pins: [{name, dir, width, side, pos}] } }
  canvasData: {},
  // Layout: positions overrides
  layoutOverrides: {},
  // Customizations: { modules: { instId: {color, rename, comment} }, wires: { wireId: {color} } }
  customizations: {},
  // Selected wire
  selectedWireId: null,
  // Pan/zoom
  pan: { x: 0, y: 0 },
  zoom: 1,
  dragging: false,
  dragStart: { x: 0, y: 0 },
  panStart: { x: 0, y: 0 },
  // Edit modes
  editMode: null,  // null | 'drag-instance' | 'drag-pin' | 'draw-wire' | 'drag-waypoint'
  editTarget: null,
  // Wire drawing
  wireStart: null,  // { instanceId, pinName, x, y } or { type: 'module-pin', pinName, x, y }
  tempWirePath: null,
  // Next IDs
  nextInstanceId: 1,
  nextWireId: 1,
  // File browser state
  fbCurrentPath: '/home',
  fbSelectedPath: '',
  // Undo
  undoStack: [],
  redoStack: [],
  maxUndo: 50,
  justFinishedDrag: false,
  // Customize target
  customizeTarget: null,  // { type: 'instance'|'wire', id: string }
};

// ─── Persistence ─────────────────────────────────────────────────────────

function bdSave(key, data) {
  try { localStorage.setItem(BD_STORAGE_PREFIX + key, JSON.stringify(data)); } catch(e) {}
}
function bdLoad(key) {
  try { const d = localStorage.getItem(BD_STORAGE_PREFIX + key); return d ? JSON.parse(d) : null; } catch(e) { return null; }
}

function bdSaveState() {
  if (!bdState.folder) return;
  const key = btoa(bdState.folder).replace(/[/+=]/g, '_');
  bdSave('state_' + key, {
    selectedFile: bdState.selectedFile,
    canvasData: bdState.canvasData,
    layoutOverrides: bdState.layoutOverrides,
    customizations: bdState.customizations,
    nextInstanceId: bdState.nextInstanceId,
    nextWireId: bdState.nextWireId,
  });
  // Remember last folder so the page can auto-restore on reload
  try { localStorage.setItem(BD_STORAGE_PREFIX + 'last_folder', bdState.folder); } catch(e) {}
  // Sync to server
  bdScheduleSyncToServer();
}

function bdLoadState() {
  if (!bdState.folder) return;
  const key = btoa(bdState.folder).replace(/[/+=]/g, '_');
  const saved = bdLoad('state_' + key);
  if (saved) {
    bdState.canvasData = saved.canvasData || {};
    bdState.layoutOverrides = saved.layoutOverrides || {};
    bdState.customizations = saved.customizations || {};
    bdState.nextInstanceId = saved.nextInstanceId || 1;
    bdState.nextWireId = saved.nextWireId || 1;
    if (saved.selectedFile) {
      bdState.selectedFile = saved.selectedFile;
      const f = bdState.scalaFiles.find(f2 => f2.path === saved.selectedFile);
      if (f) bdState.selectedFileName = f.name;
    }
  }
}

// ─── Server Sync ─────────────────────────────────────────────────────────

let _bdSyncTimer = null;
function bdScheduleSyncToServer() {
  if (_bdSyncTimer) clearTimeout(_bdSyncTimer);
  _bdSyncTimer = setTimeout(bdSyncToServer, 800);
}

function bdSyncToServer() {
  if (!bdState.folder) return;
  const folderName = bdState.folder.split('/').filter(Boolean).pop() || 'untitled';
  fetch('/api/chisel/save_design_state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: folderName,
      folder: bdState.folder,
      selectedFile: bdState.selectedFile,
      canvasData: bdState.canvasData,
      customizations: bdState.customizations,
      nextInstanceId: bdState.nextInstanceId,
      nextWireId: bdState.nextWireId,
    }),
  }).catch(() => {});
}

async function bdLoadFromServer() {
  if (!bdState.folder) return false;
  const folderName = bdState.folder.split('/').filter(Boolean).pop() || 'untitled';
  try {
    const res = await fetch(`/api/chisel/design/${encodeURIComponent(folderName)}`);
    if (!res.ok) return false;
    const data = await res.json();
    if (data.canvasData) bdState.canvasData = data.canvasData;
    if (data.customizations) bdState.customizations = data.customizations;
    if (data.nextInstanceId) bdState.nextInstanceId = data.nextInstanceId;
    if (data.nextWireId) bdState.nextWireId = data.nextWireId;
    if (data.selectedFile) {
      bdState.selectedFile = data.selectedFile;
      const f = bdState.scalaFiles.find(f2 => f2.path === data.selectedFile);
      if (f) bdState.selectedFileName = f.name;
    }
    return true;
  } catch(e) { return false; }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

const bd$ = id => document.getElementById(id);

// ─── Local Toast ─────────────────────────────────────────────────────────

function bdShowToast(msg, type = 'info') {
  let container = bd$('toast-container');
  if (!container) return;
  const colors = { success: '#238636', error: '#da3633', warn: '#9e6a03', info: '#1f6feb' };
  const toast = document.createElement('div');
  toast.style.cssText = `background:${colors[type]||colors.info};color:#fff;padding:8px 16px;border-radius:6px;
    font-size:13px;opacity:1;transition:opacity 0.4s;pointer-events:none;max-width:320px;word-break:break-word;`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 400); }, 3000);
}

// ─── Window Management ──────────────────────────────────────────────────

function openBlockDesignWindow() {
  window.open('/block-design', '_blank');
}

function closeBlockDesignWindow() {
  bdSaveState();
  window.close();
}

// ─── File Browser ───────────────────────────────────────────────────────

function bdOpenFileBrowser() {
  bd$('bd-fb-overlay').style.display = 'flex';
  bdState.fbSelectedPath = '';
  bd$('bd-fb-selected-path').textContent = '（无）';
  bd$('bd-fb-btn-confirm').disabled = true;
  bdFbNavigateTo(bdState.folder || '/home');
}

function bdCloseFileBrowser() {
  bd$('bd-fb-overlay').style.display = 'none';
}

async function bdFbNavigateTo(dirPath) {
  if (typeof dirPath !== 'string') dirPath = bdState.fbCurrentPath;
  dirPath = dirPath.trim() || '/';
  bdState.fbCurrentPath = dirPath;
  bd$('bd-fb-path-input').value = dirPath;
  bdUpdateBreadcrumb(dirPath);

  try {
    const res = await fetch('/api/chisel/browse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: dirPath }),
    });
    const data = await res.json();
    if (data.error) { bdShowToast('浏览失败: ' + data.error, 'error'); return; }
    bdState.fbCurrentPath = data.current;
    bd$('bd-fb-path-input').value = data.current;
    bdUpdateBreadcrumb(data.current);
    bdRenderFbFileList(data.entries, data.current);
  } catch (err) {
    bdShowToast('请求失败: ' + err.message, 'error');
  }
}

function bdUpdateBreadcrumb(dirPath) {
  const bc = bd$('bd-fb-breadcrumb');
  bc.innerHTML = '';
  const parts = dirPath.split('/').filter(Boolean);
  let acc = '';

  const rootSpan = document.createElement('span');
  rootSpan.className = 'fb-crumb';
  rootSpan.textContent = '🏠 /';
  rootSpan.addEventListener('click', () => bdFbNavigateTo('/'));
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
    btn.addEventListener('click', () => bdFbNavigateTo(target));
    bc.appendChild(btn);
  });
}

function bdRenderFbFileList(entries, currentPath) {
  const list = bd$('bd-fb-file-list');
  list.innerHTML = '';

  if (currentPath !== '/') {
    const parentPath = currentPath.replace(/\/[^/]+\/?$/, '') || '/';
    const row = document.createElement('div');
    row.className = 'fb-entry';
    row.innerHTML = `<span class="fb-icon">📁</span><span class="fb-name">..</span>`;
    row.addEventListener('click', () => bdFbNavigateTo(parentPath));
    list.appendChild(row);
  }

  entries.forEach(entry => {
    const row = document.createElement('div');
    row.className = 'fb-entry';
    let icon = entry.is_dir ? '📁' : '📝';
    let badge = '';
    if (entry.is_dir && entry.has_scala) badge = '<span class="fb-badge" style="background:#9c27b033;color:#ce93d8;">S</span>';
    row.innerHTML = `<span class="fb-icon">${icon}</span><span class="fb-name">${entry.name}</span>${badge}`;

    if (entry.is_dir) {
      row.addEventListener('dblclick', () => bdFbNavigateTo(entry.path));
      row.addEventListener('click', () => {
        bdState.fbSelectedPath = entry.path;
        bd$('bd-fb-selected-path').textContent = entry.path;
        bd$('bd-fb-btn-confirm').disabled = false;
        list.querySelectorAll('.fb-entry.selected').forEach(el => el.classList.remove('selected'));
        row.classList.add('selected');
      });
    }
    list.appendChild(row);
  });
}

async function bdFbConfirm() {
  const folder = bdState.fbSelectedPath || bdState.fbCurrentPath;
  if (!folder) return;
  bdCloseFileBrowser();
  await bdSetFolder(folder);
}

function bdFbGoUp() {
  const parent = bdState.fbCurrentPath.replace(/\/[^/]+\/?$/, '') || '/';
  bdFbNavigateTo(parent);
}

function bdFbGoHome() {
  bdFbNavigateTo('/home');
}

// ─── Folder & File Management ───────────────────────────────────────────

async function bdSetFolder(folder) {
  bdState.folder = folder;
  bd$('bd-folder-path').className = 'status-msg success';
  bd$('bd-folder-path').textContent = folder;

  // Load scala files
  try {
    const res = await fetch('/api/chisel/list_files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder }),
    });
    const data = await res.json();
    bdState.scalaFiles = data.files || [];
  } catch(e) {
    bdState.scalaFiles = [];
  }

  // Load all modules from folder
  try {
    const res = await fetch('/api/chisel/parse_folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder }),
    });
    const data = await res.json();
    bdState.allModules = data.modules || {};
  } catch(e) {
    bdState.allModules = {};
  }

  // Load persisted state (try server first, then localStorage)
  const fromServer = await bdLoadFromServer();
  if (!fromServer) bdLoadState();

  bd$('bd-files-section').style.display = '';
  bd$('bd-modules-section').style.display = '';

  bdRenderFileList();
  bdRenderModuleTree();

  // If a file was previously selected, load it
  if (bdState.selectedFile) {
    await bdSelectFile(bdState.selectedFile);
  }

  // Refresh history list
  bdLoadHistoryList();
}

function bdRenderFileList() {
  const list = bd$('bd-file-list');
  list.innerHTML = '';

  if (bdState.scalaFiles.length === 0) {
    list.innerHTML = '<div style="color:#484f58;font-size:12px;padding:8px;">无 .scala 文件</div>';
    return;
  }

  bdState.scalaFiles.forEach(f => {
    const item = document.createElement('div');
    item.className = 'design-item';
    const isSelected = f.path === bdState.selectedFile;
    const checkbox = `<input type="radio" name="bd-file-radio" ${isSelected ? 'checked' : ''} style="margin-right:8px;accent-color:#58a6ff;" />`;
    item.innerHTML = `${checkbox}<span class="name">${f.name}</span>`;
    item.style.cursor = 'pointer';
    if (isSelected) item.classList.add('active');

    item.addEventListener('click', () => bdSelectFile(f.path));
    list.appendChild(item);
  });
}

async function bdSelectFile(filePath) {
  bdState.selectedFile = filePath;
  const f = bdState.scalaFiles.find(f2 => f2.path === filePath);
  bdState.selectedFileName = f ? f.name : '';

  // Parse modules in this file
  try {
    const res = await fetch('/api/chisel/parse_file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath }),
    });
    const data = await res.json();
    bdState.fileModules = data.modules || [];
    bdState.selectedFileEditable = data.editable || false;
  } catch(e) {
    bdState.fileModules = [];
    bdState.selectedFileEditable = false;
  }

  // Initialize canvas data for each module if not exists (or re-init stale empty data)
  bdState.fileModules.forEach(mod => {
    const existing = bdState.canvasData[mod.name];
    const parsedInstances = mod.instances || [];
    const isStale = existing && existing.instances.length === 0 && parsedInstances.length > 0;
    if (!existing || isStale) {
      const pins = mod.ports.map((p, i) => ({
        name: p.name,
        direction: p.direction,
        width: p.width,
        condition: p.condition || null,
        side: p.direction === 'input' ? 'left' : 'right',
        pos: i,
      }));

      // Auto-populate instances from Chisel source (val x = Module(new T()))
      const autoInstances = [];
      const COLS = 3;
      const COL_W = 280, COL_H = 220, START_X = 220, START_Y = 100;
      parsedInstances.forEach((inst, idx) => {
        // Only add if the module type is known in allModules
        if (bdState.allModules[inst.module_type]) {
          const col = idx % COLS;
          const row = Math.floor(idx / COLS);
          autoInstances.push({
            id: inst.instance_name,
            moduleType: inst.module_type,
            argsText: inst.args_text || null,
            x: START_X + col * COL_W,
            y: START_Y + row * COL_H,
          });
        }
      });

      // Auto-populate wires from parsed := connections
      const autoWires = [];
      (mod.connections || []).forEach((conn, idx) => {
        // LHS of := is destination (to), RHS is source (from)
        autoWires.push({
          id: 'wire_c_' + idx,
          from: {
            instanceId: conn.rhs.instanceId || null,
            pinName: conn.rhs.pinName,
            type: conn.rhs.type,
          },
          to: {
            instanceId: conn.lhs.instanceId || null,
            pinName: conn.lhs.pinName,
            type: conn.lhs.type,
          },
          waypoints: [],
        });
      });

      bdState.canvasData[mod.name] = {
        instances: autoInstances,
        wires: autoWires,
        pins,
        params: (mod.params || []).map(p => ({ name: p.name, type: p.type, default: p.default })),
      };

      // Update nextInstanceId to avoid collision with auto-populated instance ids
      // (auto instances use parsed names like "i_ALU_inst" which are strings, so no collision)
    }
  });

  // Set active module to first one
  if (bdState.fileModules.length > 0) {
    if (!bdState.activeModule || !bdState.fileModules.find(m => m.name === bdState.activeModule)) {
      bdState.activeModule = bdState.fileModules[0].name;
    }
  } else {
    bdState.activeModule = null;  // Clear canvas — file has no modules
  }

  bdRenderFileList();
  bdRenderModuleTabs();
  bdRenderModuleTree();
  bdRenderCanvas();
  bdUpdateSaveButton();
  bdSaveState();
}

// ─── Module Tabs ────────────────────────────────────────────────────────

function bdRenderModuleTabs() {
  const tabs = bd$('bd-module-tabs');
  tabs.innerHTML = '';

  bdState.fileModules.forEach(mod => {
    const tab = document.createElement('div');
    tab.className = 'bd-tab' + (mod.name === bdState.activeModule ? ' active' : '');
    tab.textContent = mod.name;
    tab.addEventListener('click', () => {
      bdState.activeModule = mod.name;
      bdRenderModuleTabs();
      bdRenderCanvas();
    });
    tabs.appendChild(tab);
  });
}

// ─── Module Tree (all modules, grouped by file, draggable) ─────────────

function bdRenderModuleTree() {
  const tree = bd$('bd-module-tree');
  tree.innerHTML = '';

  const moduleNames = Object.keys(bdState.allModules);
  if (moduleNames.length === 0) {
    tree.innerHTML = '<div style="color:#484f58;font-size:12px;padding:8px;">无模块</div>';
    return;
  }

  // Group by source file
  const byFile = {};
  moduleNames.forEach(name => {
    const mod = bdState.allModules[name];
    const fname = (mod.file_path || '').split('/').pop() || '?';
    if (!byFile[fname]) byFile[fname] = [];
    byFile[fname].push(name);
  });

  Object.keys(byFile).sort().forEach(fname => {
    const header = document.createElement('div');
    header.className = 'bd-tree-file-header';
    header.textContent = fname;
    tree.appendChild(header);

    byFile[fname].sort().forEach(name => {
      const mod = bdState.allModules[name];
      const ports = mod.ports || [];
      const inCount  = ports.filter(p => p.direction === 'input').length;
      const outCount = ports.filter(p => p.direction === 'output').length;
      const valCount = (mod.internal_vals || []).length;
      const node = document.createElement('div');
      node.className = 'bd-tree-node';
      const valBadge = valCount > 0 ? ` <span style="color:#e0a040" title="内部变量">${valCount}v</span>` : '';
      node.innerHTML = `<span>📦</span> <span>${name}</span> <span class="bd-tree-count"><span style="color:#81c784">${inCount}↓</span> <span style="color:#ef5350">${outCount}↑</span>${valBadge}</span>`;
      node.setAttribute('draggable', 'true');
      node.setAttribute('data-module-type', name);
      node.addEventListener('dragstart', e => {
        e.dataTransfer.setData('text/plain', name);
        e.dataTransfer.effectAllowed = 'copy';
      });
      tree.appendChild(node);
    });
  });
}

// ─── Save Button State ──────────────────────────────────────────────────

function bdUpdateSaveButton() {
  const btn = bd$('bd-save-btn');
  if (!btn) return;
  btn.style.display = '';
  if (bdState.selectedFileEditable) {
    btn.disabled = false;
    btn.title = '保存到 Chisel 文件';
    btn.style.opacity = '1';
  } else {
    btn.disabled = true;
    btn.title = '只读文件（缺少 // editable 标记）';
    btn.style.opacity = '0.4';
  }
}

// ─── Save Canvas to Chisel ──────────────────────────────────────────────

async function bdSaveToChisel() {
  if (!bdState.selectedFile) { bdShowToast('请先选择一个文件', 'warn'); return; }
  if (!bdState.selectedFileEditable) { bdShowToast('该文件不可编辑（缺少 // editable 标记）', 'error'); return; }
  if (!bdState.activeModule) { bdShowToast('请先选择一个模块', 'warn'); return; }

  const cd = bdState.canvasData[bdState.activeModule];
  if (!cd) return;

  const ports = (cd.pins || []).map(p => ({ name: p.name, direction: p.direction, width: p.width }));
  const instances = (cd.instances || []).map(i => {
    const o = { id: i.id, moduleType: i.moduleType };
    if (i.paramValues) o.paramValues = i.paramValues;
    return o;
  });
  const wires = cd.wires || [];
  const params = cd.params || [];

  try {
    const res = await fetch('/api/chisel/save_canvas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file_path: bdState.selectedFile,
        module_name: bdState.activeModule,
        ports,
        instances,
        wires,
        params,
      }),
    });
    const data = await res.json();
    if (data.error) { bdShowToast('保存失败: ' + data.error, 'error'); return; }
    bdShowToast('✅ 已保存到 ' + bdState.selectedFileName, 'success');
    // Re-sync: re-parse file modules but don't reset existing canvasData
    try {
      const res2 = await fetch('/api/chisel/parse_file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: bdState.selectedFile }),
      });
      const data2 = await res2.json();
      bdState.fileModules = data2.modules || [];
      bdRenderModuleTree();
    } catch(e2) {}
  } catch(e) {
    bdShowToast('保存失败: ' + e.message, 'error');
  }
}

// ─── New File Creation ──────────────────────────────────────────────────

function bdCreateNewFile() {
  if (!bdState.folder) { bdShowToast('请先选择文件夹', 'warn'); return; }
  bd$('bd-newfile-overlay').style.display = 'flex';
  bd$('bd-newfile-name').value = '';
  bd$('bd-newfile-name').focus();
}

function bdCloseNewFileDialog() {
  bd$('bd-newfile-overlay').style.display = 'none';
}

async function bdConfirmNewFile() {
  const name = bd$('bd-newfile-name').value.trim();
  if (!name) { bdShowToast('请输入文件名', 'warn'); return; }

  try {
    const res = await fetch('/api/chisel/create_file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: bdState.folder, file_name: name }),
    });
    const data = await res.json();
    if (data.error) { bdShowToast('创建失败: ' + data.error, 'error'); return; }
    bdCloseNewFileDialog();
    bdShowToast(`已创建 ${data.name}`, 'success');
    // Refresh file list
    await bdSetFolder(bdState.folder);
  } catch(e) {
    bdShowToast('创建失败: ' + e.message, 'error');
  }
}

// ─── New Module Creation ────────────────────────────────────────────────

function bdCreateNewModule() {
  if (!bdState.selectedFile) { bdShowToast('请先选择一个 .scala 文件', 'warn'); return; }
  bd$('bd-newmod-overlay').style.display = 'flex';
  bd$('bd-newmod-name').value = '';
  bd$('bd-newmod-name').focus();
}

function bdCloseNewModuleDialog() {
  bd$('bd-newmod-overlay').style.display = 'none';
}

async function bdConfirmNewModule() {
  const name = bd$('bd-newmod-name').value.trim();
  if (!name) { bdShowToast('请输入模块名', 'warn'); return; }
  if (!/^[A-Z]/.test(name)) { bdShowToast('模块名应以大写字母开头', 'warn'); return; }

  try {
    const res = await fetch('/api/chisel/save_module', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_path: bdState.selectedFile, module_name: name, ports: [] }),
    });
    const data = await res.json();
    if (data.error) { bdShowToast('创建失败: ' + data.error, 'error'); return; }
    bdCloseNewModuleDialog();
    bdShowToast(`已创建模块 ${name}`, 'success');

    // Re-parse
    await bdSelectFile(bdState.selectedFile);
    bdState.activeModule = name;
    bdRenderModuleTabs();
    bdRenderCanvas();

    // Re-parse all modules
    try {
      const res2 = await fetch('/api/chisel/parse_folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: bdState.folder }),
      });
      const data2 = await res2.json();
      bdState.allModules = data2.modules || {};
      bdRenderModuleTree();
    } catch(e2) {}
  } catch(e) {
    bdShowToast('创建失败: ' + e.message, 'error');
  }
}

// ─── Settings (Pin Editor) ──────────────────────────────────────────────

function bdOpenSettings() {
  if (!bdState.activeModule) { bdShowToast('请先选择一个模块', 'warn'); return; }

  const content = bd$('bd-settings-content');
  const cd = bdState.canvasData[bdState.activeModule];
  const pins = cd ? cd.pins || [] : [];
  const moduleParams = cd ? cd.params || [] : [];

  let html = `<h4 style="color:#c9d1d9;margin-bottom:12px;">模块: ${bdState.activeModule}</h4>`;

  // Collect all known parameter types from internal modules + standard Chisel types
  const knownTypes = new Set(['Int', 'Boolean', 'String', 'BigInt', 'Double', 'Long']);
  Object.values(bdState.allModules || {}).forEach(m => {
    (m.params || []).forEach(p => { if (p.type) knownTypes.add(p.type); });
  });
  moduleParams.forEach(p => { if (p.type) knownTypes.add(p.type); });
  const typeOptions = [...knownTypes].sort().map(t => `<option value="${t}">`).join('');

  // ── Parameters section ──
  html += `<h5 style="color:#e0a040;margin:12px 0 8px;">参数</h5>`;
  html += `<datalist id="bd-param-type-list">${typeOptions}</datalist>`;
  html += `<div id="bd-param-list">`;
  moduleParams.forEach((p, i) => {
    html += bdBuildParamRow(p, i);
  });
  html += `</div>`;
  html += `<div style="display:flex;gap:6px;margin-top:4px;margin-bottom:12px;">
    <button class="btn-secondary" onclick="bdAddParam()">+ 添加参数</button>
    <button class="btn-secondary" onclick="bdResetOuterParams()" style="color:#8b949e;" title="恢复默认参数">↺ 恢复默认</button>
  </div>`;

  // ── Pins section ──
  html += `<h5 style="color:#4fc3f7;margin:4px 0 8px;">引脚</h5>`;
  html += `<div id="bd-pin-list">`;

  pins.forEach((pin, i) => {
    const hasAdv = pin.advCondition || pin.advWidth;
    if (hasAdv) {
      const advSummary = pin.advCondition ? `if(${pin.advCondition})` : '';
      const advWSummary = pin.advWidth ? `W:${pin.advWidth}` : `W:${pin.width}`;
      html += `
      <div class="bd-pin-row bd-pin-row-adv" data-index="${i}" data-pin-json='${JSON.stringify(pin).replace(/'/g, "&#39;")}'>
        <span style="color:#4fc3f7;font-size:12px;min-width:120px;">${pin.name}</span>
        <span style="color:#e0a040;font-size:10px;flex:1;">⚡${advSummary} ${advWSummary}</span>
        <span style="color:#8b949e;font-size:10px;">${pin.direction} ${pin.side}</span>
        <button class="btn-secondary" onclick="bdOpenAdvancedPin(${i})" style="padding:2px 8px;font-size:10px;">编辑</button>
        <button class="btn-secondary" onclick="this.parentElement.remove()" style="padding:2px 8px;color:#f85149;">✕</button>
      </div>`;
    } else {
      const condLabel = pin.condition ? `<span style="color:#e0a040;font-size:10px;margin-left:4px;" title="条件: ${pin.condition}">⚡${pin.condition}</span>` : '';
      html += `
      <div class="bd-pin-row" data-index="${i}" data-pin-condition="${pin.condition || ''}">
        <input type="text" value="${pin.name}" class="bd-pin-name" placeholder="引脚名" style="width:120px;" />${condLabel}
        <select class="bd-pin-dir">
          <option value="input" ${pin.direction === 'input' ? 'selected' : ''}>Input</option>
          <option value="output" ${pin.direction === 'output' ? 'selected' : ''}>Output</option>
        </select>
        <input type="number" value="${pin.width}" class="bd-pin-width" placeholder="位宽" min="1" style="width:60px;" />
        <select class="bd-pin-side">
          <option value="left" ${pin.side === 'left' ? 'selected' : ''}>左</option>
          <option value="right" ${pin.side === 'right' ? 'selected' : ''}>右</option>
          <option value="top" ${pin.side === 'top' ? 'selected' : ''}>上</option>
          <option value="bottom" ${pin.side === 'bottom' ? 'selected' : ''}>下</option>
        </select>
        <button class="btn-secondary" onclick="bdOpenAdvancedPin(${i})" style="padding:2px 6px;font-size:10px;" title="高级设置">⚙</button>
        <button class="btn-secondary" onclick="bdRemovePin(${i})" style="padding:2px 8px;color:#f85149;">✕</button>
      </div>`;
    }
  });

  html += `</div>`;
  html += `<button class="btn-secondary" onclick="bdAddPin()" style="margin-top:8px;">+ 添加引脚</button>`;

  // ── Internal vals section (read-only, from parser) ──
  const parsedMod = bdState.fileModules?.find(m => m.name === bdState.activeModule)
    || bdState.allModules[bdState.activeModule];
  const internalVals = parsedMod?.internal_vals || [];
  if (internalVals.length > 0) {
    html += `<h5 style="color:#b392f0;margin:12px 0 8px;">内部变量</h5>`;
    html += `<div style="font-size:11px;font-family:'JetBrains Mono',monospace;">`;
    internalVals.forEach(v => {
      if (v.condition) {
        html += `<div style="margin-bottom:4px;color:#c9d1d9;">
          <span style="color:#b392f0;">${v.name}</span> =
          <span style="color:#79c0ff;">if</span> (<span style="color:#e0a040;">${v.condition}</span>)
          <span style="color:#a5d6ff;">${v.then_val}</span>
          <span style="color:#79c0ff;">else</span>
          <span style="color:#a5d6ff;">${v.else_val}</span>
        </div>`;
      } else {
        html += `<div style="margin-bottom:4px;color:#c9d1d9;">
          <span style="color:#b392f0;">${v.name}</span> = <span style="color:#a5d6ff;">${v.expr}</span>
        </div>`;
      }
    });
    html += `</div>`;
  }

  content.innerHTML = html;
  bd$('bd-settings-overlay').style.display = 'flex';
}

function bdCloseSettings() {
  bd$('bd-settings-overlay').style.display = 'none';
}

function bdAddPin() {
  const list = bd$('bd-pin-list');
  const i = list.children.length;
  const row = document.createElement('div');
  row.className = 'bd-pin-row';
  row.setAttribute('data-index', i);
  row.setAttribute('data-pin-condition', '');
  row.innerHTML = `
    <input type="text" value="" class="bd-pin-name" placeholder="引脚名" style="width:120px;" />
    <select class="bd-pin-dir">
      <option value="input">Input</option>
      <option value="output">Output</option>
    </select>
    <input type="number" value="1" class="bd-pin-width" placeholder="位宽" min="1" style="width:60px;" />
    <select class="bd-pin-side">
      <option value="left">左</option>
      <option value="right">右</option>
      <option value="top">上</option>
      <option value="bottom">下</option>
    </select>
    <button class="btn-secondary" onclick="bdOpenAdvancedPin(${i})" style="padding:2px 6px;font-size:10px;" title="高级设置">⚙</button>
    <button class="btn-secondary" onclick="this.parentElement.remove()" style="padding:2px 8px;color:#f85149;">✕</button>`;
  list.appendChild(row);
}

// Build a param row HTML string (reusable for initial render and dynamic add)
function bdBuildParamRow(p, i) {
  const defVal = p.default != null ? p.default : '';
  const isBool = p.type === 'Boolean';
  const defInput = isBool
    ? `<select class="bd-param-default bd-dark-select" style="width:100px;">
        <option value="true" ${String(defVal).toLowerCase() !== 'false' ? 'selected' : ''}>true</option>
        <option value="false" ${String(defVal).toLowerCase() === 'false' ? 'selected' : ''}>false</option>
       </select>`
    : `<input type="text" value="${defVal}" class="bd-param-default" placeholder="默认值" style="width:100px;" />`;
  return `
    <div class="bd-pin-row bd-param-row" data-index="${i}">
      <input type="text" value="${p.name || ''}" class="bd-param-name" placeholder="参数名" style="width:100px;" />
      <input type="text" value="${p.type || ''}" class="bd-param-type" placeholder="类型" list="bd-param-type-list" style="width:90px;"
        onchange="bdOnParamTypeChange(this)" />
      ${defInput}
      <button class="btn-secondary" onclick="this.parentElement.remove()" style="padding:2px 8px;color:#f85149;">✕</button>
    </div>`;
}

// When param type changes, swap default field for Boolean
function bdOnParamTypeChange(typeInput) {
  const row = typeInput.closest('.bd-param-row');
  const newType = typeInput.value.trim();
  const oldDef = row.querySelector('.bd-param-default');
  const curVal = oldDef ? oldDef.value : '';
  if (newType === 'Boolean' && oldDef.tagName !== 'SELECT') {
    const sel = document.createElement('select');
    sel.className = 'bd-param-default bd-dark-select';
    sel.style.width = '100px';
    sel.innerHTML = `<option value="true" ${curVal.toLowerCase() !== 'false' ? 'selected' : ''}>true</option>
                     <option value="false" ${curVal.toLowerCase() === 'false' ? 'selected' : ''}>false</option>`;
    oldDef.replaceWith(sel);
  } else if (newType !== 'Boolean' && oldDef.tagName === 'SELECT') {
    const inp = document.createElement('input');
    inp.type = 'text'; inp.value = curVal;
    inp.className = 'bd-param-default'; inp.placeholder = '默认值'; inp.style.width = '100px';
    oldDef.replaceWith(inp);
  }
}

// Reset outer module params to saved defaults
function bdResetOuterParams() {
  const cd = bdState.canvasData[bdState.activeModule];
  if (!cd) return;
  // Use saved defaults if available, otherwise fall back to parsed module params
  let defaults = cd._savedParamDefaults;
  if (!defaults) {
    const parsedMod = bdState.fileModules?.find(m => m.name === bdState.activeModule)
      || bdState.allModules[bdState.activeModule];
    defaults = parsedMod?.params || [];
  }
  // Re-render the param list
  const list = bd$('bd-param-list');
  if (!list) return;
  list.innerHTML = '';
  defaults.forEach((p, i) => { list.insertAdjacentHTML('beforeend', bdBuildParamRow(p, i)); });
  bdShowToast('参数已恢复默认', 'info');
}

function bdAddParam() {
  const list = bd$('bd-param-list');
  const i = list.children.length;
  const row = document.createElement('div');
  row.className = 'bd-pin-row bd-param-row';
  row.setAttribute('data-index', i);
  row.innerHTML = `
    <input type="text" value="" class="bd-param-name" placeholder="参数名" style="width:100px;" />
    <input type="text" value="" class="bd-param-type" placeholder="类型" list="bd-param-type-list" style="width:90px;"
      onchange="bdOnParamTypeChange(this)" />
    <input type="text" value="" class="bd-param-default" placeholder="默认值" style="width:100px;" />
    <button class="btn-secondary" onclick="this.parentElement.remove()" style="padding:2px 8px;color:#f85149;">✕</button>`;
  list.appendChild(row);
}

function bdRemovePin(idx) {
  const list = bd$('bd-pin-list');
  const rows = list.querySelectorAll('.bd-pin-row, .bd-pin-row-adv');
  if (rows[idx]) rows[idx].remove();
}

// ─── Advanced Pin Editor (opens inline inside settings modal) ───────────

function bdOpenAdvancedPin(idx) {
  const cd = bdState.canvasData[bdState.activeModule];
  if (!cd) return;
  const allPins = cd.pins || [];
  const pin = allPins[idx] || {};
  const moduleParams = cd.params || [];

  // Build param options for condition and width references
  const boolParams = moduleParams.filter(p => p.type === 'Boolean');
  const numParams = moduleParams.filter(p => p.type === 'Int' || p.type === 'BigInt' || p.type === 'Long');

  const condOpts = boolParams.map(p =>
    `<option value="${p.name}" ${pin.advCondition === p.name ? 'selected' : ''}>${p.name}</option>`
  ).join('');

  const widthOpts = numParams.map(p =>
    `<option value="${p.name}" ${pin.advWidth === p.name ? 'selected' : ''}>${p.name}</option>`
  ).join('');

  // Determine values: None type for else branch
  const noneWhenFalse = pin.advNoneWhenFalse !== false;  // default true

  const content = bd$('bd-settings-content');
  // Save existing content for "back"
  if (!bdState._settingsBackupHtml) bdState._settingsBackupHtml = content.innerHTML;

  content.innerHTML = `
    <h4 style="color:#c9d1d9;margin-bottom:12px;">引脚高级设置: ${pin.name || '新引脚'}</h4>

    <div class="settings-row">
      <label>引脚名</label>
      <input type="text" id="bd-adv-pin-name" value="${pin.name || ''}" style="flex:1;" />
    </div>
    <div class="settings-row">
      <label>方向</label>
      <select id="bd-adv-pin-dir" class="bd-dark-select" style="width:100px;">
        <option value="input" ${pin.direction === 'input' ? 'selected' : ''}>Input</option>
        <option value="output" ${pin.direction === 'output' ? 'selected' : ''}>Output</option>
      </select>
      <label style="margin-left:10px;">侧</label>
      <select id="bd-adv-pin-side" class="bd-dark-select" style="width:70px;">
        <option value="left" ${pin.side === 'left' ? 'selected' : ''}>左</option>
        <option value="right" ${pin.side === 'right' ? 'selected' : ''}>右</option>
        <option value="top" ${pin.side === 'top' ? 'selected' : ''}>上</option>
        <option value="bottom" ${pin.side === 'bottom' ? 'selected' : ''}>下</option>
      </select>
    </div>

    <h5 style="color:#e0a040;margin:16px 0 8px;">条件存在 (if/else)</h5>
    <div class="settings-row">
      <label>参数条件</label>
      <select id="bd-adv-pin-cond" class="bd-dark-select" style="width:140px;">
        <option value="">— 无条件(始终存在) —</option>
        ${condOpts}
      </select>
    </div>
    <div class="settings-row" style="font-size:11px;color:#8b949e;">
      <input type="checkbox" id="bd-adv-pin-none" ${noneWhenFalse ? 'checked' : ''} style="margin-right:6px;" />
      <label for="bd-adv-pin-none" style="min-width:auto;cursor:pointer;">当条件为 false 时引脚为 None（不存在）</label>
    </div>

    <h5 style="color:#b392f0;margin:16px 0 8px;">位宽设置</h5>
    <div class="settings-row">
      <label>固定位宽</label>
      <input type="number" id="bd-adv-pin-width" value="${pin.width || 1}" min="1" style="width:70px;" />
    </div>
    <div class="settings-row">
      <label>引用参数作为位宽</label>
      <select id="bd-adv-pin-wref" class="bd-dark-select" style="width:140px;">
        <option value="">— 使用固定值 —</option>
        ${widthOpts}
      </select>
    </div>
    <div style="font-size:10px;color:#484f58;margin-top:4px;">若引用参数，位宽将跟随参数值变化</div>

    <div style="display:flex;gap:8px;margin-top:20px;">
      <button class="btn-secondary" onclick="bdAdvPinBack()" style="flex:1;">← 返回</button>
      <button class="btn-primary" onclick="bdAdvPinApply(${idx})" style="flex:1;">应用引脚</button>
    </div>`;
}

function bdAdvPinBack() {
  const content = bd$('bd-settings-content');
  if (bdState._settingsBackupHtml) {
    content.innerHTML = bdState._settingsBackupHtml;
    bdState._settingsBackupHtml = null;
  }
}

function bdAdvPinApply(idx) {
  const name = bd$('bd-adv-pin-name')?.value?.trim();
  if (!name) { bdShowToast('引脚名不能为空', 'warn'); return; }

  const pin = {
    name,
    direction: bd$('bd-adv-pin-dir').value,
    side: bd$('bd-adv-pin-side').value,
    width: parseInt(bd$('bd-adv-pin-width').value) || 1,
    pos: idx,
  };

  const cond = bd$('bd-adv-pin-cond').value;
  const noneWhenFalse = bd$('bd-adv-pin-none').checked;
  const wRef = bd$('bd-adv-pin-wref').value;

  if (cond) {
    pin.advCondition = cond;
    pin.advNoneWhenFalse = noneWhenFalse;
    pin.condition = cond;  // For renderer eval
  }
  if (wRef) {
    pin.advWidth = wRef;
  }

  // Update in canvasData
  const cd = bdState.canvasData[bdState.activeModule];
  if (cd) {
    if (idx < cd.pins.length) {
      cd.pins[idx] = pin;
    } else {
      cd.pins.push(pin);
    }
  }

  // Go back to main settings view and re-render
  bdState._settingsBackupHtml = null;
  bdOpenSettings();
  bdShowToast(`引脚 ${name} 已应用`, 'success');
}

async function bdApplySettings() {
  if (!bdState.activeModule) return;

  // Collect params
  const paramRows = bd$('bd-param-list').querySelectorAll('.bd-param-row');
  const newParams = [];
  paramRows.forEach(row => {
    const name = row.querySelector('.bd-param-name').value.trim();
    if (!name) return;
    newParams.push({
      name,
      type: row.querySelector('.bd-param-type').value.trim() || 'Int',
      default: row.querySelector('.bd-param-default').value.trim() || null,
    });
  });

  // Collect pins — preserve condition / advanced config
  const rows = bd$('bd-pin-list').querySelectorAll('.bd-pin-row, .bd-pin-row-adv');
  const newPins = [];
  rows.forEach((row, i) => {
    // Advanced pin row stores full JSON
    const pJson = row.getAttribute('data-pin-json');
    if (pJson) {
      try { const pin = JSON.parse(pJson); pin.pos = i; newPins.push(pin); } catch(e) {}
      return;
    }
    const name = row.querySelector('.bd-pin-name')?.value?.trim();
    if (!name) return;
    const pin = {
      name,
      direction: row.querySelector('.bd-pin-dir').value,
      width: parseInt(row.querySelector('.bd-pin-width').value) || 1,
      side: row.querySelector('.bd-pin-side').value,
      pos: i,
    };
    // Preserve condition from data attribute
    const cond = row.getAttribute('data-pin-condition');
    if (cond) pin.condition = cond;
    newPins.push(pin);
  });

  if (!bdState.canvasData[bdState.activeModule]) {
    bdState.canvasData[bdState.activeModule] = { instances: [], wires: [], pins: [] };
  }
  bdState.canvasData[bdState.activeModule].pins = newPins;
  bdState.canvasData[bdState.activeModule].params = newParams;
  // Store current params as saved defaults for reset
  bdState.canvasData[bdState.activeModule]._savedParamDefaults = newParams.map(p => ({...p}));

  // Also save to .scala file
  try {
    const ports = newPins.map(p => ({ name: p.name, direction: p.direction, width: p.width }));
    await fetch('/api/chisel/save_module', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_path: bdState.selectedFile, module_name: bdState.activeModule, ports }),
    });
  } catch(e) {}

  bdCloseSettings();
  bdSaveState();
  bdRenderCanvas();
  bdShowToast('引脚设置已应用', 'success');
}

// ─── Canvas ─────────────────────────────────────────────────────────────

function bdInitCanvas() {
  const container = bd$('bd-canvas-container');
  const svg = bd$('bd-svg');

  // Remove existing listeners to avoid duplicates
  if (container._bdInit) return;
  container._bdInit = true;

  // Pan
  container.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (bdState.editMode) return;
    // Only pan on background
    if (e.target === svg || e.target.id === 'bd-svg' || e.target === container) {
      // Deselect wire when clicking background
      if (bdState.selectedWireId) bdDeselectWire();
      bdState.dragging = true;
      bdState.dragStart = { x: e.clientX, y: e.clientY };
      bdState.panStart = { ...bdState.pan };
      container.style.cursor = 'grabbing';
      e.preventDefault();
    }
  });

  window.addEventListener('mousemove', e => {
    if (bdState.editMode === 'drag-instance') { bdOnInstanceDragMove(e); return; }
    if (bdState.editMode === 'draw-wire') { bdOnWireDrawMove(e); return; }
    if (bdState.editMode === 'drag-waypoint') { bdOnWaypointDragMove(e); return; }
    if (bdState.editMode === 'drag-pin') { bdOnPinDragMove(e); return; }
    if (bdState.editMode === 'resize-instance') { return; }
    if (bdState.editMode === 'resize-module-box') { return; }
    if (!bdState.dragging) return;
    bdState.pan.x = bdState.panStart.x + (e.clientX - bdState.dragStart.x);
    bdState.pan.y = bdState.panStart.y + (e.clientY - bdState.dragStart.y);
    bdApplyTransform();
  });

  window.addEventListener('mouseup', e => {
    if (bdState.editMode === 'drag-instance') { bdOnInstanceDragEnd(e); return; }
    if (bdState.editMode === 'draw-wire') { bdOnWireDrawEnd(e); return; }
    if (bdState.editMode === 'drag-waypoint') { bdOnWaypointDragEnd(e); return; }
    if (bdState.editMode === 'drag-pin') { bdOnPinDragEnd(e); return; }
    if (bdState.editMode === 'resize-instance') { bdOnInstanceResizeEnd(e); return; }
    if (bdState.editMode === 'resize-module-box') { bdOnModuleBoxResizeEnd(e); return; }
    if (bdState.dragging) {
      bdState.dragging = false;
      container.style.cursor = 'grab';
    }
  });

  container.addEventListener('wheel', e => {
    e.preventDefault();
    const scale = e.deltaY < 0 ? 1.1 : 0.9;
    const newZoom = Math.max(0.1, Math.min(5, bdState.zoom * scale));
    const rect = svg.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    bdState.pan.x = cx - (cx - bdState.pan.x) * (newZoom / bdState.zoom);
    bdState.pan.y = cy - (cy - bdState.pan.y) * (newZoom / bdState.zoom);
    bdState.zoom = newZoom;
    bdApplyTransform();
  }, { passive: false });

  // Drop from module tree
  container.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  container.addEventListener('drop', e => {
    e.preventDefault();
    const moduleType = e.dataTransfer.getData('text/plain');
    if (!moduleType || !bdState.allModules[moduleType]) return;
    if (!bdState.activeModule) { bdShowToast('请先选择一个模块', 'warn'); return; }

    const pt = bdSvgToDesignCoords(e.clientX, e.clientY);
    if (!pt) return;

    bdAddInstance(moduleType, pt.x, pt.y);
  });

  // Click on background to cancel wire drawing
  svg.addEventListener('click', e => {
    if (bdState.editMode === 'draw-wire' && (e.target === svg || e.target.id === 'bd-svg-root')) {
      // Add waypoint at click position if we're drawing
      const pt = bdSvgToDesignCoords(e.clientX, e.clientY);
      if (pt && bdState.wireStart) {
        if (!bdState.wireStart.waypoints) bdState.wireStart.waypoints = [];
        bdState.wireStart.waypoints.push({ x: pt.x, y: pt.y });
        bdRenderTempWire(e.clientX, e.clientY);
      }
    }
  });

  // Right-click to cancel wire drawing
  svg.addEventListener('contextmenu', e => {
    if (bdState.editMode === 'draw-wire') {
      e.preventDefault();
      bdCancelWireDraw();
    }
  });
}

function bdSvgToDesignCoords(clientX, clientY) {
  const svg = bd$('bd-svg');
  if (!svg) return null;
  const rect = svg.getBoundingClientRect();
  const svgX = clientX - rect.left;
  const svgY = clientY - rect.top;
  return {
    x: (svgX - bdState.pan.x) / bdState.zoom,
    y: (svgY - bdState.pan.y) / bdState.zoom,
  };
}

function bdApplyTransform() {
  const root = bd$('bd-svg-root');
  if (root) {
    root.setAttribute('transform', `translate(${bdState.pan.x}, ${bdState.pan.y}) scale(${bdState.zoom})`);
  }
}

function bdFitView() {
  const root = bd$('bd-svg-root');
  if (!root) return;
  try {
    const bbox = root.getBBox();
    if (bbox.width === 0 && bbox.height === 0) return;
    const container = bd$('bd-canvas-container');
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    const pad = 60;
    const sx = (cw - pad * 2) / (bbox.width || 1);
    const sy = (ch - pad * 2) / (bbox.height || 1);
    bdState.zoom = Math.min(sx, sy, 2);
    bdState.pan.x = pad - bbox.x * bdState.zoom + (cw - bbox.width * bdState.zoom) / 2 - pad;
    bdState.pan.y = pad - bbox.y * bdState.zoom;
    bdApplyTransform();
  } catch(e) {}
}

function bdResetLayout() {
  if (!bdState.activeModule) return;
  if (!confirm('重置当前模块的布局？')) return;
  const cd = bdState.canvasData[bdState.activeModule];
  if (cd) {
    // Reset instance positions to grid
    cd.instances.forEach((inst, i) => {
      inst.x = 100 + (i % 3) * 250;
      inst.y = 100 + Math.floor(i / 3) * 200;
    });
    // Clear wire waypoints
    cd.wires.forEach(w => { w.waypoints = []; });
  }
  bdState.pan = { x: 0, y: 0 };
  bdState.zoom = 1;
  bdRenderCanvas();
  bdSaveState();
  bdShowToast('布局已重置', 'success');
}

// ─── Instance Management ────────────────────────────────────────────────

function bdAddInstance(moduleType, x, y) {
  if (!bdState.activeModule) return;
  if (!bdState.canvasData[bdState.activeModule]) {
    bdState.canvasData[bdState.activeModule] = { instances: [], wires: [], pins: [] };
  }
  const cd = bdState.canvasData[bdState.activeModule];
  // Count existing instances of the same moduleType to determine N
  const sameTypeCount = cd.instances.filter(i => i.moduleType === moduleType).length;
  const id = moduleType + '_inst_' + (sameTypeCount + 1);
  cd.instances.push({
    id,
    moduleType,
    x: x - 80,
    y: y - 30,
  });

  bdSaveState();
  bdRenderCanvas();
  bdShowToast(`已添加 ${moduleType}`, 'success');
}

// ─── Instance Drag ──────────────────────────────────────────────────────

function bdStartInstanceDrag(e, instanceId) {
  const pt = bdSvgToDesignCoords(e.clientX, e.clientY);
  if (!pt) return;
  const cd = bdState.canvasData[bdState.activeModule];
  const inst = cd?.instances.find(i => i.id === instanceId);
  if (!inst) return;

  bdState.editMode = 'drag-instance';
  bdState.editTarget = {
    instanceId,
    startX: pt.x,
    startY: pt.y,
    origX: inst.x,
    origY: inst.y,
  };
  bd$('bd-canvas-container').style.cursor = 'move';
}

function bdOnInstanceDragMove(e) {
  const t = bdState.editTarget;
  const pt = bdSvgToDesignCoords(e.clientX, e.clientY);
  if (!pt || !t) return;

  const dx = pt.x - t.startX;
  const dy = pt.y - t.startY;

  // Live preview
  const el = bd$('bd-svg-root').querySelector(`[data-instance-id="${t.instanceId}"]`);
  if (el) el.setAttribute('transform', `translate(${t.origX + dx}, ${t.origY + dy})`);
}

function bdOnInstanceDragEnd(e) {
  const t = bdState.editTarget;
  if (!t) return;
  const pt = bdSvgToDesignCoords(e.clientX, e.clientY);
  if (pt) {
    const cd = bdState.canvasData[bdState.activeModule];
    const inst = cd?.instances.find(i => i.id === t.instanceId);
    if (inst) {
      inst.x = t.origX + (pt.x - t.startX);
      inst.y = t.origY + (pt.y - t.startY);
    }
  }
  bdState.editMode = null;
  bdState.editTarget = null;
  bd$('bd-canvas-container').style.cursor = 'grab';
  bdState.justFinishedDrag = true;
  setTimeout(() => { bdState.justFinishedDrag = false; }, 50);
  bdSaveState();
  bdRenderCanvas();
}

// ─── Pin Drag (reposition on module edge) ───────────────────────────────

function bdStartPinDrag(e, pinName) {
  e.stopPropagation();
  e.preventDefault();
  bdState.editMode = 'drag-pin';
  bdState.editTarget = { pinName };
  bd$('bd-canvas-container').style.cursor = 'move';
}

function bdOnPinDragMove(e) {
  // Visual feedback could go here - for now we just track
}

function bdOnPinDragEnd(e) {
  const t = bdState.editTarget;
  if (!t || !bdState.activeModule) { bdState.editMode = null; return; }

  const cd = bdState.canvasData[bdState.activeModule];
  if (!cd) { bdState.editMode = null; return; }

  const pin = cd.pins.find(p => p.name === t.pinName);
  if (!pin) { bdState.editMode = null; return; }

  // Determine which side based on drop position relative to module box center
  const pt = bdSvgToDesignCoords(e.clientX, e.clientY);
  if (pt) {
    // Get module box bounds (centered at origin for the main module)
    const moduleBox = { x: 50, y: 50, w: 200, h: 300 };
    const cx = moduleBox.x + moduleBox.w / 2;
    const cy = moduleBox.y + moduleBox.h / 2;
    const dx = pt.x - cx;
    const dy = pt.y - cy;

    if (Math.abs(dx) > Math.abs(dy)) {
      pin.side = dx > 0 ? 'right' : 'left';
    } else {
      pin.side = dy > 0 ? 'bottom' : 'top';
    }
  }

  bdState.editMode = null;
  bdState.editTarget = null;
  bd$('bd-canvas-container').style.cursor = 'grab';
  bdSaveState();
  bdRenderCanvas();
}

// ─── Wire Drawing ───────────────────────────────────────────────────────

function bdStartWireDraw(e, sourceInfo) {
  e.stopPropagation();
  e.preventDefault();
  bdState.editMode = 'draw-wire';
  bdState.wireStart = { ...sourceInfo, waypoints: [] };
  bd$('bd-canvas-container').style.cursor = 'crosshair';
}

function bdOnWireDrawMove(e) {
  bdRenderTempWire(e.clientX, e.clientY);
}

function bdRenderTempWire(clientX, clientY) {
  // Remove old temp wire
  const old = bd$('bd-svg-root').querySelector('#bd-temp-wire');
  if (old) old.remove();

  const pt = bdSvgToDesignCoords(clientX, clientY);
  if (!pt || !bdState.wireStart) return;

  const ws = bdState.wireStart;
  const NS = 'http://www.w3.org/2000/svg';
  const g = document.createElementNS(NS, 'g');
  g.id = 'bd-temp-wire';

  // Build path through waypoints
  const points = [{ x: ws.x, y: ws.y }];
  if (ws.waypoints) points.push(...ws.waypoints);
  points.push({ x: pt.x, y: pt.y });

  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    d += ` L${cur.x},${prev.y} L${cur.x},${cur.y}`;
  }

  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', '#ffeb3b');
  path.setAttribute('stroke-width', 2);
  path.setAttribute('stroke-dasharray', '6,3');
  path.setAttribute('pointer-events', 'none');
  g.appendChild(path);

  // Draw waypoint dots
  if (ws.waypoints) {
    ws.waypoints.forEach(wp => {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', wp.x);
      c.setAttribute('cy', wp.y);
      c.setAttribute('r', 4);
      c.setAttribute('fill', '#ffb74d');
      c.setAttribute('pointer-events', 'none');
      g.appendChild(c);
    });
  }

  bd$('bd-svg-root').appendChild(g);
}

function bdOnWireDrawEnd(e) {
  // This is triggered by mouseup; check if we're on a valid target
  const target = e.target;
  const pinEl = target.closest?.('[data-pin-target]');

  if (pinEl && bdState.wireStart) {
    const targetInfo = JSON.parse(pinEl.getAttribute('data-pin-target'));
    bdCompleteWire(targetInfo);
  }
  // Don't cancel here — wire drawing continues until right-click or valid connection
}

function bdCompleteWire(targetInfo) {
  if (!bdState.wireStart || !bdState.activeModule) return;
  const cd = bdState.canvasData[bdState.activeModule];
  if (!cd) return;

  const wireId = 'wire_' + bdState.nextWireId++;
  cd.wires.push({
    id: wireId,
    from: {
      instanceId: bdState.wireStart.instanceId || null,
      pinName: bdState.wireStart.pinName,
      type: bdState.wireStart.type || 'instance',
    },
    to: {
      instanceId: targetInfo.instanceId || null,
      pinName: targetInfo.pinName,
      type: targetInfo.type || 'instance',
    },
    waypoints: bdState.wireStart.waypoints || [],
  });

  bdCancelWireDraw();
  bdSaveState();
  bdRenderCanvas();
  bdShowToast('连线已创建', 'success');
}

function bdCancelWireDraw() {
  bdState.editMode = null;
  bdState.wireStart = null;
  const old = bd$('bd-svg-root').querySelector('#bd-temp-wire');
  if (old) old.remove();
  bd$('bd-canvas-container').style.cursor = 'grab';
}

// ─── Waypoint Drag ──────────────────────────────────────────────────────

function bdStartWaypointDrag(e, wireId, wpIdx) {
  e.stopPropagation();
  e.preventDefault();
  const pt = bdSvgToDesignCoords(e.clientX, e.clientY);
  if (!pt) return;

  bdState.editMode = 'drag-waypoint';
  bdState.editTarget = {
    wireId,
    wpIdx,
    startX: pt.x,
    startY: pt.y,
    origX: parseFloat(e.target.getAttribute('cx')),
    origY: parseFloat(e.target.getAttribute('cy')),
    el: e.target,
  };
}

function bdOnWaypointDragMove(e) {
  const t = bdState.editTarget;
  const pt = bdSvgToDesignCoords(e.clientX, e.clientY);
  if (!t || !pt) return;
  t.el.setAttribute('cx', t.origX + (pt.x - t.startX));
  t.el.setAttribute('cy', t.origY + (pt.y - t.startY));
}

function bdOnWaypointDragEnd(e) {
  const t = bdState.editTarget;
  if (!t) return;
  const pt = bdSvgToDesignCoords(e.clientX, e.clientY);
  if (pt && bdState.activeModule) {
    const cd = bdState.canvasData[bdState.activeModule];
    const wire = cd?.wires.find(w => w.id === t.wireId);
    if (wire?.waypoints?.[t.wpIdx]) {
      wire.waypoints[t.wpIdx] = {
        x: t.origX + (pt.x - t.startX),
        y: t.origY + (pt.y - t.startY),
      };
    }
  }
  bdState.editMode = null;
  bdState.editTarget = null;
  bd$('bd-canvas-container').style.cursor = 'grab';
  bdSaveState();
  bdRenderCanvas();
}

// ─── Canvas Rendering ───────────────────────────────────────────────────

function bdRenderCanvas() {
  const svg = bd$('bd-svg');
  const root = bd$('bd-svg-root');
  const welcome = bd$('bd-welcome');

  if (!bdState.activeModule || !bdState.canvasData[bdState.activeModule]) {
    root.innerHTML = '';
    if (welcome) welcome.style.display = '';
    svg.style.display = 'none';
    return;
  }

  if (welcome) welcome.style.display = 'none';
  svg.style.display = '';
  root.innerHTML = '';

  const cd = bdState.canvasData[bdState.activeModule];
  const rendered = bdRenderModuleCanvas(bdState.activeModule, cd);
  root.appendChild(rendered);

  bdApplyTransform();
  bdAttachCanvasHandlers();
}

function bdAttachCanvasHandlers() {
  const root = bd$('bd-svg-root');

  // Instance drag (header area)
  root.querySelectorAll('.bd-instance-box').forEach(box => {
    const instId = box.getAttribute('data-instance-id');
    const header = box.querySelector('.bd-inst-header');
    if (header) {
      header.style.cursor = 'move';
      header.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        bdStartInstanceDrag(e, instId);
      });
    }
  });

  // Pin connection start/complete (mousedown on instance pin stub)
  root.querySelectorAll('.bd-pin-stub').forEach(stub => {
    stub.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      if (bdState.editMode === 'draw-wire') {
        // Complete wire to this pin
        const targetInfo = JSON.parse(stub.getAttribute('data-pin-target'));
        const ws = bdState.wireStart;
        if (ws && (ws.instanceId !== targetInfo.instanceId || ws.pinName !== targetInfo.pinName)) {
          bdCompleteWire(targetInfo);
        }
      } else {
        const info = JSON.parse(stub.getAttribute('data-pin-source'));
        bdStartWireDraw(e, info);
      }
    });
    stub.addEventListener('mouseup', e => {
      if (bdState.editMode === 'draw-wire') {
        const targetInfo = JSON.parse(stub.getAttribute('data-pin-target'));
        const ws = bdState.wireStart;
        if (ws && (ws.instanceId !== targetInfo.instanceId || ws.pinName !== targetInfo.pinName)) {
          bdCompleteWire(targetInfo);
        }
        e.stopPropagation();
      }
    });
  });

  // Module pin: click-to-start or click-to-complete, shift-drag to reposition
  root.querySelectorAll('.bd-module-pin').forEach(pinEl => {
    pinEl.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const pinName = pinEl.getAttribute('data-pin-name');
      if (e.shiftKey) {
        bdStartPinDrag(e, pinName);
      } else if (bdState.editMode === 'draw-wire') {
        const targetInfo = JSON.parse(pinEl.getAttribute('data-pin-target'));
        const ws = bdState.wireStart;
        if (ws && (ws.pinName !== targetInfo.pinName || ws.type !== 'module-pin')) {
          bdCompleteWire(targetInfo);
        }
      } else {
        const info = JSON.parse(pinEl.getAttribute('data-pin-source'));
        bdStartWireDraw(e, info);
      }
    });
    pinEl.addEventListener('mouseup', e => {
      if (bdState.editMode === 'draw-wire') {
        const targetInfo = JSON.parse(pinEl.getAttribute('data-pin-target'));
        const ws = bdState.wireStart;
        if (ws && (ws.pinName !== targetInfo.pinName || ws.type !== 'module-pin')) {
          bdCompleteWire(targetInfo);
        }
        e.stopPropagation();
      }
    });
  });

  // Instance settings button — open customization modal
  root.querySelectorAll('.bd-inst-settings-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const instId = btn.getAttribute('data-instance-id');
      bdOpenInstanceCustomize(instId);
    });
  });

  // Instance resize handle (SE corner)
  root.querySelectorAll('.bd-inst-resize-handle').forEach(handle => {
    handle.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      bdStartInstanceResize(e, handle.getAttribute('data-instance-id'));
    });
  });

  // Module box resize handle
  root.querySelectorAll('.bd-module-resize-handle').forEach(handle => {
    handle.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      bdStartModuleBoxResize(e, handle.getAttribute('data-corner'));
    });
  });

  // Waypoint drag
  root.querySelectorAll('.bd-waypoint').forEach(wp => {
    wp.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      const wireId = wp.getAttribute('data-wire-id');
      const wpIdx = parseInt(wp.getAttribute('data-wp-idx'));
      bdStartWaypointDrag(e, wireId, wpIdx);
    });
    // Right-click to delete waypoint
    wp.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      const wireId = wp.getAttribute('data-wire-id');
      const wpIdx = parseInt(wp.getAttribute('data-wp-idx'));
      const cd = bdState.canvasData[bdState.activeModule];
      const wire = cd?.wires.find(w => w.id === wireId);
      if (wire?.waypoints) {
        wire.waypoints.splice(wpIdx, 1);
        bdSaveState();
        bdRenderCanvas();
      }
    });
  });

  // Wire click to select
  root.querySelectorAll('.bd-wire-path').forEach(wp => {
    wp.addEventListener('click', e => {
      e.stopPropagation();
      const wireId = wp.getAttribute('data-wire-id');
      if (bdState.selectedWireId === wireId) {
        bdDeselectWire();
      } else {
        bdSelectWire(wireId);
      }
    });
  });

  // Wire double-click to add waypoint
  root.querySelectorAll('.bd-wire-path').forEach(wp => {
    wp.addEventListener('dblclick', e => {
      e.stopPropagation();
      const wireId = wp.getAttribute('data-wire-id');
      const cd = bdState.canvasData[bdState.activeModule];
      const wire = cd?.wires.find(w => w.id === wireId);
      if (!wire) return;
      const pt = bdSvgToDesignCoords(e.clientX, e.clientY);
      if (!pt) return;
      if (!wire.waypoints) wire.waypoints = [];
      wire.waypoints.push({ x: pt.x, y: pt.y });
      bdSaveState();
      bdRenderCanvas();
    });
  });

  // Wire right-click to delete
  root.querySelectorAll('.bd-wire-path').forEach(wp => {
    wp.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      const wireId = wp.getAttribute('data-wire-id');
      const cd = bdState.canvasData[bdState.activeModule];
      if (cd) {
        cd.wires = cd.wires.filter(w => w.id !== wireId);
        bdSaveState();
        bdRenderCanvas();
      }
    });
  });

  // Instance right-click to delete
  root.querySelectorAll('.bd-instance-box').forEach(box => {
    box.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      const instId = box.getAttribute('data-instance-id');
      if (!confirm('删除此实例?')) return;
      const cd = bdState.canvasData[bdState.activeModule];
      if (cd) {
        cd.instances = cd.instances.filter(i => i.id !== instId);
        // Remove connected wires
        cd.wires = cd.wires.filter(w =>
          w.from.instanceId !== instId && w.to.instanceId !== instId
        );
        bdSaveState();
        bdRenderCanvas();
      }
    });
  });
}

// ─── Instance Rename ────────────────────────────────────────────────────

function bdRenameInstance(instId) {
  const cd = bdState.canvasData[bdState.activeModule];
  if (!cd) return;
  const inst = cd.instances.find(i => i.id === instId);
  if (!inst) return;
  const newName = prompt('重命名实例:', inst.id);
  if (!newName || !newName.trim() || newName.trim() === inst.id) return;
  const trimmed = newName.trim();
  const oldId = inst.id;
  inst.id = trimmed;
  // Update any wires referencing this instance
  cd.wires.forEach(w => {
    if (w.from.instanceId === oldId) w.from.instanceId = trimmed;
    if (w.to.instanceId === oldId) w.to.instanceId = trimmed;
  });
  bdSaveState();
  bdRenderCanvas();
  bdShowToast(`已重命名为 ${trimmed}`, 'success');
}

// ─── Instance Resize (SE corner drag) ──────────────────────────────────

function bdStartInstanceResize(e, instId) {
  const pt = bdSvgToDesignCoords(e.clientX, e.clientY);
  if (!pt) return;
  const cd = bdState.canvasData[bdState.activeModule];
  const inst = cd?.instances.find(i => i.id === instId);
  if (!inst) return;
  bdState.editMode = 'resize-instance';
  bdState.editTarget = { instId, startX: pt.x, startY: pt.y, origW: inst.customW || 0 };
  bd$('bd-canvas-container').style.cursor = 'se-resize';
}

function bdOnInstanceResizeEnd(e) {
  const t = bdState.editTarget;
  if (!t) return;
  const pt = bdSvgToDesignCoords(e.clientX, e.clientY);
  if (pt) {
    const cd = bdState.canvasData[bdState.activeModule];
    const inst = cd?.instances.find(i => i.id === t.instId);
    if (inst) {
      const BASE_W = 140;
      inst.customW = Math.max(80, (t.origW || BASE_W) + (pt.x - t.startX));
    }
  }
  bdState.editMode = null;
  bdState.editTarget = null;
  bd$('bd-canvas-container').style.cursor = 'grab';
  bdSaveState();
  bdRenderCanvas();
}

// ─── Module Box Resize (SE corner drag) ─────────────────────────────────

function bdStartModuleBoxResize(e, corner) {
  const pt = bdSvgToDesignCoords(e.clientX, e.clientY);
  if (!pt || !bdState.activeModule) return;
  const cd = bdState.canvasData[bdState.activeModule];
  if (!cd) return;
  const outlineRect = bd$('bd-svg-root').querySelector('.bd-module-outline rect');
  const ox = parseFloat(outlineRect?.getAttribute('x') || 50);
  const oy = parseFloat(outlineRect?.getAttribute('y') || 50);
  const ow = parseFloat(outlineRect?.getAttribute('width') || 200);
  const oh = parseFloat(outlineRect?.getAttribute('height') || 300);
  bdState.editMode = 'resize-module-box';
  bdState.editTarget = { corner, startX: pt.x, startY: pt.y, origX: ox, origY: oy, origW: ow, origH: oh };
  bd$('bd-canvas-container').style.cursor = 'se-resize';
}

function bdOnModuleBoxResizeEnd(e) {
  const t = bdState.editTarget;
  if (!t || !bdState.activeModule) return;
  const pt = bdSvgToDesignCoords(e.clientX, e.clientY);
  if (pt) {
    const dx = pt.x - t.startX;
    const dy = pt.y - t.startY;
    const cd = bdState.canvasData[bdState.activeModule];
    if (cd) {
      if (!cd.moduleBox) cd.moduleBox = { x: t.origX, y: t.origY, w: t.origW, h: t.origH };
      if (t.corner === 'se') {
        cd.moduleBox.w = Math.max(150, t.origW + dx);
        cd.moduleBox.h = Math.max(100, t.origH + dy);
      } else if (t.corner === 'nw') {
        cd.moduleBox.x = t.origX + dx;
        cd.moduleBox.y = t.origY + dy;
        cd.moduleBox.w = Math.max(150, t.origW - dx);
        cd.moduleBox.h = Math.max(100, t.origH - dy);
      }
    }
  }
  bdState.editMode = null;
  bdState.editTarget = null;
  bd$('bd-canvas-container').style.cursor = 'grab';
  bdSaveState();
  bdRenderCanvas();
}

// ─── Wire Selection ─────────────────────────────────────────────────────

let bdWpPanelExpanded = false;

function bdSelectWire(wireId) {
  bdState.selectedWireId = wireId;
  const cd = bdState.canvasData[bdState.activeModule];
  const wire = cd?.wires.find(w => w.id === wireId);
  if (!wire) return;

  const info = bd$('bd-wire-info');
  const text = bd$('bd-wire-info-text');
  if (info && text) {
    const fromLabel = wire.from.type === 'module-pin'
      ? `模块.${wire.from.pinName}`
      : `${wire.from.instanceId}.${wire.from.pinName}`;
    const toLabel = wire.to.type === 'module-pin'
      ? `模块.${wire.to.pinName}`
      : `${wire.to.instanceId}.${wire.to.pinName}`;
    const wps = wire.waypoints || [];
    text.innerHTML = `
      <span style="color:#8b949e;">🔌 线路:</span> <span style="color:#4fc3f7">${wireId}</span> &nbsp;
      <span style="color:#8b949e;">源:</span> <span style="color:#ef5350">${fromLabel}</span> &nbsp;
      <span style="color:#8b949e;">→ 目标:</span> <span style="color:#81c784">${toLabel}</span>
      &nbsp;<span style="color:#8b949e;">拐点:</span> <span style="color:#c9d1d9">${wps.length}</span>
      &nbsp;<span style="color:#484f58;font-size:11px;">| 双击添加拐点 | 右键拐点删除 | 单击空白取消选中</span>`;
    info.style.display = '';
  }
  bdUpdateWaypointPanel(wireId);
  bdRenderCanvas();
}

function bdDeselectWire() {
  bdState.selectedWireId = null;
  const info = bd$('bd-wire-info');
  if (info) info.style.display = 'none';
  const wpPanel = bd$('bd-wp-panel');
  if (wpPanel) wpPanel.style.display = 'none';
  bdRenderCanvas();
}

function bdUpdateWaypointPanel(wireId) {
  const wpPanel = bd$('bd-wp-panel');
  const wpBody = bd$('bd-wp-panel-body');
  const wpTitle = bd$('bd-wp-panel-title');
  const wpArrow = bd$('bd-wp-panel-arrow');
  if (!wpPanel) return;

  if (!wireId) { wpPanel.style.display = 'none'; return; }
  wpPanel.style.display = '';

  const cd = bdState.canvasData[bdState.activeModule];
  const wire = cd?.wires.find(w => w.id === wireId);
  const wps = wire?.waypoints || [];
  wpTitle.textContent = `拐点 (${wps.length})`;
  wpArrow.textContent = bdWpPanelExpanded ? '▼' : '▶';
  wpBody.style.display = bdWpPanelExpanded ? '' : 'none';

  const header = bd$('bd-wp-panel-header');
  header.onclick = () => {
    bdWpPanelExpanded = !bdWpPanelExpanded;
    wpArrow.textContent = bdWpPanelExpanded ? '▼' : '▶';
    wpBody.style.display = bdWpPanelExpanded ? '' : 'none';
    if (bdWpPanelExpanded) bdRenderWaypointList(wireId);
  };

  if (bdWpPanelExpanded) bdRenderWaypointList(wireId);
}

function bdRenderWaypointList(wireId) {
  const wpBody = bd$('bd-wp-panel-body');
  if (!wpBody || !wireId) return;

  const cd = bdState.canvasData[bdState.activeModule];
  const wire = cd?.wires.find(w => w.id === wireId);
  const wps = wire?.waypoints || [];

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
      <button data-act="up" title="上移" style="background:none;border:none;color:#8b949e;cursor:pointer;padding:0 2px;font-size:12px;${i === 0 ? 'opacity:0.25;cursor:default;' : ''}" ${i === 0 ? 'disabled' : ''}>▲</button>
      <button data-act="down" title="下移" style="background:none;border:none;color:#8b949e;cursor:pointer;padding:0 2px;font-size:12px;${i === wps.length - 1 ? 'opacity:0.25;cursor:default;' : ''}" ${i === wps.length - 1 ? 'disabled' : ''}>▼</button>
      <button data-act="del" title="删除" style="background:none;border:none;color:#ef5350;cursor:pointer;padding:0 2px;font-size:12px;">✕</button>`;

    // Highlight waypoint on hover
    row.addEventListener('mouseenter', () => {
      const circle = bd$('bd-svg-root')?.querySelector(`.bd-waypoint[data-wire-id="${wireId}"][data-wp-idx="${i}"]`);
      if (circle) { circle.setAttribute('r', BD_LAYOUT.WAYPOINT_R * 1.8); circle.style.fill = '#ffeb3b'; }
    });
    row.addEventListener('mouseleave', () => {
      const circle = bd$('bd-svg-root')?.querySelector(`.bd-waypoint[data-wire-id="${wireId}"][data-wp-idx="${i}"]`);
      if (circle) { circle.setAttribute('r', BD_LAYOUT.WAYPOINT_R); circle.style.fill = ''; }
    });

    row.querySelector('[data-act="up"]').addEventListener('click', () => bdMoveWaypoint(wireId, i, -1));
    row.querySelector('[data-act="down"]').addEventListener('click', () => bdMoveWaypoint(wireId, i, 1));
    row.querySelector('[data-act="del"]').addEventListener('click', () => bdDeleteWaypoint(wireId, i));

    wpBody.appendChild(row);
  });
}

function bdDeleteWaypoint(wireId, idx) {
  const cd = bdState.canvasData[bdState.activeModule];
  const wire = cd?.wires.find(w => w.id === wireId);
  if (wire?.waypoints) {
    wire.waypoints.splice(idx, 1);
    bdSaveState();
    bdRenderCanvas();
    bdSelectWire(wireId); // refresh info panel
  }
}

function bdMoveWaypoint(wireId, idx, dir) {
  const cd = bdState.canvasData[bdState.activeModule];
  const wire = cd?.wires.find(w => w.id === wireId);
  if (!wire?.waypoints) return;
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= wire.waypoints.length) return;
  [wire.waypoints[idx], wire.waypoints[newIdx]] = [wire.waypoints[newIdx], wire.waypoints[idx]];
  bdSaveState();
  bdRenderCanvas();
  bdSelectWire(wireId); // refresh info panel
}

// ─── Customization Modal (Verilog-style: color/rename/comment) ──────────

function bdOpenInstanceCustomize(instId) {
  bdState.customizeTarget = { type: 'instance', id: instId };
  const customs = bdState.customizations || {};
  const existing = customs[instId] || {};
  const instColor = existing.color || '#1c2333';

  // Collect used colors
  const usedColors = [...new Set(
    Object.values(customs).map(c => c.color).filter(c => c && c !== '#1c2333')
  )];
  const swatches = usedColors.length > 0
    ? `<div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;margin-top:4px;">${usedColors.map(c =>
        `<span title="${c}" onclick="document.getElementById('bd-cust-color').value='${c}';document.getElementById('bd-cust-color-hex').value='${c}'" style="display:inline-block;width:20px;height:20px;border-radius:4px;background:${c};cursor:pointer;border:1px solid #30363d;"></span>`
      ).join('')}</div>`
    : '';

  const cd = bdState.canvasData[bdState.activeModule];
  const inst = cd?.instances.find(i => i.id === instId);
  const moduleType = inst ? inst.moduleType : '';
  // Prefill rename with current instance id if no existing rename
  const renameVal = existing.rename || instId;

  // Get module type's parameters and instance's override values
  const modInfo = bdState.allModules[moduleType];
  const modParams = modInfo?.params || [];
  const instParamValues = inst?.paramValues || {};
  // Get outer module params for reference options
  const outerParams = cd?.params || [];

  // Build parameter rows HTML
  let paramHtml = '';
  // Show constructor args if available
  if (inst?.argsText) {
    paramHtml += `<div style="margin-top:4px;color:#484f58;font-size:11px;font-family:'JetBrains Mono',monospace;">
      来源: <span style="color:#a5d6ff;">${inst.argsText}</span></div>`;
  }
  if (modParams.length > 0) {
    modParams.forEach(p => {
      const curVal = instParamValues[p.name] != null ? instParamValues[p.name] : (p.default != null ? p.default : '');
      const srcDefault = p.default != null ? p.default : '';
      // For Boolean type, use a select instead of text input
      const isBool = p.type === 'Boolean';
      const curBool = String(curVal).toLowerCase() !== 'false';
      // Build outer param options for dropdown — Boolean params also get Boolean outer refs
      const outerOpts = outerParams
        .filter(op => op.type && p.type && op.type === p.type)
        .map(op => `<option value="${op.name}" ${String(curVal) === op.name ? 'selected' : ''}>${op.name} (${op.type})</option>`)
        .join('');
      const valInput = isBool
        ? `<select class="bd-inst-param-val bd-dark-select" style="width:100px;">
            <option value="true" ${curBool ? 'selected' : ''}>true</option>
            <option value="false" ${!curBool ? 'selected' : ''}>false</option>
           </select>`
        : `<input type="text" class="bd-inst-param-val" value="${curVal}" placeholder="${srcDefault}" style="width:100px;" />`;
      const resetBtn = `<button class="btn-secondary" onclick="bdResetInstParam(this,'${srcDefault}')" style="padding:2px 6px;font-size:10px;color:#8b949e;" title="重置为默认值 ${srcDefault}">↺</button>`;
      paramHtml += `
        <div class="settings-row bd-inst-param-row" style="margin-bottom:6px;" data-param="${p.name}">
          <label style="min-width:80px;color:#e0a040;font-size:12px;">${p.name}<span style="color:#484f58;font-size:10px;margin-left:4px;">${p.type || ''}</span></label>
          ${valInput}
          ${outerOpts ? `<select class="bd-inst-param-ref bd-dark-select" onchange="if(this.value){const v=this.closest('.bd-inst-param-row').querySelector('.bd-inst-param-val');if(v.tagName==='SELECT'){for(let o of v.options){if(o.value===this.value){o.selected=true;break}}}else{v.value=this.value}}" style="width:110px;"><option value="">— 引用外部 —</option>${outerOpts}</select>` : ''}
          ${resetBtn}
        </div>`;
    });
  }

  const content = bd$('bd-custom-content');
  const hasParams = modParams.length > 0 || inst?.argsText;
  content.innerHTML = `
    <h4 style="color:#c9d1d9;margin-bottom:8px;">实例设置: ${instId} : ${moduleType}</h4>
    <div class="bd-cust-tabs">
      <button class="bd-cust-tab bd-cust-tab-active" onclick="bdSwitchCustomTab(this,'bd-cust-panel-basic')">基本设置</button>
      ${hasParams ? `<button class="bd-cust-tab" onclick="bdSwitchCustomTab(this,'bd-cust-panel-params')">构造参数</button>` : ''}
    </div>
    <div id="bd-cust-panel-basic" style="flex:1;display:flex;flex-direction:column;min-height:0;">
      <div class="settings-row">
        <label>颜色</label>
        <input type="color" id="bd-cust-color" value="${instColor}" oninput="document.getElementById('bd-cust-color-hex').value=this.value" />
        <input type="text" id="bd-cust-color-hex" value="${instColor}" maxlength="7" placeholder="#rrggbb"
          style="width:70px;padding:4px 6px;background:#0d1117;border:1px solid #30363d;border-radius:4px;color:#c9d1d9;font-size:12px;font-family:monospace;"
          oninput="if(/^#[0-9a-fA-F]{6}$/.test(this.value))document.getElementById('bd-cust-color').value=this.value" />
        <button class="btn-secondary" onclick="document.getElementById('bd-cust-color').value='#1c2333';document.getElementById('bd-cust-color-hex').value='#1c2333'" style="padding:4px 8px;font-size:11px;">重置</button>
      </div>
      ${swatches}
      <div class="settings-row" style="margin-top:10px;">
        <label>重命名</label>
        <input type="text" id="bd-cust-rename" placeholder="自定义显示名称..." value="${renameVal}" />
      </div>
      <div class="settings-row settings-row-grow">
        <label>注释</label>
        <div style="flex:1;display:flex;flex-direction:column;gap:6px;min-height:0;">
          <textarea id="bd-cust-comment" placeholder="支持 Markdown 格式..." style="flex:1;resize:none;min-height:60px;">${existing.comment || ''}</textarea>
        </div>
      </div>
    </div>
    ${hasParams ? `<div id="bd-cust-panel-params" style="display:none;flex:1;overflow-y:auto;padding-top:4px;">${paramHtml}</div>` : ''}`;

  bd$('bd-custom-overlay').style.display = 'flex';
  _bdRestoreCustomizeSize();
}

function bdSwitchCustomTab(btn, panelId) {
  const content = btn.closest('#bd-custom-content');
  content.querySelectorAll('.bd-cust-tab').forEach(t => t.classList.remove('bd-cust-tab-active'));
  btn.classList.add('bd-cust-tab-active');
  ['bd-cust-panel-basic', 'bd-cust-panel-params'].forEach(id => {
    const el = content.querySelector('#' + id);
    if (el) el.style.display = id === panelId ? (id === 'bd-cust-panel-basic' ? 'flex' : 'block') : 'none';
  });
}

// Reset an instance param value to its source default
function bdResetInstParam(btn, srcDefault) {
  const row = btn.closest('.bd-inst-param-row');
  const valEl = row?.querySelector('.bd-inst-param-val');
  if (!valEl) return;
  if (valEl.tagName === 'SELECT') {
    // Boolean select
    for (const opt of valEl.options) {
      opt.selected = opt.value === srcDefault;
    }
  } else {
    valEl.value = srcDefault;
  }
  // Also reset the ref dropdown if present
  const ref = row.querySelector('.bd-inst-param-ref');
  if (ref) ref.value = '';
}

function bdOpenWireCustomize() {
  const wireId = bdState.selectedWireId;
  if (!wireId) return;
  bdState.customizeTarget = { type: 'wire', id: wireId };
  const customs = bdState.customizations || {};
  const existing = customs[`wire:${wireId}`] || {};
  const wireColor = existing.color || '#4fc3f7';

  // Collect used wire colors
  const usedColors = [...new Set(
    Object.entries(customs).filter(([k]) => k.startsWith('wire:')).map(([, v]) => v.color).filter(c => c && c !== '#4fc3f7')
  )];
  const swatches = usedColors.length > 0
    ? `<div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;margin-top:4px;">${usedColors.map(c =>
        `<span title="${c}" onclick="document.getElementById('bd-cust-color').value='${c}';document.getElementById('bd-cust-color-hex').value='${c}'" style="display:inline-block;width:20px;height:20px;border-radius:4px;background:${c};cursor:pointer;border:1px solid #30363d;"></span>`
      ).join('')}</div>`
    : '';

  const content = bd$('bd-custom-content');
  content.innerHTML = `
    <h4 style="color:#c9d1d9;margin-bottom:12px;">线路设置: ${wireId}</h4>
    <div class="settings-row">
      <label>颜色</label>
      <input type="color" id="bd-cust-color" value="${wireColor}" oninput="document.getElementById('bd-cust-color-hex').value=this.value" />
      <input type="text" id="bd-cust-color-hex" value="${wireColor}" maxlength="7" placeholder="#rrggbb"
        style="width:70px;padding:4px 6px;background:#0d1117;border:1px solid #30363d;border-radius:4px;color:#c9d1d9;font-size:12px;font-family:monospace;"
        oninput="if(/^#[0-9a-fA-F]{6}$/.test(this.value))document.getElementById('bd-cust-color').value=this.value" />
      <button class="btn-secondary" onclick="document.getElementById('bd-cust-color').value='#4fc3f7';document.getElementById('bd-cust-color-hex').value='#4fc3f7'" style="padding:4px 8px;font-size:11px;">重置</button>
    </div>
    ${swatches}`;

  bd$('bd-custom-overlay').style.display = 'flex';
  _bdRestoreCustomizeSize();
}

function bdCloseCustomize() {
  bd$('bd-custom-overlay').style.display = 'none';
  bdState.customizeTarget = null;
}

function bdApplyCustomize() {
  const target = bdState.customizeTarget;
  if (!target) return;

  if (!bdState.customizations) bdState.customizations = {};

  if (target.type === 'instance') {
    const hexVal = bd$('bd-cust-color-hex')?.value;
    const color = (/^#[0-9a-fA-F]{6}$/.test(hexVal) ? hexVal : null) || bd$('bd-cust-color')?.value;
    const rename = bd$('bd-cust-rename')?.value?.trim() || '';
    const comment = bd$('bd-cust-comment')?.value?.trim() || '';
    const entry = {};
    if (color && color !== '#1c2333') entry.color = color;
    if (rename) entry.rename = rename;
    if (comment) entry.comment = comment;
    if (Object.keys(entry).length > 0) {
      bdState.customizations[target.id] = entry;
    } else {
      delete bdState.customizations[target.id];
    }

    // Save param values on the instance object
    const cd = bdState.canvasData[bdState.activeModule];
    const inst = cd?.instances.find(i => i.id === target.id);
    if (inst) {
      const paramRows = bd$('bd-custom-content')?.querySelectorAll('.bd-inst-param-row') || [];
      const pv = {};
      paramRows.forEach(row => {
        const pName = row.getAttribute('data-param');
        const val = row.querySelector('.bd-inst-param-val')?.value?.trim();
        if (pName && val !== '' && val != null) pv[pName] = val;
      });
      inst.paramValues = Object.keys(pv).length > 0 ? pv : undefined;
    }
  } else if (target.type === 'wire') {
    const hexVal = bd$('bd-cust-color-hex')?.value;
    const color = (/^#[0-9a-fA-F]{6}$/.test(hexVal) ? hexVal : null) || bd$('bd-cust-color')?.value;
    const key = `wire:${target.id}`;
    if (color && color !== '#4fc3f7') {
      bdState.customizations[key] = { color };
    } else {
      delete bdState.customizations[key];
    }
  }

  bdCloseCustomize();
  bdSaveState();
  bdRenderCanvas();
  bdShowToast('设置已应用', 'success');
}

// ─── Customize Modal Resize ─────────────────────────────────────────────

const BD_CUSTOM_SIZE_KEY = 'bd_custom_modal_size';

function _bdSaveCustomizeSize(w, h) {
  try { localStorage.setItem(BD_CUSTOM_SIZE_KEY, JSON.stringify({ w, h })); } catch(e) {}
}
function _bdLoadCustomizeSize() {
  try { const d = localStorage.getItem(BD_CUSTOM_SIZE_KEY); return d ? JSON.parse(d) : { w: 500, h: 420 }; }
  catch(e) { return { w: 500, h: 420 }; }
}
function _bdRestoreCustomizeSize() {
  const modal = bd$('bd-custom-modal');
  if (!modal) return;
  const saved = _bdLoadCustomizeSize();
  modal.style.width = saved.w + 'px';
  modal.style.height = saved.h + 'px';
}

function bdInitCustomizeResize() {
  const handle = bd$('bd-custom-resize');
  const modal = bd$('bd-custom-modal');
  if (!handle || !modal || handle._resizeAttached) return;
  handle._resizeAttached = true;
  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();
    window._bdCustomResizing = true;
    const startX = e.clientX, startY = e.clientY;
    const startW = modal.offsetWidth, startH = modal.offsetHeight;
    const onMove = (ev) => {
      modal.style.width = Math.max(320, startW + ev.clientX - startX) + 'px';
      modal.style.height = Math.max(200, startH + ev.clientY - startY) + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      _bdSaveCustomizeSize(modal.offsetWidth, modal.offsetHeight);
      setTimeout(() => { window._bdCustomResizing = false; }, 200);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ─── History Design List ─────────────────────────────────────────────────

async function bdLoadHistoryList() {
  const list = bd$('bd-history-list');
  if (!list) return;
  try {
    const res = await fetch('/api/chisel/designs');
    const designs = await res.json();
    if (!designs || designs.length === 0) {
      list.innerHTML = '<div style="color:#484f58;font-size:12px;padding:8px;">暂无历史设计</div>';
      return;
    }
    list.innerHTML = '';
    designs.forEach(d => {
      const item = document.createElement('div');
      item.className = 'design-item';
      item.innerHTML = `<span class="name" title="${d.folder || d.name}">📦 ${d.name}</span>
        <span class="actions">
          <button onclick="event.stopPropagation();bdDeleteHistory('${d.name.replace(/'/g, "\\'")}')" title="删除">🗑</button>
        </span>`;
      item.style.cursor = 'pointer';
      if (d.folder) {
        item.addEventListener('click', () => bdSetFolder(d.folder));
      }
      list.appendChild(item);
    });
  } catch(e) {
    list.innerHTML = '<div style="color:#484f58;font-size:12px;padding:8px;">加载失败</div>';
  }
}

async function bdDeleteHistory(name) {
  if (!confirm(`删除历史设计 "${name}"？`)) return;
  try {
    await fetch(`/api/chisel/delete_design/${encodeURIComponent(name)}`, { method: 'DELETE' });
    bdLoadHistoryList();
    bdShowToast('已删除', 'success');
  } catch(e) {
    bdShowToast('删除失败', 'error');
  }
}

// Also refresh history list after setting a folder
const _origBdSetFolder = bdSetFolder;

// ─── Expose to global ──────────────────────────────────────────────────

window.openBlockDesignWindow = openBlockDesignWindow;
window.closeBlockDesignWindow = closeBlockDesignWindow;
window.bdOpenFileBrowser = bdOpenFileBrowser;
window.bdCloseFileBrowser = bdCloseFileBrowser;
window.bdFbNavigateTo = bdFbNavigateTo;
window.bdFbGoUp = bdFbGoUp;
window.bdFbGoHome = bdFbGoHome;
window.bdFbConfirm = bdFbConfirm;
window.bdCreateNewFile = bdCreateNewFile;
window.bdCloseNewFileDialog = bdCloseNewFileDialog;
window.bdConfirmNewFile = bdConfirmNewFile;
window.bdCreateNewModule = bdCreateNewModule;
window.bdCloseNewModuleDialog = bdCloseNewModuleDialog;
window.bdConfirmNewModule = bdConfirmNewModule;
window.bdOpenSettings = bdOpenSettings;
window.bdCloseSettings = bdCloseSettings;
window.bdApplySettings = bdApplySettings;
window.bdAddPin = bdAddPin;
window.bdRemovePin = bdRemovePin;
window.bdFitView = bdFitView;
window.bdResetLayout = bdResetLayout;
window.bdSaveToChisel = bdSaveToChisel;
window.bdSelectWire = bdSelectWire;
window.bdDeselectWire = bdDeselectWire;
window.bdOpenInstanceCustomize = bdOpenInstanceCustomize;
window.bdSwitchCustomTab = bdSwitchCustomTab;
window.bdOpenWireCustomize = bdOpenWireCustomize;
window.bdCloseCustomize = bdCloseCustomize;
window.bdApplyCustomize = bdApplyCustomize;
window.bdInitCustomizeResize = bdInitCustomizeResize;
window.bdLoadHistoryList = bdLoadHistoryList;
window.bdDeleteHistory = bdDeleteHistory;
window.bdDeleteWaypoint = bdDeleteWaypoint;
window.bdMoveWaypoint = bdMoveWaypoint;
window.bdOnParamTypeChange = bdOnParamTypeChange;
window.bdBuildParamRow = bdBuildParamRow;
window.bdOpenAdvancedPin = bdOpenAdvancedPin;
window.bdAdvPinBack = bdAdvPinBack;
window.bdAdvPinApply = bdAdvPinApply;
window.bdResetInstParam = bdResetInstParam;
window.bdResetOuterParams = bdResetOuterParams;
