# HGhub iOS 版：构建、打包与安装

本仓库在原有 Rust + Tauri 2 客户端基础上补齐了 iOS 目标。因为 iOS 应用**只能在 macOS 上编译**（需要 Xcode 的 iOS SDK 与 `xcodebuild`），这里的方案是：

- Windows / Linux 上用 **GitHub Actions 的 macOS runner 一键出包**（推荐，无需 Mac）；
- 有 Mac 的话，也可以本地一条命令出包。

两条路产出的是同一个东西：**未签名 `.ipa`**，装到 iPhone 上需要自签或 TrollStore。

> 打包脚本本身不做签名。签名涉及 Apple 开发者账号与证书，属于你自己的凭据，不该放进仓库。

---

## 一、仓库里为 iOS 做了什么

| 位置 | 作用 |
| --- | --- |
| `src-tauri/tauri.ios.conf.json` | iOS 专用配置：最低系统 15.0、关闭 `devUrl`（保证打出来的是内嵌前端的正式包） |
| `src-tauri/Info.ios.plist` | iOS 的 Info.plist 片段：横屏方向、ATS 放开、文件共享等，由 `tauri ios build` 自动合并 |
| `scripts/build-ios-unsigned.mjs` | 免签名打包主脚本：起 `tauri ios build --open` 常驻选项服务 → 校验产物 → 压成 ipa |
| `scripts/sync-ios-icons.mjs` | 把 `src-tauri/icons/ios/*.png` 同步进生成的 `gen/apple/Assets.xcassets`（`tauri ios init` 只会写默认图标） |
| `.github/workflows/build-ios.yml` | 一键出包 + 上传 artifact + 打 tag 时发 Release |
| 前端 `src/` | 已有 iOS 分支：`platform === "ios"`（关闭 hls.js Worker、竖屏刷剧流、横竖屏切换、触控手势等） |
| `src-tauri/src/api.rs` | `set_orientation` 命令：iOS 16+ 走 `requestGeometryUpdateWithPreferences:`，旧系统走 fallback |

### 为什么打包脚本要“后台常驻”一个 tauri 进程

`tauri-cli` 2.x 没有 `ios build --no-sign`，没有证书时 `tauri ios build` 会在归档签名阶段失败。但 Xcode 工程里的 **Build Rust Code** 阶段会调用 `tauri ios xcode-script`，这个隐藏子命令需要向 `tauri ios build` 起的 WebSocket 选项服务读取 `--features`、config 等参数（地址写在临时目录的 `<identifier>-server-addr` 文件里）。

所以脚本的流程是：

1. 后台跑 `pnpm tauri ios build --open --ci --features custom-protocol`
   —— 它做 init、合并 `Info.ios.plist`、跑 `beforeBuildCommand`（前端 + 图标同步）、写好选项服务地址，然后打开 Xcode 并永久 sleep；
2. 等地址文件出现；
3. 自己执行 `xcodebuild ... CODE_SIGNING_ALLOWED=NO`，得到 `.app`；
4. 自检（arm64、Bundle ID、Info.plist 键、不是 dev 包）；
5. 按 `Payload/HGhub.app` 结构压成 `artifacts/HGhub_<版本>_ios.ipa`，最后 kill 后台进程。

---

## 二、在 GitHub 上一键出包（无需 Mac）

1. 把本仓库（含本次改动）推到你自己 GitHub 仓库的 `main` 分支。
2. 仓库 → **Actions** → 左侧 **Build iOS IPA** → **Run workflow**。
   - 版本号可留空，默认取 `src-tauri/tauri.conf.json` 的 `version`；
   - 打 `v1.2.1` 这类 tag 推送时会自动触发，并把 ipa 发到 Release。
3. 跑完（首次约 15–25 分钟，之后有缓存会快一些）：
   - 页面底部 **Artifacts** 下载 `HGhub-iOS-<版本>`（zip 里是 `.ipa`）；
   - 或者到 **Releases** 里下 `HGhub_<版本>_ios.ipa`。
4. 校验：

   ```bash
   shasum -a 256 HGhub_1.2.1_ios.ipa
   ```

   和 Actions 日志里打印的 SHA256 对一下即可。

### 常见失败点

