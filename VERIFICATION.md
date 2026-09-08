# 验证记录

日期：2026-09-07。环境：macOS、Node 22.21.1、Electron 44.2.0、本机 Google Chrome。使用实际安装的 Midscene 1.12.4。

## 已验证

桌面构建通过，包含主进程和 React 的 TypeScript 检查。录制 MVP 阶段的全量检查 18 项全部通过：5 项存储测试、1 条原有桌面流程、8 项执行器测试，以及新增的 3 项录制转换/回放测试和 1 条完整录制桌面流程。

### 官方录制交互接入

2026-09-07：官方预览独立构建和类型检查通过。构建仍提示部分未使用的 Node 模块被浏览器构建排除，以及预览包较大；已验证的远程交互路径不依赖这些 Node 模块。3 项录制转换/回放检查、1 条真实 Electron 录制流程和 1 条桌面资产/报告流程通过，共 5 项。本次新增真实交互验证：

- 在官方预览中直接输入英文，使用全选和退格清除后重新输入。
- 向官方输入组件派发中文 paste 和 composition 事件，确认实际目标网页收到正确中文；测试未改动系统剪贴板或输入法。
- 通过真实鼠标滚轮滚动，通过拖动改变网页滑块值；这些事件被采集并生成 YAML。
- 停止后保存可见文本断言，回放再次提交相同中英文消息，并通过滑块结果断言。
- 输入后立即停止，最后一段文字仍保留在录制草稿中。
- 活动录制中的步骤列表能显示拖动事件；草稿重启恢复、冲突拒绝和历史保留通过。
- 未带会话凭据的其他本机 HTTP 客户端访问录制服务返回 403。

已视觉检查官方预览和回放结果。首次验证暴露 SDK 缺少 Buffer polyfill，补齐与官方相同用途的浏览器构建依赖后，同一流程通过。

中文 composition/paste 事件处理已经验证，系统输入法候选窗的人工操作及真实剪贴板快捷键尚未单独验证。Android/iOS 设备连接没有在本次接入；官方代码包含这些预览能力不代表本产品已完成移动端录制。

源码来源、唯一的 React 19 类型调整和许可证见 `vendor/midscene-preview/README.md`。外层仍为 shadcn + Tailwind；预览的官方组件保留其 Ant Design 依赖。

### shadcn/ui + Tailwind 迁移

本次迁移后重新通过桌面构建、主进程/界面类型检查，以及两条真实 Electron 端到端流程：桌面资产管理流程和录制 → 检查 → 保存 → 回放流程。测试使用独立的数据目录，不修改用户项目或运行历史。此前的 18 项完整验证属于录制 MVP 阶段，本次没有重跑未修改的存储及执行器单元测试。

本次新增检查覆盖：

- Escape 关闭新建项目弹窗后不创建项目，Tab 焦点保持在弹窗内。
- 使用 Enter 提交 Suite 表单，Web/Android 复选框正常保存平台选择。
- 点击结果页的运行事件标签可以查看日志，方向键可以切换回执行步骤。
- 980 × 680 窗口中的项目列表没有页面横向溢出。
- 录制预览的坐标映射、文本输入、清空、滚动、提交、断言、草稿恢复和历史恢复全部通过原有真实交互检查。

检查命令：`ALLOW_HEAVY=1 npm run build:desktop`、`node --test --test-concurrency=1 dist/tests/desktop.test.js dist/tests/recording.test.js`。截图已更新为 shadcn 界面，保留浅色和蓝色主操作的设计方向。

### 桌面交互

真实启动 Electron，通过页面完成：

- 创建项目、Chat Suite，以及包含 Web/Android 的业务用例。
- 编辑描述、P0 优先级和标签，修改环境地址。
- 保存 Android 草稿，确认没有移动端运行按钮。
- 从本地文件导入 Web YAML；无效 Web 步骤保存时被拒绝。
- 运行真实 Chrome，展示 Passed、步骤事件和耗时。
- 在独立窗口打开原生 Midscene 报告，点击 Screenshot 和 JSON View。
- 执行过程中拒绝第二个运行请求，取消后显示 Cancelled。
- 按标签搜索、显示无匹配结果。
- 重启后恢复项目、用例和成功/取消两次历史记录。
- 保存模型字段与测试字符串 Key，检查磁盘中没有明文 Key；界面不会回显 Key，留空保存保留原有密文，重启恢复配置。

