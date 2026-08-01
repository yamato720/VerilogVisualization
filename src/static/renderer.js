/**
 * renderer.js — SVG Verilog module renderer with Vivado-style port collapsing,
 * real inter-module wire connections, module drag/resize, obstacle-aware wire
 * routing, draggable wire waypoints, and persistent layout.
 */

const NS = 'http://www.w3.org/2000/svg';

const LAYOUT = {
  MODULE_MIN_WIDTH: 160,
  MODULE_HEADER_H: 30,
  PORT_H: 18,
  PORT_GAP: 3,
  PORT_PAD_X: 10,
  PORT_STUB: 28,
  MOD_PAD_X: 50,
  MOD_PAD_Y: 50,
  INST_GAP_X: 100,
  INST_GAP_Y: 50,
  COLS_MAX: 4,
  PORT_FONT: 11,
  TITLE_FONT: 13,
  COLLAPSE_THRESHOLD: 10,
  RESIZE_HANDLE: 12,
  WIRE_GRID: 10,       // grid snap for obstacle avoidance
  WIRE_MARGIN: 15,     // margin around modules for wire routing
  WAYPOINT_R: 5,       // radius of draggable waypoint circles
  INLINE_MAX_DEPTH: 32,
  INLINE_CONTENT_X: 72,
  INLINE_CONTENT_Y: 22,
  INLINE_PAD_RIGHT: 72,
  INLINE_PAD_BOTTOM: 50,
};

const COL = {
  modFill: '#1c2333',   modStroke: '#30363d',
  topFill: '#1a2744',   topStroke: '#1f6feb',
  header:  '#21262d',
  pIn: '#81c784',  pOut: '#ef5350',  pInout: '#ffb74d',
  wire: '#4fc3f7', wireHl: '#ffeb3b',
  activeLow: '#ef5350',
  txt: '#c9d1d9',  dim: '#8b949e',
  groupFill: '#21262d',
  resizeHandle: '#58a6ff',
  waypoint: '#ffb74d',
  waypointHover: '#ffeb3b',
};

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function scopedLayoutKey(parentModuleName, instanceName) {
  return `${parentModuleName}::${instanceName}`;
}

function childRenderPath(parentPath, instanceName) {
  return parentPath.endsWith('::')
    ? `${parentPath}${instanceName}`
    : `${parentPath}/${instanceName}`;
}

function getLayoutOverride(layoutOverrides, parentModuleName, instanceName) {
  return layoutOverrides?.[scopedLayoutKey(parentModuleName, instanceName)]
    || layoutOverrides?.[instanceName]
    || null;
}

// ─── Port grouping (Vivado-style collapse) ─────────────────────────────

/**
 * Group ports by common prefix.
 * E.g. io_tick_pc, io_tick_ifid, io_tick_idex -> group "io_tick" with 3 ports.
 * Returns array of { label, ports[], totalWidth, collapsed }
 */
function groupPortsByPrefix(ports) {
  if (ports.length <= LAYOUT.COLLAPSE_THRESHOLD) {
    // No collapse needed — return each port as its own group
    return ports.map(p => ({
      label: null,
      ports: [p],
      totalWidth: p.width,
      collapsed: false,
    }));
  }

  // Find common prefixes (split by '_' or camelCase boundaries)
  const prefixMap = {};  // prefix -> [port, ...]
  ports.forEach(p => {
    // Use first 2 underscore-separated parts as prefix key
    const parts = p.name.split('_');
    const prefix = parts.length >= 2 ? parts.slice(0, 2).join('_') : parts[0];
    if (!prefixMap[prefix]) prefixMap[prefix] = [];
    prefixMap[prefix].push(p);
  });

  const groups = [];
  for (const [prefix, groupPorts] of Object.entries(prefixMap)) {
    if (groupPorts.length === 1) {
      // Single port — don't collapse
      groups.push({ label: null, ports: groupPorts, totalWidth: groupPorts[0].width, collapsed: false });
    } else {
      const totalW = groupPorts.reduce((s, p) => s + p.width, 0);
      groups.push({
        label: `${prefix}_* (${groupPorts.length})`,
        ports: groupPorts,
        totalWidth: totalW,
        collapsed: true,
      });
    }
  }
  return groups;
}

// ─── Module size calculation ────────────────────────────────────────────

function calcModuleSize(mod, collapsedState = {}, hideClockReset = false) {
  const clockResetPattern = /\b(clock|reset|clk|rst)\b/i;
  const inputs = mod.ports.filter(p => p.direction === 'input' && !(hideClockReset && clockResetPattern.test(p.name)));
  const outputs = mod.ports.filter(p => p.direction === 'output' && !(hideClockReset && clockResetPattern.test(p.name)));

  const inGroups = groupPortsByPrefix(inputs);
  const outGroups = groupPortsByPrefix(outputs);

  // Count visible rows (collapsed group = 1 row, expanded = N rows)
  const isExpGroup = (g, side) => {
    if (!g.collapsed) return true;
    const key = `${mod.name}:${side}:${g.label}`;
    return collapsedState[key] === true;
  };

  let inRows = 0;
  inGroups.forEach(g => {
    if (!g.collapsed || isExpGroup(g, 'in')) {
      inRows += g.ports.length;
      if (g.collapsed) inRows += 1; // header row for re-collapse
    } else {
      inRows += 1;
    }
  });
  let outRows = 0;
  outGroups.forEach(g => {
    if (!g.collapsed || isExpGroup(g, 'out')) {
      outRows += g.ports.length;
      if (g.collapsed) outRows += 1; // header row for re-collapse
    } else {
      outRows += 1;
    }
  });

  const maxRows = Math.max(inRows, outRows, 1);

  // Width from longest visible label
  let maxNameLen = mod.name.length;
  const allVisible = [];
  const addLabels = (groups, side) => {
    groups.forEach(g => {
      if (g.collapsed && !isExpGroup(g, side)) {
        allVisible.push(g.label);
      } else {
        g.ports.forEach(p => {
          allVisible.push(p.width > 1 ? `${p.name} [${p.msb}:${p.lsb}]` : p.name);
        });
      }
    });
  };
  addLabels(inGroups, 'in');
  addLabels(outGroups, 'out');
  allVisible.forEach(l => { maxNameLen = Math.max(maxNameLen, l.length); });

  const width = Math.max(LAYOUT.MODULE_MIN_WIDTH, Math.min(maxNameLen * 7 + 50, 500));
  const height = LAYOUT.MODULE_HEADER_H + maxRows * (LAYOUT.PORT_H + LAYOUT.PORT_GAP) + LAYOUT.PORT_GAP * 2 + 4;

  return { width, height, inGroups, outGroups };
}

// ─── Render a single module box ──────────────────────────────────────────