| 现象 | 原因 / 处理 |
| --- | --- |
| `xcodegen: command not found` | 工作流里已有 `brew install xcodegen` 兜底；本地构建先 `brew install xcodegen` |
| `Waiting for tauri 选项服务超时` | 多半是 `beforeBuildCommand`（`pnpm build`）失败，脚本会打印 `ios-build-session.log` 末尾 |
| `Info.plist 缺少 UISupportedInterfaceOrientations` | 说明没走 `tauri ios build`（直接把 xcodebuild 当入口了），或 `src-tauri/Info.ios.plist` 被删 |
| `二进制里出现 localhost:1420` | 打成了 dev 包：检查 `tauri.ios.conf.json` 的 `devUrl: null` 与 `--features custom-protocol` |
| `找不到 gen/apple` | 先 `pnpm tauri ios init --ci` |
| runner 上 Xcode 版本变化导致失败 | `.github/workflows/build-ios.yml` 里 `runs-on: macos-15` 改成别的镜像 |

---

## 三、在 Mac 上本地出包

前置：macOS + Xcode（含 iOS SDK/模拟器）、Node 22、pnpm 10、Rust（`rustup target add aarch64-apple-ios aarch64-apple-ios-sim`）。

```bash
brew install xcodegen cocoapods     # 如果没有
pnpm install
pnpm tauri ios init --ci            # 生成 src-tauri/gen/apple
node scripts/build-ios-unsigned.mjs # 产物：artifacts/HGhub_<版本>_ios.ipa
```

> 脚本会顺带把 Xcode 打开（`tauri ios build --open` 的行为，选项服务要活到 xcodebuild 结束），忽略它即可，不要手动关。

想真机调试（需要开发者证书）：

```bash
# 把 src-tauri/tauri.conf.json 里 bundle.iOS.developmentTeam 换成你的 Team ID，
# 或设置环境变量 APPLE_DEVELOPMENT_TEAM
pnpm tauri ios dev
```

---

## 四、装到 iPhone 上

ipa 是**未签名**的，因此：

### 1. TrollStore（巨魔）

直接把 `.ipa` 导入 TrollStore 安装。优点是永久有效、不受 7 天限制；缺点是只支持 TrollStore 兼容的系统版本（社区里通常要求较老的 iOS 大版本，具体以 TrollStore 官方说明为准，iOS 17 之后的新系统基本不支持）。

### 2. AltStore / SideStore / Sideloadly（个人 Apple ID 自签）

1. 在电脑上装 AltServer / Sideloadly，iPhone 用数据线连上；
2. 选择 `HGhub_<版本>_ios.ipa`，用你的 Apple ID 签名安装；
3. 首次安装后到 **设置 → 通用 → VPN 与设备管理** 信任开发者证书；
4. 免费账号签的 App **7 天过期**，需重签（AltStore 在 Wi-Fi 下可自动续签）。

### 3. ESign / 轻松签 / Feather / 全能签（证书签名）

如果你有个人/企业开发者证书，导入证书后直接签这个 ipa 安装，有效期跟随证书（个人证书通常 1 年）。

> 以上都需要在“设置 → 通用 → VPN 与设备管理”里信任对应证书；企业证书有被吊销的风险，与 HGhub 无关。

---

## 五、iOS 端功能与限制

- 已适配：竖屏刷剧流、横屏全屏（原生方向切换，含物理横置自动全屏）、双指缩放/平移、单击清屏、双击暂停、长按 2 倍速、左右横滑定位、HLS 走本地自定义协议、插件导入（文件/粘贴/网址）、收藏与历史续播。
- iOS 上关闭了 hls.js 的 Worker（WKWebView 对 `hg://` 自定义协议配 Worker 容易死锁），大码率流首帧会略慢一点。
- 未签名包不包含推送、后台播放、iCloud 同步等需要 entitlement/证书的能力；这些要等你用自己的证书签名后再补。
- App 不内置任何内容源，插件由你自己导入；第三方源是否可用与 HGhub 无关。
- 本项目是 **PolyForm Noncommercial 1.0.0** 许可，禁止商业用途（售卖、广告变现、卡密、付费解锁等都算）。

---

## 六、构建产物与证据

一次完整构建会留下这些文件（都在 `.gitignore` 里，不会进仓库）：

- `artifacts/HGhub_<版本>_ios.ipa` —— 安装包
- `build_output/` —— Xcode DerivedData
- `ios-build-session.log` —— 后台 tauri 会话日志（排错用）