测试只替代了操作系统文件选择对话框的返回路径，文件读取、YAML 校验、执行器、浏览器和报告均为真实实现。测试没有调用外部模型。页面未记录 JavaScript 异常。

移动端保存问题先通过真实界面复现：主进程不区分平台，使用 Web 注册表拒绝 `launch` 草稿步骤。调整平台分支后同一流程通过；Web 无效步骤仍被拒绝。移动端草稿通过保存不代表步骤语义正确或可执行。

实际界面截图已进行视觉检查，侧栏、项目卡片、用例详情和结果页符合确认的浅色设计方向。新增启动文件已执行，并通过系统窗口内容确认打开了 Testing Workspace 的空项目首页。

### 平台内录制 MVP

真实 Electron 页面完成创建项目/用例和环境设置 → 开始录制 → 打开新地址 → 滚动 → 点击输入框 → 输入文字 → 清空输入框 → 再次输入 → 点击提交 → 停止录制 → 添加可见文本断言 → 预览 YAML → 保存到用例 → 运行 → Passed。录制和回放分别向本地服务器提交同一条消息，服务器实际收到了两次请求。

本次没有替代录制服务、浏览器、截图、事件采集或回放结果。采集使用官方 Midscene Playground HTTP 接口；回放使用官方 actionSpace 动作。生成步骤固定 1280 × 800 视口，不调用模型。

同时验证：

- 运行接口拒绝与活动录制并发执行。
- 重新启动后恢复停止的录制草稿、最后画面、AI 步骤描述和断言编辑。
- 原 Workflow 在录制期间被外部修改后，保存被拒绝，外部内容不被覆盖。
- 放弃草稿后保留原 Workflow 和运行历史。
- 未支持的事件和错误尺寸不能生成貌似可运行的 YAML。
- 合并后的输入、Enter、点击和滚动能真实回放。
- 可见文本断言成功；同名隐藏文本无法使断言成功，失败仍生成原生报告。
- 清空输入框最初缺少回放坐标，已通过真实录制复现保存拒绝；补齐点击目标坐标后，相同流程保存和回放均通过。

检查命令：`ALLOW_HEAVY=1 node --test --test-concurrency=1 dist/tests/*.test.js`，18 项通过，总耗时约 38 秒。桌面构建和主进程/React 类型检查也已通过。

### 数据存储

5 项测试覆盖项目/Suite/用例/环境恢复、旧用例编辑不覆盖外部修改、Workflow ID 和版本冲突、目录越界拒绝、SQLite 将遗留 Running 记录恢复为 Interrupted。

### 执行器

8 项测试覆盖正常执行和报告落盘、导航失败及 afterEach、运行中取消、无效步骤拒绝、多 Case 拒绝、启动时取消、子进程异常退出、运行超时。异常清理检查实际浏览器 PID 已退出。

## 证据文件

- [平台内录制](artifacts/recording-live.png)
- [录制步骤检查](artifacts/recording-review.png)
- [录制回放结果](artifacts/recording-replay.png)
- [录制回放摘要](artifacts/recording-ui-WBouOZ/app/artifacts/6db17c40-e06d-414c-b485-b31fcf68df40/summary.json)
- [录制回放原生报告](artifacts/recording-ui-WBouOZ/app/artifacts/6db17c40-e06d-414c-b485-b31fcf68df40/report/36722273-92a8-4bdc-ac6a-5bea1cf86253.html)

