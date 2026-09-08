# Testing Workspace

基于 Midscene 的本地跨端测试资产管理桌面应用。界面采用浅色侧栏、白色卡片和蓝色主操作，与确认的设计方向保持一致。当前已经能在平台中创建用例、录制 Web 操作、检查步骤、生成 Workflow、运行测试和查看报告。

## 界面组件

界面已切换为 **shadcn/ui + Tailwind CSS 4**，保留浅色侧栏、白色卡片和蓝色主操作。项目列表、用例列表/详情、环境、模型设置、运行结果及录制外层使用统一的组件和主题。录制预览内部沿用 Midscene 官方组件和其 Ant Design 依赖，通过独立 iframe 隔离样式。

- 官方 shadcn 组件源码位于 `src/renderer/components/ui/`，包括 Button、Card、Input、Textarea、Label、Badge、Dialog、Alert、NativeSelect、Checkbox、Tabs 和 Separator。
- `components.json` 保存 shadcn 配置；`src/renderer/styles.css` 定义 Tailwind 主题和基础样式，布局使用 Tailwind 工具类。
- Vite 通过 `@tailwindcss/vite` 编译样式；`@/` 映射到 `src/renderer/`，`lib/utils.ts` 使用 clsx 和 tailwind-merge 合并类名。
- Dialog 和 Tabs 使用 Radix 的焦点和键盘交互。业务页面不再使用原来的自定义按钮、表单控件及弹窗样式。

已有测试定义、运行历史和模型配置保留。已经打开的应用需要重启才能加载新界面；如果正在录制，请先完成并保存录制。

## 启动

当前机器已安装依赖并完成编译，可以双击本目录的 `启动 Workspace.command`。

重新安装或修改源码后，需要 Node 22.12 及以上兼容版本、本机 Google Chrome：

```sh
npm ci
ALLOW_HEAVY=1 npm run build:desktop
npm run desktop
```

`npm ci` 会安装 Electron 桌面运行时，需要网络。当前交付的是可运行的开发版本，尚未打包签名安装程序。

## 使用流程

1. 新建项目，或打开已有 `workspace.yaml` 的项目文件夹。
2. 创建 Suite 和业务用例，填写名称、描述、优先级、标签，选择平台。
3. 在 Environments 中配置目标网站地址。
4. 在用例的 Web 区域点击「开始录制」。在 Workspace 的官方预览里点击网页输入框后直接打字或粘贴，也可以使用全选、删除、Enter、滚轮和拖动。页面上方可以打开新地址。
5. 点击「停止录制并检查」，排除误操作，按需把步骤改为 AI 描述，并添加预期结果断言。
6. 点击「预览 YAML」检查生成内容，再「保存到当前用例」。已有 Workflow 在保存前保持不变。
7. 点击「运行」，在结果页查看步骤、取消运行、打开原生 Midscene 报告。Run History 保存历次执行结果。

已有 YAML 仍可直接导入或粘贴。每个文件只有一个具名 Case，并包含非空 steps。

浏览器使用独立上下文，不会沿用用户已打开的 Chrome 登录状态。同一时间只能运行一个测试。默认运行时限为 120 秒。

## 模型配置

Model Settings 对应 Midscene 的 `MIDSCENE_MODEL_NAME`、`MIDSCENE_MODEL_BASE_URL`、`MIDSCENE_MODEL_FAMILY` 和 `MIDSCENE_MODEL_API_KEY`，不绑定服务商。API Key 使用 Electron safeStorage 系统加密后保存在本机，不返回界面明文；留空保留已保存的 Key。

应用也继承启动环境中的 Midscene 变量，支持从外部配置规划模型和识别模型等高级选项。界面中的非空配置覆盖对应环境变量，配置在每次运行或录制启动时传入子进程。

配置保存并不代表模型连接成功。本次只验证了配置保存和恢复，尚未使用真实模型运行 `aiAct` / `aiAssert`。`model.env.example` 可用于命令行运行：

```sh
node --env-file=.env dist/src/runner/cli.js --workflow examples/web.yaml --base-url https://your-test-site.example --channel chrome --headed
```