function renderModuleBox(mod, x, y, opts = {}) {
  const {
    isTop = false,
    collapsedState = {},
    instName = '',
    widthOverride,
    heightOverride,
    displayWidth,
    displayHeight,
    hideClockReset = false,
    customizations,
    inlineExpanded = false,
    renderPath = '',
    layoutKey = '',
    layoutOriginX = 0,
    layoutOriginY = 0,
    expansionBlocked = false,
    expansionBlockedReason = '',
  } = opts;
  const info = calcModuleSize(mod, collapsedState, hideClockReset);
  const W = displayWidth || (inlineExpanded ? info.width : (widthOverride || info.width));
  const H = displayHeight || (inlineExpanded ? info.height : (heightOverride || info.height));
  const { inGroups, outGroups } = info;

  // Custom module color / rename / comment
  const modCustom = customizations?.modules?.[instName];
  const customFill = modCustom?.color || null;
  const customName = modCustom?.rename || null;
  const customComment = modCustom?.comment || null;

  const g = svgEl('g', {
    class: `module-box${inlineExpanded ? ' inline-expanded' : ''}`,
    transform: `translate(${x}, ${y})`,
    'data-module': mod.name,
    'data-instance': instName,
    'data-render-path': renderPath,
    'data-layout-key': layoutKey,
    'data-layout-origin-x': layoutOriginX,
    'data-layout-origin-y': layoutOriginY,
    'data-inline-expanded': inlineExpanded ? 'true' : 'false',
  });

  // Main rect
  g.appendChild(svgEl('rect', {
    class: 'module-rect', x: 0, y: 0, width: W, height: H, rx: 6, ry: 6,
    fill: inlineExpanded ? 'none' : (customFill || (isTop ? COL.topFill : COL.modFill)),
    stroke: isTop ? COL.topStroke : COL.modStroke,
    'stroke-width': isTop ? 2 : 1.5,
  }));
  // Header
  g.appendChild(svgEl('rect', { class: 'module-header-primary', x: 1, y: 1, width: W - 2, height: LAYOUT.MODULE_HEADER_H - 1, rx: 5, ry: 5, fill: COL.header }));
  g.appendChild(svgEl('rect', { x: 1, y: LAYOUT.MODULE_HEADER_H / 2, width: W - 2, height: LAYOUT.MODULE_HEADER_H / 2, fill: COL.header }));

  // Title text
  const displayName = customName || (instName ? `${instName} : ${mod.name}` : mod.name);
  const titleStr = displayName;
  const title = svgEl('text', {
    class: 'module-title', x: W / 2, y: LAYOUT.MODULE_HEADER_H / 2 + 5,
    'text-anchor': 'middle', 'font-size': LAYOUT.TITLE_FONT, fill: COL.txt, 'font-weight': '600',
  });
  title.textContent = titleStr.length > 36 ? titleStr.slice(0, 34) + '…' : titleStr;
  g.appendChild(title);

  // Add SVG tooltip for truncated titles
  if (titleStr.length > 36) {
    const tooltip = svgEl('title');
    tooltip.textContent = titleStr;
    title.appendChild(tooltip);
  }

  // Expand indicator
  if (mod.instances && mod.instances.length > 0) {
    const hitW = 22;
    const ei = svgEl('g', {
      class: `expand-indicator${expansionBlocked ? ' expansion-blocked' : ''}`,
      transform: `translate(${W - hitW - 2}, 4)`,
      role: 'button',
      tabindex: expansionBlocked ? '-1' : '0',
      'aria-label': expansionBlocked
        ? `无法展开 ${instName || mod.name}`
        : `${inlineExpanded ? '收起' : '展开'} ${instName || mod.name}`,
      'aria-expanded': inlineExpanded ? 'true' : 'false',
      'data-render-path': renderPath,
      'data-expansion-blocked': expansionBlocked ? 'true' : 'false',
      style: expansionBlocked ? 'cursor:not-allowed;' : 'cursor:pointer;',
    });
    ei.appendChild(svgEl('rect', {
      class: 'expand-indicator-hit',
      x: 0, y: 0, width: hitW, height: LAYOUT.MODULE_HEADER_H - 8,
      rx: 3, fill: 'transparent',
    }));
    const eiText = svgEl('text', {
      x: hitW / 2, y: LAYOUT.MODULE_HEADER_H / 2 + 1,
      'text-anchor': 'middle',
      fill: expansionBlocked ? COL.dim : '#58a6ff',
      'font-size': 12,
      'pointer-events': 'none',
    });
    eiText.textContent = expansionBlocked ? '×' : (inlineExpanded ? '▼' : '▶');
    ei.appendChild(eiText);
    if (expansionBlockedReason) {
      const blockedTitle = svgEl('title');
      blockedTitle.textContent = expansionBlockedReason;
      ei.appendChild(blockedTitle);
    }
    g.appendChild(ei);
  }

  // Settings gear button (for non-top instances) — uses a <g> so pointer-events work
  if (instName) {
    const hasExpand = mod.instances && mod.instances.length > 0;
    const btnW = 18, btnH = 14;
    const gearCX = hasExpand ? W - 40 : W - 12;
    const gearCY = LAYOUT.MODULE_HEADER_H / 2;
    const gearG = svgEl('g', {
      class: 'module-settings-icon',
      style: 'cursor:pointer;',
      transform: `translate(${gearCX - btnW / 2}, ${gearCY - btnH / 2})`,
    });
    // Transparent hit area
    gearG.appendChild(svgEl('rect', { x: 0, y: 0, width: btnW, height: btnH, rx: 3, fill: 'transparent' }));
    // Visible border box (shown on hover via CSS)
    gearG.appendChild(svgEl('rect', { x: 0, y: 0, width: btnW, height: btnH, rx: 3,
      fill: 'none', stroke: '#30363d', 'stroke-width': 1, class: 'module-settings-icon-border' }));
    const gearTxt = svgEl('text', {
      x: btnW / 2, y: btnH / 2 + 4,
      'text-anchor': 'middle', fill: '#8b949e', 'font-size': 11,
      style: 'pointer-events:none;user-select:none;',
    });
    gearTxt.textContent = '⚙';
    gearG.appendChild(gearTxt);
    g.appendChild(gearG);
  }

  const portPositions = {};  // portName -> { x (abs), y (abs), side }
  // Stable only while a port group remains in its current collapsed/expanded state.
  // It lets the internal renderer collapse many bit-level dependencies into one visible bus.
  const portGroupIds = {};   // portName -> "in|out:<group label or port name>"
  let curY = LAYOUT.MODULE_HEADER_H + LAYOUT.PORT_GAP * 2;

  // ── Draw port groups helper ──
  const drawGroups = (groups, side) => {
    let py = curY;
    const isLeft = side === 'in';

    groups.forEach(group => {
      const isExpGroup = (g2) => {
        if (!g2.collapsed) return true;
        const key = `${mod.name}:${side}:${g2.label}`;
        return collapsedState[key] === true;
      };

      if (group.collapsed && !isExpGroup(group)) {
        // ── Collapsed group: single row with summary ──
        const midY = py + LAYOUT.PORT_H / 2;
        const portG = svgEl('g', {
          class: 'port-group-collapsed',
          'data-group-key': `${mod.name}:${side}:${group.label}`,
        });

        // Background highlight bar
        portG.appendChild(svgEl('rect', {
          x: isLeft ? 2 : W / 2, y: py - 1,
          width: W / 2 - 4, height: LAYOUT.PORT_H + 2,
          rx: 3, fill: COL.groupFill, opacity: 0.6,
        }));

        // Summary label
        const lbl = svgEl('text', {
          class: 'port-group-summary',
          x: isLeft ? LAYOUT.PORT_PAD_X : W - LAYOUT.PORT_PAD_X,
          y: midY + 4,
          'text-anchor': isLeft ? 'start' : 'end',
          fill: isLeft ? COL.pIn : COL.pOut,
          'font-size': 10,
        });
        lbl.textContent = group.label;
        portG.appendChild(lbl);

        // Total width badge
        const badge = svgEl('text', {
          x: isLeft ? LAYOUT.PORT_PAD_X : W - LAYOUT.PORT_PAD_X,
          y: midY + 14,
          'text-anchor': isLeft ? 'start' : 'end',
          fill: COL.dim, 'font-size': 9,
        });
        badge.textContent = `${group.totalWidth} bits`;
        portG.appendChild(badge);

        // Stub line
        const stubX1 = isLeft ? -LAYOUT.PORT_STUB : W + 4;
        const stubX2 = isLeft ? -4 : W + LAYOUT.PORT_STUB;
        portG.appendChild(svgEl('line', {
          x1: stubX1, y1: midY, x2: stubX2, y2: midY,
          stroke: isLeft ? COL.pIn : COL.pOut, 'stroke-width': 3,
        }));
        // Bus slash
        const slashX = (stubX1 + stubX2) / 2;
        portG.appendChild(svgEl('line', {
          x1: slashX - 3, y1: midY - 4, x2: slashX + 3, y2: midY + 4,
          stroke: isLeft ? COL.pIn : COL.pOut, 'stroke-width': 1.5,
        }));
        const busLbl = svgEl('text', {
          x: slashX, y: midY - 6, 'text-anchor': 'middle', fill: COL.dim, 'font-size': 9,
        });
        busLbl.textContent = `${group.totalWidth}`;
        portG.appendChild(busLbl);

        g.appendChild(portG);

        // Register port positions for all ports in group at this Y
        group.ports.forEach(p => {
          portGroupIds[p.name] = `${side}:${group.label}`;
          portPositions[p.name] = {
            x: x + (isLeft ? -LAYOUT.PORT_STUB : W + LAYOUT.PORT_STUB),
            y: y + midY,
            side: isLeft ? 'left' : 'right',
          };
        });

        py += LAYOUT.PORT_H + LAYOUT.PORT_GAP;

      } else {
        // ── Expanded: draw each port individually ──
        // If this group CAN be collapsed (has label), add a clickable header to re-collapse
        if (group.collapsed) {
          const headerG = svgEl('g', {
            class: 'port-group-expanded-header',
            'data-group-key': `${mod.name}:${side}:${group.label}`,
          });
          // Small collapse indicator bar
          headerG.appendChild(svgEl('rect', {
            x: isLeft ? 2 : W / 2, y: py - 3,
            width: W / 2 - 4, height: 14,
            rx: 3, fill: '#1f6feb', opacity: 0.15,
          }));
          const hdrTxt = svgEl('text', {
            x: isLeft ? LAYOUT.PORT_PAD_X : W - LAYOUT.PORT_PAD_X,
            y: py + 7,
            'text-anchor': isLeft ? 'start' : 'end',
            fill: '#58a6ff', 'font-size': 9, style: 'cursor:pointer;',
          });
          hdrTxt.textContent = `▼ ${group.label}`;
          headerG.appendChild(hdrTxt);
          g.appendChild(headerG);
          py += 14 + LAYOUT.PORT_GAP;
        }

        group.ports.forEach(port => {
          const midY = py + LAYOUT.PORT_H / 2;
          const portG = svgEl('g', { class: `port-group port-${isLeft ? 'input' : 'output'}`, 'data-port': port.name });

          const label = port.width > 1 ? `${port.name} [${port.msb}:${port.lsb}]` : port.name;
          const txt = svgEl('text', {
            class: 'port-label',
            x: isLeft ? LAYOUT.PORT_PAD_X : W - LAYOUT.PORT_PAD_X,
            y: midY + 4,
            'text-anchor': isLeft ? 'start' : 'end',
            fill: isLeft ? COL.pIn : COL.pOut,
            'font-size': LAYOUT.PORT_FONT,
          });
          txt.textContent = label;
          portG.appendChild(txt);

          // Stub
          const isBus = port.width > 1;
          const stubX1 = isLeft ? -LAYOUT.PORT_STUB : W + 4;
          const stubX2 = isLeft ? -4 : W + LAYOUT.PORT_STUB;
          portG.appendChild(svgEl('line', {
            x1: stubX1, y1: midY, x2: stubX2, y2: midY,
            stroke: isLeft ? COL.pIn : COL.pOut,
            'stroke-width': isBus ? 3 : 1.5,
          }));

          // Arrow
          const arrX = isLeft ? stubX2 : stubX2;
          const arrDir = isLeft ? 1 : 1;
          if (isLeft) {
            portG.appendChild(svgEl('polygon', {
              points: `${stubX2},${midY} ${stubX2 - 5},${midY - 3} ${stubX2 - 5},${midY + 3}`,
              fill: COL.pIn,
            }));
          } else {
            portG.appendChild(svgEl('polygon', {
              points: `${stubX2},${midY} ${stubX2 - 5},${midY - 3} ${stubX2 - 5},${midY + 3}`,
              fill: COL.pOut,
            }));
          }

          // Active-low circle
          if (port.is_active_low) {
            const cx = isLeft ? -2 : W + 2;
            portG.appendChild(svgEl('circle', {
              cx, cy: midY, r: 4, fill: 'none', stroke: COL.activeLow, 'stroke-width': 1.5,
            }));
          }

          // Bus width
          if (isBus) {
            const slashX = (stubX1 + stubX2) / 2;
            portG.appendChild(svgEl('line', {
              x1: slashX - 3, y1: midY - 4, x2: slashX + 3, y2: midY + 4,
              stroke: isLeft ? COL.pIn : COL.pOut, 'stroke-width': 1,
            }));
            const bLbl = svgEl('text', {
              x: slashX, y: midY - 6, 'text-anchor': 'middle', fill: COL.dim, 'font-size': 9,
            });
            bLbl.textContent = `${port.width}`;
            portG.appendChild(bLbl);
          }

          g.appendChild(portG);
          portGroupIds[port.name] = `${side}:${port.name}`;
          portPositions[port.name] = {
            x: x + (isLeft ? -LAYOUT.PORT_STUB : W + LAYOUT.PORT_STUB),
            y: y + midY,
            side: isLeft ? 'left' : 'right',
          };

          py += LAYOUT.PORT_H + LAYOUT.PORT_GAP;
        });
      }
    });
  };

  drawGroups(inGroups, 'in');
  curY = LAYOUT.MODULE_HEADER_H + LAYOUT.PORT_GAP * 2;  // reset for right side
  drawGroups(outGroups, 'out');

  // Resize handle (bottom-right corner triangle)
  const rh = LAYOUT.RESIZE_HANDLE;
  if (!inlineExpanded) {
    const resizeHandle = svgEl('polygon', {
      class: 'resize-handle',
      points: `${W},${H - rh} ${W},${H} ${W - rh},${H}`,
      fill: COL.resizeHandle, opacity: 0.3,
      'data-instance': instName, 'data-module': mod.name,
      'data-render-path': renderPath,
      'data-layout-key': layoutKey,
      style: 'cursor:nwse-resize;',
    });
    g.appendChild(resizeHandle);
  }

  // Drag handle (header area) - mark for identification
  g.querySelector('.module-rect').setAttribute('data-drag-target', 'true');

  return { group: g, portPositions, portGroupIds, size: { width: W, height: H } };
}

