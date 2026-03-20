/**
 * block_renderer.js — SVG renderer for Block Design canvas.
 * Renders: module box with edge pins, dragged-in instances with IO pins,
 * wires between pins with waypoints.
 */

const BD_NS = 'http://www.w3.org/2000/svg';

const BD_LAYOUT = {
  MODULE_W: 200,
  MODULE_H: 300,
  MODULE_X: 50,
  MODULE_Y: 50,
  HEADER_H: 30,
  PIN_SIZE: 10,     // Pin stub length
  PIN_GAP: 24,      // Gap between pins
  PIN_LABEL_SIZE: 11,
  INST_MIN_W: 140,
  INST_HEADER_H: 26,
  INST_PORT_H: 16,
  INST_PORT_GAP: 2,
  INST_PORT_STUB: 20,
  WAYPOINT_R: 5,
};

const BD_COL = {
  moduleFill: '#1a2744',
  moduleStroke: '#1f6feb',
  moduleHeader: '#21262d',
  instFill: '#1c2333',
  instStroke: '#30363d',
  instHeader: '#21262d',
  pinIn: '#81c784',
  pinOut: '#ef5350',
  wire: '#4fc3f7',
  wireTemp: '#ffeb3b',
  waypoint: '#ffb74d',
  txt: '#c9d1d9',
  dim: '#8b949e',
};

