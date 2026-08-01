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
  vm.runInContext(
    `${rendererSource}\nthis.__layoutInstances = layoutInstances; this.__layoutConstants = LAYOUT;`,
    context,
    {
    filename: rendererPath,
    },
  );
  return {
    layoutInstances: context.__layoutInstances,
    constants: context.__layoutConstants,
  };
}

function overlaps(left, right) {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function checkUnboundedInlineGeometry(layoutInstances, constants) {
  const leaf = { name: 'Leaf', ports: [], instances: [] };
  const parent = {
    name: 'Parent',
    ports: [],
    instances: [
      { instance_name: 'u_negative', module_type: 'Leaf', connections: {} },
      { instance_name: 'u_positive', module_type: 'Leaf', connections: {} },
    ],
  };
  const top = {
    name: 'Top',
    ports: [],
    instances: [
      { instance_name: 'u_blocker', module_type: 'Leaf', connections: {} },
      { instance_name: 'u_parent', module_type: 'Parent', connections: {} },
    ],
  };
  const modules = { Top: top, Parent: parent, Leaf: leaf };
  const layout = {
    'Top::u_blocker': { x: 0, y: 0 },
    'Top::u_parent': { x: 100, y: 100 },
    'Parent::u_negative': { x: -240, y: -160 },
    'Parent::u_positive': { x: 300, y: 220 },
  };
  const items = layoutInstances(top.instances, modules, {}, layout, false, {
    parentModuleName: 'Top',
    parentPath: 'Top::',
    inlineExpandedPaths: new Set(['Top::u_parent']),
    ancestry: ['Top'],
    depth: 1,
  });
  const item = items.find(entry => entry.instance.instance_name === 'u_parent');
  const geometry = item?.geometry;
  const negative = geometry?.childLayout?.find(
    child => child.instance.instance_name === 'u_negative',
  );
  if (!geometry || !negative) fail('无法构造负坐标内联布局测试');

  const left = geometry.contentX + negative.x;
  const topY = geometry.contentY + negative.y;
  const preservedX = item.x + left;
  const preservedY = item.y + topY;
  const expectedX = layout['Top::u_parent'].x
    + constants.INLINE_CONTENT_X
    + layout['Parent::u_negative'].x;
  const expectedY = layout['Top::u_parent'].y
    + constants.MODULE_HEADER_H
    + constants.INLINE_CONTENT_Y
    + layout['Parent::u_negative'].y;
  if (geometry.frameShiftX !== -240 || geometry.frameShiftY !== -160) {
    fail('展开容器没有向负坐标方向自动扩展');
  }
  if (left < constants.INLINE_CONTENT_X
      || topY < constants.MODULE_HEADER_H + constants.INLINE_CONTENT_Y) {
    fail('负坐标组件没有被重新包围到展开容器内');
  }
  if (preservedX !== expectedX || preservedY !== expectedY) {
    fail('展开容器自动扩展改变了组件的全局位置');
  }
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
  const renderer = loadRendererLayout(rendererPath);
  const { layoutInstances, constants } = renderer;
  checkUnboundedInlineGeometry(layoutInstances, constants);

  const selectedParents = parents.length > 0
    ? parents
    : Object.values(design.modules || {})
      .filter(module => (module.instances || []).length > 1)
      .map(module => module.name);
  const collisions = [];
  const containmentIssues = [];
  const inlineExpandedPaths = new Set(design.inline_expanded_paths || []);
  let nestedScopeCount = 0;

  function checkScope(parentName, items, scopeName) {
    nestedScopeCount += 1;
    const boxes = items.map(item => ({
      name: item.instance.instance_name,
      x: item.x,
      y: item.y,
      width: item.size.width,
      height: item.size.height,
      item,
    }));
    for (let leftIndex = 0; leftIndex < boxes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < boxes.length; rightIndex += 1) {
        if (overlaps(boxes[leftIndex], boxes[rightIndex])) {
          collisions.push(`${scopeName}: ${boxes[leftIndex].name} 与 ${boxes[rightIndex].name}`);
        }
      }
    }
    boxes.forEach(box => {
      const geometry = box.item.geometry;
      if (!geometry?.expanded) return;
      geometry.childLayout.forEach(child => {
        const right = geometry.contentX + child.x + child.size.width;
        const bottom = geometry.contentY + child.y + child.size.height;
        if (right > geometry.width || bottom > geometry.height
            || geometry.contentX + child.x < 0
            || geometry.contentY + child.y < 30) {
          containmentIssues.push(`${scopeName}/${box.name}: ${child.instance.instance_name} 超出展开容器`);
        }
      });
      checkScope(
        box.item.mod.name,
        geometry.childLayout,
        `${scopeName}/${box.name}`,
      );
    });
    return boxes;
  }

  for (const parentName of selectedParents) {
    const parent = design.modules?.[parentName];
    if (!parent) fail(`找不到父模块: ${parentName}`);
    const items = layoutInstances(
      parent.instances || [], design.modules || {}, {}, design.layout || {}, !showClockReset,
      {
        parentModuleName: parent.name,
        parentPath: `${parent.name}::`,
        inlineExpandedPaths,
        ancestry: [parent.name],
        depth: 1,
      },
    );
    const boxes = checkScope(parentName, items, parentName);

    console.log(`${parentName}: ${boxes.map(box => `${box.name}@${box.x},${box.y}`).join(' | ')}`);
  }

  if (collisions.length > 0) fail(collisions.join('; '));
  if (containmentIssues.length > 0) fail(containmentIssues.join('; '));
  console.log(
    `布局检查通过: ${nestedScopeCount} 个模块作用域没有重叠或内容溢出，负坐标自动包围有效`,
  );
}

main();