// ─── Wire drawing with orthogonal routing & waypoints ──────────────────

function wireLead(x, y, side) {
  const clearance = LAYOUT.WIRE_MARGIN + 8;
  return { x: side === 'left' ? x - clearance : x + clearance, y };
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left - right);
}

function pointBlocked(point, obstacles) {
  const margin = LAYOUT.WIRE_MARGIN;
  return obstacles.some(obstacle => {
    const left = obstacle.x - margin;
    const right = obstacle.x + obstacle.w + margin;
    const top = obstacle.y - margin;
    const bottom = obstacle.y + obstacle.h + margin;
    return point.x > left && point.x < right && point.y > top && point.y < bottom;
  });
}

function segmentBlocked(from, to, obstacles) {
  const margin = LAYOUT.WIRE_MARGIN;
  return obstacles.some(obstacle => {
    const left = obstacle.x - margin;
    const right = obstacle.x + obstacle.w + margin;
    const top = obstacle.y - margin;
    const bottom = obstacle.y + obstacle.h + margin;
    if (from.x === to.x) {
      return from.x > left && from.x < right
        && Math.max(from.y, to.y) > top && Math.min(from.y, to.y) < bottom;
    }
    return from.y > top && from.y < bottom
      && Math.max(from.x, to.x) > left && Math.min(from.x, to.x) < right;
  });
}

