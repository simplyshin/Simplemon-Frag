#!/usr/bin/env node
/**
 * frag-mcp 服务管理脚本（Windows）
 * ---------------------------------------------------------------------------
 * 统一管理服务的后台启动与 Windows 服务安装：
 *
 *   node service.mjs run           前台运行（调试用，Ctrl+C 停止）
 *   node service.mjs start         后台启动（无需管理员；已装服务则启动服务）
 *   node service.mjs stop          停止（后台进程或 Windows 服务）
 *   node service.mjs restart       重启
 *   node service.mjs status        查看运行状态与健康检查
 *   node service.mjs install       安装为 Windows 服务（需管理员）
 *   node service.mjs uninstall     卸载 Windows 服务（需管理员）
 *   node service.mjs logs [N]      查看最近日志（默认 50 行）
 *   node service.mjs doctor        环境自检
 *   node service.mjs init          生成默认 service.config.json
 *
 * 启动模式由 service.config.json 的 server.mode 决定：
 *   web        HTTP 模式（默认）      → node dist/server.js
 *   stdio      stdio 模式             → node dist/server.js --stdio
 *   stdio-web  stdio + 内嵌 Web 后台  → node dist/server.js --stdio --web
 *
 * Windows 服务后端（daemon.manager）：
 *   auto   自动选择：优先 NSSM，其次 WinSW（自动下载）
 *   nssm   使用 nssm.exe（PATH 或 tools/nssm/nssm.exe，下载: https://nssm.cc/download）
 *   winsw  使用 WinSW（tools/winsw/，缺失时自动从 GitHub 及镜像下载）
 *
 * 端口优先级：service.config.json 的 server.port（若显式设置）> .env PORT
 *           > data/config.json > 内置默认 3210。
 * 服务自行加载项目根 .env（AUTH_TOKEN 等），无需在本脚本重复配置。
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  statSync,
  renameSync,
  copyFileSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(ROOT, 'service.config.json');
const INSTALL_MARK = join(ROOT, 'tools', 'service-install.json');
const MODES = new Set(['web', 'stdio', 'stdio-web']);

const WINSW_VERSION = 'v2.12.0';
const WINSW_FILENAME = 'WinSW-x64.exe';
const WINSW_URLS = [
  `https://github.com/winsw/winsw/releases/download/${WINSW_VERSION}/${WINSW_FILENAME}`,
  `https://gh-proxy.com/https://github.com/winsw/winsw/releases/download/${WINSW_VERSION}/${WINSW_FILENAME}`,
  `https://ghproxy.net/https://github.com/winsw/winsw/releases/download/${WINSW_VERSION}/${WINSW_FILENAME}`,
];

const DEFAULT_CONFIG = {
  service: {
    name: 'FragMcpServer',
    displayName: 'frag-mcp 项目文档管理服务',
    description: '自托管项目知识库 MCP 服务（文档管理/语义检索/归档）',
    startup: 'auto',
  },
  server: {
    mode: 'web',
    script: 'dist/server.js',
    port: 3210,
    nodePath: '',
    nodeOptions: [],
    env: {},
  },
  daemon: {
    manager: 'auto',
    logDir: 'logs',
    logRotationMB: 10,
    healthTimeoutSec: 30,
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 输出工具 ----------

const useColor = Boolean(process.stdout.isTTY);
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const ok = (s) => console.log(paint('32', '✓') + ' ' + s);
const bad = (s) => console.log(paint('31', '✗') + ' ' + s);
const info = (s) => console.log(paint('36', '·') + ' ' + s);
const die = (msg) => {
  console.error(paint('31', '✗') + ' ' + msg);
  process.exit(1);
};

// ---------- 配置 ----------

let rawConfig = {};

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? base : override;
  }
  const result = { ...base };
  for (const [k, v] of Object.entries(override)) {
    result[k] = isPlainObject(v) && isPlainObject(result[k]) ? deepMerge(result[k], v) : v;
  }
  return result;
}

function loadConfig() {
  rawConfig = {};
  if (existsSync(CONFIG_FILE)) {
    try {
      rawConfig = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    } catch (err) {
      die(`service.config.json 解析失败: ${err.message}`);
    }
  } else {
    info('未找到 service.config.json，使用默认配置（node service.mjs init 可生成）');
  }
  const cfg = deepMerge(structuredClone(DEFAULT_CONFIG), rawConfig);
  if (!MODES.has(cfg.server.mode)) {
    die(`server.mode 无效: ${cfg.server.mode}（可选 web | stdio | stdio-web）`);
  }
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(cfg.service.name)) {
    die(`service.name 无效: ${cfg.service.name}（仅限字母/数字/下划线/横线，且以字母开头）`);
  }
  if (cfg.service.startup !== 'auto' && cfg.service.startup !== 'manual') {
    die(`service.startup 无效: ${cfg.service.startup}（可选 auto | manual）`);
  }
  if (!['auto', 'nssm', 'winsw'].includes(cfg.daemon.manager)) {
    die(`daemon.manager 无效: ${cfg.daemon.manager}（可选 auto | nssm | winsw）`);
  }
  if (cfg.daemon.logRotationMB <= 0) cfg.daemon.logRotationMB = 10;
  if (cfg.daemon.healthTimeoutSec <= 0) cfg.daemon.healthTimeoutSec = 30;
  return cfg;
}

/** .env 文件解析（服务进程会自行加载，这里仅用于端口探测与 doctor） */
function envMap() {
  const file = join(ROOT, '.env');
  const map = {};
  if (!existsSync(file)) return map;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    map[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return map;
}

/** 实际生效端口：service.config.json 显式配置 > .env > 默认 */
function resolvePort(cfg) {
  const explicit = rawConfig?.server?.port;
  if (explicit) return Number(explicit);
  const env = envMap();
  if (env.PORT) return Number(env.PORT);
  return Number(cfg.server.port) || 3210;
}

/** 需要注入服务进程的环境变量（显式 port 与 server.env） */
function serviceEnv(cfg) {
  const env = {};
  const explicit = rawConfig?.server?.port;
  if (explicit) env.PORT = String(explicit);
  for (const [k, v] of Object.entries(cfg.server.env || {})) env[k] = String(v);
  return env;
}

function modeArgs(cfg) {
  switch (cfg.server.mode) {
    case 'stdio':
      return ['--stdio'];
    case 'stdio-web':
      return ['--stdio', '--web'];
    default:
      return [];
  }
}

function scriptPath(cfg) {
  return join(ROOT, cfg.server.script);
}

/**
 * 服务使用的 Node 解释器：
 * server.nodePath 显式配置（相对路径以项目根解析）> 执行本脚本的 node。
 * 适用于多版本共存环境（如原生模块按特定 ABI 编译时指定兼容的 node.exe）。
 */
function resolveNodeExe(cfg) {
  const p = rawConfig?.server?.nodePath;
  if (p && String(p).trim()) {
    const abs = resolve(ROOT, String(p));
    if (!existsSync(abs)) die(`server.nodePath 指向的文件不存在: ${p}`);
    return abs;
  }
  return process.execPath;
}

function logDir(cfg) {
  return join(ROOT, cfg.daemon.logDir || 'logs');
}

function logFile(cfg) {
  return join(logDir(cfg), 'service.log');
}

function pidFile(cfg) {
  return join(logDir(cfg), 'service.pid');
}

// ---------- 环境探测 ----------

const isWindows = process.platform === 'win32';

function requireWindows() {
  if (!isWindows) {
    die('本命令仅支持 Windows。Linux 请参考《部署指南_HTTP多人使用.md》使用 systemd。');
  }
}

function isAdmin() {
  if (!isWindows) return false;
  const r = spawnSync('net.exe', ['session'], { stdio: 'ignore' });
  return r.status === 0;
}

function requireAdmin() {
  if (!isAdmin()) {
    die('需要管理员权限：请右键“以管理员身份运行” cmd / PowerShell / Git Bash 后重试。');
  }
}

function findNssm() {
  const local = join(ROOT, 'tools', 'nssm', 'nssm.exe');
  if (existsSync(local)) return local;
  const r = spawnSync('where.exe', ['nssm'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout) {
    const first = r.stdout.split(/\r?\n/)[0].trim();
    if (first) return first;
  }
  return null;
}

async function ensureWinsw(onProgress) {
  const dir = join(ROOT, 'tools', 'winsw');
  const exe = join(dir, WINSW_FILENAME);
  if (existsSync(exe)) return exe;
  mkdirSync(dir, { recursive: true });
  for (const url of WINSW_URLS) {
    try {
      onProgress?.(`正在下载 WinSW: ${url}`);
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 200 * 1024) continue; // 防镜像返回错误页
      writeFileSync(exe, buf);
      return exe;
    } catch {
      /* 尝试下一个镜像 */
    }
  }
  return null;
}

// ---------- Windows 服务操作（PowerShell，输出为 ASCII 状态枚举，无编码问题） ----------

function serviceStatus(name) {
  // → 'Running' | 'Stopped' | 'StartPending' ... | null（未安装）
  const ps = `try { (Get-Service -Name '${name}' -ErrorAction Stop).Status } catch { exit 3 }`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  if (r.status === 3) return null;
  if (r.status !== 0) return null;
  return (r.stdout || '').trim() || null;
}

function serviceInstalled(name) {
  return serviceStatus(name) !== null;
}

function serviceControl(name, action) {
  // action: 'Start' | 'Stop' | 'Restart'
  const ps = `try { ${action}-Service -Name '${name}' -ErrorAction Stop; exit 0 } catch { Write-Host $_.Exception.Message; exit 1 }`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
  return r.status === 0;
}

// ---------- 后台进程（detached）操作 ----------

function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // Windows 上无权限访问 = 进程存在
  }
}

