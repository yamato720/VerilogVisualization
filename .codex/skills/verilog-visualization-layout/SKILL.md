---
name: verilog-visualization-layout
description: 维护 `npc/VerilogVisualization` 的 RTL 发现、已保存设计 JSON、数据流可视化布局、刷新保留状态和同步控制。处理 Verilog/SystemVerilog 分析结果、`data/VerilogVisualization/*.json`、模块位置冲突、手工 JSON 布局被浏览器缓存覆盖，或需要按硬件数据流重排可视化设计图时使用。
---

# Verilog 可视化布局

在工作区根目录操作；可视化项目根目录为 `npc/VerilogVisualization/`。

## 定位

先读取以下文件，再改变布局或持久化行为：

1. `src/app.py`：分析、刷新、保存状态 API。
2. `src/verilog_parser.py`：RTL 解析和刷新时的 JSON 状态保留。
3. `src/static/app.js`：浏览器状态、同步开关、手动保存和视图恢复。
4. `src/static/renderer.js`：`layoutInstances`、`calcModuleSize` 和实际坐标语义。
5. 目标 `data/VerilogVisualization/<design>.json`：`source_path`、`modules`、`layout` 和持久化 UI 状态。

不要根据 Config 名称、FPGA 类型或目录命名猜测 RTL；始终从保存设计 JSON 的 `source_path` 和实际模块连接出发。

## 参考设计

- 版本库可提交 `data/VerilogVisualization/CPU.json` 作为 CPU 布局示例；`.gitignore` 只放行这一份 JSON，其他分析结果仍保持本地生成数据。
- 本技能始终以用户指定的目标设计或当前打开的设计为准。除非任务明确指向 `CPU.json`，或它已经是当前目标，否则不要主动查找、检查、恢复或读取它。
- 参考示例缺失不影响技能使用；继续基于当前目标 JSON、其 `source_path` 与实际 RTL 连接完成分析和布局。

## 持久化规则

- JSON 是已保存设计的权威状态。打开设计时，已有的 `layout`、`wire_waypoints`、`customizations` 和 `view_state` 必须覆盖旧 `localStorage`。
- `layout_metrics` 是由当前 RTL、`layout` 与 `inline_expanded_paths` 计算出的只读布局摘要，不是坐标的权威来源。仅当其 `generated_for_layout_revision` 与 `geometry_signature` 可验证时使用；坐标、展开状态或 RTL 改变后必须重新生成。
- `server_sync_enabled` 是每个设计的 JSON 字段；字段缺失时默认 `true`。开启实时同步先提交当前内存状态，再同步后续编辑；关闭实时同步必须取消已排队请求，并只提交该开关字段，不能连同过期坐标一起写回。
- 手动保存应强制提交当前设计状态；打开设计本身和刷新后的重新打开不得自动写回状态。
- 最近激活的设计名保存在浏览器 `localStorage` 的 `vviz_last_design`；启动拉取设计列表后，仅在设计仍存在时自动恢复，设计的重命名、删除和标签切换必须同步更新该指针；该指针不写入设计 JSON。
- `/api/refresh` 和 `/api/reload` 重解析 `source_path` 后，必须保留 `layout`、`wire_waypoints`、`timeline_dividers`、`view_state`、`customizations`、`tree_expanded`、`sidebar_ui`、`canvas_controls` 与 `server_sync_enabled`。
- 不存在 JSON `view_state` 时，只在本次打开后自动适配画布一次；不得重新采用旧浏览器视图。

## 数据流布局

1. 读取目标父模块的 `instances` 与 `connections`，找出寄存器级主路径、状态存储、并行执行单元、响应寄存器、存储支路和旁路控制。
2. 将主请求路径由左到右放置。流水寄存器位于阶段边界，响应寄存器放在它所服务的长时延执行路径上，不能伪装成主串行阶段。
3. 将同一输入阶段分发的执行单元置于同一纵向列，例如整数 ALU、乘除 ALU 与 CSR 执行单元。将汇合寄存器放在这些并行路径右侧。
4. 将寄存器堆、CSR 文件等状态源放在左侧；将写回反馈、转发和冒险控制置于主路径下方或边缘，避免挤占主数据通路。
5. 为长时延或宽端口模块留出足够间距。不要仅把所有实例排成均匀网格，也不要按文件名或字母顺序布局。
6. 对前端、内存 Fabric、乘除子模块等下钻视图重复相同原则。实例名是跨视图复用的布局键，只需避免同一父模块视图内的碰撞。
7. `timeline_dividers` 是当前父模块局部坐标系中的纵向时序分割线；它们应穿过相应流水寄存器，并位于模块层下方，以便阶段边界不遮挡模块内容。

## 重布线与手工拐点

1. 修改位置或 `wire_waypoints` 前，先用实际渲染器重建目标父模块的 SVG 路径；不得只根据 JSON 中的实例坐标判断线路是否清晰。
2. 输出端口在右侧：第一段必须水平向右离开输出端。输入端口在左侧：最后一段必须从左向右水平进入输入端。不得让反馈线从输入的右侧、上方或下方贴入端口。
3. 所有正交线段必须避开模块矩形及 `LAYOUT.WIRE_MARGIN` 安全边界，源和目标模块也不例外；唯一允许接近模块的是端口外的短水平引线。
4. 优先移动模块为主数据通路和反馈通道腾出空间。左向反馈、写回和旁路放在主通路下方或外侧的独立通道；不要用大量交叉的短拐点穿过模块阵列。
5. `wire_waypoints` 是有意的路径锚点，不是绕过自动路由缺陷的堆栈。每个锚点必须在空白通道中；保留尽量少的锚点，并按源到目标顺序保存。
6. 折叠端口组时，渲染器会把同一源/目的端口组的细粒度依赖汇总为总线。先在折叠视图优化全局路径；只有在展开端口组排查信号时才接受细粒度扇出。

## 校验

修改 JSON 后运行：

```bash
node npc/VerilogVisualization/.codex/skills/verilog-visualization-layout/scripts/check-layout.js \
  npc/VerilogVisualization/data/VerilogVisualization/<design>.json
```

使用 `--parent NpcBackend --parent NpcMemoryFabric` 只检查指定模块。脚本复用当前渲染器的尺寸与自动布局规则，非零退出表示同一模块视图存在重叠。

重布线后还必须运行：

```bash
node npc/VerilogVisualization/.codex/skills/verilog-visualization-layout/scripts/check-routing.js \
  npc/VerilogVisualization/data/VerilogVisualization/<design>.json \
  --parent NpcBackend
```

该脚本用当前 `renderer.js` 重建线路，检查输出/输入进入方向、非正交线段与压到模块上的路径。任一检查失败时，先调整模块位置或手工拐点，不能只靠视觉猜测。

需要将当前可见层级的实际边界、展开尺寸和实例几何写入 JSON 时，运行：

```bash
node npc/VerilogVisualization/.codex/skills/verilog-visualization-layout/scripts/update-layout-metrics.js \
  npc/VerilogVisualization/data/VerilogVisualization/<design>.json
```

提交前以 `--check` 确认摘要没有过期。该摘要用于布局判断和审阅，渲染器仍以实际模块、`layout` 和展开状态为准。

再执行 JSON 解析、`node --check src/static/app.js`，并通过运行中的 `/api/design/<design>` 确认服务返回的坐标与磁盘 JSON 相同。修改前端后，以项目虚拟环境启动服务：

```bash
npc/VerilogVisualization/.venv/bin/python npc/VerilogVisualization/src/app.py
```