function bdSvgEl(tag, attrs = {}) {
  const el = document.createElementNS(BD_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/**
 * Render the complete canvas for a module.
 * @param {string} moduleName - The active module name
 * @param {object} canvasData - { instances, wires, pins, moduleBox }
 * @returns {SVGGElement}
 */
function bdRenderModuleCanvas(moduleName, canvasData) {
  const g = bdSvgEl('g', { class: 'bd-design-root' });

  // Build param map for conditional pin evaluation
  const paramMap = {};
  const paramMapRaw = {};
  (canvasData.params || []).forEach(p => {
    if (p.default != null) {
      paramMap[p.name] = String(p.default).toLowerCase();
      paramMapRaw[p.name] = String(p.default);
    }
  });
  // Helper: evaluate a condition string — false/none/"0"/"false" hides the pin
  function evalCond(cond) {
    if (!cond) return true;
    const v = paramMap[cond];
    if (v === undefined) return true; // unknown param → show by default
    return v !== 'false' && v !== '0' && v !== 'none' && v !== '';
  }
  // Helper: resolve advWidth param reference to numeric width
  function resolveWidth(pin) {
    if (pin.advWidth) {
      const v = parseInt(paramMapRaw[pin.advWidth]);
      return isNaN(v) ? (pin.width || 1) : v;
    }
    return pin.width || 1;
  }

  const allPins = canvasData.pins || [];
  // Filter out conditional pins whose condition evaluates to false (including advCondition)
  const pins = allPins.filter(pin => {
    if (pin.advCondition && pin.advNoneWhenFalse !== false) return evalCond(pin.advCondition);
    return evalCond(pin.condition);
  });
  const instances = canvasData.instances || [];
  const wires = canvasData.wires || [];

  // Load customizations from bdState
  const customs = (typeof bdState !== 'undefined') ? (bdState.customizations || {}) : {};
  const selectedWireId = (typeof bdState !== 'undefined') ? bdState.selectedWireId : null;

  // ── Compute adaptive module bounding box ───────────────────────────
  const leftPins = pins.filter(p => p.side === 'left');
  const rightPins = pins.filter(p => p.side === 'right');
  const topPins = pins.filter(p => p.side === 'top');
  const bottomPins = pins.filter(p => p.side === 'bottom');

  // Min size driven by pin count
  const maxSidePins = Math.max(leftPins.length, rightPins.length, 1);
  const maxTopBottomPins = Math.max(topPins.length, bottomPins.length, 0);
  const pinDrivenW = Math.max(BD_LAYOUT.MODULE_W, (maxTopBottomPins + 1) * BD_LAYOUT.PIN_GAP + 60);
  const pinDrivenH = Math.max(BD_LAYOUT.MODULE_H, (maxSidePins + 1) * BD_LAYOUT.PIN_GAP + BD_LAYOUT.HEADER_H + 40);

  let autoX = BD_LAYOUT.MODULE_X;
  let autoY = BD_LAYOUT.MODULE_Y;
  let autoW = pinDrivenW;
  let autoH = pinDrivenH;

  if (instances.length > 0) {
    const PAD = 80;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    instances.forEach(inst => {
      const modDef = (typeof bdState !== 'undefined') ? bdState.allModules[inst.moduleType] : null;
      const ports = modDef?.ports || [];
      const params = modDef?.params || [];
      const inLen = ports.filter(p => p.direction === 'input').length;
      const outLen = ports.filter(p => p.direction === 'output').length;
      const maxP = Math.max(inLen, outLen, 1);
      const paramH = params.length > 0 ? params.length * 14 + 6 : 0;
      const instW = inst.customW || BD_LAYOUT.INST_MIN_W;
      const instH = BD_LAYOUT.INST_HEADER_H + paramH + maxP * (BD_LAYOUT.INST_PORT_H + BD_LAYOUT.INST_PORT_GAP) + 10;
      minX = Math.min(minX, inst.x - BD_LAYOUT.INST_PORT_STUB);
      minY = Math.min(minY, inst.y);
      maxX = Math.max(maxX, inst.x + instW + BD_LAYOUT.INST_PORT_STUB);
      maxY = Math.max(maxY, inst.y + instH);
    });
    autoX = minX - PAD;
    autoY = minY - BD_LAYOUT.HEADER_H - PAD;
    autoW = Math.max(pinDrivenW, maxX - minX + PAD * 2);
    autoH = Math.max(pinDrivenH, maxY - minY + BD_LAYOUT.HEADER_H + PAD * 2);
  }

  // Manual override from canvasData.moduleBox
  const mb = canvasData.moduleBox || {};
  const modX = mb.x !== undefined ? mb.x : autoX;
  const modY = mb.y !== undefined ? mb.y : autoY;
  const modW = mb.w !== undefined ? mb.w : autoW;
  const modH = mb.h !== undefined ? mb.h : autoH;

  // Wire layer (behind everything)
  const wireLayer = bdSvgEl('g', { class: 'bd-wire-layer' });
  g.appendChild(wireLayer);

  // Module box (main module outline)
  const moduleGroup = bdRenderModuleOutline(moduleName, modX, modY, modW, modH, pins, resolveWidth);
  g.appendChild(moduleGroup);

  // Instance layer
  const instLayer = bdSvgEl('g', { class: 'bd-instance-layer' });
  g.appendChild(instLayer);

  // Pin position map for wire routing
  const pinPositions = {};

  // Calculate module-level pin positions
  bdCalcModulePinPositions(pins, modX, modY, modW, modH, pinPositions, null);

  // Render instances
  instances.forEach(inst => {
    const modDef = (typeof bdState !== 'undefined') ? bdState.allModules[inst.moduleType] : null;
    const instPorts = modDef ? modDef.ports || [] : [];
    const instCustom = customs[inst.id] || {};
    const rendered = bdRenderInstance(inst, instPorts, instCustom);
    instLayer.appendChild(rendered.group);

    // Calculate instance pin positions
    for (const [portName, pos] of Object.entries(rendered.portPositions)) {
      pinPositions[`${inst.id}.${portName}`] = pos;
    }
  });

  // Render wires
  wires.forEach(wire => {
    const fromKey = wire.from.type === 'module-pin'
      ? `module.${wire.from.pinName}`
      : `${wire.from.instanceId}.${wire.from.pinName}`;
    const toKey = wire.to.type === 'module-pin'
      ? `module.${wire.to.pinName}`
      : `${wire.to.instanceId}.${wire.to.pinName}`;

    const fromPos = pinPositions[fromKey];
    const toPos = pinPositions[toKey];

    if (fromPos && toPos) {
      const wireCustom = customs[`wire:${wire.id}`] || {};
      const isSelected = wire.id === selectedWireId;
      const wireGroup = bdRenderWire(wire, fromPos, toPos, wireCustom.color, isSelected);
      wireLayer.appendChild(wireGroup);
    }
  });

  return g;
}

/**
 * Render the main module outline with edge pins and resize handles.
 */
function bdRenderModuleOutline(moduleName, x, y, w, h, pins, resolveWidth) {
  if (!resolveWidth) resolveWidth = pin => pin.width || 1;
  const g = bdSvgEl('g', { class: 'bd-module-outline' });

  // Dashed outline
  g.appendChild(bdSvgEl('rect', {
    x, y, width: w, height: h, rx: 8, ry: 8,
    fill: 'none', stroke: BD_COL.moduleStroke,
    'stroke-width': 2, 'stroke-dasharray': '8,4', opacity: 0.6,
  }));

  // Header
  g.appendChild(bdSvgEl('rect', {
    x: x + 1, y: y + 1, width: w - 2, height: BD_LAYOUT.HEADER_H - 1,
    rx: 7, fill: BD_COL.moduleHeader, opacity: 0.4,
  }));

  // Title
  const title = bdSvgEl('text', {
    x: x + w / 2, y: y + BD_LAYOUT.HEADER_H / 2 + 5,
    'text-anchor': 'middle', fill: BD_COL.moduleStroke,
    'font-size': 14, 'font-weight': '600',
    'pointer-events': 'none', style: 'user-select:none;',
  });
  title.textContent = `📦 ${moduleName}`;
  g.appendChild(title);

  // Render edge pins
  const leftPins = pins.filter(p => p.side === 'left');
  const rightPins = pins.filter(p => p.side === 'right');
  const topPins = pins.filter(p => p.side === 'top');
  const bottomPins = pins.filter(p => p.side === 'bottom');

  const renderEdgePins = (pinList, side) => {
    pinList.forEach((pin, i) => {
      // Pin dot sits ON the dashed border; labels + arrows go inside the box
      let cx, cy, labelX, labelY, anchor, arrowPts;
      const offset = BD_LAYOUT.HEADER_H + 20 + i * BD_LAYOUT.PIN_GAP;

      if (side === 'left') {
        cx = x; cy = y + offset;
        labelX = cx + 10; labelY = cy + 4; anchor = 'start';
        arrowPts = `${cx+2},${cy} ${cx+10},${cy-4} ${cx+10},${cy+4}`;
      } else if (side === 'right') {
        cx = x + w; cy = y + offset;
        labelX = cx - 10; labelY = cy + 4; anchor = 'end';
        arrowPts = `${cx-2},${cy} ${cx-10},${cy-4} ${cx-10},${cy+4}`;
      } else if (side === 'top') {
        cx = x + 40 + i * BD_LAYOUT.PIN_GAP; cy = y;
        labelX = cx; labelY = cy + 16; anchor = 'middle';
        arrowPts = `${cx},${cy+2} ${cx-4},${cy+10} ${cx+4},${cy+10}`;
      } else { // bottom
        cx = x + 40 + i * BD_LAYOUT.PIN_GAP; cy = y + h;
        labelX = cx; labelY = cy - 8; anchor = 'middle';
        arrowPts = `${cx},${cy-2} ${cx-4},${cy-10} ${cx+4},${cy-10}`;
      }

      const color = pin.direction === 'input' ? BD_COL.pinIn : BD_COL.pinOut;

      const pinG = bdSvgEl('g', {
        class: 'bd-module-pin',
        'data-pin-name': pin.name,
        'data-pin-source': JSON.stringify({ type: 'module-pin', pinName: pin.name, x: cx, y: cy }),
        'data-pin-target': JSON.stringify({ type: 'module-pin', pinName: pin.name }),
        style: 'cursor:crosshair;',
      });

      // Invisible hit area
      pinG.appendChild(bdSvgEl('circle', { cx, cy, r: 10, fill: 'transparent' }));
      // Filled dot on border
      pinG.appendChild(bdSvgEl('circle', { cx, cy, r: 5, fill: color, stroke: '#0d1117', 'stroke-width': 1.5 }));
      // Inward direction arrow
      pinG.appendChild(bdSvgEl('polygon', { points: arrowPts, fill: color, opacity: 0.7 }));

      const label = bdSvgEl('text', {
        x: labelX, y: labelY, 'text-anchor': anchor,
        fill: color, 'font-size': BD_LAYOUT.PIN_LABEL_SIZE,
        'font-family': "'JetBrains Mono', monospace",
        'pointer-events': 'none', style: 'user-select:none;',
      });
      const rw = resolveWidth(pin);
      const widthSuffix = rw > 1 ? ` [${rw - 1}:0]` : '';
      const condSuffix = (pin.advCondition || pin.condition) ? ` [${pin.advCondition || pin.condition}]` : '';
      label.textContent = pin.name + widthSuffix + condSuffix;
      if (pin.advCondition || pin.condition) label.setAttribute('fill', '#e0a040');
      pinG.appendChild(label);

      g.appendChild(pinG);
    });
  };

  renderEdgePins(leftPins, 'left');
  renderEdgePins(rightPins, 'right');
  renderEdgePins(topPins, 'top');
  renderEdgePins(bottomPins, 'bottom');

  // NW resize handle (move/resize top-left)
  g.appendChild(bdSvgEl('rect', {
    class: 'bd-module-resize-handle',
    x: x - 5, y: y - 5, width: 10, height: 10,
    rx: 2, fill: '#21262d', stroke: BD_COL.moduleStroke, 'stroke-width': 1.5,
    cursor: 'nw-resize', 'data-corner': 'nw',
  }));
  // SE resize handle
  g.appendChild(bdSvgEl('rect', {
    class: 'bd-module-resize-handle',
    x: x + w - 5, y: y + h - 5, width: 10, height: 10,
    rx: 2, fill: '#21262d', stroke: BD_COL.moduleStroke, 'stroke-width': 1.5,
    cursor: 'se-resize', 'data-corner': 'se',
  }));

  return g;
}

/**
 * Calculate positions of module-level pins for wire routing.
 */
function bdCalcModulePinPositions(pins, modX, modY, modW, modH, posMap, prefix) {
  const leftPins = pins.filter(p => p.side === 'left');
  const rightPins = pins.filter(p => p.side === 'right');
  const topPins = pins.filter(p => p.side === 'top');
  const bottomPins = pins.filter(p => p.side === 'bottom');

  leftPins.forEach((pin, i) => {
    const py = modY + BD_LAYOUT.HEADER_H + 20 + i * BD_LAYOUT.PIN_GAP;
    posMap[`module.${pin.name}`] = { x: modX - BD_LAYOUT.PIN_SIZE, y: py, side: 'left' };
  });
  rightPins.forEach((pin, i) => {
    const py = modY + BD_LAYOUT.HEADER_H + 20 + i * BD_LAYOUT.PIN_GAP;
    posMap[`module.${pin.name}`] = { x: modX + modW + BD_LAYOUT.PIN_SIZE, y: py, side: 'right' };
  });
  topPins.forEach((pin, i) => {
    const px = modX + 40 + i * BD_LAYOUT.PIN_GAP;
    posMap[`module.${pin.name}`] = { x: px, y: modY - BD_LAYOUT.PIN_SIZE, side: 'top' };
  });
  bottomPins.forEach((pin, i) => {
    const px = modX + 40 + i * BD_LAYOUT.PIN_GAP;
    posMap[`module.${pin.name}`] = { x: px, y: modY + modH + BD_LAYOUT.PIN_SIZE, side: 'bottom' };
  });
}

/**
 * Render an instance (sub-module) box with settings button and resize handle.
 */
function bdRenderInstance(inst, ports, custom) {
  const x = inst.x;
  const y = inst.y;
  const instCustom = custom || {};

  const inputs = ports.filter(p => p.direction === 'input');
  const outputs = ports.filter(p => p.direction === 'output');
  const maxPorts = Math.max(inputs.length, outputs.length, 1);

  let maxNameLen = inst.moduleType.length;
  ports.forEach(p => { maxNameLen = Math.max(maxNameLen, p.name.length + 3); });

  // Get parameters for this module type
  const modDef = (typeof bdState !== 'undefined') ? bdState.allModules[inst.moduleType] : null;
  const params = modDef?.params || [];
  const paramH = params.length > 0 ? params.length * 14 + 6 : 0;

  const W = inst.customW || Math.max(BD_LAYOUT.INST_MIN_W, Math.min(maxNameLen * 7 + 40, 280));
  const H = BD_LAYOUT.INST_HEADER_H + paramH + maxPorts * (BD_LAYOUT.INST_PORT_H + BD_LAYOUT.INST_PORT_GAP) + 10;

  const fillColor = instCustom.color || BD_COL.instFill;

  const g = bdSvgEl('g', {
    class: 'bd-instance-box',
    transform: `translate(${x}, ${y})`,
    'data-instance-id': inst.id,
    'data-module-type': inst.moduleType,
    style: 'user-select:none;',
  });

  // Main rect
  g.appendChild(bdSvgEl('rect', {
    class: 'bd-inst-rect',
    x: 0, y: 0, width: W, height: H, rx: 6, ry: 6,
    fill: fillColor, stroke: BD_COL.instStroke, 'stroke-width': 1.5,
  }));

  // Header rect (two pieces to fill top half)
  g.appendChild(bdSvgEl('rect', {
    class: 'bd-inst-header',
    x: 1, y: 1, width: W - 2, height: BD_LAYOUT.INST_HEADER_H - 1, rx: 5, fill: BD_COL.instHeader,
  }));
  g.appendChild(bdSvgEl('rect', {
    x: 1, y: BD_LAYOUT.INST_HEADER_H / 2, width: W - 2, height: BD_LAYOUT.INST_HEADER_H / 2, fill: BD_COL.instHeader,
  }));

  // Title (with rename support)
  const displayName = instCustom.rename || inst.id;
  const fullTitle = instCustom.rename
    ? `${displayName} (${inst.id} : ${inst.moduleType})`
    : `${inst.id} : ${inst.moduleType}`;
  const titleText = fullTitle.length > 28 ? fullTitle.slice(0, 26) + '…' : fullTitle;
  const title = bdSvgEl('text', {
    x: W / 2 - 6, y: BD_LAYOUT.INST_HEADER_H / 2 + 5,
    'text-anchor': 'middle', fill: BD_COL.txt,
    'font-size': 11, 'font-weight': '600',
    'pointer-events': 'none', style: 'user-select:none;',
  });
  title.textContent = titleText;
  g.appendChild(title);

  // Settings button (⚙) — styled as a small bordered box like toolbar buttons
  const btnSize = 18;
  const btnX = W - btnSize - 3;
  const btnY = (BD_LAYOUT.INST_HEADER_H - btnSize) / 2;
  const btnG = bdSvgEl('g', {
    class: 'bd-inst-settings-btn',
    cursor: 'pointer',
    'data-instance-id': inst.id,
  });
  btnG.appendChild(bdSvgEl('rect', {
    x: btnX, y: btnY, width: btnSize, height: btnSize, rx: 4,
    fill: 'transparent', stroke: '#30363d', 'stroke-width': 1,
  }));
  const btnText = bdSvgEl('text', {
    x: btnX + btnSize / 2, y: btnY + btnSize / 2 + 4,
    'text-anchor': 'middle', fill: '#8b949e',
    'font-size': 11, 'pointer-events': 'none',
    style: 'user-select:none;',
  });
  btnText.textContent = '⚙';
  btnG.appendChild(btnText);
  g.appendChild(btnG);

  // Render parameters below header (if any)
  let paramEndY = BD_LAYOUT.INST_HEADER_H;
  if (params.length > 0) {
    const instParamValues = inst.paramValues || {};
    let py = BD_LAYOUT.INST_HEADER_H + 4;
    params.forEach(p => {
      const overrideVal = instParamValues[p.name];
      const hasOverride = overrideVal != null && overrideVal !== '' && overrideVal !== String(p.default);
      const paramLabel = bdSvgEl('text', {
        x: 6, y: py + 10,
        'text-anchor': 'start', fill: hasOverride ? '#58a6ff' : '#e0a040',
        'font-size': 9,
        'font-family': "'JetBrains Mono', monospace",
        'pointer-events': 'none', style: 'user-select:none;',
      });
      const displayVal = overrideVal != null && overrideVal !== '' ? overrideVal : (p.default != null ? p.default : '');
      const valStr = displayVal !== '' ? ` = ${displayVal}` : '';
      paramLabel.textContent = `${p.name}: ${p.type}${valStr}`;
      g.appendChild(paramLabel);
      py += 14;
    });
    // Separator line
    g.appendChild(bdSvgEl('line', {
      x1: 4, y1: py + 1, x2: W - 4, y2: py + 1,
      stroke: '#30363d', 'stroke-width': 0.5,
    }));
    paramEndY = py + 4;
  }

  const portPositions = {};
  let inY = paramEndY + 8;
  let outY = paramEndY + 8;

  // Input ports (left side)
  inputs.forEach(port => {
    const midY = inY + BD_LAYOUT.INST_PORT_H / 2;
    const stubX1 = -BD_LAYOUT.INST_PORT_STUB;
    const stubX2 = -2;

    const pinG = bdSvgEl('g', {
      class: 'bd-pin-stub',
      'data-pin-source': JSON.stringify({ instanceId: inst.id, pinName: port.name, x: x + stubX1, y: y + midY, type: 'instance' }),
      'data-pin-target': JSON.stringify({ instanceId: inst.id, pinName: port.name, type: 'instance' }),
      style: 'cursor:pointer;',
    });

    pinG.appendChild(bdSvgEl('line', { x1: stubX1, y1: midY, x2: stubX2, y2: midY, stroke: BD_COL.pinIn, 'stroke-width': port.width > 1 ? 3 : 1.5 }));
    pinG.appendChild(bdSvgEl('polygon', {
      points: `${stubX2},${midY} ${stubX2 - 5},${midY - 3} ${stubX2 - 5},${midY + 3}`,
      fill: BD_COL.pinIn,
    }));
    pinG.appendChild(bdSvgEl('rect', {
      x: stubX1 - 4, y: midY - 8, width: BD_LAYOUT.INST_PORT_STUB + 8, height: 16,
      fill: 'transparent', style: 'cursor:pointer;',
    }));

    const labelIn = bdSvgEl('text', {
      x: 6, y: midY + 4,
      'text-anchor': 'start', fill: BD_COL.pinIn,
      'font-size': BD_LAYOUT.PIN_LABEL_SIZE,
      'font-family': "'JetBrains Mono', monospace",
      'pointer-events': 'none', style: 'user-select:none;',
    });
    labelIn.textContent = port.name + (port.width > 1 ? ` [${port.width - 1}:0]` : '');
    pinG.appendChild(labelIn);

    g.appendChild(pinG);
    portPositions[port.name] = { x: x + stubX1, y: y + midY, side: 'left' };
    inY += BD_LAYOUT.INST_PORT_H + BD_LAYOUT.INST_PORT_GAP;
  });

  // Output ports (right side)
  outputs.forEach(port => {
    const midY = outY + BD_LAYOUT.INST_PORT_H / 2;
    const stubX1 = W + 2;
    const stubX2 = W + BD_LAYOUT.INST_PORT_STUB;

    const pinG = bdSvgEl('g', {
      class: 'bd-pin-stub',
      'data-pin-source': JSON.stringify({ instanceId: inst.id, pinName: port.name, x: x + stubX2, y: y + midY, type: 'instance' }),
      'data-pin-target': JSON.stringify({ instanceId: inst.id, pinName: port.name, type: 'instance' }),
      style: 'cursor:pointer;',
    });

    pinG.appendChild(bdSvgEl('line', { x1: stubX1, y1: midY, x2: stubX2, y2: midY, stroke: BD_COL.pinOut, 'stroke-width': port.width > 1 ? 3 : 1.5 }));
    pinG.appendChild(bdSvgEl('polygon', {
      points: `${stubX2},${midY} ${stubX2 - 5},${midY - 3} ${stubX2 - 5},${midY + 3}`,
      fill: BD_COL.pinOut,
    }));
    pinG.appendChild(bdSvgEl('rect', {
      x: stubX1 - 4, y: midY - 8, width: BD_LAYOUT.INST_PORT_STUB + 8, height: 16,
      fill: 'transparent', style: 'cursor:pointer;',
    }));

    const labelOut = bdSvgEl('text', {
      x: W - 6, y: midY + 4,
      'text-anchor': 'end', fill: BD_COL.pinOut,
      'font-size': BD_LAYOUT.PIN_LABEL_SIZE,
      'font-family': "'JetBrains Mono', monospace",
      'pointer-events': 'none', style: 'user-select:none;',
    });
    labelOut.textContent = port.name + (port.width > 1 ? ` [${port.width - 1}:0]` : '');
    pinG.appendChild(labelOut);

    g.appendChild(pinG);
    portPositions[port.name] = { x: x + stubX2, y: y + midY, side: 'right' };
    outY += BD_LAYOUT.INST_PORT_H + BD_LAYOUT.INST_PORT_GAP;
  });

  // SE resize handle
  g.appendChild(bdSvgEl('rect', {
    class: 'bd-inst-resize-handle',
    x: W - 8, y: H - 8, width: 8, height: 8,
    fill: '#30363d', stroke: '#484f58', 'stroke-width': 1,
    rx: 2, cursor: 'se-resize', 'data-instance-id': inst.id,
  }));

  return { group: g, portPositions };
}

/**
 * Render a wire between two pin positions.
 */
function bdRenderWire(wire, fromPos, toPos, customColor, isSelected) {
  const g = bdSvgEl('g', { class: 'bd-wire-group', 'data-wire-id': wire.id });

  const waypoints = wire.waypoints || [];
  const points = [{ x: fromPos.x, y: fromPos.y }];
  waypoints.forEach(wp => points.push(wp));
  points.push({ x: toPos.x, y: toPos.y });

  // Build orthogonal path
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    // Horizontal then vertical
    d += ` L${cur.x},${prev.y} L${cur.x},${cur.y}`;
  }

  const wireColor = customColor || BD_COL.wire;
  const strokeWidth = isSelected ? 3 : 1.5;
  const strokeColor = isSelected ? '#fff' : wireColor;

  // Glow effect for selected wire
  if (isSelected) {
    const glow = bdSvgEl('path', {
      d, fill: 'none', stroke: wireColor, 'stroke-width': 6,
      opacity: 0.35, 'pointer-events': 'none',
    });
    g.appendChild(glow);
  }

  const path = bdSvgEl('path', {
    class: 'bd-wire-path',
    d, fill: 'none', stroke: strokeColor, 'stroke-width': strokeWidth,
    'data-wire-id': wire.id,
    style: 'cursor:pointer;',
  });
  g.appendChild(path);

  // Waypoint handles
  waypoints.forEach((wp, i) => {
    const circle = bdSvgEl('circle', {
      class: 'bd-waypoint',
      cx: wp.x, cy: wp.y, r: BD_LAYOUT.WAYPOINT_R,
      fill: BD_COL.waypoint, stroke: '#0d1117', 'stroke-width': 1.5,
      'data-wire-id': wire.id, 'data-wp-idx': i,
      style: 'cursor:move;',
    });
    g.appendChild(circle);
  });

  return g;
}
