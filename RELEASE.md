# macOS 安装包与 Chrome 扩展

版本号由 `package.json` 的 `version` 决定。构建输出位于 `release/`，不会进入 Git。已接通本地打包与正式签名配置；正式签名、公证和更新安装仍需取得 Apple 开发者资格及证书后验证。

## 本地测试包

需要 macOS、Node 22.12+ 或 24+，以及项目依赖：

```sh
npm ci
ALLOW_HEAVY=1 npm run package:mac
npm run package:connector
```

生成当前机器架构的 `Testo-0.0.1-mac-arm64.dmg`、应用 ZIP 和 `Testo-Connector-0.0.1.zip`。Intel 架构可以在桌面构建完成后执行：

```sh
npx electron-builder --config electron-builder.config.cjs --mac --x64 --publish never
```

DMG 中的 Testo.app 拖入 Applications 后启动。当前测试包使用 ad-hoc 签名，没有 Developer ID 与 Apple 公证，下载到其他 Mac 后仍可能被 Gatekeeper 阻止；它不满足“同事无痛安装”的正式分发要求。

应用包含录制预览、Runner、依赖和连接扩展，不需要另装 Midscene app。Web 测试仍需要 Chrome；AI 操作还需要配置模型服务。

## 加载连接扩展

1. 解压 `Testo-Connector-0.0.1.zip` 到一个固定目录，保留整个目录。
2. 在目标 Chrome Profile 中打开 `chrome://extensions`，开启开发者模式，选择“加载已解压的扩展程序”，选中包含 `manifest.json` 的目录。
3. 在 Testo 的 Chrome 标签页选择器中添加 Profile，复制配对码；打开扩展设置，粘贴并保存。
4. 返回 Testo 刷新连接，查看并选择目标标签页。

安装版也可以通过“打开扩展目录”直接找到应用内置的扩展；独立 ZIP 更适合保留在固定位置。每个 Profile 单独配对。当前没有发布 Chrome Web Store 版本。

## 正式签名与公证

使用个人 Apple Developer Program 账号也可以申请 Developer ID Application 证书。正式包需在构建前配置：

| 变量 | 内容 |
| --- | --- |
| `TESTO_SIGNED_RELEASE` | `1` |
| `CSC_LINK` | 含私钥的 Developer ID Application `.p12` 文件路径或 base64 |
| `CSC_KEY_PASSWORD` | `.p12` 导出密码 |
| `APPLE_ID` | Apple 开发者账号 |
| `APPLE_APP_SPECIFIC_PASSWORD` | Apple 专用密码 |
| `APPLE_TEAM_ID` | 开发者 Team ID |

本地也支持 electron-builder 的 App Store Connect API Key 方式：同时配置 `APPLE_API_KEY`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`，替代 Apple ID 三个变量。凭证通过本机环境或 CI secrets 提供，不写入仓库。

开启正式发布后，缺失证书或公证凭证会在构建开始前报错。electron-builder 启用 hardened runtime、Developer ID 签名和公证。生成后应在发布机验证：

```sh
codesign --verify --deep --strict --verbose=2 release/mac-arm64/Testo.app
spctl --assess --type execute --verbose=2 release/mac-arm64/Testo.app
xcrun stapler validate release/mac-arm64/Testo.app
```

还需在另一台 Mac 上从下载的 DMG 安装，验证首次启动、录制、运行和更新。当前缺少正式证书，以上正式发布路径尚未端到端验证。配置说明参考 [electron-builder 公证文档](https://www.electron.build/v26/docs/notarization/)。

## GitHub 构建与发布

`.github/workflows/check.yml` 在 main 推送和 PR 时检查构建与核心行为。

`.github/workflows/release.yml` 为手动触发，构建 Apple Silicon / Intel 的 DMG、ZIP 和扩展 ZIP，并上传到本次 Actions 的 artifacts。勾选 `signed` 前先设置对应 repository secrets。工作流不会自动创建公开 Release。

正式发布时，在 GitHub 为匹配 `package.json` 的版本创建 `v0.0.1` 等 tag/Release，并上传本次生成的 DMG、ZIP、blockmap 和 `latest-mac.yml`，保留原文件名。应用自动更新依赖 ZIP 和更新元数据，不能只上传 DMG。发布前先验证全部资产，再发布正式 Release；草稿和预发布版不会被当前更新器当作正式更新。

签名安装版在 Model Settings 中提供“检查更新 → 下载 → 安装并重启”。开发版和 ad-hoc 测试版禁用更新。应用不会在后台自动下载，也不会在测试运行或录制期间安装更新。仓库若为私有仓库，还需设计分发访问权限；应用未内置 GitHub 私有仓库 token。

## 数据目录和升级

安装版通过 Electron `userData` 保存注册项目、加密配置、录制草稿、SQLite 历史及产物；Model Settings 显示实际路径。新建项目默认位于其 `projects/` 子目录，也可打开其他 Git 项目目录。开发模式继续使用仓库的 `.desktop-data/` 和 `projects/`，不会自动搬移用户原有数据。

升级替换应用，不替换用户数据。`WORKSPACE_DATA_DIR` / `WORKSPACE_PROJECTS_DIR` 可指定测试或迁移目录。验证安装包时使用隔离目录：

```sh
ALLOW_HEAVY=1 node --test dist/tests/package.test.js
```

此测试实际启动 `release/mac-arm64/Testo.app`，执行本地页面测试、录制、ZIP 导出和重启恢复；`TESTO_PACKAGE_EXECUTABLE` 可指定另一架构或路径。没有安装包时测试会跳过，不能把跳过视为通过。