function readPid(cfg) {
  const file = pidFile(cfg);
  if (!existsSync(file)) return null;
  const pid = Number(readFileSync(file, 'utf8').trim());
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function rotateIfNeeded(file, maxMB) {
  if (!existsSync(file)) return;
  try {
    if (statSync(file).size > maxMB * 1024 * 1024) {
      const old = file + '.1';
      if (existsSync(old)) rmSync(old);
      renameSync(file, old);
    }
  } catch {
    /* 轮转失败不阻断启动 */
  }
}

// ---------- 健康检查 ----------

async function checkHealth(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitHealth(port, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    if (await checkHealth(port)) return true;
    await sleep(500);
  }
  return false;
}

async function reportStartup(cfg, child) {
  const mode = cfg.server.mode;
  if (mode === 'stdio') {
    info('纯 stdio 模式无 HTTP 端点可探测；该模式通常由 AI 客户端以子进程方式拉起，');
    info('常驻后台建议使用 web 或 stdio-web 模式（service.config.json 的 server.mode）。');
    await sleep(2000);
    if (child.exitCode === null) ok(`进程运行中（PID ${child.pid}）`);
    else bad(`进程已退出（exitCode=${child.exitCode}），请查日志: node service.mjs logs`);
    return;
  }
  const port = resolvePort(cfg);
  info(`等待健康检查 http://127.0.0.1:${port}/health（最多 ${cfg.daemon.healthTimeoutSec}s，首次启动需下载 embedding 模型）...`);
  if (await waitHealth(port, cfg.daemon.healthTimeoutSec)) {
    ok(`服务已就绪: http://127.0.0.1:${port}（PID ${child.pid}）`);
  } else if (child.exitCode !== null) {
    bad(`进程已退出（exitCode=${child.exitCode}），日志尾部:`);
    printLogTail(cfg, 30);
  } else {
    info('暂未通过健康检查，进程仍在运行（可能在下载 embedding 模型），稍后可执行 node service.mjs status 复查。');
  }
}

function printLogTail(cfg, lines) {
  const file = logFile(cfg);
  if (!existsSync(file)) {
    info(`（日志文件尚不存在: ${file}）`);
    return;
  }
  const content = readFileSync(file, 'utf8');
  const tail = content.split(/\r?\n/).filter((l) => l.length > 0).slice(-lines);
  console.log(tail.join('\n'));
}

// ---------- 服务安装后端 ----------

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function installNssm(nssm, cfg, args) {
  const name = cfg.service.name;
  const nodeExe = resolveNodeExe(cfg);
  const run = (params) => {
    const r = spawnSync(nssm, params, { encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error(`nssm ${params.join(' ')} 失败: ${(r.stderr || r.stdout || '').trim()}`);
    }
  };
  mkdirSync(logDir(cfg), { recursive: true });
  run(['install', name, nodeExe, scriptPath(cfg), ...args]);
  run(['set', name, 'AppDirectory', ROOT]);
  run(['set', name, 'AppStdout', logFile(cfg)]);
  run(['set', name, 'AppStderr', logFile(cfg)]);
  run(['set', name, 'AppRotateFiles', '1']);
  run(['set', name, 'AppRotateBytes', String(Math.round(cfg.daemon.logRotationMB * 1024 * 1024))]);
  run(['set', name, 'Start', cfg.service.startup === 'auto' ? 'SERVICE_AUTO_START' : 'SERVICE_DEMAND_START']);
  run(['set', name, 'AppExit', 'Default', 'Restart']);
  run(['set', name, 'AppRestartDelay', '5000']);
  const env = serviceEnv(cfg);
  if (Object.keys(env).length > 0) {
    run(['set', name, 'AppEnvironmentExtra', ...Object.entries(env).map(([k, v]) => `${k}=${v}`)]);
  }
  return true;
}

function buildWinswXml(cfg, args) {
  const env = serviceEnv(cfg);
  const nodeExe = resolveNodeExe(cfg);
  const envTags = Object.entries(env)
    .map(([k, v]) => `  <env name="${xmlEscape(k)}" value="${xmlEscape(v)}"/>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<service>
  <id>${xmlEscape(cfg.service.name)}</id>
  <name>${xmlEscape(cfg.service.displayName)}</name>
  <description>${xmlEscape(cfg.service.description)}</description>
  <executable>${xmlEscape(nodeExe)}</executable>
  <arguments>${xmlEscape(`"${scriptPath(cfg)}" ${args.join(' ')}`)}</arguments>
  <workingdirectory>${xmlEscape(ROOT)}</workingdirectory>
${envTags ? envTags + '\n' : ''}  <startmode>${cfg.service.startup === 'auto' ? 'Automatic' : 'Manual'}</startmode>
  <onfailure action="restart" delay="5 sec"/>
  <stoptimeout>15 sec</stoptimeout>
  <log mode="roll-by-size">
    <logpath>${xmlEscape(logDir(cfg))}</logpath>
    <sizeThreshold>${Math.round(cfg.daemon.logRotationMB * 1024 * 1024)}</sizeThreshold>
    <keepFiles>4</keepFiles>
  </log>
</service>
`;
}

async function installWinsw(cfg, args) {
  const src = await ensureWinsw((msg) => info(msg));
  if (!src) {
    bad('WinSW 自动下载失败（网络受限）。请手动下载后放入 tools/winsw/ 目录：');
    for (const u of WINSW_URLS) info(u);
    return false;
  }
  const dir = join(ROOT, 'tools', 'winsw');
  mkdirSync(dir, { recursive: true });
  mkdirSync(logDir(cfg), { recursive: true });
  const svcExe = join(dir, `${cfg.service.name}.exe`);
  if (resolve(src) !== resolve(svcExe)) copyFileSync(src, svcExe);
  writeFileSync(join(dir, `${cfg.service.name}.xml`), buildWinswXml(cfg, args), 'utf8');
  const r = spawnSync(svcExe, ['install'], { stdio: 'inherit' });
  return r.status === 0;
}

function readInstallMark() {
  if (!existsSync(INSTALL_MARK)) return null;
  try {
    return JSON.parse(readFileSync(INSTALL_MARK, 'utf8'));
  } catch {
    return null;
  }
}

function writeInstallMark(manager, name) {
  const dir = dirname(INSTALL_MARK);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    INSTALL_MARK,
    JSON.stringify({ manager, name, installedAt: new Date().toISOString() }, null, 2) + '\n',
    'utf8',
  );
}

// ---------- 命令实现 ----------

async function cmdStart() {
  requireWindows();
  const cfg = loadConfig();
  const name = cfg.service.name;

  if (serviceInstalled(name)) {
    const st = serviceStatus(name);
    if (st === 'Running') {
      ok(`Windows 服务 ${name} 已在运行`);
      return;
    }
    info(`通过 Windows 服务启动 ${name} ...`);
    if (!serviceControl(name, 'Start')) die('服务启动失败，可查看日志: node service.mjs logs');
    await waitHealthIfWeb(cfg);
    return;
  }

  if (!existsSync(scriptPath(cfg))) {
    die(`未找到 ${cfg.server.script}，请先执行 npm run build`);
  }
  const pid = readPid(cfg);
  if (pidAlive(pid)) die(`已在运行（PID ${pid}）。如需重启: node service.mjs restart`);

  // 端口预检：防止拉起第二个进程共用同一 data 目录（SQLITE_BUSY 风险）
  if (cfg.server.mode !== 'stdio') {
    const port = resolvePort(cfg);
    if (await checkHealth(port)) {
      die(`端口 ${port} 已有服务实例在响应（非本脚本管理的进程，PID 文件不存在）。\n  双进程共用同一 data/ 目录会触发 SQLITE_BUSY。请先停止现有实例，\n  或修改端口（service.config.json 的 server.port / .env 的 PORT）后再启动。`);
    }
  }

  if (cfg.server.mode === 'stdio') {
    info('提示: 纯 stdio 模式通常由 AI 客户端拉起子进程使用，常驻后台建议 web / stdio-web 模式。');
  }

  mkdirSync(logDir(cfg), { recursive: true });
  rotateIfNeeded(logFile(cfg), cfg.daemon.logRotationMB);

  const args = modeArgs(cfg);
  const env = { ...process.env, ...serviceEnv(cfg) };
  const out = openSync(logFile(cfg), 'a');
  appendFileSync(logFile(cfg), `\n===== ${new Date().toISOString()} 以 ${cfg.server.mode} 模式后台启动 =====\n`);

  const child = spawn(
    resolveNodeExe(cfg),
    [...(cfg.server.nodeOptions || []), scriptPath(cfg), ...args],
    { detached: true, stdio: ['ignore', out, out], cwd: ROOT, env, windowsHide: true },
  );
  child.unref();
  writeFileSync(pidFile(cfg), String(child.pid), 'utf8');
  info(`后台进程已拉起（PID ${child.pid}），日志: ${logFile(cfg)}`);
  await reportStartup(cfg, child);
}

async function waitHealthIfWeb(cfg) {
  if (cfg.server.mode === 'stdio') return;
  const port = resolvePort(cfg);
  info(`等待健康检查 http://127.0.0.1:${port}/health ...`);
  if (await waitHealth(port, cfg.daemon.healthTimeoutSec)) {
    ok(`服务已就绪: http://127.0.0.1:${port}`);
  } else {
    info('暂未通过健康检查（首次启动可能仍在下载 embedding 模型），稍后可用 node service.mjs status 复查。');
  }
}

async function cmdStop() {
  requireWindows();
  const cfg = loadConfig();
  const name = cfg.service.name;

  if (serviceInstalled(name)) {
    const st = serviceStatus(name);
    if (st !== 'Running') {
      ok(`Windows 服务 ${name} 未在运行（状态: ${st || '未知'}）`);
      return;
    }
    info(`停止 Windows 服务 ${name} ...`);
    if (serviceControl(name, 'Stop')) ok('已停止');
    else die('停止失败，可在服务管理器（services.msc）中手动停止');
    return;
  }

  const pid = readPid(cfg);
  if (!pid) die('未发现运行中的后台进程（logs/service.pid 不存在）。');
  if (!pidAlive(pid)) {
    rmSync(pidFile(cfg), { force: true });
    ok('进程已不存在，清理了过期的 PID 文件');
    return;
  }
  const r = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' });
  if (r.status === 0) {
    rmSync(pidFile(cfg), { force: true });
    ok(`已停止进程 ${pid}（及其子进程）`);
  } else {
    die(`停止失败（PID ${pid}）: ${(r.stderr || r.stdout || '').trim()}\n可手动执行: taskkill /PID ${pid} /T /F`);
  }
}

async function cmdRestart() {
  requireWindows();
  const cfg = loadConfig();
  const name = cfg.service.name;
  if (serviceInstalled(name)) {
    info(`重启 Windows 服务 ${name} ...`);
    if (serviceControl(name, 'Restart')) ok('已重启');
    else die('重启失败');
    await waitHealthIfWeb(cfg);
    return;
  }
  await cmdStop().catch(() => {});
  // stop 失败（如无进程）不阻断重启
  const pid = readPid(cfg);
  if (pid && pidAlive(pid)) die('旧进程未能停止，放弃重启');
  await cmdStart();
}

async function cmdStatus() {
  const cfg = loadConfig();
  const name = cfg.service.name;
  const port = resolvePort(cfg);
  console.log(`服务名    : ${name}`);
  console.log(`启动模式  : ${cfg.server.mode}（${modeArgs(cfg).join(' ') || '默认 HTTP'}）`);

  if (isWindows && serviceInstalled(name)) {
    console.log(`运行方式  : Windows 服务`);
    console.log(`服务状态  : ${serviceStatus(name)}`);
  } else {
    const pid = readPid(cfg);
    if (pidAlive(pid)) {
      console.log(`运行方式  : 后台进程（PID ${pid}）`);
    } else {
      if (pid) rmSync(pidFile(cfg), { force: true });
      console.log(`运行方式  : 未运行`);
    }
  }

  if (cfg.server.mode !== 'stdio') {
    const healthy = await checkHealth(port);
    console.log(`健康检查  : http://127.0.0.1:${port}/health ${healthy ? paint('32', 'ok') : paint('31', '无响应')}`);
  }
}

async function cmdInstall(autoStart = true) {
  requireWindows();
  requireAdmin();
  const cfg = loadConfig();
  const name = cfg.service.name;

  if (!existsSync(scriptPath(cfg))) {
    die(`未找到 ${cfg.server.script}，请先执行 npm run build`);
  }
  if (serviceInstalled(name)) {
    die(`服务 ${name} 已安装。重装请先执行: node service.mjs uninstall`);
  }

  const args = modeArgs(cfg);
  let manager = cfg.daemon.manager;
  if (manager === 'auto') {
    manager = findNssm() ? 'nssm' : 'winsw';
    info(`daemon.manager=auto → 选择 ${manager}`);
  }

  if (manager === 'nssm') {
    const nssm = findNssm();
    if (!nssm) {
      bad('未找到 nssm.exe。两种解决方式:');
      info('1. 从 https://nssm.cc/download 下载，放到 tools/nssm/nssm.exe 或加入 PATH');
      info('2. 修改 service.config.json 的 daemon.manager 为 "winsw"（自动下载）');
      die('任选其一后重试');
    }
    info(`使用 NSSM 安装服务（${nssm}）...`);
    try {
      installNssm(nssm, cfg, args);
    } catch (err) {
      die(err.message);
    }
    ok(`已安装 Windows 服务 ${name}（NSSM，开机自启: ${cfg.service.startup === 'auto' ? '是' : '否'}）`);
  } else if (manager === 'winsw') {
    info('使用 WinSW 安装服务...');
    if (!(await installWinsw(cfg, args))) {
      die('WinSW 安装失败');
    }
    ok(`已安装 Windows 服务 ${name}（WinSW，开机自启: ${cfg.service.startup === 'auto' ? '是' : '否'}）`);
  } else {
    die(`未知 daemon.manager: ${manager}`);
  }

  writeInstallMark(manager, name);
  info(`启动命令: node service.mjs start（或 net start ${name}）`);
  info(`运行状态: node service.mjs status`);
  info(`查看日志: node service.mjs logs`);
  info(`卸载服务: node service.mjs uninstall`);

  if (autoStart && cfg.server.mode !== 'stdio') {
    info('正在启动服务...');
    if (serviceControl(name, 'Start')) {
      await waitHealthIfWeb(cfg);
    } else {
      bad('服务启动失败，可稍后手动: node service.mjs start');
    }
  } else if (autoStart && cfg.server.mode === 'stdio') {
    info('纯 stdio 模式未自动启动（无对外端点，作为常驻服务意义有限）。');
    info('如需以 stdio 接入 AI 客户端，请参考 README 的客户端配置章节。');
  }
}

async function cmdUninstall() {
  requireWindows();
  requireAdmin();
  const cfg = loadConfig();
  const name = cfg.service.name;

  if (!serviceInstalled(name)) {
    die(`服务 ${name} 未安装`);
  }
  const st = serviceStatus(name);
  if (st === 'Running') {
    info('先停止服务...');
    if (!serviceControl(name, 'Stop')) die('停止失败，请在 services.msc 中手动停止后重试');
  }

  const mark = readInstallMark();
  let manager = mark?.manager;
  if (!['nssm', 'winsw'].includes(manager)) {
    // 无记录时推断：tools/winsw 下有同名 xml → winsw，否则找 nssm
    manager = existsSync(join(ROOT, 'tools', 'winsw', `${name}.xml`)) ? 'winsw' : findNssm() ? 'nssm' : 'winsw';
    info(`（无安装记录，推断 manager=${manager}）`);
  }

  if (manager === 'nssm') {
    const nssm = findNssm();
    if (!nssm) die('未找到 nssm.exe，无法卸载；请手动执行: nssm remove ' + name + ' confirm');
    const r = spawnSync(nssm, ['remove', name, 'confirm'], { stdio: 'inherit' });
    if (r.status !== 0) die('nssm 卸载失败');
  } else {
    const svcExe = join(ROOT, 'tools', 'winsw', `${name}.exe`);
    if (!existsSync(svcExe)) die(`未找到 ${svcExe}，无法卸载`);
    const r = spawnSync(svcExe, ['uninstall'], { stdio: 'inherit' });
    if (r.status !== 0) die('WinSW 卸载失败');
    // 清理生成的 xml 与重命名的 exe（保留 WinSW-x64.exe 源文件供下次使用）
    for (const f of [join(ROOT, 'tools', 'winsw', `${name}.xml`), svcExe]) {
      if (existsSync(f)) rmSync(f, { force: true });
    }
  }
  if (existsSync(INSTALL_MARK)) rmSync(INSTALL_MARK, { force: true });
  ok(`已卸载 Windows 服务 ${name}（日志保留在 ${logDir(cfg)}）`);
}

async function cmdLogs(lines = 50) {
  const cfg = loadConfig();
  const file = logFile(cfg);
  if (!existsSync(file)) die(`日志文件不存在: ${file}（尚未启动过？）`);
  info(`—— ${file} 最近 ${lines} 行 ——`);
  printLogTail(cfg, lines);
}

async function cmdRun() {
  const cfg = loadConfig();
  if (!existsSync(scriptPath(cfg))) {
    die(`未找到 ${cfg.server.script}，请先执行 npm run build`);
  }
  const args = modeArgs(cfg);
  info(`前台运行: ${cfg.server.mode} 模式（${modeArgs(cfg).join(' ') || 'HTTP'}），Ctrl+C 停止`);
  const child = spawn(
    resolveNodeExe(cfg),
    [...(cfg.server.nodeOptions || []), scriptPath(cfg), ...args],
    { stdio: 'inherit', cwd: ROOT, env: { ...process.env, ...serviceEnv(cfg) } },
  );
  child.on('exit', (code) => process.exit(code ?? 1));
  child.on('error', (err) => die(`启动失败: ${err.message}`));
}

async function cmdDoctor() {
  const cfg = loadConfig();
  console.log('── frag-mcp 服务环境自检 ──');
  const [major] = process.versions.node.split('.').map(Number);
  if (major >= 20) ok(`Node.js ${process.versions.node}（≥20，当前脚本解释器）`);
  else bad(`Node.js ${process.versions.node}（要求 ≥ 20）`);

  const nodeExe = resolveNodeExe(cfg);
  if (resolve(nodeExe) !== resolve(process.execPath)) {
    const ver = spawnSync(nodeExe, ['-v'], { encoding: 'utf8' });
    info(`服务将使用指定 Node: ${nodeExe}（${(ver.stdout || '').trim()}）`);
    // 原生模块按特定 ABI 编译时，指定解释器与实际运行解释器一致才有意义
    const r = spawnSync(nodeExe, ['-e', "require('better-sqlite3')"], { cwd: ROOT, encoding: 'utf8' });
    if (r.status === 0) ok('原生模块 better-sqlite3 在指定 Node 下可加载');
    else {
      bad('better-sqlite3 在指定 Node 下无法加载（ABI 不匹配）');
      info('处理: 换 server.nodePath 指向兼容版本，或执行 npm rebuild better-sqlite3');
    }
  } else {
    info(`服务将使用当前 Node: ${nodeExe}`);
    const r = spawnSync(nodeExe, ['-e', "require('better-sqlite3')"], { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) {
      bad('better-sqlite3 无法在当前 Node 下加载（ABI 不匹配）');
      info('处理: 在 service.config.json 的 server.nodePath 指定兼容的 node.exe（本项目原生模块的编译版本），或 npm rebuild better-sqlite3');
    }
  }

  if (existsSync(scriptPath(cfg))) ok(`服务入口 ${cfg.server.script} 已构建`);
  else bad(`服务入口 ${cfg.server.script} 不存在 → 执行 npm run build`);

  const webDist = join(ROOT, 'web', 'dist', 'index.html');
  if (existsSync(webDist)) ok('Web 后台前端已构建（web/dist）');
  else info('Web 后台前端未构建（可选）→ cd web && npm install && npm run build');

  const env = envMap();
  if (cfg.server.mode !== 'stdio') {
    if (env.AUTH_TOKEN && env.AUTH_TOKEN !== 'change-me-to-a-random-string') {
      ok('.env 已配置 AUTH_TOKEN');
    } else {
      bad('.env 未配置有效 AUTH_TOKEN（HTTP 模式启动会失败）');
    }
  } else {
    info('stdio 模式无需 AUTH_TOKEN');
  }

  const port = resolvePort(cfg);
  info(`端口: ${port}（来源: ${
    rawConfig?.server?.port ? 'service.config.json' : env.PORT ? '.env' : '默认'
  }）`);

  if (isWindows) {
    const nssm = findNssm();
    if (nssm) ok(`NSSM 可用（${nssm}）`);
    else info('NSSM 未安装（install 时将改用 WinSW 自动下载，或手动放到 tools/nssm/）');
    const winsw = join(ROOT, 'tools', 'winsw', WINSW_FILENAME);
    if (existsSync(winsw)) ok(`WinSW 已就绪（${winsw}）`);
    else info('WinSW 未下载（install 时会自动尝试，需可访问 GitHub 或其镜像）');
    if (isAdmin()) ok('当前终端具有管理员权限（可安装/卸载服务）');
    else info('当前终端非管理员（后台 start/stop 可用；install/uninstall 需管理员）');
    if (serviceInstalled(cfg.service.name)) {
      info(`Windows 服务已安装（状态: ${serviceStatus(cfg.service.name)}）`);
    } else {
      info(`Windows 服务未安装（node service.mjs install 可安装）`);
    }
  } else {
    info('当前非 Windows 平台：仅支持 run / doctor / status，服务托管请参考部署指南（systemd）');
  }

  if (cfg.server.mode !== 'stdio') {
    const healthy = await checkHealth(port);
    if (healthy) ok(`端口 ${port} 健康检查通过（服务正在运行）`);
    else info(`端口 ${port} 无响应（服务未运行属正常）`);
  }
}

async function cmdInit() {
  if (existsSync(CONFIG_FILE)) die(`配置文件已存在: ${CONFIG_FILE}`);
  writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8');
  ok(`已生成默认配置: ${CONFIG_FILE}`);
  info('可编辑 server.mode 切换启动模式: web | stdio | stdio-web');
}

function cmdHelp() {
  console.log(`frag-mcp 服务管理脚本

用法: node service.mjs <命令> [参数]

命令:
  run           前台运行（调试用，Ctrl+C 停止）
  start         后台启动服务（普通权限即可；已装 Windows 服务则启动服务）
  stop          停止服务（后台进程或 Windows 服务）
  restart       重启服务
  status        查看运行状态与健康检查
  install       安装为 Windows 服务（需管理员权限终端）
  uninstall     卸载 Windows 服务（需管理员权限终端）
  logs [行数]   查看最近日志（默认 50 行）
  doctor        环境自检（Node/构建/鉴权/端口/服务管理器）
  init          生成默认 service.config.json
  help          显示本帮助

启动模式（service.config.json → server.mode）:
  web        HTTP 模式（默认）      node dist/server.js
  stdio      stdio 模式             node dist/server.js --stdio
  stdio-web  stdio + 内嵌 Web 后台  node dist/server.js --stdio --web

Windows 服务后端（service.config.json → daemon.manager）:
  auto   优先 NSSM，其次 WinSW（自动下载）
  nssm   nssm.exe（PATH 或 tools/nssm/，下载: https://nssm.cc/download）
  winsw  WinSW（tools/winsw/，缺失时自动下载）

端口优先级: service.config.json 的 server.port > .env PORT > 默认 3210。
鉴权 token 等环境变量请配置在项目根 .env（服务进程自行加载）。
server.nodePath 可指定服务使用的 node.exe（多版本共存时指向与原生模块 ABI 匹配的版本，留空则用执行本脚本的 node）。`);
}

// ---------- 入口 ----------

const [, , cmd, ...rest] = process.argv;

const commands = {
  run: cmdRun,
  start: cmdStart,
  stop: cmdStop,
  restart: cmdRestart,
  status: cmdStatus,
  install: () => cmdInstall(!rest.includes('--no-start')),
  uninstall: cmdUninstall,
  logs: () => cmdLogs(Number(rest[0]) > 0 ? Number(rest[0]) : 50),
  doctor: cmdDoctor,
  init: cmdInit,
  help: cmdHelp,
};

const handler = commands[cmd || 'help'];
if (!handler) {
  console.error(`未知命令: ${cmd}`);
  cmdHelp();
  process.exit(1);
}

try {
  await handler();
} catch (err) {
  die(err?.stack || String(err));
}