`examples/web.yaml` 是需要真实模型的聊天场景示例，不属于已经通过验证的业务用例。

## 录制与回放

网页预览原样复用官方 `PreviewRenderer`、`DeviceInteractionLayer`、`ScreenshotViewer` 和相关组件，直接使用官方 PlaygroundSDK 处理点击、连续输入、粘贴、输入法、键盘、滚轮及拖动；Web 画面使用 MJPEG 流。固定源码版本与 MIT 许可见 [官方源码来源](vendor/midscene-preview/README.md)。交互逻辑没有重写，唯一的上游类型调整用于兼容 React 19。

Workspace 负责开始/停止、步骤检查、断言、YAML 保存和运行历史。

时间线完整保留官方采集的事件字段，包括来源、输入合并信息、截图引用和语义描述。初始导航、手动导航与页面自动产生的 URL 变化都会显示；Web 导航通过 Playwright 的主页面导航监听接入官方 session 事件生成器，延迟的 History 跳转也能到达。页面自动产生的导航只作记录，回放时不会额外执行 gotoUrl。

官方元素描述和备用 recorderAI 描述按最多两条并发自动生成，使用 Model Settings。时间线显示生成中、失败和需要确认的低置信度状态，可以查看事件详情及带目标位置的截图。停止录制后可以先检查、保存，未完成的描述继续写回当前草稿和录制归档；每条描述最多等待 90 秒。退出应用或开始下一次录制会结束旧描述任务，未完成项标记失败，原始事件仍保留。截图按需读取本地文件，不依赖已经关闭的预览服务。

本次没有新增页面加载、按钮变化、回答完成等业务观察，也没有新增等待或断言类型。

停止前会等待官方输入批次和已发送操作完成，避免立即停止时漏掉最后输入。这里复用的是官方录制交互组件，没有嵌入 Studio 的整套管理页面或 AI 代码生成流程。

官方前端单独构建到 `dist-preview/`，与 Workspace 的样式和 preload 权限隔离。录制服务在独立进程运行，HTTP 仅监听本机。Electron 仅为当前应用窗口向该录制服务的请求添加随机会话 token；其他本机 HTTP 客户端不能直接控制录制。原生 Chrome 窗口中的操作不在录制范围内。

默认「按录制操作回放」固定 1280 × 800 页面尺寸，使用录制坐标和官方 Midscene actionSpace 执行动作，不请求模型；布局变化可能导致坐标失效。每步可以切换为「AI 描述执行」，填写自然语言操作描述，生成 `aiAct`。

断言可选「页面包含可见文本」或「AI 判断预期结果」。前者检查页面中精确匹配的可见文本，后者生成 `aiAssert` 并调用模型。没有断言时，Passed 仅代表操作执行完成，不能证明业务结果正确。

Workspace 生成的 `recordedAction` 和 `assertText` 是本项目为 `@midscene/test` 注册的节点；直接交给其他 Midscene CLI 执行前，需要同时接入这两个节点，或改成标准 AI 步骤。初始地址使用 `${baseUrl}`，后续手动输入的跳转地址保留录制时的完整 URL。

未保存的录制步骤和最后画面保存在本机，检查页的步骤选择及断言编辑也会自动保留，切换页面或重启后可以继续检查。退出应用会停止活动录制；异常退出后，下次启动标记为 Interrupted。录制启动时保存 Workflow 版本，外部文件有修改时拒绝覆盖。放弃草稿保留本地归档，不修改已保存 Workflow。

本次 MVP 支持 Web 单页面录制，支持拖动，不包含弹出窗口、文件上传、跨标签页、移动端录制或设备执行。录制与执行不能同时进行。录制草稿可能包含输入内容，请使用适合保存到测试资产的测试数据。

## 数据和文件

六个核心对象是 Project、Suite、TestCase、Workflow、Environment、Run。TestCase 描述业务意图，一个用例可以关联多个平台 Workflow；Midscene 负责具体步骤执行和报告。

新建项目默认位于本目录的 `projects/<projectId>/`：

