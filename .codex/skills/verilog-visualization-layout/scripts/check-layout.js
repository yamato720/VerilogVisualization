#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function fail(message) {
  console.error(`布局检查失败: ${message}`);
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

  if (!designPath) {
    fail('用法: check-layout.js <design.json> [--parent <模块名>] [--show-clock-reset]');
  }
  return { designPath, parents, showClockReset };
}

function loadRendererLayout(rendererPath) {
  const rendererSource = fs.readFileSync(rendererPath, 'utf8');
  const context = {
    document: {
      createElementNS() {
        throw new Error('布局检查不应创建 SVG 元素');
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(`${rendererSource}\nthis.__layoutInstances = layoutInstances;`, context, {
    filename: rendererPath,
  });
  return context.__layoutInstances;
}

function overlaps(left, right) {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
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
  if (!fs.existsSync(rendererPath)) fail(`找不到渲染器: ${rendererPath}`);
  const layoutInstances = loadRendererLayout(rendererPath);

  const selectedParents = parents.length > 0
    ? parents
    : Object.values(design.modules || {})
      .filter(module => (module.instances || []).length > 1)
      .map(module => module.name);
  const collisions = [];

  for (const parentName of selectedParents) {
    const parent = design.modules?.[parentName];
    if (!parent) fail(`找不到父模块: ${parentName}`);
    const items = layoutInstances(
      parent.instances || [], design.modules || {}, {}, design.layout || {}, !showClockReset,
    );
    const boxes = items.map(item => ({
      name: item.instance.instance_name,
      x: item.x,
      y: item.y,
      width: item.size.width,
      height: item.size.height,
    }));

    console.log(`${parentName}: ${boxes.map(box => `${box.name}@${box.x},${box.y}`).join(' | ')}`);
    for (let leftIndex = 0; leftIndex < boxes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < boxes.length; rightIndex += 1) {
        if (overlaps(boxes[leftIndex], boxes[rightIndex])) {
          collisions.push(`${parentName}: ${boxes[leftIndex].name} 与 ${boxes[rightIndex].name}`);
        }
      }
    }
  }

  if (collisions.length > 0) fail(collisions.join('; '));
  console.log(`布局检查通过: ${selectedParents.length} 个模块视图没有重叠`);
}

main();
