# Testo

基于 Midscene 的本地跨端测试资产管理桌面应用。界面采用浅色侧栏、白色卡片和蓝色主操作，与确认的设计方向保持一致。当前已经能在平台中创建用例、录制 Web 操作、检查步骤、生成 Workflow、运行测试和查看报告。

## 界面组件

界面已切换为 **shadcn/ui + Tailwind CSS 4**，保留浅色侧栏、白色卡片和蓝色主操作。项目列表、用例列表/详情、环境、模型设置、运行结果及录制外层使用统一的组件和主题。录制预览内部沿用 Midscene 官方组件和其 Ant Design 依赖，通过独立 iframe 隔离样式。

- 官方 shadcn 组件源码位于 `src/renderer/components/ui/`，包括 Button、Card、Input、Textarea、Label、Badge、Dialog、Alert、NativeSelect、Checkbox、Tabs 和 Separator。
- `components.json` 保存 shadcn 配置；`src/renderer/styles.css` 定义 Tailwind 主题和基础样式，布局使用 Tailwind 工具类。
- Vite 通过 `@tailwindcss/vite` 编译样式；`@/` 映射到 `src/renderer/`，`lib/utils.ts` 使用 clsx 和 tailwind-merge 合并类名。
- Dialog 和 Tabs 使用 Radix 的焦点和键盘交互。业务页面不再使用原来的自定义按钮、表单控件及弹窗样式。

已有测试定义、运行历史和模型配置保留。已经打开的应用需要重启才能加载新界面；如果正在录制，请先完成并保存录制。

## 启动

当前机器已安装依赖并完成编译，可以双击本目录的 `启动 Testo.command`。

重新安装或修改源码后，需要 Node 22.12 及以上兼容版本、本机 Google Chrome：

```sh
npm ci
ALLOW_HEAVY=1 npm run build:desktop
npm run desktop
```

`npm ci` 会安装 Electron 桌面运行时，需要网络。已支持构建 macOS DMG、ZIP 和 Chrome 连接扩展包；本地测试包没有 Developer ID 签名与 Apple 公证，正式分发步骤见 [发布与安装](RELEASE.md)。

## 使用流程

1. 新建项目，或打开已有 `workspace.yaml` 的项目文件夹。
2. 创建 Suite 和业务用例，填写名称、描述、优先级、标签，选择平台。
3. 在 Environments 中配置目标网站地址。
4. 在用例的 Web 区域点击「开始录制」。在 Workspace 的官方预览里点击网页输入框后直接打字或粘贴，也可以使用全选、删除、Enter、滚轮和拖动。页面上方可以打开新地址。
5. 点击「停止录制并检查」，排除误操作，按需把步骤改为 AI 描述，并在需要的位置插入等待条件或预期结果断言。
6. 点击「预览 YAML」检查生成内容，再「保存到当前用例」。已有 Workflow 在保存前保持不变。
7. 点击「运行」，在结果页查看步骤、取消运行、打开原生 Midscene 报告。Run History 保存历次执行结果。

已有 YAML 仍可直接导入或粘贴。每个文件只有一个具名 Case，并包含非空 steps。用例详情的 Workflow 编辑器支持可视化编辑与 YAML 切换、复制、移动、停用步骤、撤销/重做、局部重新录制及指定步骤调试。

默认的独立会话不会沿用用户已打开的 Chrome 登录状态；选择 Chrome 现有会话可复用手动登录。批量运行按队列顺序执行，同一时间只控制一个用例。默认运行时限为 120 秒加用例中的条件等待时限；显式设置的运行时限仍优先。

## Group 与关系图

在侧栏 **Groups** 中新建可复用分组，按名称、标签或 Suite 搜索用例，添加成员并调整顺序。同一用例可以加入多个 Group；Suite 继续用于业务分类，Group 用于组合运行。

勾选一个或多个 Group，调整组的运行顺序，再点击运行。选择环境和准确的 Chrome 运行标签页后，所有成员按组顺序、组内顺序依次执行；重复用例只在首次出现时运行一次。空组、缺失用例或未保存 Web Workflow 会阻止整批启动，修复后再运行。批次历史保存当时的组名、成员顺序和每例结果，后续修改 Group 不改变旧记录。