/**
 * Find an obstacle-free Manhattan path on the module-edge visibility grid.
 * The returned points contain both endpoints and never traverse a module body.
 */
function findOrthogonalPath(start, end, obstacles) {
  if (start.x === end.x && start.y === end.y) return [start];
  if (pointBlocked(start, obstacles) || pointBlocked(end, obstacles)) return null;

  const margin = LAYOUT.WIRE_MARGIN;
  const clearance = margin + 40;
  const bounds = obstacles.reduce((acc, obstacle) => ({
    minX: Math.min(acc.minX, obstacle.x - margin),
    maxX: Math.max(acc.maxX, obstacle.x + obstacle.w + margin),
    minY: Math.min(acc.minY, obstacle.y - margin),
    maxY: Math.max(acc.maxY, obstacle.y + obstacle.h + margin),
  }), {
    minX: Math.min(start.x, end.x), maxX: Math.max(start.x, end.x),
    minY: Math.min(start.y, end.y), maxY: Math.max(start.y, end.y),
  });
  const xs = uniqueSorted([
    start.x, end.x, bounds.minX - clearance, bounds.maxX + clearance,
    ...obstacles.flatMap(obstacle => [obstacle.x - margin, obstacle.x + obstacle.w + margin]),
  ]);
  const ys = uniqueSorted([
    start.y, end.y, bounds.minY - clearance, bounds.maxY + clearance,
    ...obstacles.flatMap(obstacle => [obstacle.y - margin, obstacle.y + obstacle.h + margin]),
  ]);
  const width = xs.length;
  const nodeCount = width * ys.length;
  const nodeAt = (xIndex, yIndex) => yIndex * width + xIndex;
  const pointAt = node => ({ x: xs[node % width], y: ys[Math.floor(node / width)] });
  const startNode = nodeAt(xs.indexOf(start.x), ys.indexOf(start.y));
  const endNode = nodeAt(xs.indexOf(end.x), ys.indexOf(end.y));
  if (startNode < 0 || endNode < 0) return null;

  const stateCount = nodeCount * 5;
  const distances = new Array(stateCount).fill(Infinity);
  const previous = new Array(stateCount).fill(-1);
  const startState = startNode * 5 + 4;
  distances[startState] = 0;
  const heap = [];
  const push = item => {
    heap.push(item);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (heap[parent].cost <= item.cost) break;
      heap[index] = heap[parent];
      index = parent;
    }
    heap[index] = item;
  };
  const pop = () => {
    if (heap.length === 0) return null;
    const root = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      let index = 0;
      while (true) {
        let child = index * 2 + 1;
        if (child >= heap.length) break;
        if (child + 1 < heap.length && heap[child + 1].cost < heap[child].cost) child += 1;
        if (heap[child].cost >= last.cost) break;
        heap[index] = heap[child];
        index = child;
      }
      heap[index] = last;
    }
    return root;
  };
  push({ state: startState, cost: 0 });

  const directions = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
  ];
  let finalState = -1;
  while (heap.length > 0) {
    const current = pop();
    if (current.cost !== distances[current.state]) continue;
    const node = Math.floor(current.state / 5);
    const previousDirection = current.state % 5;
    if (node === endNode) {
      finalState = current.state;
      break;
    }
    const xIndex = node % width;
    const yIndex = Math.floor(node / width);
    directions.forEach(([dx, dy], direction) => {
      const nextX = xIndex + dx;
      const nextY = yIndex + dy;
      if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= ys.length) return;
      const nextNode = nodeAt(nextX, nextY);
      const from = pointAt(node);
      const to = pointAt(nextNode);
      if (pointBlocked(to, obstacles) || segmentBlocked(from, to, obstacles)) return;
      const bendPenalty = previousDirection === 4 || previousDirection === direction ? 0 : 24;
      const nextState = nextNode * 5 + direction;
      const cost = current.cost + Math.abs(to.x - from.x) + Math.abs(to.y - from.y) + bendPenalty;
      if (cost >= distances[nextState]) return;
      distances[nextState] = cost;
      previous[nextState] = current.state;
      push({ state: nextState, cost });
    });
  }
  if (finalState < 0) return null;

  const nodes = [];
  for (let state = finalState; state >= 0; state = previous[state]) {
    nodes.push(Math.floor(state / 5));
  }
  return nodes.reverse().map(pointAt);
}

function appendPathPoints(target, points) {
  points.forEach(point => {
    const previous = target[target.length - 1];
    if (!previous || previous.x !== point.x || previous.y !== point.y) target.push(point);
  });
}

/**
 * Route every wire from an output-side lead to an input-side lead.  Manual
 * waypoints are mandatory anchors, while the segments between them remain
 * obstacle-aware so they cannot disappear beneath an unrelated module.
 */