```text
workspace.yaml                # 项目信息、Suite ID 和目录映射
cases/
  <suite-directory>/
    <caseId>/
      case.yaml               # 业务信息、稳定 ID、平台 Workflow 引用
      web.yaml                # Web 执行定义
      android.yaml            # Android 草稿，保存后创建
      ios.yaml                # iOS 草稿，保存后创建
environments/
  local.yaml                  # 环境 ID、名称及 web.baseUrl
```

测试定义以这些 YAML 文件为准，可以使用 Git 管理。应用目前不执行 Git 初始化、commit 或 push，也不展示分支和变更状态。用例及 Workflow 编辑包含版本冲突检查，防止旧编辑内容覆盖外部修改。外部文件修改后可点击刷新重新读取。

本机运行数据与测试定义分开，默认保存在 `.desktop-data/`：

```text
projects.json                 # 已打开的项目目录
model.json                    # 模型配置，Key 字段为加密内容
runs.db                       # SQLite 历史记录
recording-draft.json           # 当前录制草稿
recording-preview.json         # 最后一帧预览
recordings/<recordingId>/      # 录制服务产物、放弃草稿归档
  draft.json                  # 完整事件和描述，保存用例后继续保留
  screenshots/<assetId>       # 官方事件截图的本地副本
artifacts/<runId>/
  workflow.yaml               # 本次执行的 YAML 快照
  events.jsonl               # 步骤和生命周期事件
  summary.json               # 状态、耗时、输入 SHA-256、版本、报告路径
  stdout.log / stderr.log    # 子进程有输出时生成
  report/                    # Midscene 原生 HTML 报告
```

重新启动后保留项目和历史；遗留的运行中记录标记为 Interrupted。报告在独立的隔离窗口打开。纯浏览器步骤不一定生成报告，`recordToReport` 或 Agent 操作才会生成相关内容。

相对文件引用仍按原 Workflow 所在目录解析，当前快照不包含全部引用文件，不能保证单独复制快照就能重放。报告可能包含网页内容和截图，当前没有报告脱敏功能。

## 实现范围

已实现项目/Suite/用例创建、编辑和搜索、环境编辑、平台内 Web 录制、草稿检查和恢复、YAML 生成/导入/编辑、Web 执行与取消、步骤事件、SQLite 历史、原生报告窗口、模型配置和本机加密存储。

Web 保存时使用实际安装的 Midscene 节点注册表校验。Android/iOS 目前只保存文件并检查单 Case 结构，不校验平台步骤，也没有设备执行入口。Web 已接入官方录制会话和保存流程；应用不依赖录制 Markdown 转换。外部 Markdown 仍不能直接执行。

当前进程结构是 React 界面 → 隔离 preload → Electron 主进程 → 独立 Runner 子进程。实际 Electron 中的子进程执行已通过验证；尚未切换到 utilityProcess，也未验证安装包环境。

团队权限、云同步、设备池、定时任务、CI 调度、并发执行和分析看板尚未实现。Windows/Linux 桌面和异常进程清理未验证。

官方组件保留了 Android/iOS 预览相关代码，但当前 Workspace 的设备连接、录制保存及执行入口仍只接通 Web，不能据此认为移动端已经完成。

## 检查与截图

```sh
ALLOW_HEAVY=1 npm run build:desktop
node --test dist/tests/workspace.test.js
npm run test:desktop
npm run test:runner
npm run test:recording
```

桌面和 Runner 测试会启动真实 Electron/Chrome 与本地 HTTP 服务。详细证据见 [验证记录](VERIFICATION.md)。

- [事件截图和目标位置](artifacts/recording-event-screenshot.png)
- [平台内录制](artifacts/recording-live.png)
- [录制步骤检查](artifacts/recording-review.png)
- [录制回放结果](artifacts/recording-replay.png)
- [项目列表](artifacts/desktop-projects.png)
- [用例列表](artifacts/desktop-cases.png)
- [用例详情](artifacts/desktop-case.png)
- [运行结果](artifacts/desktop-run.png)

截图中的 LongbridgeAI 是本地测试创建的演示项目，成功结果来自本地页面，不代表真实业务网站的 AI 流程已经通过。
