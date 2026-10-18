#!/usr/bin/env node
/**
 * 一键启动器：
 *   1. 确保 Hub 在跑（没有就后台拉起）
 *   2. 确保 QQ 在跑，并且带 --force-renderer-accessibility（否则 UIA 读不到）
 *   3. 打开本机状态页
 *
 * 不修改 QQ 安装目录，只决定“怎么启动 QQ”。用户随时可以自己正常启动 QQ，
 * 只是那样会失去界面读取能力，启动器检测到后会自动重启一次。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { loadConfig, defaultConfigPath, PKG_ROOT, resolvePaths, ensureDirs } from './config.js';
import { probeHub } from './hub.js';
import { runUia } from './adapters/qq-uia.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findQqPath(config) {
  const configured = config.adapters.qqUia?.qqPath;
  if (configured && fs.existsSync(configured)) return configured;
  const candidates = [
    'D:\\浏览器软件下载\\QQ.exe',
    'C:\\Program Files\\Tencent\\QQNT\\QQ.exe',
    'C:\\Program Files (x86)\\Tencent\\QQ\\Bin\\QQ.exe',
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'QQ', 'QQ.exe'),
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) ?? null;
}

function qqProcesses() {
  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-Command', "(Get-Process QQ -ErrorAction SilentlyContinue | Measure-Object).Count"],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
    });
    child.on('close', () => resolve(Number.parseInt(out.trim(), 10) || 0));
  });
}

async function ensureHub({ configPath, config, log }) {
  const url = `http://${config.server.host}:${config.server.port}`;
  if (await probeHub(url)) return { url, started: false };
  log(`Hub 未运行，后台启动（${url}）`);
  const child = spawn('node', [path.join(PKG_ROOT, 'src', 'hub.js')], {
    cwd: PKG_ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, GROUPDIGEST_CONFIG: configPath },
  });
  child.unref();
  for (let i = 0; i < 30; i += 1) {
    await sleep(400);
    if (await probeHub(url)) return { url, started: true };
  }
  throw new Error('Hub 启动超时，请手动运行 node src/hub.js 查看错误');
}

async function startQq(qqPath, log) {
  log(`启动 QQ（无障碍模式）：${qqPath}`);
  const child = spawn(qqPath, ['--force-renderer-accessibility'], {
    cwd: path.dirname(qqPath),
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
}

async function restartQq(qqPath, log) {
  log('关闭当前 QQ（需要带无障碍参数重启一次）');
  await new Promise((resolve) => {
    const child = spawn('taskkill', ['/F', '/IM', 'QQ.exe'], { windowsHide: true, stdio: 'ignore' });
    child.on('close', resolve);
  });
  await sleep(2500);
  await startQq(qqPath, log);
}

async function main() {
  const configPath = defaultConfigPath();
  const loaded = loadConfig(configPath);
  if (!loaded.exists) {
    throw new Error(`找不到配置文件 ${configPath}，先运行 node src/cli.js init`);
  }
  const config = loaded.config;
  const paths = resolvePaths(config, configPath);
  ensureDirs(paths);
  const log = (message) => process.stdout.write(`[group-digest] ${message}\n`);

  const hub = await ensureHub({ configPath, config, log });
  log(`Hub：${hub.url}`);

  const qqPath = findQqPath(config);
  if (!qqPath) {
    log('未找到 QQ.exe。可以在 config.json 的 adapters.qqUia.qqPath 里手动指定。');
  } else {
    const count = await qqProcesses();
    let sessionsOk = false;
    if (count > 0) {
      const result = await runUia('sessions', {}, { timeoutMs: 15000 }).catch(() => null);
      sessionsOk = Boolean(result?.ok && (result.sessions?.length ?? 0) > 0);
      log(sessionsOk ? `QQ 已运行，可读取 ${result.sessions.length} 个会话` : 'QQ 已运行，但读不到界面（可能缺少无障碍参数）');
    }
    if (!sessionsOk && config.adapters.qqUia?.restartIfNeeded !== false) {
      await restartQq(qqPath, log);
      log('等待 QQ 登录并建立会话列表（最多 25 秒）…');
      for (let i = 0; i < 25; i += 1) {
        await sleep(1000);
        const result = await runUia('sessions', {}, { timeoutMs: 10000 }).catch(() => null);
        if (result?.ok && (result.sessions?.length ?? 0) > 0) {
          sessionsOk = true;
          log(`QQ 已就绪：${result.sessions.length} 个会话`);
          break;
        }
      }
      if (!sessionsOk) {
        log('仍未读到会话：QQ 可能停在登录界面，请先登录，然后重新打开本启动器。');
      }
    }
  }

  const appUrl = `${hub.url}/app?token=${encodeURIComponent(config.server.token)}`;
  const setupUrl = `${hub.url}/setup?token=${encodeURIComponent(config.server.token)}`;
  log(`应用：${appUrl}`);
  if (config.launcher?.openBrowser !== false && process.env.GROUPDIGEST_NO_BROWSER !== '1') {
    openAppWindow(appUrl, paths, log);
  }
}

/** 用 Edge/Chrome 的 --app 模式开一个无地址栏的独立窗口。 */
function openAppWindow(url, paths, log) {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  const browser = candidates.find((candidate) => fs.existsSync(candidate));
  if (!browser) {
    log('未找到 Edge/Chrome，改用默认浏览器打开');
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return;
  }
  const profile = path.join(paths.base, 'browser-profile');
  fs.mkdirSync(profile, { recursive: true });
  const child = spawn(
    browser,
    [
      `--app=${url}`,
      '--window-size=1280,860',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
    ],
    { detached: true, stdio: 'ignore', windowsHide: false },
  );
  child.unref();
  log('已打开应用窗口');
}

main().catch((err) => {
  process.stderr.write(`[group-digest] 启动失败：${err.message}\n`);
  process.exit(1);
});