function buildWirePath(x1, y1, x2, y2, waypoints, wireIdx, totalWires, obstacles, sourceSide = 'right', targetSide = 'left') {
  const source = { x: x1, y: y1 };
  const target = { x: x2, y: y2 };
  const sourceLead = wireLead(x1, y1, sourceSide);
  const targetLead = wireLead(x2, y2, targetSide);
  const offset = (wireIdx - (totalWires - 1) / 2) * 12;
  const anchors = [sourceLead, ...(waypoints || []), targetLead];

  // Feedback must leave the right-side output and return to the left-side input
  // through a lower rail, never by approaching the input from its output side.
  if ((!waypoints || waypoints.length === 0) && targetLead.x <= sourceLead.x) {
    const bottom = Math.max(
      sourceLead.y,
      targetLead.y,
      ...obstacles.map(obstacle => obstacle.y + obstacle.h + LAYOUT.WIRE_MARGIN),
    ) + 40 + Math.abs(offset);
    anchors.splice(1, 0,
      { x: sourceLead.x, y: bottom },
      { x: targetLead.x, y: bottom },
    );
  }

  const points = [source];
  appendPathPoints(points, [sourceLead]);
  for (let index = 1; index < anchors.length; index += 1) {
    const route = findOrthogonalPath(anchors[index - 1], anchors[index], obstacles);
    if (route) {
      appendPathPoints(points, route.slice(1));
    } else {
      // The visibility grid should always find a route. Keep an orthogonal
      // fallback for malformed manual waypoints instead of emitting diagonals.
      appendPathPoints(points, [
        { x: anchors[index - 1].x, y: anchors[index].y },
        anchors[index],
      ]);
    }
  }
  appendPathPoints(points, [target]);
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`).join(' ');
}

/**
 * Obstacle avoidance: if the vertical segment at midX passes through
 * any module box, iteratively shift midX to go around all obstacles.
 */
function avoidObstaclesSimple(x1, y1, x2, y2, midX, obstacles, offset) {
  const margin = LAYOUT.WIRE_MARGIN;
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);

  let currentMidX = midX;
  let iterations = 0;
  const maxIter = obstacles.length + 2;

  while (iterations < maxIter) {
    let blocked = false;
    for (const obs of obstacles) {
      const ol = obs.x - margin;
      const or_ = obs.x + obs.w + margin;
      const ot = obs.y - margin;
      const ob = obs.y + obs.h + margin;

      // Check if vertical segment at currentMidX intersects this obstacle
      if (currentMidX > ol && currentMidX < or_ && maxY > ot && minY < ob) {
        // Also check horizontal segments
        const leftPath = ol - 10 + offset;
        const rightPath = or_ + 10 + offset;
        currentMidX = Math.abs(leftPath - midX) < Math.abs(rightPath - midX) ? leftPath : rightPath;
        blocked = true;
        break; // Re-check all obstacles with new midX
      }
    }
    if (!blocked) break;
    iterations++;
  }

  if (currentMidX !== midX) {
    // Also check the horizontal segments (y1 line from x1 to midX, y2 line from midX to x2)
    // for obstacles they might pass through
    let finalPath = `M${x1},${y1} L${currentMidX},${y1} L${currentMidX},${y2} L${x2},${y2}`;

    // Check if horizontal segment at y1 from x1 to currentMidX passes through obstacles
    const hMinX = Math.min(x1, currentMidX);
    const hMaxX = Math.max(x1, currentMidX);
    for (const obs of obstacles) {
      const ol = obs.x - margin;
      const or_ = obs.x + obs.w + margin;
      const ot = obs.y - margin;
      const ob = obs.y + obs.h + margin;

      if (y1 > ot && y1 < ob && hMaxX > ol && hMinX < or_) {
        // Horizontal segment passes through obstacle — route above or below
        const aboveY = ot - 10;
        const belowY = ob + 10;
        const detourY = Math.abs(aboveY - y1) < Math.abs(belowY - y1) ? aboveY : belowY;
        finalPath = `M${x1},${y1} L${x1},${detourY} L${currentMidX},${detourY} L${currentMidX},${y2} L${x2},${y2}`;
        break;
      }
    }

    return finalPath;
  }
  return null;
}

function avoidObstaclesVertical(x1, y1, x2, y2, routeX, obstacles, offset) {
  const margin = LAYOUT.WIRE_MARGIN;
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);

  let currentX = routeX;
  let iterations = 0;
  const maxIter = obstacles.length + 2;

  while (iterations < maxIter) {
    let blocked = false;
    for (const obs of obstacles) {
      const ol = obs.x - margin;
      const or_ = obs.x + obs.w + margin;
      const ot = obs.y - margin;
      const ob = obs.y + obs.h + margin;

      if (currentX > ol && currentX < or_ && maxY > ot && minY < ob) {
        currentX = or_ + 10 + Math.abs(offset);
        blocked = true;
        break;
      }
    }
    if (!blocked) break;
    iterations++;
  }

  if (currentX !== routeX) {
    return `M${x1},${y1} L${currentX},${y1} L${currentX},${y2 + offset} L${x2},${y2}`;
  }
  return null;
}

function drawWire(x1, y1, x2, y2, isBus, signalName, wireIdx, totalWires, wireKey, waypoints, obstacles, customColor, sourceSide, targetSide) {
  const g = svgEl('g', {
    class: 'wire-group',
    'data-signal': signalName,
    'data-wire-key': wireKey || '',
  });

  const d = buildWirePath(
    x1, y1, x2, y2, waypoints, wireIdx, totalWires, obstacles,
    sourceSide, targetSide,
  );

  const path = svgEl('path', {
    class: 'wire-path' + (isBus ? ' bus' : ''),
    d, fill: 'none', stroke: customColor || COL.wire,
    'stroke-width': isBus ? 3 : 1.5,
    'data-signal': signalName,
  });
  g.appendChild(path);

  // Draw waypoint handles if waypoints exist
  if (waypoints && waypoints.length > 0) {
    waypoints.forEach((wp, i) => {
      const circle = svgEl('circle', {
        class: 'wire-waypoint',
        cx: wp.x, cy: wp.y, r: LAYOUT.WAYPOINT_R,
        fill: COL.waypoint, stroke: '#0d1117', 'stroke-width': 1.5,
        'data-wire-key': wireKey, 'data-wp-index': i,
        style: 'cursor:move;',
      });
      g.appendChild(circle);
      // Sequence number badge (shown above the circle)
      const label = svgEl('text', {
        class: 'wire-waypoint-label',
        x: wp.x, y: wp.y - LAYOUT.WAYPOINT_R - 2,
        'text-anchor': 'middle',
        'font-size': 9,
        fill: COL.waypoint,
        'pointer-events': 'none',
        'data-wire-key': wireKey, 'data-wp-index': i,
      });
      label.textContent = i + 1;
      g.appendChild(label);
    });
  }

  return g;
}

// ─── Recursive layout and inline module geometry ────────────────────────

function rectanglesOverlap(a, b, gap = 20) {
  return a.x < b.x + b.size.width + gap
    && a.x + a.size.width + gap > b.x
    && a.y < b.y + b.size.height + gap
    && a.y + a.size.height + gap > b.y;
}

function computeModuleGeometry(mod, allModules, collapsedState, layoutOverrides, options = {}) {
  const base = calcModuleSize(mod, collapsedState, options.hideClockReset || false);
  const override = getLayoutOverride(
    layoutOverrides,
    options.parentModuleName || '',
    options.instanceName || '',
  );
  const ancestry = options.ancestry || [];
  const depth = options.depth || 0;
  const hasChildren = Boolean(mod.instances?.length);
  const expansionBlocked = hasChildren
    && (depth >= LAYOUT.INLINE_MAX_DEPTH || ancestry.includes(mod.name));
  const requested = Boolean(
    options.renderPath
    && options.inlineExpandedPaths?.has(options.renderPath)
    && hasChildren
  );
  const expanded = requested && !expansionBlocked;
  let width = override?.width || base.width;
  let height = override?.height || base.height;
  let childLayout = [];
  let contentX = LAYOUT.INLINE_CONTENT_X;
  let contentY = LAYOUT.MODULE_HEADER_H + LAYOUT.INLINE_CONTENT_Y;
  let frameShiftX = 0;
  let frameShiftY = 0;

  if (expanded) {
    childLayout = layoutInstances(
      mod.instances,
      allModules,
      collapsedState,
      layoutOverrides,
      options.hideClockReset || false,
      {
        parentModuleName: mod.name,
        parentPath: options.renderPath,
        inlineExpandedPaths: options.inlineExpandedPaths,
        ancestry: [...ancestry, mod.name],
        depth: depth + 1,
      },
    );
    let contentLeft = 0;
    let contentTop = 0;
    let contentRight = 0;
    let contentBottom = 0;
    childLayout.forEach(item => {
      contentLeft = Math.min(contentLeft, item.x);
      contentTop = Math.min(contentTop, item.y);
      contentRight = Math.max(contentRight, item.x + item.size.width);
      contentBottom = Math.max(contentBottom, item.y + item.size.height);
    });
    frameShiftX = Math.min(0, contentLeft);
    frameShiftY = Math.min(0, contentTop);
    contentX = LAYOUT.INLINE_CONTENT_X - frameShiftX;
    contentY = LAYOUT.MODULE_HEADER_H + LAYOUT.INLINE_CONTENT_Y - frameShiftY;
    width = Math.max(
      base.width,
      contentX + contentRight + LAYOUT.INLINE_PAD_RIGHT,
    );
    height = Math.max(
      base.height,
      contentY + contentBottom + LAYOUT.INLINE_PAD_BOTTOM,
    );
  }

  return {
    width,
    height,
    expanded,
    expansionBlocked,
    expansionBlockedReason: expansionBlocked
      ? (depth >= LAYOUT.INLINE_MAX_DEPTH
        ? `已达到 ${LAYOUT.INLINE_MAX_DEPTH} 层递归保护上限`
        : `检测到循环实例化：${[...ancestry, mod.name].join(' → ')}`)
      : '',
    childLayout,
    contentX,
    contentY,
    frameShiftX,
    frameShiftY,
  };
}

function applyInlineSiblingAvoidance(items) {
  if (!items.some(item => item.geometry.expanded)) return items;
  const placed = [];
  const placementOrder = items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const expansionPriority = Number(right.item.geometry.expanded)
        - Number(left.item.geometry.expanded);
      return expansionPriority || left.index - right.index;
    });
  placementOrder.forEach(({ item }) => {
    const displayBaseX = item.x;
    const displayBaseY = item.y;
    let attempts = 0;
    while (attempts < Math.max(8, items.length * 3)) {
      const blocker = placed.find(other => rectanglesOverlap(item, other));
      if (!blocker) break;
      const moveRight = blocker.x + blocker.size.width + LAYOUT.INST_GAP_X - displayBaseX;
      const moveDown = blocker.y + blocker.size.height + LAYOUT.INST_GAP_Y - displayBaseY;
      if (moveRight <= moveDown) {
        item.x = displayBaseX + Math.max(0, moveRight);
      } else {
        item.y = displayBaseY + Math.max(0, moveDown);
      }
      attempts += 1;
    }
    item.displayOffsetX = item.x - displayBaseX;
    item.displayOffsetY = item.y - displayBaseY;
    placed.push(item);
  });
  return items;
}

function layoutInstances(instances, allModules, collapsedState, layoutOverrides, hideClockReset, options = {}) {
  const parentModuleName = options.parentModuleName || '';
  const parentPath = options.parentPath || `${parentModuleName}::`;
  const items = [];
  (instances || []).forEach(inst => {
    const mod = allModules[inst.module_type];
    if (!mod) return;
    const renderPath = childRenderPath(parentPath, inst.instance_name);
    const layoutKey = scopedLayoutKey(parentModuleName, inst.instance_name);
    const geometry = computeModuleGeometry(mod, allModules, collapsedState, layoutOverrides, {
      parentModuleName,
      instanceName: inst.instance_name,
      renderPath,
      inlineExpandedPaths: options.inlineExpandedPaths || new Set(),
      ancestry: options.ancestry || [],
      depth: options.depth || 0,
      hideClockReset,
    });
    items.push({
      instance: inst,
      mod,
      geometry,
      size: { width: geometry.width, height: geometry.height },
      renderPath,
      layoutKey,
      override: getLayoutOverride(layoutOverrides, parentModuleName, inst.instance_name),
    });
  });
  if (items.length === 0) return [];

  const cols = Math.min(items.length, LAYOUT.COLS_MAX);
  const results = [];
  let cx = LAYOUT.MOD_PAD_X;
  let cy = LAYOUT.MOD_PAD_Y;
  let rowH = 0;
  let col = 0;

  items.forEach(item => {
    const override = item.override;
    if (override?.x !== undefined && override?.y !== undefined) {
      const baseX = override.x;
      const baseY = override.y;
      results.push({
        ...item,
        baseX,
        baseY,
        x: baseX + (item.geometry.frameShiftX || 0),
        y: baseY + (item.geometry.frameShiftY || 0),
      });
      return;
    }
    if (col >= cols) {
      col = 0;
      cx = LAYOUT.MOD_PAD_X;
      cy += rowH + LAYOUT.INST_GAP_Y;
      rowH = 0;
    }
    const frameShiftX = item.geometry.frameShiftX || 0;
    const frameShiftY = item.geometry.frameShiftY || 0;
    results.push({
      ...item,
      baseX: cx - frameShiftX,
      baseY: cy - frameShiftY,
      x: cx,
      y: cy,
    });
    cx += item.size.width + LAYOUT.INST_GAP_X + LAYOUT.PORT_STUB * 2;
    rowH = Math.max(rowH, item.size.height);
    col += 1;
  });
  return applyInlineSiblingAvoidance(results);
}

function renderModuleTree(item, x, y, allModules, collapsedState, layoutOverrides, wireWaypoints, options) {
  const geometry = item.geometry;
  const render = renderModuleBox(item.mod, x, y, {
    collapsedState,
    instName: item.instance.instance_name,
    displayWidth: geometry.width,
    displayHeight: geometry.height,
    hideClockReset: options.hideClockReset,
    customizations: options.customizations,
    inlineExpanded: geometry.expanded,
    renderPath: item.renderPath,
    layoutKey: item.layoutKey,
    layoutOriginX: options.layoutOriginX || 0,
    layoutOriginY: options.layoutOriginY || 0,
    expansionBlocked: geometry.expansionBlocked,
    expansionBlockedReason: geometry.expansionBlockedReason,
  });

  if (geometry.expanded) {
    const boundaryPorts = {};
    Object.entries(render.portPositions).forEach(([portName, pos]) => {
      boundaryPorts[portName] = {
        x: pos.x - x,
        y: pos.y - y,
        side: pos.side,
      };
    });
    const internal = renderModuleInternal(
      item.mod,
      allModules,
      geometry.contentX,
      geometry.contentY,
      collapsedState,
      layoutOverrides,
      wireWaypoints,
      {
        ...options,
        parentPath: item.renderPath,
        ancestry: [...(options.ancestry || []), item.mod.name],
        depth: (options.depth || 0) + 1,
        boundaryPorts,
        precomputedLayout: geometry.childLayout,
      },
    );
    const header = render.group.children?.[1] || null;
    render.group.insertBefore(internal, header);
  }

  return render;
}

function expressionKeys(expression) {
  const compact = String(expression || '').replace(/\s+/g, '');
  if (!compact) return [];
  const keys = new Set([compact]);
  const base = compact.replace(/\[[^\]]+\]/g, '');
  if (base) keys.add(base);
  const tokens = compact.match(/[a-zA-Z_]\w*/g) || [];
  tokens.forEach(token => keys.add(token));
  return [...keys];
}

function renderModuleInternal(parentMod, allModules, offsetX, offsetY, collapsedState, layoutOverrides, wireWaypoints, options = {}) {
  const g = svgEl('g', {
    class: 'module-internal',
    'data-module': parentMod.name,
    'data-render-path': options.parentPath || `${parentMod.name}::`,
    'data-scope-origin-x': offsetX,
    'data-scope-origin-y': offsetY,
  });
  const hideClockReset = options.hideClockReset || false;
  const customizations = options.customizations || { modules: {}, wires: {} };
  const wireLayer = svgEl('g', { class: 'wire-layer' });
  const moduleLayer = svgEl('g', { class: 'module-layer' });
  g.appendChild(wireLayer);
  g.appendChild(moduleLayer);

  const instOverrides = layoutOverrides || {};
  const parentPath = options.parentPath || `${parentMod.name}::`;
  const layout = options.precomputedLayout || layoutInstances(
    parentMod.instances,
    allModules,
    collapsedState,
    instOverrides,
    hideClockReset,
    {
      parentModuleName: parentMod.name,
      parentPath,
      inlineExpandedPaths: options.inlineExpandedPaths || new Set(),
      ancestry: options.ancestry || [parentMod.name],
      depth: (options.depth || 0) + 1,
    },
  );
  const renders = {};

  layout.forEach(item => {
    const ix = offsetX + item.x;
    const iy = offsetY + item.y;
    const render = renderModuleTree(
      item,
      ix,
      iy,
      allModules,
      collapsedState,
      instOverrides,
      wireWaypoints,
      {
        ...options,
        hideClockReset,
        customizations,
        layoutOriginX: offsetX
          + (item.displayOffsetX || 0)
          + (item.geometry.frameShiftX || 0),
        layoutOriginY: offsetY
          + (item.displayOffsetY || 0)
          + (item.geometry.frameShiftY || 0),
      },
    );
    moduleLayer.appendChild(render.group);
    renders[item.instance.instance_name] = {
      portPositions: render.portPositions,
      portGroupIds: render.portGroupIds,
      instance: item.instance,
      mod: item.mod,
      x: ix,
      y: iy,
      size: render.size,
      renderPath: item.renderPath,
    };
  });

  const wireToInstPort = {};
  const addWireEndpoint = (expression, endpoint) => {
    expressionKeys(expression).forEach(key => {
      if (!wireToInstPort[key]) wireToInstPort[key] = [];
      if (!wireToInstPort[key].some(existing => (
        existing.inst === endpoint.inst && existing.port === endpoint.port
      ))) {
        wireToInstPort[key].push(endpoint);
      }
    });
  };

  layout.forEach(item => {
    const instName = item.instance.instance_name;
    const render = renders[instName];
    if (!render) return;
    for (const [portName, wireName] of Object.entries(item.instance.connections || {})) {
      if (!wireName || !String(wireName).trim()) continue;
      const portDef = render.mod.ports.find(port => port.name === portName);
      const pos = render.portPositions[portName];
      if (!portDef || !pos) continue;
      addWireEndpoint(wireName, {
        inst: instName,
        port: portName,
        dir: portDef.direction,
        pos,
        portDef,
        portGroupId: render.portGroupIds[portName] || portName,
      });
    }
  });

  if (options.boundaryPorts) {
    (parentMod.ports || []).forEach(portDef => {
      const pos = options.boundaryPorts[portDef.name];
      if (!pos) return;
      const endpoint = {
        inst: portDef.direction === 'input' ? '@parent-input' : '@parent-output',
        port: portDef.name,
        dir: portDef.direction === 'input' ? 'output'
          : (portDef.direction === 'output' ? 'input' : 'inout'),
        pos: {
          ...pos,
          side: portDef.direction === 'input' ? 'right' : 'left',
        },
        portDef,
        portGroupId: `parent:${portDef.name}`,
      };
      addWireEndpoint(portDef.name, endpoint);
    });
  }

  const verilogKeywords = new Set([
    'wire', 'reg', 'logic', 'input', 'output', 'assign', 'if', 'else',
    'begin', 'end', 'and', 'or', 'not', 'xor', 'nand', 'nor', 'xnor',
  ]);
  const extractWireRefs = expression => expressionKeys(expression)
    .filter(key => /^[a-zA-Z_]\w*$/.test(key) && !verilogKeywords.has(key));
  const assigns = parentMod.assigns || [];
  const intermediateToSources = {};

  for (let pass = 0; pass < Math.max(2, assigns.length); pass += 1) {
    let changed = false;
    assigns.forEach(asgn => {
      const targets = expressionKeys(asgn.target);
      const target = targets.find(key => /^[a-zA-Z_]\w*$/.test(key)) || targets[0];
      if (!target || wireToInstPort[target]) return;
      const refs = extractWireRefs(asgn.source);
      const resolved = [];
      refs.forEach(ref => {
        if (wireToInstPort[ref]) resolved.push(ref);
        (intermediateToSources[ref] || []).forEach(source => resolved.push(source));
      });
      const unique = [...new Set(resolved)];
      if (unique.length && JSON.stringify(unique) !== JSON.stringify(intermediateToSources[target] || [])) {
        intermediateToSources[target] = unique;
        changed = true;
      }
    });
    if (!changed) break;
  }

  const allWires = [];
  const connectedPairs = new Set();
  const isOutput = port => port.dir === 'output' || port.dir === 'inout';
  const isInput = port => port.dir === 'input' || port.dir === 'inout';
  const connectPorts = (signal, sourcePorts, targetPorts) => {
    sourcePorts.filter(isOutput).forEach(out => {
      targetPorts.filter(isInput).forEach(inp => {
        if (out.inst === inp.inst && out.port === inp.port) return;
        const pairKey = `${out.inst}.${out.port}→${inp.inst}.${inp.port}`;
        if (connectedPairs.has(pairKey)) return;
        connectedPairs.add(pairKey);
        allWires.push({
          signal,
          out,
          inp,
          isBus: (out.portDef.width > 1) || (inp.portDef.width > 1),
        });
      });
    });
  };

  assigns.forEach(asgn => {
    const targetNames = expressionKeys(asgn.target);
    const targetPorts = targetNames.flatMap(name => wireToInstPort[name] || []);
    if (!targetPorts.some(isInput)) return;
    const sourceNames = new Set(expressionKeys(asgn.source));
    [...sourceNames].forEach(name => {
      (intermediateToSources[name] || []).forEach(source => sourceNames.add(source));
    });
    sourceNames.forEach(name => {
      if (wireToInstPort[name]) connectPorts(
        `${name} → ${targetNames[0] || asgn.target}`,
        wireToInstPort[name],
        targetPorts,
      );
    });
  });

  Object.entries(wireToInstPort).forEach(([wireName, ports]) => {
    if (ports.some(isOutput) && ports.some(isInput)) {
      connectPorts(wireName, ports, ports);
    }
  });

  const clockResetPattern = /\b(clock|reset|clk|rst)\b/i;
  const filteredWires = hideClockReset
    ? allWires.filter(wire => (
      !clockResetPattern.test(wire.signal)
      && !clockResetPattern.test(wire.out.port)
      && !clockResetPattern.test(wire.inp.port)
    ))
    : allWires;
  const bundledWires = new Map();
  filteredWires.forEach(wire => {
    const key = `${wire.out.inst}:${wire.out.portGroupId}→${wire.inp.inst}:${wire.inp.portGroupId}`;
    let bundle = bundledWires.get(key);
    if (!bundle) {
      bundle = { ...wire, members: [] };
      bundledWires.set(key, bundle);
    }
    bundle.members.push(wire);
  });
  const visibleWires = [...bundledWires.values()];
  const obstacles = Object.entries(renders).map(([instName, render]) => ({
    x: render.x,
    y: render.y,
    w: render.size.width,
    h: render.size.height,
    inst: instName,
  }));
  const wireCountByPair = {};
  const wireIdxByPair = {};
  visibleWires.forEach(wire => {
    const pairKey = `${wire.out.inst}→${wire.inp.inst}`;
    wireCountByPair[pairKey] = (wireCountByPair[pairKey] || 0) + 1;
  });

  visibleWires.forEach(wire => {
    const pairKey = `${wire.out.inst}→${wire.inp.inst}`;
    const index = wireIdxByPair[pairKey] || 0;
    wireIdxByPair[pairKey] = index + 1;
    const localWireKey = `${wire.out.inst}.${wire.out.port}→${wire.inp.inst}.${wire.inp.port}`;
    const wireKey = `${parentMod.name}::${localWireKey}`;
    const savedWaypoints = wireWaypoints?.[wireKey];
    const legacyWaypoints = wireWaypoints?.[localWireKey];
    const canonicalWaypoints = savedWaypoints || (legacyWaypoints
      ? legacyWaypoints.map(point => ({ x: point.x - 50, y: point.y - 50 }))
      : []);
    const displayWaypoints = canonicalWaypoints.map(point => ({
      x: point.x + offsetX,
      y: point.y + offsetY,
    }));
    const customWireColor = customizations.wires?.[wireKey]?.color
      || customizations.wires?.[localWireKey]?.color
      || null;
    const signalName = wire.members.length > 1
      ? `${wire.signal} 等 ${wire.members.length} 条信号`
      : wire.signal;
    const renderedWire = drawWire(
      wire.out.pos.x,
      wire.out.pos.y,
      wire.inp.pos.x,
      wire.inp.pos.y,
      wire.isBus || wire.members.length > 1,
      signalName,
      index,
      wireCountByPair[pairKey],
      wireKey,
      displayWaypoints,
      obstacles,
      customWireColor,
      wire.out.pos.side,
      wire.inp.pos.side,
    );
    renderedWire.setAttribute('data-waypoint-origin-x', offsetX);
    renderedWire.setAttribute('data-waypoint-origin-y', offsetY);
    renderedWire.setAttribute('data-render-path', `${parentPath}::wire::${localWireKey}`);
    renderedWire.querySelectorAll?.('.wire-waypoint').forEach(handle => {
      handle.setAttribute('data-waypoint-origin-x', offsetX);
      handle.setAttribute('data-waypoint-origin-y', offsetY);
      handle.setAttribute('data-render-path', `${parentPath}::wire::${localWireKey}`);
    });
    wireLayer.appendChild(renderedWire);
  });

  return g;
}

// ─── Top-level design view ──────────────────────────────────────────────

function renderDesignView(topModName, allModules, expandedModules, collapsedState, layoutOverrides, wireWaypoints, options = {}) {
  const rootG = svgEl('g', { id: 'design-root' });
  const topMod = allModules[topModName];
  if (!topMod) return rootG;
  const parentPath = `${topModName}::`;
  const inlineExpandedPaths = options.inlineExpandedPaths || new Set();

  if (expandedModules.has(topModName)) {
    const renderOptions = {
      ...options,
      inlineExpandedPaths,
      parentPath,
      ancestry: [topModName],
      depth: 0,
    };
    const internal = renderModuleInternal(
      topMod,
      allModules,
      50,
      50,
      collapsedState,
      layoutOverrides,
      wireWaypoints,
      renderOptions,
    );
    rootG.appendChild(internal);
    const layout = layoutInstances(
      topMod.instances,
      allModules,
      collapsedState,
      layoutOverrides,
      options.hideClockReset,
      {
        parentModuleName: topMod.name,
        parentPath,
        inlineExpandedPaths,
        ancestry: [topModName],
        depth: 1,
      },
    );
    let minX = Infinity;
    let minY = Infinity;
    let maxX = 0;
    let maxY = 0;
    layout.forEach(item => {
      minX = Math.min(minX, item.x - LAYOUT.PORT_STUB);
      minY = Math.min(minY, item.y);
      maxX = Math.max(maxX, item.x + item.size.width + LAYOUT.PORT_STUB + LAYOUT.MOD_PAD_X);
      maxY = Math.max(maxY, item.y + item.size.height + LAYOUT.MOD_PAD_Y + 30);
    });
    if (minX === Infinity) {
      minX = 0;
      minY = 0;
    }
    const bbX = Math.min(20, minX + 40);
    const bbY = Math.min(20, minY + 40);
    maxX = Math.max(maxX, 400) + 50;
    maxY = Math.max(maxY, 200) + 50;
    rootG.insertBefore(svgEl('rect', {
      x: bbX,
      y: bbY,
      width: maxX - bbX + 30,
      height: maxY - bbY + 30,
      rx: 8,
      ry: 8,
      fill: 'none',
      stroke: COL.topStroke,
      'stroke-width': 2,
      'stroke-dasharray': '8,4',
      opacity: 0.5,
    }), rootG.firstChild);
    const label = svgEl('text', {
      x: bbX + 10,
      y: bbY - 5,
      fill: COL.topStroke,
      'font-size': 16,
      'font-weight': '600',
    });
    label.textContent = `📦 ${topModName}`;
    rootG.insertBefore(label, rootG.firstChild);
  } else {
    const render = renderModuleBox(topMod, 80, 80, {
      isTop: true,
      collapsedState,
      renderPath: parentPath,
    });
    rootG.appendChild(render.group);
  }

  return rootG;
}

function computeInitialLayout(topModName, allModules, collapsedState, existingOverrides, hideClockReset) {
  const topMod = allModules[topModName];
  if (!topMod) return {};
  const result = {};
  const layout = layoutInstances(
    topMod.instances,
    allModules,
    collapsedState,
    existingOverrides || {},
    hideClockReset,
    {
      parentModuleName: topMod.name,
      parentPath: `${topMod.name}::`,
      ancestry: [topMod.name],
      depth: 1,
    },
  );
  layout.forEach(item => {
    if (!existingOverrides?.[item.layoutKey] && !existingOverrides?.[item.instance.instance_name]) {
      result[item.layoutKey] = { x: item.baseX ?? item.x, y: item.baseY ?? item.y };
    }
  });
  return result;
}
