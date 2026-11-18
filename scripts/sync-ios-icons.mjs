#!/usr/bin/env node
/**
 * 把仓库里跟踪的 iOS 图标同步进生成的 Xcode 工程。
 *
 * 为什么需要：
 *   `tauri ios init` 只把 CLI 内置模板的默认图标（Tauri 那个图标）渲染进
 *   `gen/apple/Assets.xcassets/AppIcon.appiconset/`，**不会**读
 *   `src-tauri/icons/ios/`。而 `gen/` 不入库，CI 每次都会重新 init，
 *   于是打出来的 ipa 图标永远是 Tauri 默认图标 —— 和安卓图标是同一个坑。
 *
 * 用法：
 *   node scripts/sync-ios-icons.mjs
 *   （tauri.conf.json 的 beforeBuildCommand 已自动调用，一般不用手动跑）
 */
import { cpSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src-tauri", "icons", "ios");
const dest = join(
  root,
  "src-tauri",
  "gen",
  "apple",
  "Assets.xcassets",
  "AppIcon.appiconset",
);

if (!existsSync(src)) {
  console.log(`[icons] 跳过：缺少 ${src}`);
  process.exit(0);
}
if (!existsSync(dest)) {
  console.log("[icons] 跳过：gen/apple 还没生成（先跑 tauri ios init）");
  process.exit(0);
}

const pngs = readdirSync(src).filter((name) => name.toLowerCase().endsWith(".png"));
if (pngs.length === 0) {
  console.log(`[icons] 跳过：${src} 里没有 png`);
  process.exit(0);
}

// Contents.json 由 Tauri 模板提供，只覆盖同名 png，不新增引用。
for (const name of pngs) {
  cpSync(join(src, name), join(dest, name), { force: true });
}
console.log(`[icons] iOS 图标已同步 ${pngs.length} 个 → ${dest}`);
