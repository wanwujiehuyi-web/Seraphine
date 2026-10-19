/**
 * Hub 主进程：加载配置 → 开库 → 适配器 → HTTP → 调度器。
 *
 * 单实例：端口被占用时先探 /health，如果已经是自己人就安静退出，
 * 避免 DSH 插件自动拉起与手动 `npm start` 打架。
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { OneBotAdapter } from './adapters/onebot.js';
import { QqUiaAdapter } from './adapters/qq-uia.js';
import { WechatOcrAdapter } from './adapters/wechat-ocr.js';
import { startCacheCleaner } from './cache.js';
import {
  createLogger,
  defaultConfigPath,
  ensureDirs,
  initConfig,
  loadConfig,
  resolvePaths,
} from './config.js';
import { normalizeOneBot } from './ingest.js';
import { Ingest } from './ingest.js';
import { createHttpServer } from './http.js';
import { Scheduler } from './scheduler.js';
import { GroupDigestService } from './service.js';
import { Store } from './store.js';

export async function startHub({
  configPath = defaultConfigPath(),
  config: configOverride = null,
  port = null,
  host = null,
  autoInit = true,
  startScheduler = true,
  createSocket,
} = {}) {
  let loaded = loadConfig(configPath);
  if (!loaded.exists && autoInit) {
    initConfig(configPath);
    loaded = loadConfig(configPath);
  }
  const config = configOverride ?? loaded.config;
  if (port !== null) config.server.port = Number(port);
  if (host) config.server.host = host;

  const paths = resolvePaths(config, configPath);
  ensureDirs(paths);

  const log = createLogger({ level: config.logging.level, file: paths.logs });
  const store = new Store(paths.db);
  const ingest = new Ingest({ store, config, log: (m) => log.debug(m) });
  const service = new GroupDigestService({ config, store, paths, log });
  const scheduler = new Scheduler({ config, service, log });

  let adapter = null;
  let qqUia = null;
  let wechatOcr = null;
  if (config.adapters.qqUia?.enabled) {
    qqUia = new QqUiaAdapter({
      config,
      store,
      log,
      onMessage: (message) => {
        const result = ingest.ingest(message);
        if (result.inserted) {
          log.debug(`[uia] + ${message.chatName} / ${message.senderName}：${message.text.slice(0, 60)}`);
        }
      },
    });
  }
  if (config.adapters.wechatOcr?.enabled) {
    wechatOcr = new WechatOcrAdapter({
      config,
      store,
      paths,
      log,
      onMessage: (message) => {
        const result = ingest.ingest(message);
        if (result.inserted) log.debug(`[wechat] + ${message.chatName}（${message.text.length} 字）`);
      },
    });
  }
  const runtime = () => ({
    onebot: adapter ? adapter.stats : { enabled: false, status: 'disabled' },
    qqUia: qqUia ? qqUia.stats : { enabled: false, status: 'disabled' },
    wechatOcr: wechatOcr ? wechatOcr.stats : { enabled: false, status: 'disabled' },
    webhook: { enabled: Boolean(config.adapters.webhook.enabled) },
    scheduler: { enabled: startScheduler, slots: config.digest.slots },
  });
  service.setRuntime(runtime);

  const server = createHttpServer({ service, config, ingest, log, runtime, qq: qqUia, wechat: wechatOcr, paths, configPath });
  const httpServer = await listen(server, config.server.host, config.server.port);
  const actualPort = httpServer.address()?.port ?? config.server.port;
  const url = `http://${config.server.host}:${actualPort}`;

  // 记录真实端口，便于插件与 CLI 找到它（端口配 0 时尤其重要）。
  store.setMeta('server', { url, host: config.server.host, port: actualPort });

  if (config.adapters.onebot.enabled) {
    adapter = new OneBotAdapter({
      config: config.adapters.onebot,
      log,
      createSocket,
      onEvent: (event) => {
        const message = normalizeOneBot(event, { platform: 'qq', adapter: 'onebot' });
        if (!message) return;
        const include = config.adapters.onebot.includeGroups ?? [];
        if (include.length && message.chatType === 'group' && !include.includes(message.chatId)) {
          return;
        }
        const result = ingest.ingest(message);
        if (result.inserted) {
          log.debug(`+ ${message.chatName} / ${message.senderName}：${message.text.slice(0, 60)}`);
        }
      },
      onReady: () => {
        syncGroupNames({ adapter, store, log }).catch((err) => log.warn(`同步群名失败：${err.message}`));
      },
    });
    adapter.start();
  }

  qqUia?.start();
  wechatOcr?.start();

  if (startScheduler) scheduler.start();
  const stopCacheCleaner = startCacheCleaner({ paths, config, log });

  try {
    fs.writeFileSync(paths.pid, String(process.pid), 'utf8');
  } catch {
    /* 非关键 */
  }

  log.info(`Hub 已启动：${url}（config=${configPath}）`);

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    scheduler.stop();
    stopCacheCleaner();
    qqUia?.stop();
    wechatOcr?.stop();
    await adapter?.stop();
    await new Promise((resolve) => httpServer.close(() => resolve()));
    store.close();
    try {
      fs.unlinkSync(paths.pid);
    } catch {
      /* 可能已被清理 */
    }
    log.close();
  }

  return {
    config,
    paths,
    store,
    service,
    adapter,
    qqUia,
    wechatOcr,
    scheduler,
    server: httpServer,
    url,
    port: actualPort,
    close,
    log,
  };
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function syncGroupNames({ adapter, store, log }) {
  const groups = await adapter.syncGroupList();
  if (!groups.length) return;
  let renamed = 0;
  for (const group of groups) {
    if (!group.name) continue;
    const existing = store.getGroup('qq', group.chatId);
    if (existing && existing.name !== group.name) {
      store.renameGroup('qq', group.chatId, group.name);
      renamed += 1;
    }
  }
  if (renamed) log.info(`已更新 ${renamed} 个群名`);
}

/** 探测端口上是否已经有本 Hub 在跑。 */
export function probeHub(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(`${url}/health`, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve(json?.name === 'group-digest' ? json : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

async function main() {
  const configPath = defaultConfigPath();
  let override = null;
  try {
    const loaded = loadConfig(configPath);
    override = loaded.config;
  } catch (err) {
    process.stderr.write(`配置读取失败：${err.message}\n`);
    process.exit(1);
  }

  // 已有实例：直接退出，不抢端口。
  if (override.server.port) {
    const existing = await probeHub(`http://${override.server.host}:${override.server.port}`);
    if (existing) {
      process.stderr.write(
        `[group-digest] ${override.server.host}:${override.server.port} 已有实例在运行（pid 未知），本次启动退出。\n`,
      );
      return;
    }
  }

  let hub;
  try {
    hub = await startHub({ configPath, config: override });
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(`端口 ${override.server.port} 已被占用，且探测不到本 Hub。请改 server.port。\n`);
      process.exit(1);
    }
    throw err;
  }

  const shutdown = async (signal) => {
    process.stderr.write(`[group-digest] 收到 ${signal}，正在退出…\n`);
    await hub.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => {
    process.stderr.write(`[group-digest] 未处理的 Promise 拒绝：${err?.stack ?? err}\n`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    process.stderr.write(`[group-digest] 启动失败：${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
