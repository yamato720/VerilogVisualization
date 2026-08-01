#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(args) {
  let designPath = '';
  let checkOnly = false;
  args.forEach(arg => {
    if (arg === '--check') checkOnly = true;
    else if (!designPath) designPath = arg;
    else fail(`不支持的参数: ${arg}`);
  });
  if (!designPath) fail('用法: update-layout-metrics.js <design.json> [--check]');
  return { designPath, checkOnly };
}

function loadLayoutInstances(rendererPath) {
  const source = fs.readFileSync(rendererPath, 'utf8');
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.__layoutInstances = layoutInstances;`, context, {
    filename: rendererPath,
  });
  return context.__layoutInstances;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableValue(value[key]);
    return result;
  }, {});
}

function signature(value) {
  const text = JSON.stringify(stableValue(value));
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

function summarizeBounds(items) {
  if (items.length === 0) {
    return { min_x: 0, min_y: 0, max_x: 0, max_y: 0, width: 0, height: 0 };
  }
  const minX = Math.min(...items.map(item => item.x));
  const minY = Math.min(...items.map(item => item.y));
  const maxX = Math.max(...items.map(item => item.x + item.size.width));
  const maxY = Math.max(...items.map(item => item.y + item.size.height));
  return {
    min_x: minX,
    min_y: minY,
    max_x: maxX,
    max_y: maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function collectScope(scopes, moduleName, renderPath, items) {
  scopes[renderPath] = {
    module: moduleName,
    bounds: summarizeBounds(items),
    instance_count: items.length,
    expanded_instance_count: items.filter(item => item.geometry.expanded).length,
    instances: items.map(item => ({
      instance: item.instance.instance_name,
      module: item.mod.name,
      layout_key: item.layoutKey,
      x: item.x,
      y: item.y,
      width: item.size.width,
      height: item.size.height,
      expanded: item.geometry.expanded,
    })),
  };
  items.filter(item => item.geometry.expanded).forEach(item => {
    collectScope(scopes, item.mod.name, item.renderPath, item.geometry.childLayout);
  });
}

function buildMetrics(design, layoutInstances) {
  const topModules = Array.isArray(design.top_modules) && design.top_modules.length > 0
    ? design.top_modules
    : Object.keys(design.modules || {});
  const expandedPaths = new Set(design.inline_expanded_paths || []);
  const scopes = {};
  topModules.forEach(topModule => {
    const module = design.modules?.[topModule];
    if (!module) return;
    const renderPath = `${topModule}::`;
    const items = layoutInstances(
      module.instances,
      design.modules,
      {},
      design.layout || {},
      true,
      {
        parentModuleName: topModule,
        parentPath: renderPath,
        inlineExpandedPaths: expandedPaths,
        ancestry: [topModule],
        depth: 1,
      },
    );
    collectScope(scopes, topModule, renderPath, items);
  });
  const geometryInput = {
    top_modules: topModules,
    modules: design.modules || {},
    layout: design.layout || {},
    inline_expanded_paths: [...expandedPaths].sort(),
    hide_clock_reset: true,
  };
  return {
    schema_version: 1,
    generated_for_layout_revision: Number(design.layout_revision) || 0,
    geometry_signature: signature(geometryInput),
    scopes,
  };
}

function main() {
  const { designPath, checkOnly } = parseArgs(process.argv.slice(2));
  const absoluteDesignPath = path.resolve(designPath);
  let design;
  try {
    design = JSON.parse(fs.readFileSync(absoluteDesignPath, 'utf8'));
  } catch (error) {
    fail(`无法读取 ${absoluteDesignPath}: ${error.message}`);
  }
  const visualizerRoot = path.resolve(__dirname, '..', '..', '..', '..');
  const layoutInstances = loadLayoutInstances(path.join(visualizerRoot, 'src', 'static', 'renderer.js'));
  const metrics = buildMetrics(design, layoutInstances);
  if (checkOnly) {
    if (JSON.stringify(stableValue(design.layout_metrics || {})) !== JSON.stringify(stableValue(metrics))) {
      fail('layout_metrics 已过期，请运行 update-layout-metrics.js 重新生成');
    }
    console.log(`layout_metrics 检查通过: ${Object.keys(metrics.scopes).length} 个可见层级`);
    return;
  }
  design.layout_metrics = metrics;
  fs.writeFileSync(absoluteDesignPath, `${JSON.stringify(design, null, 2)}\n`);
  console.log(`已更新 layout_metrics: ${Object.keys(metrics.scopes).length} 个可见层级`);
}

main();
