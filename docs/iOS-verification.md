# iOS 改动的验证记录

本仓库的 iOS 构建只能在 macOS 上跑，本次改动是在 Windows 上整理并做的静态验证。下面写清楚「验过什么、没法验什么」，方便你复现。

## 已在本机验证

| 项 | 命令 / 方式 | 结果 |
| --- | --- | --- |
| 前端类型检查 | `tsc --noEmit` + `tsc -p tsconfig.tests.json` | 通过 |
| 前端生产构建 | `vite build` | 通过，产出 `dist/`（index.html + css 53KB + js 922KB） |
| `Info.ios.plist` 合法性 | Python `plistlib.load` | 合法，键可读出（方向 / ATS / 文件共享 / 导出合规） |
| iOS 图标同步脚本 | 造一个假的 `gen/apple/.../AppIcon.appiconset` 后运行 `sync-ios-icons.mjs` | 18 个 png 全部覆盖成功 |
| 打包脚本语法 | `node --check scripts/build-ios-unsigned.mjs` | 通过 |
| 打包脚本失败路径 | 在 Windows 上直接运行 | 正确报「只能在 macOS 上跑」，退出码 1 |
| 工作流 YAML | `js-yaml` 解析 | 合法，13 个 step，`runs-on: macos-15` |
| 配置 JSON | `json.load` | `tauri.conf.json` / `package.json` / `tauri.ios.conf.json` 均合法 |
| Tauri CLI 行为 | 读 `tauri-cli 2.10.1` 源码（crates.io 包） | 确认 `ios init --ci`、`ios build --open --ci --features` 参数存在；`--open` 会 `write_options` 后进 `loop{sleep}`，选项服务随进程存活；`ios build` 会把 `src-tauri/Info.ios.plist` 合并进生成工程 |
| iOS 图标会被 init 覆盖 | 读 `crates/tauri-cli/src/mobile/ios/project.rs` | `gen()` 只渲染内置模板，不读 `icons/ios/`——这就是加 `sync-ios-icons.mjs` 的原因 |

## 必须在 macOS 上验证的部分

以下步骤本机做不了（没有 Xcode / iOS SDK / `xcodebuild`），只能在 GitHub Actions 或 Mac 上跑一次：

- `pnpm tauri ios init --ci`（xcodegen 生成 `.xcodeproj`、pod install）
- `tauri ios build --open` 的后台选项服务与 `xcodebuild` 的实际配合
- Rust `aarch64-apple-ios` 交叉编译（`swift-rs`、`ring` 等依赖需要 Apple 工具链）
- 真机安装、竖屏刷剧、横屏全屏、手势、插件导入

跑通一次 Actions 后，如果哪一步红了，日志里对应步骤已经很具体（脚本会打印 `ios-build-session.log` 末尾 80 行）。把那段日志贴回 issues 即可。