- [小窗口项目列表](artifacts/desktop-compact.png)
- [项目列表](artifacts/desktop-projects.png)
- [用例列表](artifacts/desktop-cases.png)
- [用例详情](artifacts/desktop-case.png)
- [运行结果](artifacts/desktop-run.png)
- [桌面成功运行摘要](artifacts/desktop-ZStEUM/app/artifacts/a7548ffa-5d04-4e82-b240-9accc45a1513/summary.json)
- [桌面成功运行报告](artifacts/desktop-ZStEUM/app/artifacts/a7548ffa-5d04-4e82-b240-9accc45a1513/report/d83923ee-0d24-4826-9d15-74eae47147da.html)
- [桌面取消运行摘要](artifacts/desktop-ZStEUM/app/artifacts/55d7417a-5638-4627-b9c9-ea8b982287cd/summary.json)

## 未验证及限制

- 没有真实模型配置，因此没有运行 aiAct / aiAssert，也没有验证服务商连通性。
- 截图中的 LongbridgeAI 是本地演示项目，结果来自本地 HTTP 页面，不代表实际业务网站通过测试。
- Android/iOS 只验证了资产保存逻辑，没有设备执行；iOS 尚未进行单独桌面交互检查。
- 未验证 Windows/Linux、签名安装包、utilityProcess、云端或 CI。Web 单页面录制与拖动已实现，弹窗、文件上传和跨标签页未接入。
- 录制进程异常恢复有实现，但本次录制桌面测试验证的是正常停止后的重启恢复；强制退出中的录制恢复未单独测试。
- AI 模式的 YAML 转换和保存经过测试，但没有调用真实模型，不能把无模型回放成功等同于 AI 操作通过。
- 原生报告显示 unknown version，运行摘要另外记录明确的 Runner 版本；没有修改第三方报告。

检查命令见 README。项目没有 commit、push 或发布。


## 2026-09-08 官方事件与描述补齐

`npm run test:recording` 共 10 项通过，约 43 秒。桌面构建（含主进程、React 和官方预览类型检查）通过；构建保留官方预览依赖的 browser externalization 和 chunk 大小提示。

已验证：

- 真实 Electron/Chrome 中的官方预览点击、输入、按键、滚动、拖动，停止、保存 YAML、真实回放。
- 初始导航保留；点击后延迟 1.2 秒产生的 history.pushState 在没有后续交互时到达时间线，且只有一条对应记录；生成 YAML 不重复跳转。
- 官方事件字段和合并输入元信息保留；重复 hash 更新不重复展示；后台描述不被原始事件轮询覆盖，过期描述不能覆盖新输入。
- 每条事件截图可以在停止后打开，显示目标位置；重启后能读回完全一致的图片。
- 主进程从配置启动真实录制 worker，官方 aiDescribe 实际发送带目标标记截图的 OpenAI-compatible 请求，结果在停止并保存后写回归档；官方 recorderAI 备用描述成功和全失败路径均通过。
- 描述并发上限为 2；未配置模型、模型失败、描述超时、截图保存失败保留原始记录；退出后未完成描述不再永久显示 pending。
- 本地截图接口拒绝过期录制 ID 和任意文件请求。

模型接口验证只在 HTTP 服务边界提供本地固定响应，没有替换官方事件采集、图像处理、请求生成、解析或语义转换代码。此结果证明集成链路可用，不代表真实模型的识别质量或外部服务商连通性已经验证。测试未修改真实业务项目数据。

新证据：[事件截图](artifacts/recording-event-screenshot.png)、[时间线](artifacts/recording-live.png)、[录制检查](artifacts/recording-review.png)。本轮未新增业务等待、按钮/加载状态观察或断言能力。

复查发现原滑块测试依赖浏览器默认控件样式，预设拖动起点偏离滑块中心，曾出现一次回放失败。测试页面已显式固定原生 range 的滑块和轨道尺寸，使录制与回放都从滑块中心开始；没有修改应用的录制或回放实现。

固定滑块尺寸后，完整桌面录制、截图检查、保存回放和重启恢复测试再次通过，耗时约 22 秒。截图弹窗在动画结束后重新截图并进行了视觉检查。
