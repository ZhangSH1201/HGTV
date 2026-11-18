#!/usr/bin/env node
/**
 * HGhub iOS 免签名打包：产出可自签安装的 .ipa（Payload/HGhub.app）
 *
 * 为什么不是一条 `tauri ios build` 就完事：
 *   tauri-cli 2.x 没有 `ios build --no-sign`，没有开发者证书时
 *   `tauri ios build` 会在签名/归档那一步失败。
 *
 * 这里的做法（CI 用的也是它）：
 *   1. 后台常驻 `tauri ios build --open`。它会：
 *        - 需要时 init 出 gen/apple 工程；
 *        - 把 src-tauri/Info.ios.plist 合并进生成的 Info.plist；
 *        - 跑 beforeBuildCommand（前端 pnpm build + 图标同步）；
 *        - 写 <identifier>-server-addr 并起一个 WebSocket 选项服务；
 *        - 打开 Xcode 后永久 sleep（不会自己退出）。
 *   2. Xcode 工程里的 "Build Rust Code" 阶段调用 `tauri ios xcode-script`，
 *      它靠上面那个地址文件向后台进程读取 CLI 选项（features / config / vars），
 *      再 cargo 编译 aarch64-apple-ios。所以后台进程必须活到 xcodebuild 结束。
 *   3. 我们自己跑 xcodebuild 并关掉签名（CODE_SIGNING_ALLOWED=NO），
 *      拿到 .app 后按 Payload/ 结构压成 ipa。
 *
 * 用法：
 *   node scripts/build-ios-unsigned.mjs [版本号]
 *   版本号缺省取 src-tauri/tauri.conf.json 的 version。
 *
 * 产物：
 *   artifacts/HGhub_<版本号>_ios.ipa
 */
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);

const CONF = "src-tauri/tauri.conf.json";
const conf = JSON.parse(readFileSync(CONF, "utf8"));
const VERSION = process.argv[2] || conf.version;
const IDENTIFIER = conf.identifier;
const PRODUCT = conf.productName;

const BUILD_DIR = join(ROOT, "build_output");
const ARTIFACT_DIR = join(ROOT, "artifacts");
const LOG = join(ROOT, "ios-build-session.log");
const ADDR_FILE = join(tmpdir(), `${IDENTIFIER}-server-addr`);
const WAIT_SECONDS = 300;

// 后台常驻的 tauri 会话（模块级，便于退出时统一 kill 进程组）
let session = null;
function killSession() {
  if (!session) return;
  const pid = session.pid;
  session = null;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    /* 已经退出 */
  }
}

const bold = (s) => `\u001b[1;34m${s}\u001b[0m`;
const red = (s) => `\u001b[1;31m${s}\u001b[0m`;
const log = (msg) => console.log(`${bold("[ios]")} ${msg}`);