切换到关系图可以查看 Project → Group → Case，展开成员、点击用例查看详情、选择分组运行，并平移、缩放或适应画布。图形使用 [React Flow](https://reactflow.dev/)，节点沿用 shadcn/ui + Tailwind。连线表示归属关系；执行顺序在 Group 编辑器与运行预览中维护。列表和编辑器每页 50 条，画布每页最多 8 个组、展开组的 12 个成员，避免一次渲染全部用例。

Group 保存于项目的 `groups/<id>.yaml`，可以随 Git 管理；删除 Group 只删除分组定义，保留用例和运行历史：

```yaml
schemaVersion: 1
id: smoke
name: 冒烟测试
description: 发布前检查主要功能
caseIds:
  - login
  - send-message
```

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

目标描述按最多两条并发自动生成，使用 Model Settings。描述会在保存的事件截图上重新定位校验，失败后重试一次；只有校验通过的描述可以直接用于 AI 回放。未通过校验、没有单一目标或人工修改的描述需要对照截图确认。时间线保留原始操作，并显示描述状态和截图。停止录制后可以先检查、保存，未完成的描述继续写回当前草稿和录制归档；每条描述最多等待 90 秒。退出应用或开始下一次录制会结束旧描述任务，未完成项标记失败，原始事件仍保留。截图按需读取本地文件，不依赖已经关闭的预览服务。

页面加载、按钮变化、回答完成等业务条件需要在检查时补充，不会自动从录制事件推断。

停止前会等待官方输入批次和已发送操作完成，避免立即停止时漏掉最后输入。这里复用的是官方录制交互组件，没有嵌入 Studio 的整套管理页面或 AI 代码生成流程。

官方前端单独构建到 `dist-preview/`，与 Workspace 的样式和 preload 权限隔离。录制服务在独立进程运行，HTTP 仅监听本机。Electron 仅为当前应用窗口向该录制服务的请求添加随机会话 token；其他本机 HTTP 客户端不能直接控制录制。原生 Chrome 窗口中的操作不在录制范围内。

「按录制操作回放」使用录制坐标和官方 Midscene actionSpace，不请求模型。独立浏览器自动采用录制尺寸（没有尺寸信息时默认 1280 × 800）；连接现有 Chrome 时也会设置录制的网页内容尺寸，并在每个坐标操作前检查稳定性。每步可以切换为「AI 描述执行」，生成 `aiAct`；新生成的纯 AI 用例不再添加视口限制，混合用例保留坐标步骤需要的尺寸检查。尺寸相同也不保证动态布局完全相同。新录制会在操作前保存目标元素信息，坐标回放前比较实际命中的目标；目标不匹配会停止并保存证据。没有目标信息的旧录制仍保留原行为。

断言可选「页面包含可见文本」或「AI 判断预期结果」。前者检查页面中精确匹配的可见文本，后者生成 `aiAssert` 并调用模型。没有断言时，Passed 仅代表操作执行完成，不能证明业务结果正确。

Workspace 生成的 `recordedAction`、`assertText` 和 `requireViewport` 是本项目为 `@midscene/test` 注册的节点；直接交给其他 Midscene CLI 执行前，需要同时接入这些节点，或改成标准 AI 步骤。初始地址使用 `${baseUrl}`；新录制的同源导航通过 `${baseOrigin}` 跟随运行环境，跨站地址保留完整 URL。旧文件不会被自动改写。

Chrome 连接失败且尚未采集事件时，可以在原页面点击「重新连接 Chrome」。重试会关闭失效连接并保留用例和草稿信息；已经采集事件的草稿需要先检查保存或明确放弃，避免重试覆盖录制。

运行结果显示具体动作、输入内容、坐标及未执行的步骤。录制操作提供执行前后截图，并在有坐标时显示操作前该位置的页面元素；弹窗用圆圈标出原坐标。绿色勾只表示操作调用完成，业务结果仍需由断言确认。截图采集失败只提示证据缺失，不将成功动作改成失败；旧历史从本次执行保存的 YAML 恢复名称，缺少步骤截图时仍可查看原始 Midscene 报告。

未保存的录制步骤和最后画面保存在本机，检查页的步骤选择及断言编辑也会自动保留，切换页面或重启后可以继续检查。退出应用会停止活动录制；异常退出后，下次启动标记为 Interrupted。录制启动时保存 Workflow 版本，外部文件有修改时拒绝覆盖。放弃草稿保留本地归档，不修改已保存 Workflow。

本次 MVP 支持 Web 单页面录制，支持拖动，不包含弹出窗口、文件上传、跨标签页、移动端录制或设备执行。录制与执行不能同时进行。录制草稿可能包含输入内容，请使用适合保存到测试资产的测试数据。

## 使用 Chrome 已有登录状态

不需要服务端支持、专用账号或导出 Cookie。录制交互仍沿用官方 Midscene 预览组件。

1. 在目标 Chrome Profile 安装 Testo Connector，并按下方“首次连接一个 Profile”完成配对。
2. 在 Chrome 中打开目标网站，先手动完成登录，再回到平台。
3. 在用例详情选择“Chrome 现有会话”，刷新 Profile 的窗口与标签页列表，通过页面标题、网址和标签页编号选择目标。可以先点击“在 Chrome 中查看”核对。录制时点击“连接 Chrome”，确认准备好后开始录制，然后在 Workspace 的官方预览中操作。原生 Chrome 中的操作不会进入 Timeline。
4. 运行和录制共用同一套选择器，平台绑定所选 Profile 和标签页，不会跟随当前激活标签页变化。
5. 结束后保留 Profile 配对；应用重启后需刷新连接并重新选择标签页，平台不会直接恢复之前的控制目标。

结束、取消或退出 Workspace 只断开连接，不关闭用户 Chrome、标签页或清除 Cookie。用例自身的退出登录等操作仍会影响真实会话。未登录用例选择「独立会话（未登录）」。

登录是否完成由用户在准备阶段确认，本版本不识别各业务站点的认证状态，也不能保证安全验证通过。登录失效后应停止操作，先在 Chrome 手动登录，再重新选择并连接标签页；暂不提供检测会话过期并自动续登。测试期间不修改服务端权限或会员状态。

Chrome 录制在调试连接完成后，读取连续稳定的网页内容视口，固定该尺寸并保存开始 URL。回放的 `requireViewport` 通过 CDP 设置相同的 CSS 视口，使用浏览器原有像素比例；不对点击坐标加减提示条高度或进行比例缩放。每步坐标操作保留尺寸检查。结束、失败和取消时清除本次视口设置，让网页恢复为当前窗口的自然尺寸，保留标签页和登录态。独立浏览器同样自动设置录制尺寸。纯 AI 用例不生成视口要求；已有文件不会自动删除手写的要求。

录制开始、回放连接后及导航后都会检查视口连续稳定 500ms，每次最多等待 5 秒。临时变化后恢复可以继续；持续失配、读取失败或无法稳定时停止，错误显示预期尺寸、实际最后尺寸和等待上限。取消会中断等待。尺寸稳定只表示窗口布局稳定，不表示业务控件已完成加载。

`gotoUrl` 默认等待 DOMContentLoaded，导航超时默认 20 秒。Chrome 模式支持 `waitUntil: commit / domcontentloaded / load` 和 `timeoutMs`（最多 25000）；不支持 networkidle 及 Playwright 专属 Cookie/视口节点。Bridge 导航关联本次文档 loaderId，报告当前 URL、等待阶段和超时上限；失败或取消时尝试停止加载，保留原标签页。独立模式继续使用 Playwright 导航能力。未明确设置步骤超时时，外层等待比导航上限多留 7 秒，其中 5 秒用于视口稳定检查、2 秒用于清理。

基础文档就绪不等于业务可操作或 AI 回答结束；这些条件仍应由后续元素等待或 `aiWaitFor` 明确表达。Bridge 使用固定 Midscene 1.12.4/1.12.5 中可转发的私有 CDP 方法适配，升级 Midscene 时必须运行真实扩展回归。测试通过独立 `WORKSPACE_BRIDGE_PORT` 避免与日常 Chrome 扩展争抢连接；应用默认端口不变。

本机只保存用例与标签页的临时连接信息，不复制登录 Cookie。为识别 Chrome 标签页会话是否已更换，开始录制或确认会话时在该网站的 sessionStorage 写入 `__testing_workspace_bridge_session` 随机标记；它不是认证凭证。标签页关闭、离开目标网站或标记失效时，回放会报错，不会自动接管其他标签页。业务截图、输入内容和步骤仍按已有录制规则保存，请在登录结束后再开始录制。

验证命令：先运行 `ALLOW_HEAVY=1 npm run build:desktop`，再运行 `npm run test:chrome-bridge`。测试需要 Playwright Chromium（`npx playwright install chromium`），也可以通过 `TEST_CHROME_EXECUTABLE` 指定已安装的 Chrome for Testing。测试在隔离配置目录中构建最小测试扩展，直接使用官方 `ExtensionBridgePageBrowserSide`、Chrome API 和真实 Electron 界面，不读取日常 Chrome 的账号数据。

## 批量运行

在用例列表点击「批量运行」，或从 Groups 运行所选分组。平台显示已配对的 Chrome Profile，按窗口列出页面标题、完整网址和标签页序号。先点「在 Chrome 中查看」核对目标，再点「使用此标签页」。同一网址的多个页面依靠 Profile、窗口和标签页 ID 区分，不依赖当前激活的标签页，也不按网址自动选择。

### 首次连接一个 Profile

1. 构建应用（`ALLOW_HEAVY=1 npm run build:desktop` 会一起构建连接扩展），在批量运行页面添加 Profile，打开连接扩展文件夹。
2. 在需要连接的 Chrome Profile 中打开 `chrome://extensions`，开启开发者模式，选择「加载已解压的扩展程序」，加载项目的 `dist-browser-extension/` 文件夹。
3. 打开 Testo Connector 设置，粘贴平台提供的配对码，并设置便于识别的连接名称，例如「工作账号」。名称由用户填写，平台不能读取 Chrome 的真实 Profile 显示名称。
4. 在扩展保存配对后，在 Chrome 目标页面完成登录，再回到平台刷新连接与页面列表，核对并选择运行标签页。另一个 Profile 需要单独安装和配对。列表只显示已配对的 Profile，不会自动发现所有正在打开的 Profile。

Testo Connector 复用固定版本 Midscene 的执行、截图与调试能力，只补充 Profile 身份、跨窗口页面列表和精确选择。扩展只连接本机的指定端口；配对信息通过系统加密后保存在本机，应用重启后可以继续使用。录制、单例运行和批量运行共用此连接扩展与标签页选择流程。连接和选择并不验证业务登录成功，用户应在运行前准备好目标页面的登录状态。

多个 Profile 使用各自独立连接。同一 Profile 的普通窗口共享 Cookie，不同窗口不代表独立账号。所有用例仍共用一条顺序队列；每例连接选定的 Profile 和标签页，完成清理后才开始下一例。页面关闭、切换到其他网站、Profile 不匹配或扩展断线会报错，平台不会自动换到另一个同网址页面。默认失败后停止，也可选择继续；取消会停止当前用例并跳过剩余用例。

应用重启后保留批次历史，未完成批次标记为中断，不自动恢复执行；Profile 配对保留，但需要刷新连接并重新选择标签页。选择器中的页面列表是上次刷新的快照，可手动刷新。全部 Workflow、共享步骤、参数、环境和模型配置在开始前冻结；排队期间修改源文件不影响当前批次。用例内的退出登录和页面操作会影响所选会话；每例仍需明确等待条件和断言。

## 数据和文件

六个核心对象是 Project、Suite、TestCase、Workflow、Environment、Run。TestCase 描述业务意图，一个用例可以关联多个平台 Workflow；Midscene 负责具体步骤执行和报告。

开发模式新建项目默认位于本目录的 `projects/<projectId>/`，安装版默认位于应用数据目录下的 `projects/`，也可以打开外部项目目录：

```text
workspace.yaml                # 项目信息、Suite ID 和目录映射
resources.yaml                # 项目变量与共享步骤
groups/<id>.yaml              # Group 名称与有序成员
cases/
  <suite-directory>/
    <caseId>/
      case.yaml               # 业务信息、稳定 ID、平台 Workflow 引用
      web.yaml                # Web 执行定义
      android.yaml            # Android 草稿，保存后创建
      ios.yaml                # iOS 草稿，保存后创建
environments/
  local.yaml                  # 环境 ID、名称、web.baseUrl 与变量
```

测试定义以这些 YAML 文件为准，可以使用 Git 管理。项目内可以查看 Git 分支、变更文件和 diff；Git 面板只读，提交和推送仍由外部 Git 工具完成。用例及 Workflow 编辑包含版本冲突检查，防止旧编辑内容覆盖外部修改。外部文件修改后可点击刷新重新读取。

本机运行数据与测试定义分开。开发模式默认保存在 `.desktop-data/`，安装版使用 Electron 的用户数据目录，可在 Model Settings 中查看实际路径。`WORKSPACE_DATA_DIR` 和 `WORKSPACE_PROJECTS_DIR` 可显式覆盖路径：

```text
projects.json                 # 已打开的项目目录
model.json                    # 模型配置，Key 字段为加密内容
runs.db                       # SQLite 运行摘要、分页事件与批次记录
browser-profiles.enc           # 系统加密后的 Profile 配对
recording-draft.json           # 系统加密后的当前录制草稿
recording-preview.json         # 最后一帧预览
recordings/<recordingId>/      # 录制服务产物、放弃草稿归档
  draft.json                  # 加密事件和描述，保存用例后继续保留
  screenshots/<assetId>       # 官方事件截图的本地副本
artifacts/<runId>/
  workflow.yaml               # 本次执行的源 YAML 快照
  compiled-workflow.yaml      # 展开共享步骤和移除编辑元信息后的定义
  run-configuration.json      # 实际运行参数、数据集、模型名称等配置
  events.jsonl               # 步骤计划、执行状态、截图索引和生命周期事件
  steps/                     # 每个录制操作的执行前/执行后/失败截图
  summary.json               # 状态、耗时、输入 SHA-256、版本、报告路径
  stdout.log / stderr.log    # 子进程有输出时生成
  report/                    # Midscene 原生 HTML 报告
```

重新启动后保留项目和历史；遗留的运行中记录标记为 Interrupted。报告在独立的隔离窗口打开。纯浏览器步骤不一定生成报告，`recordToReport` 或 Agent 操作才会生成相关内容。

相对文件引用仍按原 Workflow 所在目录解析，当前快照不包含全部引用文件，不能保证单独复制快照就能重放。报告可能包含网页内容和截图，当前没有报告脱敏功能。

## 实现范围

已实现项目/Suite/用例创建、编辑和搜索、环境编辑、平台内 Web 录制、草稿检查和恢复、YAML 生成/导入/编辑、Web 执行与取消、步骤事件、SQLite 历史、原生报告窗口、模型配置和本机加密存储。

Web 保存时使用实际安装的 Midscene 节点注册表校验。Android/iOS 目前只保存文件并检查单 Case 结构，不校验平台步骤，也没有设备执行入口。Web 已接入官方录制会话和保存流程；应用不依赖录制 Markdown 转换。外部 Markdown 仍不能直接执行。

当前进程结构是 React 界面 → 隔离 preload → Electron 主进程 → 独立 Runner 子进程。实际 Electron 中的子进程执行已通过验证；尚未切换到 utilityProcess；安装包中的录制服务、Runner、原生报告、导出及重启恢复已通过本地页面验证。

已提供命令行执行、JUnit 和 GitHub Actions 构建检查。团队权限、云同步、设备池、平台内定时/CI 调度、并发执行和分析看板尚未实现。Windows/Linux 桌面和异常进程清理未验证。

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


## 等待异步结果

录制结束后，可以在 Timeline 的任意操作前后插入“等待条件”或“断言”，修改内容和等待上限，也可以上下移动或删除检查步骤。预览和保存的 YAML 按 Timeline 顺序执行；原始录制事件及其截图保持不变，页面自动产生的导航记录仍只作为观察证据。旧草稿中末尾的等待和断言会保留在末尾；编辑后的顺序会保存在本机。已有用例可以在可视化 Workflow 编辑器中插入或修改等待步骤，无需重新录制。等待步骤默认最多 60 秒，支持 1–300 秒；条件提前满足立即继续。AI 断言仍只检查当时页面，不会因为描述里写了“等十秒”而延迟执行。

例如，要等回答完成后继续点击回答中的链接，可以设置“点击发送 → 等待本次回答结束 → 点击回答中的链接 → 检查目标页面”。下面的 AI 操作描述需要按实际页面调整：

```yaml
      - aiAct: 点击发送按钮
      - aiWaitFor:
          prompt: 最新用户消息下方出现非空的 AI 回答正文
          timeoutMs: 60000
          checkIntervalMs: 3000
      - aiWaitFor:
          prompt: 本次回答已经结束生成，生成中提示和停止生成按钮消失
          timeoutMs: 120000
      - aiAct: 点击本次回答中的详情链接
      - aiWaitFor:
          prompt: 链接对应的详情页标题和正文已显示
          timeoutMs: 60000
      - aiAssert: 详情页显示本次回答所引用的内容
```

等待只重复检查页面，发送或点击动作不会因为等待而重放。这个顺序遵循 [Midscene 条件等待](https://www.midscenejs.com/zh/reference/#aiwaitfor)、[Playwright 自动重试断言](https://playwright.dev/docs/test-assertions)和 [Cypress 重试机制](https://docs.cypress.io/app/core-concepts/retry-ability)的原则：先完成触发动作，在后续操作需要的状态满足后继续，并为等待设置明确上限。

等待条件必须描述本次操作的结果，避免把旧消息、推荐内容或加载提示算作成功。生成结束的条件需要与被测页面的实际状态一致；等待不保证模型判断永远准确。每次检查都会调用已配置的模型，默认相邻检查开始时间至少间隔 3 秒。超时保存条件与最后检查原因，取消会停止后续检查和动作。最后一次尚未完成的浏览器截图请求可能无法中断，但晚结果不会让等待通过。

当前固定的 Midscene 1.12.4 的 aiWaitFor 内部循环不接受有效的取消信号，因此平台的同名 YAML 节点调用官方 aiAssert 的可取消单次检查，并管理串行轮询与总时限；没有复制视觉识别实现。保存校验和真正运行都注册了相同的等待节点。未显式指定单步时限时，等待节点的外层时限为条件时限加 1 秒；整次运行的默认时限为原有 120 秒加全部等待窗口，明确设置的运行时限仍优先。

## Midscene 能力接入状态（固定版本 1.12.4）

| 状态 | 能力 |
| --- | --- |
| 界面已接入 | Web 官方录制预览；点击、输入、键盘、滚动、拖动、导航；原始操作或 AI 操作回放；文本断言、AI 断言、条件等待；截图、报告、历史；Chrome 会话复用 |
| 可视化新增 | aiTap、固定时长 wait、waitForElement，以及上方列出的录制、等待与断言步骤 |
| YAML 导入后可编辑参数 | aiBoolean、aiNumber、aiString、aiAsk；复杂参数使用 JSON |
| 仅独立浏览器 YAML | setCookies、clearCookies、setViewportSize；Chrome Bridge 不支持这些节点 |
| 未作为独立 YAML 节点接入 | aiInput、aiKeyboardPress、aiScroll、aiQuery、aiLocate 等 API；其中输入、键盘和滚动仍可通过原始录制或 aiAct 执行 |
| 未接入 | Android / iOS 的录制和执行，目前只保存 Workflow；高级 agent 任务缺少 agentExecutor |

这是一份代码接入清单，不代表每个只通过 YAML 暴露的节点都完成了真实模型验证。运行前会按所选浏览器模式检查节点、参数、共享步骤和变量，Chrome Bridge 不支持的 Cookie/视口节点会提前报错。高级 agent 任务仍缺少执行器，不能作为已支持能力使用。


## 可视化编辑、参数与共享步骤

Workflow 编辑器直接读写原 YAML，保留注释和未知字段。每一步可以改名称和参数、复制、调整顺序或停用；前置与清理步骤在 `beforeAll`、`beforeEach`、`afterEach`、`afterAll` 中配置。保存时检查文件版本，外部文件变化会提示重新加载，防止覆盖。

- “运行到此步”从头执行到所选步骤，仍执行清理步骤。
- “单步调试”需要填写当前页面前置条件，先等待该条件成立再执行所选步骤；不会自动重放之前的前置操作。
- “局部重新录制”替换选定区间；预览与保存使用同一份合并结果，保留其他步骤与清理配置。
- AI 检查模板包含首条回复、回复完成、停止生成、引用来源和内容规则。模板是可编辑的起点，需按实际页面确定验收条件。

在项目“变量与共享步骤”配置默认值，在环境或 Workflow 中覆盖，也可以给 Workflow 添加数据集。单次/批量运行前填写本次参数；同一批次共享同一组值。例如创建与删除知识库的操作都引用 `${knowledgeBaseName}`，在开始批量运行前输入一次名称即可。

优先级从低到高：项目 → 环境 → Workflow → 数据集 → 本次运行参数。`baseUrl`、`baseOrigin` 来自所选环境，不能手动覆盖。变量必须是 JSON 值；输入框按字符串编辑，JSON 编辑模式可使用数字、布尔值、对象和数组。

`resources.yaml` 示例：

```yaml
schemaVersion: 1
variables:
  knowledgeBaseName: regression-library
flows:
  open-library:
    name: 打开知识库
    steps:
      - aiAct: 打开知识库页面
```

Workflow 示例（这些内容均可以从编辑器维护）：

```yaml
testo:
  variables:
    knowledgeBaseName: default-library
  datasets:
    - id: english
      name: 英文名称
      variables:
        knowledgeBaseName: my-library
cases:
  - name: 创建知识库
    steps:
      - gotoUrl: { url: "${baseUrl}" }
      - useFlow: { id: open-library }
      - aiAct: 创建名称为 ${knowledgeBaseName} 的知识库
        testo: { name: 创建知识库 }
      - aiWaitFor:
          prompt: 知识库列表出现 ${knowledgeBaseName}
          timeoutMs: 60000
afterEach:
  - recordToReport: 结束页面
```

共享步骤展开后才交给 Midscene；不存在、循环引用或被删除的引用会提前报错。Midscene 原生节点的执行设置位于参数内，例如 `gotoUrl: { url: "${baseUrl}", $: { timeout: 30000 } }`，超时单位为毫秒。

## 批次重跑与执行证据

批量运行支持逐用例选择数据集、共享参数、每例总时限及可选登录条件。开始前检查全部用例，保存本批次的定义和配置快照。历史中可以重跑全部、失败或未完成的项，并重新选择本次 Chrome 标签页。

创建、改名、删除等前后依赖的用例应勾选“关联场景”。此类批次重跑时从首项开始，避免只运行删除等依赖步骤。普通批次可以只重跑失败或未完成项；旧快照缺失时会明确拒绝，不能将当前定义伪装成旧定义。

结果页区分动作调用完成与业务断言通过，保留执行前后截图、实际命中元素、等待进度、检查耗时和模型调用次数。独立浏览器会采集网络失败、HTTP 错误及控制台异常；Chrome Bridge 当前没有相应订阅能力，会明确提示诊断不可用。首条回复与完成耗时记录的是对应检查步骤的等待时长，不等同于服务端精确的首 token 延迟。

历史列表按页读取，详情按需加载完整事件，避免一次加载所有运行和截图。原生报告可以在应用中打开，也可以导出 ZIP 后离线查看。


## 命令行与 CI 运行

命令行与桌面端共用 `compileWorkflow`、Midscene 节点注册表和 Runner 子进程。先运行 `ALLOW_HEAVY=1 npm run build:runner`，再选择一个已有项目目录（目录中包含 `workspace.yaml`）：

```sh
npm run run:workflow -- \
  --project ./projects/my-project \
  --environment staging \
  --group "知识库冒烟" \
  --group "聊天冒烟" \
  --variables ./run-variables.json \
  --failure-policy stop \
  --artifacts ./artifacts/ci \
  --junit ./artifacts/ci/junit.xml
```

`run-variables.json` 中提供本次运行共同使用的值，例如：

```json
{"libraryName":"test-library-20260912"}
```

在新建、改名、删除等用例的输入或 AI 指令中写 `${libraryName}`。变量优先级从低到高为：项目默认值、环境默认值、Workflow 默认值、所选数据集、本次运行的 JSON 参数。内置 `baseUrl` 和 `baseOrigin` 由环境决定，不能在参数文件中覆盖。

- `--environment`、`--group` 和 `--case` 接受 ID 或完整名称；名称重复时必须使用 ID。
- `--group` 和 `--case` 可以重复传入。多个 Group 先按参数顺序展开组内用例，再追加显式选择的用例；同一个用例只保留第一次出现的位置。
- `--tag` 可以重复传入，保留候选用例中匹配任意指定标签的用例。没有 Group/Case 筛选时，候选集合为项目中全部可运行的 Web 用例。
- `--dataset <id>` 为每个所选 Workflow 选择同一个数据集 ID；任何一个用例缺少该 ID，整批在启动前失败。`--all-datasets` 按各用例的行顺序运行全部数据集，无数据集的用例运行一次。这两个参数不能同时使用。
- `--failure-policy stop` 为默认行为；第一个失败之后，剩余项标为 skipped。使用 `continue` 会继续后续用例，整批仍返回失败。
- `--timeout <秒>` 设置每个用例的总时限。未设置时，Runner 为所有步骤和条件等待预留时限，并读取原生节点内部的 `$.timeout` 毫秒数。
- 默认使用独立、无头的 Chromium 会话，每个用例重新创建浏览器上下文。`--headed` 显示窗口；`--channel chrome` 使用本机 Chrome。CI 不会接管个人 Chrome Profile 或当前已登录标签页。

整个批次在第一个用例运行前检查并冻结全部 Workflow 文本、共享步骤、环境、参数及模型配置。后续修改原 YAML 不会改变正在排队的内容。模型通过 Midscene 标准环境变量配置，例如 `MIDSCENE_MODEL_NAME`、`MIDSCENE_MODEL_FAMILY`、`MIDSCENE_MODEL_BASE_URL` 和 `MIDSCENE_MODEL_API_KEY`；凭证由 CI 的 secret 配置提供。

每次项目运行创建独立的批次目录，保存 `batch-summary.json` 和各用例的报告目录；传入 `--junit` 后可接入 CI 的测试结果展示。退出码为：全部通过 `0`，校验/执行失败 `1`，收到取消信号 `130`。SIGINT/SIGTERM 会取消当前用例并停止调度剩余项。

原来的单 YAML 命令仍可使用，也支持 `--variables`、`--dataset`、`--all-datasets` 和 `--junit`：

```sh
npm run run:workflow -- --workflow ./web.yaml --base-url https://example.com --channel chrome
```

报告导出生成 ZIP。解压后打开 `index.html`，即可查看原生 Midscene HTML 报告、执行截图、事件、定义和配置，无需安装 Midscene。报告包不包含应用凭证文件、Chrome 配对、`.env` 和原始进程日志；明确的配置凭证字段会被隐藏。原生报告和截图仍包含测试页面内容，导出包也不包含所有相对引用文件，因此它是可分享的运行证据，不保证仅凭报告包就能重新执行。
