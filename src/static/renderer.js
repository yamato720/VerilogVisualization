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

  const width = Math.max(LAYOUT.MODULE_MIN_WIDTH, maxNameLen * 7 + 50);
  const height = LAYOUT.MODULE_HEADER_H + maxRows * (LAYOUT.PORT_H + LAYOUT.PORT_GAP) + LAYOUT.PORT_GAP * 2 + 4;

  return { width, height, inGroups, outGroups };
}

// ─── Render a single module box ──────────────────────────────────────────

function renderModuleBox(mod, x, y, opts = {}) {
  const { isTop = false, collapsedState = {}, instName = '', widthOverride, heightOverride, hideClockReset = false } = opts;
  const info = calcModuleSize(mod, collapsedState, hideClockReset);
  const W = widthOverride || info.width;
  const H = heightOverride || info.height;
  const { inGroups, outGroups } = info;

  const g = svgEl('g', {
    class: 'module-box',
    transform: `translate(${x}, ${y})`,
    'data-module': mod.name,
    'data-instance': instName,
  });

  // Main rect
  g.appendChild(svgEl('rect', {
    class: 'module-rect', x: 0, y: 0, width: W, height: H, rx: 6, ry: 6,
    fill: isTop ? COL.topFill : COL.modFill,
    stroke: isTop ? COL.topStroke : COL.modStroke,
    'stroke-width': isTop ? 2 : 1.5,
  }));
  // Header
  g.appendChild(svgEl('rect', { x: 1, y: 1, width: W - 2, height: LAYOUT.MODULE_HEADER_H - 1, rx: 5, ry: 5, fill: COL.header }));
  g.appendChild(svgEl('rect', { x: 1, y: LAYOUT.MODULE_HEADER_H / 2, width: W - 2, height: LAYOUT.MODULE_HEADER_H / 2, fill: COL.header }));

  // Title text
  const titleStr = instName ? `${instName} : ${mod.name}` : mod.name;
  const title = svgEl('text', {
    class: 'module-title', x: W / 2, y: LAYOUT.MODULE_HEADER_H / 2 + 5,
    'text-anchor': 'middle', 'font-size': LAYOUT.TITLE_FONT, fill: COL.txt, 'font-weight': '600',
  });
  title.textContent = titleStr.length > 28 ? titleStr.slice(0, 26) + '…' : titleStr;
  g.appendChild(title);

  // Expand indicator
  if (mod.instances && mod.instances.length > 0) {
    const ei = svgEl('text', {
      class: 'expand-indicator', x: W - 8, y: LAYOUT.MODULE_HEADER_H / 2 + 4,
      'text-anchor': 'end', fill: '#58a6ff', 'font-size': 12, style: 'cursor:pointer;',
    });
    ei.textContent = '▶';
    g.appendChild(ei);
  }

  const portPositions = {};  // portName -> { x (abs), y (abs), side }
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
  const resizeHandle = svgEl('polygon', {
    class: 'resize-handle',
    points: `${W},${H - rh} ${W},${H} ${W - rh},${H}`,
    fill: COL.resizeHandle, opacity: 0.3,
    'data-instance': instName, 'data-module': mod.name,
    style: 'cursor:nwse-resize;',
  });
  g.appendChild(resizeHandle);

  // Drag handle (header area) - mark for identification
  g.querySelector('.module-rect').setAttribute('data-drag-target', 'true');

  return { group: g, portPositions, size: { width: W, height: H } };
}

// ─── Wire drawing with orthogonal routing & waypoints ──────────────────

/**
 * Build path through waypoints with orthogonal segments.
 * waypoints: array of {x, y} user-defined control points (can be empty).
 * obstacles: array of {x, y, w, h} module bounding boxes.
 */