function die(msg) {
  console.error(`${red("[ios]")} ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

function logTail(lines = 80) {
  try {
    const text = readFileSync(LOG, "utf8").trimEnd().split(/\r?\n/);
    return text.slice(-lines).join("\n");
  } catch {
    return "(没有 tauri 会话日志)";
  }
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.error) throw new Error(`${cmd} 无法执行：${r.error.message}`);
  return r;
}

function hasBinary(name) {
  return run("which", [name]).status === 0;
}

async function main() {
  if (process.platform !== "darwin") {
    die("iOS 打包只能在 macOS 上跑（需要 Xcode / xcodebuild）。");
  }
  if (!hasBinary("xcodebuild")) {
    die("找不到 xcodebuild，请先安装 Xcode 并执行 xcode-select -s /Applications/Xcode.app");
  }
  if (!existsSync("src-tauri/gen/apple")) {
    die("缺少 src-tauri/gen/apple，请先执行：pnpm tauri ios init --ci");
  }

  mkdirSync(ARTIFACT_DIR, { recursive: true });
  rmSync(BUILD_DIR, { recursive: true, force: true });
  rmSync(LOG, { force: true });
  rmSync(ADDR_FILE, { force: true });

  log(`版本 ${VERSION} · ${PRODUCT} (${IDENTIFIER})`);

  // ── 1. 后台常驻 tauri 会话：init / 合并 Info.plist / 前端构建 / 选项服务 ──
  log("启动 tauri 会话（--open 只用来常驻选项服务，不依赖它签名）");
  const logFd = openSync(LOG, "a");
  session = spawn(
    "pnpm",
    ["tauri", "ios", "build", "--open", "--ci", "--features", "custom-protocol"],
    { stdio: ["ignore", logFd, logFd], detached: true },
  );
  closeSync(logFd);
  let sessionExited = false;
  session.on("exit", () => {
    sessionExited = true;
  });
  session.on("error", (err) => {
    sessionExited = true;
    console.error(`${red("[ios]")} 启动 pnpm 失败：${err.message}`);
  });

  const addrReady = () => {
    try {
      return existsSync(ADDR_FILE) && statSync(ADDR_FILE).size > 0;
    } catch {
      return false;
    }
  };

  const deadline = Date.now() + WAIT_SECONDS * 1000;
  let ready = false;
  while (Date.now() < deadline) {
    if (addrReady()) {
      ready = true;
      break;
    }
    if (sessionExited) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!ready) {
    die(
      sessionExited
        ? `tauri 会话在就绪前退出。日志末尾：\n${logTail()}`
        : `等待 tauri 选项服务超时（${WAIT_SECONDS}s）。日志末尾：\n${logTail()}`,
    );
  }
  log(`选项服务就绪：${readFileSync(ADDR_FILE, "utf8").trim()}`);

  // ── 2. 定位工程与 scheme ─────────────────────────────────────────────────
  const projects = readdirSync("src-tauri/gen/apple", { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.endsWith(".xcodeproj"))
    .map((e) => join("src-tauri/gen/apple", e.name));
  if (projects.length === 0) die("找不到 gen/apple 下的 .xcodeproj");
  const project = projects[0];

  let scheme = "";
  const listed = run("xcodebuild", ["-list", "-json", "-project", project]);
  if (listed.status === 0) {
    try {
      const schemes = JSON.parse(listed.stdout).project.schemes || [];
      scheme = schemes.find((s) => s.endsWith("_iOS")) || "";
    } catch {
      scheme = "";
    }
  }
  // 解析失败时退回 xcodegen 的命名规则：<工程名>_iOS
  if (!scheme) scheme = `${basename(project, ".xcodeproj")}_iOS`;
  log(`工程 ${basename(project)} · scheme ${scheme}`);

  const toolchain = join(
    run("xcode-select", ["-p"]).stdout.trim(),
    "Toolchains/XcodeDefault.xctoolchain",
  );
  if (!existsSync(toolchain)) die(`找不到 Xcode 默认工具链：${toolchain}`);

  // ── 3. 免签名 xcodebuild ──────────────────────────────────────────────────
  log("xcodebuild（release / iphoneos / arm64 / 无签名）");
  const build = spawnSync(
    "xcodebuild",
    [
      "build",
      "-project", project,
      "-scheme", scheme,
      "-configuration", "release",
      "-sdk", "iphoneos",
      "-destination", "generic/platform=iOS",
      "-derivedDataPath", BUILD_DIR,
      "ARCHS=arm64",
      "ONLY_ACTIVE_ARCH=NO",
      "ENABLE_USER_SCRIPT_SANDBOXING=NO",
      `TOOLCHAIN_DIR=${toolchain}`,
      "CODE_SIGNING_ALLOWED=NO",
      "CODE_SIGNING_REQUIRED=NO",
      "CODE_SIGN_IDENTITY=",
    ],
    { stdio: "inherit" },
  );
  if (build.status !== 0) die(`xcodebuild 失败（退出码 ${build.status}）`);

  const app = join(BUILD_DIR, "Build/Products/release-iphoneos", `${PRODUCT}.app`);
  if (!existsSync(app)) die(`构建产物不存在：${app}`);

  // ── 4. 产物自检（防止把 dev 包或没合并 Info.plist 的包发出去）────────────
  const plist = join(app, "Info.plist");
  const readPlist = (key) => {
    const r = run("/usr/libexec/PlistBuddy", ["-c", `Print ${key}`, plist]);
    if (r.status !== 0) die(`Info.plist 缺少 ${key}：src-tauri/Info.ios.plist 没被合并（必须走 tauri ios build，不能直接 xcodebuild）`);
    return r.stdout.trim();
  };
  const executable = readPlist(":CFBundleExecutable");
  const binPath = join(app, executable);
  if (!existsSync(binPath) || statSync(binPath).size === 0) die(`主二进制缺失：${binPath}`);

  const fileInfo = run("file", [binPath]).stdout;
  if (!/Mach-O.*arm64/.test(fileInfo)) die(`主二进制不是 arm64：${fileInfo.trim()}`);

  const bundleId = readPlist(":CFBundleIdentifier");
  if (bundleId !== IDENTIFIER) die(`Bundle ID 不一致：${bundleId} != ${IDENTIFIER}`);
  readPlist(":UISupportedInterfaceOrientations:1");
  readPlist(":NSAppTransportSecurity:NSAllowsArbitraryLoads");

  if (readFileSync(binPath).includes(Buffer.from("localhost:1420", "utf8"))) {
    die("二进制里出现 localhost:1420，这是 dev 包；检查 tauri.ios.conf.json 与 --features custom-protocol");
  }

  // ── 5. 压成 ipa ───────────────────────────────────────────────────────────
  const pkgDir = run("mktemp", ["-d"]).stdout.trim();
  const ipa = join(ARTIFACT_DIR, `HGhub_${VERSION}_ios.ipa`);
  try {
    mkdirSync(join(pkgDir, "Payload"), { recursive: true });
    const copied = spawnSync("cp", ["-R", app, join(pkgDir, "Payload/")], { stdio: "inherit" });
    if (copied.status !== 0) die("拷贝 .app 失败");
    rmSync(ipa, { force: true });
    const zipped = spawnSync("zip", ["-qry", ipa, "Payload"], { cwd: pkgDir, stdio: "inherit" });
    if (zipped.status !== 0) die("压缩 ipa 失败");
  } finally {
    rmSync(pkgDir, { recursive: true, force: true });
  }

  const size = run("du", ["-h", ipa]).stdout.trim().split(/\s+/)[0];
  const sha = run("shasum", ["-a", "256", ipa]).stdout.trim().split(/\s+/)[0];
  log(`完成：${ipa}`);
  log(`大小：${size} · SHA256：${sha}`);
}

process.on("exit", () => {
  killSession();
  try {
    rmSync(ADDR_FILE, { force: true });
  } catch {
    /* ignore */
  }
});
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

main()
  .catch(() => {
    // 失败时把后台会话日志末尾打出来，CI 里足够定位
    const tail = logTail();
    if (tail !== "(没有 tauri 会话日志)") {
      console.error(`\n${bold("[ios]")} tauri 会话日志（末尾 80 行）：\n${tail}`);
    }
    process.exitCode = process.exitCode || 1;
  })
  .finally(() => {
    killSession();
  });
