#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function fail(message) {
  console.error(`布线检查失败: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const parents = [];
  let designPath = null;
  let showClockReset = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--parent') {
      const value = argv[++index];
      if (!value) fail('--parent 需要模块名');
      parents.push(...value.split(',').filter(Boolean));
    } else if (arg === '--show-clock-reset') {
      showClockReset = true;
    } else if (!designPath) {
      designPath = arg;
    } else {
      fail(`不支持的参数: ${arg}`);
    }
  }
  if (!designPath) fail('用法: check-routing.js <design.json> [--parent <模块名>] [--show-clock-reset]');
  return { designPath, parents, showClockReset };
}

class FakeSvgElement {
  constructor(tag) {
    this.tag = tag;
    this.attrs = {};
    this.children = [];
    this.style = {};
    this.textContent = '';
  }

  setAttribute(key, value) { this.attrs[key] = String(value); }
  getAttribute(key) { return this.attrs[key] ?? null; }
  appendChild(child) { this.children.push(child); return child; }

  insertBefore(child, reference) {
    const index = this.children.indexOf(reference);
    this.children.splice(index < 0 ? this.children.length : index, 0, child);
    return child;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

  querySelectorAll(selector) {
    const matches = [];
    const className = selector.startsWith('.') ? selector.slice(1) : null;
    const visit = element => {
      if (className && (element.attrs.class || '').split(/\s+/).includes(className)) matches.push(element);
      element.children.forEach(visit);
    };
    visit(this);
    return matches;
  }
}

function loadRenderer(rendererPath) {
  const source = fs.readFileSync(rendererPath, 'utf8');
  const context = {
    document: { createElementNS: (_namespace, tag) => new FakeSvgElement(tag) },
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.__renderModuleInternal = renderModuleInternal; this.__layoutInstances = layoutInstances; this.__wireMargin = LAYOUT.WIRE_MARGIN;`, context, {
    filename: rendererPath,
  });
  return {
    renderModuleInternal: context.__renderModuleInternal,
    layoutInstances: context.__layoutInstances,
    wireMargin: context.__wireMargin,
  };
}

function parsePath(pathData) {
  return [...pathData.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map(match => ({
    x: Number(match[1]), y: Number(match[2]),
  }));
}

function nonZeroSegments(points) {
  return points.slice(1).map((point, index) => [points[index], point])
    .filter(([from, to]) => from.x !== to.x || from.y !== to.y);
}

function intersectsBox(from, to, box, margin) {
  const left = box.x - margin;
  const right = box.x + box.width + margin;
  const top = box.y - margin;
  const bottom = box.y + box.height + margin;
  if (from.x === to.x) {
    return from.x > left && from.x < right
      && Math.max(from.y, to.y) > top && Math.min(from.y, to.y) < bottom;
  }
  if (from.y === to.y) {
    return from.y > top && from.y < bottom
      && Math.max(from.x, to.x) > left && Math.min(from.x, to.x) < right;
  }
  return true;
}

function main() {
  const { designPath, parents, showClockReset } = parseArgs(process.argv.slice(2));
  const absoluteDesignPath = path.resolve(designPath);
  let design;
  try {
    design = JSON.parse(fs.readFileSync(absoluteDesignPath, 'utf8'));
  } catch (error) {
    fail(`无法读取 ${absoluteDesignPath}: ${error.message}`);
  }

  const visualizerRoot = path.resolve(__dirname, '..', '..', '..', '..');
  const rendererPath = path.join(visualizerRoot, 'src', 'static', 'renderer.js');
  const { renderModuleInternal, layoutInstances, wireMargin } = loadRenderer(rendererPath);
  const selectedParents = parents.length > 0
    ? parents
    : Object.values(design.modules || {})
      .filter(module => (module.instances || []).length > 1)
      .map(module => module.name);
  const issues = [];

  selectedParents.forEach(parentName => {
    const parent = design.modules?.[parentName];
    if (!parent) fail(`找不到父模块: ${parentName}`);
    const root = renderModuleInternal(
      parent, design.modules, 50, 50, {}, design.layout || {}, design.wire_waypoints || {},
      { hideClockReset: !showClockReset, customizations: { modules: {}, wires: {} } },
    );
    const wireLayer = root.children.find(child => child.attrs.class === 'wire-layer');
    const boxes = layoutInstances(parent.instances || [], design.modules || {}, {}, design.layout || {}, !showClockReset)
      .map(item => ({
        name: item.instance.instance_name,
        x: item.x + 50,
        y: item.y + 50,
        width: item.size.width,
        height: item.size.height,
      }));
    const wires = wireLayer?.children || [];
    let localIssues = 0;

    wires.forEach(wire => {
      const wireKey = wire.attrs['data-wire-key'] || '(未命名线路)';
      const pathElement = wire.children.find(child => child.tag === 'path');
      const segments = nonZeroSegments(parsePath(pathElement?.attrs.d || ''));
      if (segments.length === 0) {
        issues.push(`${parentName}: ${wireKey} 没有可见路径`);
        localIssues += 1;
        return;
      }
      const first = segments[0];
      const last = segments[segments.length - 1];
      if (first[0].y !== first[1].y || first[1].x <= first[0].x) {
        issues.push(`${parentName}: ${wireKey} 未从右侧输出端水平引出`);
        localIssues += 1;
      }
      if (last[0].y !== last[1].y || last[1].x <= last[0].x) {
        issues.push(`${parentName}: ${wireKey} 未从左侧水平进入输入端`);
        localIssues += 1;
      }
      segments.forEach(([from, to]) => {
        if (from.x !== to.x && from.y !== to.y) {
          issues.push(`${parentName}: ${wireKey} 存在非正交线段`);
          localIssues += 1;
        }
        boxes.forEach(box => {
          if (intersectsBox(from, to, box, wireMargin)) {
            issues.push(`${parentName}: ${wireKey} 穿过 ${box.name}`);
            localIssues += 1;
          }
        });
      });
    });
    console.log(`${parentName}: ${wires.length} 条线路，${localIssues} 个布线问题`);
  });

  if (issues.length > 0) fail(issues.join('; '));
  console.log(`布线检查通过: ${selectedParents.length} 个模块视图的方向与避障均有效`);
}

main();