function buildWirePath(x1, y1, x2, y2, waypoints, wireIdx, totalWires, obstacles) {
  const spread = 6;
  const offset = (wireIdx - (totalWires - 1) / 2) * spread;

  // If user has defined waypoints, route through them with orthogonal segments
  if (waypoints && waypoints.length > 0) {
    const pts = [{ x: x1, y: y1 }, ...waypoints, { x: x2, y: y2 }];
    let d = `M${pts[0].x},${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1];
      const cur = pts[i];
      // Orthogonal: go horizontal first, then vertical
      d += ` L${cur.x},${prev.y} L${cur.x},${cur.y}`;
    }
    return d;
  }

  // Auto-routing with obstacle avoidance
  const y1o = y1 + offset;
  const y2o = y2 + offset;
  const dx = x2 - x1;

  // Simple orthogonal routing (enhanced with obstacle check)
  let midX;
  if (dx > 60) {
    midX = x1 + dx * 0.4;
  } else if (dx > 0) {
    midX = x1 + dx / 2;
  } else {
    midX = Math.max(x1, x2) + 60;
  }
  midX += offset;

  if (Math.abs(y1 - y2) < 4 && dx > 0) {
    return `M${x1},${y1} L${x2},${y2}`;
  }

  if (dx < -20) {
    const loopOut = 40 + Math.abs(offset);
    // Check if the straight-up route hits an obstacle
    const routeX = x1 + loopOut;
    if (obstacles && obstacles.length > 0) {
      const rerouted = avoidObstaclesVertical(x1, y1, x2, y2, routeX, obstacles, offset);
      if (rerouted) return rerouted;
    }
    return `M${x1},${y1} L${routeX},${y1} L${routeX},${y2o} L${x2},${y2}`;
  }

  // Normal orthogonal - check for obstacles in the path
  if (obstacles && obstacles.length > 0) {
    const rerouted = avoidObstaclesSimple(x1, y1, x2, y2, midX, obstacles, offset);
    if (rerouted) return rerouted;
  }

  return `M${x1},${y1} L${midX},${y1} L${midX},${y2} L${x2},${y2}`;
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

function drawWire(x1, y1, x2, y2, isBus, signalName, wireIdx, totalWires, wireKey, waypoints, obstacles) {
  const g = svgEl('g', {
    class: 'wire-group',
    'data-signal': signalName,
    'data-wire-key': wireKey || '',
  });

  const d = buildWirePath(x1, y1, x2, y2, waypoints, wireIdx, totalWires, obstacles);

  const path = svgEl('path', {
    class: 'wire-path' + (isBus ? ' bus' : ''),
    d, fill: 'none', stroke: COL.wire,
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
    });
  }

  return g;
}

// ─── Layout instances in a grid (with position/size overrides) ───────────

function layoutInstances(instances, allModules, collapsedState, layoutOverrides, hideClockReset) {
  const items = [];
  instances.forEach(inst => {
    const mod = allModules[inst.module_type];
    if (mod) {
      const size = calcModuleSize(mod, collapsedState, hideClockReset);
      // Apply size override if present
      const ovr = layoutOverrides?.[inst.instance_name];
      if (ovr?.width) size.width = ovr.width;
      if (ovr?.height) size.height = ovr.height;
      items.push({ instance: inst, mod, size });
    }
  });
  if (items.length === 0) return [];

  const cols = Math.min(items.length, LAYOUT.COLS_MAX);
  const results = [];
  let cx = LAYOUT.MOD_PAD_X;
  let cy = LAYOUT.MOD_PAD_Y;
  let rowH = 0;
  let col = 0;

  items.forEach(item => {
    // Check for position override
    const ovr = layoutOverrides?.[item.instance.instance_name];
    if (ovr?.x !== undefined && ovr?.y !== undefined) {
      results.push({ ...item, x: ovr.x, y: ovr.y });
    } else {
      if (col >= cols) {
        col = 0;
        cx = LAYOUT.MOD_PAD_X;
        cy += rowH + LAYOUT.INST_GAP_Y;
        rowH = 0;
      }
      results.push({ ...item, x: cx, y: cy });
      cx += item.size.width + LAYOUT.INST_GAP_X + LAYOUT.PORT_STUB * 2;
      rowH = Math.max(rowH, item.size.height);
      col++;
    }
  });
  return results;
}

// ─── Render internal view of a module ────────────────────────────────────

function renderModuleInternal(parentMod, allModules, offsetX, offsetY, collapsedState, layoutOverrides, wireWaypoints, options) {
  const g = svgEl('g', { class: 'module-internal', 'data-module': parentMod.name });
  const hideClockReset = options?.hideClockReset || false;

  // Create separate layers so wires render behind module boxes
  const wireLayer = svgEl('g', { class: 'wire-layer' });
  const moduleLayer = svgEl('g', { class: 'module-layer' });
  g.appendChild(wireLayer);
  g.appendChild(moduleLayer);

  const instOverrides = layoutOverrides || {};
  const layout = layoutInstances(parentMod.instances, allModules, collapsedState, instOverrides, hideClockReset);
  const renders = {};

  // Draw each instance
  layout.forEach(item => {
    const ix = offsetX + item.x;
    const iy = offsetY + item.y;
    const ovr = instOverrides[item.instance.instance_name];
    const r = renderModuleBox(item.mod, ix, iy, {
      collapsedState,
      instName: item.instance.instance_name,
      widthOverride: ovr?.width,
      heightOverride: ovr?.height,
      hideClockReset,
    });
    moduleLayer.appendChild(r.group);
    renders[item.instance.instance_name] = {
      portPositions: r.portPositions,
      instance: item.instance,
      mod: item.mod,
      x: ix, y: iy, size: r.size,
    };
  });

  // ── Build wire-name → instance-port mapping ──
  // Each instance connection: inst.connections[portName] = wireName
  // We map wireName → { inst, port, direction, pos }
  const wireToInstPort = {};  // wireName -> [{inst, port, dir, pos, portDef}]

  layout.forEach(item => {
    const instName = item.instance.instance_name;
    const render = renders[instName];
    if (!render) return;
    const modDef = render.mod;

    for (const [portName, wireName] of Object.entries(item.instance.connections)) {
      if (!wireName || wireName.trim() === '') continue;
      const portDef = modDef.ports.find(p => p.name === portName);
      if (!portDef) continue;
      const pos = render.portPositions[portName];
      if (!pos) continue;

      const cleanWire = wireName.replace(/\s+/g, '');
      if (!wireToInstPort[cleanWire]) wireToInstPort[cleanWire] = [];
      wireToInstPort[cleanWire].push({
        inst: instName, port: portName, dir: portDef.direction,
        pos, portDef
      });
    }
  });

  // ── Helper: extract all wire name tokens from an expression ──
  // Matches identifiers that look like instance port wires (e.g., InsBuffer_inst_io_busy)
  // Filters out numeric literals, Verilog keywords, and pure constants
  function extractWireRefs(expr) {
    const verilogKeywords = new Set([
      'wire', 'reg', 'input', 'output', 'assign', 'if', 'else', 'begin', 'end',
      'and', 'or', 'not', 'xor', 'nand', 'nor', 'xnor',
    ]);
    // Match all identifier tokens (word characters)
    const tokens = expr.match(/\b[a-zA-Z_]\w*\b/g) || [];
    // Filter: keep only tokens that aren't keywords
    return [...new Set(tokens.filter(t => !verilogKeywords.has(t)))];
  }

  // ── Build intermediate wire resolution: non-instance wires that chain instance ports ──
  // e.g., wire _x = A_inst_io_out ? B_inst_io_val : 0; assign C_inst_io_in = _x;
  // We map intermediate wire name → set of instance port wire names it references
  const assigns = parentMod.assigns || [];
  const intermediateToSources = {}; // wireName -> [instPortWireName, ...]
  assigns.forEach(asgn => {
    const target = asgn.target.replace(/\s*\[.*?\]\s*$/, '').trim();
    if (!wireToInstPort[target]) {
      // Target is NOT an instance port wire → it's an intermediate
      const refs = extractWireRefs(asgn.source);
      const instRefs = refs.filter(r => wireToInstPort[r]);
      if (instRefs.length > 0) {
        if (!intermediateToSources[target]) intermediateToSources[target] = [];
        instRefs.forEach(r => {
          if (!intermediateToSources[target].includes(r)) {
            intermediateToSources[target].push(r);
          }
        });
      }
      // Also check if source refs are themselves intermediate wires (one level of chaining)
      const intermediateRefs = refs.filter(r => !wireToInstPort[r] && intermediateToSources[r]);
      intermediateRefs.forEach(ir => {
        if (!intermediateToSources[target]) intermediateToSources[target] = [];
        intermediateToSources[ir].forEach(r => {
          if (!intermediateToSources[target].includes(r)) {
            intermediateToSources[target].push(r);
          }
        });
      });
    }
  });

  // ── Use assigns to find connections ──
  // assign target = source; means source drives target
  // If both map to instance ports, draw a wire
  const allWires = [];
  const connectedPairs = new Set(); // track "out.inst.port→inp.inst.port" to avoid duplicates

  assigns.forEach(asgn => {
    const target = asgn.target.replace(/\s*\[.*?\]\s*$/, '').trim();
    const sourceExpr = asgn.source;

    // Get target ports (should be inputs being driven)
    const targetPorts = wireToInstPort[target] || [];
    const targetInputs = targetPorts.filter(p => p.dir === 'input');
    if (targetInputs.length === 0) return; // target doesn't connect to any instance input

    // Extract all wire references from the source expression
    const allRefs = extractWireRefs(sourceExpr);

    // Collect source wire names that map to instance port outputs
    const sourceWireNames = [];
    allRefs.forEach(ref => {
      if (wireToInstPort[ref]) {
        if (!sourceWireNames.includes(ref)) sourceWireNames.push(ref);
      }
      // Also resolve intermediate wires
      if (intermediateToSources[ref]) {
        intermediateToSources[ref].forEach(r => {
          if (!sourceWireNames.includes(r)) sourceWireNames.push(r);
        });
      }
    });

    // Also try the whole source as a direct wire name (strip bit-select)
    const directSource = sourceExpr.replace(/\s*\[.*?\]\s*$/, '').trim();
    if (wireToInstPort[directSource] && !sourceWireNames.includes(directSource)) {
      sourceWireNames.push(directSource);
    }
    // And resolve if directSource is an intermediate wire
    if (intermediateToSources[directSource]) {
      intermediateToSources[directSource].forEach(r => {
        if (!sourceWireNames.includes(r)) sourceWireNames.push(r);
      });
    }

    // For each source wire that maps to an output, connect to target inputs
    sourceWireNames.forEach(srcWire => {
      const sourcePorts = wireToInstPort[srcWire] || [];
      const sourceOutputs = sourcePorts.filter(p => p.dir === 'output');

      if (sourceOutputs.length > 0) {
        sourceOutputs.forEach(out => {
          targetInputs.forEach(inp => {
            const pairKey = `${out.inst}.${out.port}→${inp.inst}.${inp.port}`;
            if (!connectedPairs.has(pairKey)) {
              connectedPairs.add(pairKey);
              allWires.push({
                signal: srcWire + ' → ' + target,
                out, inp,
                isBus: (out.portDef.width > 1) || (inp.portDef.width > 1),
              });
            }
          });
        });
      }
    });
  });

  // ── Also check direct matches (same wire name on output and input) ──
  for (const [wireName, ports] of Object.entries(wireToInstPort)) {
    const outputs = ports.filter(p => p.dir === 'output');
    const inputs = ports.filter(p => p.dir === 'input');
    if (outputs.length > 0 && inputs.length > 0) {
      outputs.forEach(out => {
        inputs.forEach(inp => {
          const pairKey = `${out.inst}.${out.port}→${inp.inst}.${inp.port}`;
          if (!connectedPairs.has(pairKey)) {
            connectedPairs.add(pairKey);
            allWires.push({
              signal: wireName,
              out, inp,
              isBus: (out.portDef.width > 1) || (inp.portDef.width > 1),
            });
          }
        });
      });
    }
  }

  // ── Filter clock/reset wires if requested ──
  const clockResetPattern = /\b(clock|reset|clk|rst)\b/i;
  const filteredWires = hideClockReset
    ? allWires.filter(w => !clockResetPattern.test(w.signal) && !clockResetPattern.test(w.out.port) && !clockResetPattern.test(w.inp.port))
    : allWires;

  // ── Draw wires with obstacle avoidance ──
  // Build obstacle list from rendered module bounding boxes
  const obstacles = [];
  for (const [instName, render] of Object.entries(renders)) {
    obstacles.push({
      x: render.x,
      y: render.y,
      w: render.size.width,
      h: render.size.height,
      inst: instName,
    });
  }

  const wireCountByPair = {};
  const wireIdxByPair = {};

  filteredWires.forEach(w => {
    const pairKey = `${w.out.inst}→${w.inp.inst}`;
    wireCountByPair[pairKey] = (wireCountByPair[pairKey] || 0) + 1;
  });

  filteredWires.forEach(w => {
    const pairKey = `${w.out.inst}→${w.inp.inst}`;
    const idx = wireIdxByPair[pairKey] || 0;
    wireIdxByPair[pairKey] = idx + 1;
    const total = wireCountByPair[pairKey];

    // Wire key for identifying this wire in layout persistence
    const wireKey = `${w.out.inst}.${w.out.port}→${w.inp.inst}.${w.inp.port}`;
    const waypoints = wireWaypoints?.[wireKey] || [];

    // Filter obstacles: exclude the source and target modules
    const filteredObs = obstacles.filter(o => o.inst !== w.out.inst && o.inst !== w.inp.inst);

    const wire = drawWire(
      w.out.pos.x, w.out.pos.y,
      w.inp.pos.x, w.inp.pos.y,
      w.isBus, w.signal, idx, total,
      wireKey, waypoints, filteredObs
    );
    wireLayer.appendChild(wire);
  });

  return g;
}

// ─── Top-level design view ──────────────────────────────────────────────

function renderDesignView(topModName, allModules, expandedModules, collapsedState, layoutOverrides, wireWaypoints, options) {
  const rootG = svgEl('g', { id: 'design-root' });
  const topMod = allModules[topModName];
  if (!topMod) return rootG;

  if (expandedModules.has(topModName)) {
    const internal = renderModuleInternal(topMod, allModules, 50, 50, collapsedState, layoutOverrides, wireWaypoints, options);
    rootG.appendChild(internal);

    // Bounding box — compute from actual rendered positions (including overrides)
    const layout = layoutInstances(topMod.instances, allModules, collapsedState, layoutOverrides, options?.hideClockReset);
    let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
    layout.forEach(item => {
      const ix = item.x;
      const iy = item.y;
      minX = Math.min(minX, ix - LAYOUT.PORT_STUB);
      minY = Math.min(minY, iy);
      maxX = Math.max(maxX, ix + item.size.width + LAYOUT.PORT_STUB + LAYOUT.MOD_PAD_X);
      maxY = Math.max(maxY, iy + item.size.height + LAYOUT.MOD_PAD_Y + 30);
    });
    if (minX === Infinity) { minX = 0; minY = 0; }
    // Add margins
    const bbX = Math.min(20, minX + 40);
    const bbY = Math.min(20, minY + 40);
    maxX = Math.max(maxX, 400) + 50;
    maxY = Math.max(maxY, 200) + 50;
    const bbW = maxX - bbX + 30;
    const bbH = maxY - bbY + 30;

    // Dashed outline
    rootG.insertBefore(svgEl('rect', {
      x: bbX, y: bbY, width: bbW, height: bbH, rx: 8, ry: 8,
      fill: 'none', stroke: COL.topStroke, 'stroke-width': 2,
      'stroke-dasharray': '8,4', opacity: 0.5,
    }), rootG.firstChild);

    const label = svgEl('text', {
      x: bbX + 10, y: bbY - 5, fill: COL.topStroke, 'font-size': 16, 'font-weight': '600',
    });
    label.textContent = `📦 ${topModName}`;
    rootG.insertBefore(label, rootG.firstChild);

  } else {
    // Collapsed top-level view
    const r = renderModuleBox(topMod, 80, 80, { isTop: true, collapsedState });
    rootG.appendChild(r.group);
  }

  return rootG;
}
