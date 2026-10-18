#!/usr/bin/env node
/**
 * 本地命令行：初始化、跑 demo、生成摘要/报告、导出日程、管理关注。
 *
 * 除了 `serve`，其余命令都直接读写数据库（SQLite WAL 支持多进程），
 * 因此不需要 Hub 在跑；`status` 会额外探测 Hub 以显示适配器状态。
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  createLogger,
  defaultConfigPath,
  ensureDirs,
  generateToken,
  initConfig,
  loadConfig,
  resolvePaths,
} from './config.js';
import { demoFollows, demoMessages } from '../fixtures/demo.js';
import { Ingest } from './ingest.js';
import { probeHub, startHub } from './hub.js';
import { GroupDigestService } from './service.js';
import { Store } from './store.js';
import { formatDateTime } from './util/time.js';

const HELP = `萨勒芬妮 group-digest

用法：node src/cli.js <命令> [参数]

  init                         生成 config.json（随机 token）
  serve                        启动 Hub（HTTP + OneBot + 定时摘要）
  status                       查看配置、统计与 Hub 连接状态
  demo [--reset]               用演示数据跑通「入库 → 摘要 → 报告 → 日程」
  digest [--hours 12]          预览摘要与报告 Markdown
  report [--hours 12]          创建待审报告（不外发）
  reports [--status pending]   列出报告
  show <报告ID>                打印报告 Markdown
  approve <报告ID> [--channels file,dsh,qq]
                               批准并发送（CLI 即人工操作）
  reject <报告ID> [--reason 文本]
  schedule [--days 14]         查看未来日程
  export [--format ics|csv|md] 导出一段时间的日程
  messages [--hours 12] [--chat ID] [--user ID] [--q 关键词]
  watch <platform> <chatId> [--off]
  follow <platform> <userId> [--group chatId] [--name 名字] [--priority high] [--note 备注]
  unfollow <platform> <userId> [--group chatId]
  notify [--limit 20]          取出未投递通知（调试唤醒插件用）
  url                          打印本机 API 地址与 token

所有命令都支持 --config <路径> 指定配置文件。`;

function parseArgv(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq >= 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function openLocal({ configPath, storageDir = null }) {
  let loaded = loadConfig(configPath);
  if (!loaded.exists) {
    throw new Error(`找不到配置文件 ${configPath}，先运行：node src/cli.js init`);
  }
  const config = loaded.config;
  if (storageDir) config.storage.dir = storageDir;
  const paths = resolvePaths(config, configPath);
  ensureDirs(paths);
  const log = createLogger({ level: config.logging.level, file: paths.logs });
  const store = new Store(paths.db);
  const service = new GroupDigestService({ config, store, paths, log });
  return {
    config,
    paths,
    store,
    service,
    log,
    close: () => {
      store.close();
      log.close();
    },
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgv(argv);
  const cmd = positional[0] ?? 'help';
  const configPath = flags.config ? path.resolve(String(flags.config)) : defaultConfigPath();

  if (cmd === 'help' || flags.help) {
    console.log(HELP);
    return;
  }

  if (cmd === 'init') {
    const result = initConfig(configPath);
    if (!result.created) {
      console.log(`配置已存在：${configPath}（未覆盖）`);
    } else {
      const { config } = loadConfig(configPath);
      console.log(`已生成配置：${configPath}`);
      console.log(`本机 API：http://${config.server.host}:${config.server.port}`);
      console.log(`token：${config.server.token}`);
      console.log('');
      console.log('下一步：');
      console.log('  1) 把 OneBot 桥（NapCat/Lagrange）的 WS 地址填进 adapters.onebot.url');
      console.log('  2) node src/cli.js demo   先看完整效果');
      console.log('  3) node src/hub.js        启动采集与定时摘要');
    }
    return;
  }

  if (cmd === 'url') {
    const { config } = loadConfig(configPath);
    console.log(`http://${config.server.host}:${config.server.port}`);
    console.log(`token: ${config.server.token}`);
    return;
  }

  if (cmd === 'serve') {
    const hub = await startHub({ configPath });
    const shutdown = async () => {
      await hub.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  if (cmd === 'demo') {
    const { config } = loadConfig(configPath);
    if (flags.reset) {
      const base = path.resolve(path.dirname(configPath), 'state', 'demo');
      if (fs.existsSync(base)) fs.rmSync(base, { recursive: true, force: true });
      console.log(`已清空演示数据：${base}`);
    }
    const local = openLocal({ configPath, storageDir: path.join('state', 'demo') });
    try {
      const now = Date.now();
      const ingest = new Ingest({ store: local.store, config: local.config });
      let inserted = 0;
      for (const message of demoMessages(now)) {
        if (ingest.ingest(message).inserted) inserted += 1;
      }
      for (const follow of demoFollows()) {
        local.service.addFollow(follow);
      }
      const reportResult = local.service.createReport({
        since: new Date(now - 12 * 3_600_000).toISOString(),
        until: new Date(now).toISOString(),
        title: '演示 · 群聊情报日报',
        source: 'demo',
      });
      const schedule = local.service.schedule({
        since: new Date(now - 12 * 3_600_000).toISOString(),
        until: new Date(now).toISOString(),
      });
      const exported = local.service.exportSchedule({
        since: new Date(now - 12 * 3_600_000).toISOString(),
        until: new Date(now + 30 * 86_400_000).toISOString(),
        format: 'ics',
      });

      console.log('演示数据已写入独立数据库（不影响真实消息）');
      console.log(`  新增消息：${inserted} 条`);
      console.log(`  识别日程：${schedule.count} 项`);
      console.log(`  摘要：${reportResult.digest?.overview ?? ''}`);
      if (reportResult.created) {
        console.log(`  待审报告：${reportResult.report.id}`);
        console.log(`  报告文件：${reportResult.report.filePath}`);
        console.log(`  审核页面：http://${local.config.server.host}:${local.config.server.port}/review/${reportResult.report.id}?token=${local.config.server.token}`);
        console.log('  注意：审核页面需要 Hub 在运行（node src/hub.js）才能打开。');
      }
      if (exported.path) console.log(`  日程 ICS：${exported.path}`);
      console.log('');
      console.log('查看完整报告：');
      console.log(`  node src/cli.js show ${reportResult.report?.id ?? '<id>'} --config ${configPath}`);
    } finally {
      local.close();
    }
    return;
  }

  if (cmd === 'status') {
    const { config } = loadConfig(configPath);
    const url = `http://${config.server.host}:${config.server.port}`;
    const health = await probeHub(url);
    const local = openLocal({ configPath });
    try {
      const stats = local.store.stats();
      console.log(`配置：${configPath}`);
      console.log(`Hub：${health ? `运行中（${url}，v${health.version}）` : `未运行（${url}）`}`);
      console.log(`数据库：${local.paths.db}`);
      console.log(
        `统计：消息 ${stats.messages} · 群 ${stats.groups} · 关注 ${stats.follows} · 报告 ${stats.reports}（待审 ${stats.pendingReports}）· 日程 ${stats.events} · 未投递通知 ${stats.undeliveredNotifications}`,
      );
      const last = local.store.getMeta('scheduler', null);
      if (last) console.log(`调度器：上次检查 ${last.lastTickAt}`);
      if (health) {
        const res = await fetch(`${url}/api/status`, {
          headers: { Authorization: `Bearer ${config.server.token}` },
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          const data = await res.json();
          console.log(`适配器：${JSON.stringify(data.adapters, null, 2)}`);
        }
      }
    } finally {
      local.close();
    }
    return;
  }

  const local = openLocal({ configPath });
  try {
    if (cmd === 'digest') {
      const hours = Number(flags.hours ?? local.config.digest.lookbackHours) || 12;
      const now = Date.now();
      const digest = local.service.previewDigest({
        since: new Date(now - hours * 3_600_000).toISOString(),
        until: new Date(now).toISOString(),
      });
      console.log(digest.markdown);
      return;
    }

    if (cmd === 'report') {
      const hours = Number(flags.hours ?? local.config.digest.lookbackHours) || 12;
      const now = Date.now();
      const result = local.service.createReport({
        since: new Date(now - hours * 3_600_000).toISOString(),
        until: new Date(now).toISOString(),
        source: 'cli',
      });
      if (!result.created) {
        console.log(result.message ?? '未生成报告');
        return;
      }
      console.log(`已创建待审报告：${result.report.id}`);
      console.log(`文件：${result.report.filePath}`);
      console.log(`审核页：http://${local.config.server.host}:${local.config.server.port}/review/${result.report.id}?token=${local.config.server.token}`);
      console.log('批准：node src/cli.js approve ' + result.report.id);
      return;
    }

    if (cmd === 'reports') {
      const list = local.service.listReports({ status: flags.status, limit: Number(flags.limit ?? 20) });
      if (!list.count) {
        console.log('没有报告。');
        return;
      }
      for (const report of list.reports) {
        console.log(`${report.id}  [${report.status}]  ${report.title}`);
      }
      return;
    }

    if (cmd === 'show') {
      const id = positional[1];
      if (!id) throw new Error('用法：show <报告ID>');
      console.log(local.service.getReport(id).markdown);
      return;
    }

    if (cmd === 'approve') {
      const id = positional[1];
      if (!id) throw new Error('用法：approve <报告ID>');
      const channels = flags.channels ? String(flags.channels).split(',').map((s) => s.trim()).filter(Boolean) : undefined;
      const result = await local.service.approveReport(id, {
        approvedBy: 'cli',
        channels,
        confirmed: true,
      });
      console.log(JSON.stringify(result.delivery ?? result, null, 2));
      return;
    }

    if (cmd === 'reject') {
      const id = positional[1];
      if (!id) throw new Error('用法：reject <报告ID>');
      const report = local.service.rejectReport(id, String(flags.reason ?? ''));
      console.log(`已驳回：${report.id}`);
      return;
    }

    if (cmd === 'schedule') {
      if (flags.export) {
        const result = local.service.exportSchedule({ format: flags.export });
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      const days = Number(flags.days ?? 14);
      const upcoming = local.service.listUpcomingEvents({ days });
      console.log(upcoming.markdown);
      console.log(`\n共 ${upcoming.count} 项（未来 ${days} 天）`);
      return;
    }

    if (cmd === 'export') {
      const format = String(flags.format ?? 'ics');
      const now = Date.now();
      const since = flags.since ?? new Date(now - 7 * 86_400_000).toISOString();
      const until = flags.until ?? new Date(now + 30 * 86_400_000).toISOString();
      const result = local.service.exportSchedule({ since, until, format });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (cmd === 'messages') {
      const hours = Number(flags.hours ?? 12) || 12;
      const now = Date.now();
      const result = local.service.queryMessages({
        since: new Date(now - hours * 3_600_000).toISOString(),
        until: new Date(now).toISOString(),
        chatId: flags.chat,
        userId: flags.user,
        q: flags.q,
        limit: Number(flags.limit ?? 100),
      });
      for (const m of result.messages) {
        console.log(`${m.time}  [${m.chatName}] ${m.senderName}${m.follow ? '★' : ''}：${m.text}`);
      }
      console.log(`\n共 ${result.count} 条`);
      return;
    }

    if (cmd === 'watch') {
      const [, platform, chatId] = positional;
      if (!platform || !chatId) throw new Error('用法：watch <platform> <chatId> [--off]');
      const group = local.service.setWatch(platform, chatId, !flags.off);
      console.log(JSON.stringify(group, null, 2));
      return;
    }

    if (cmd === 'follow') {
      const [, platform, userId] = positional;
      if (!platform || !userId) throw new Error('用法：follow <platform> <userId> [--group chatId]');
      const follow = local.service.addFollow({
        platform,
        userId,
        chatId: flags.group ?? '*',
        userName: flags.name,
        priority: flags.priority ?? 'normal',
        note: flags.note ?? '',
      });
      console.log(JSON.stringify(follow, null, 2));
      return;
    }

    if (cmd === 'unfollow') {
      const [, platform, userId] = positional;
      if (!platform || !userId) throw new Error('用法：unfollow <platform> <userId> [--group chatId]');
      console.log(JSON.stringify(local.service.removeFollow({ platform, userId, chatId: flags.group ?? '*' })));
      return;
    }

    if (cmd === 'notify') {
      const result = local.service.drainNotifications({ limit: Number(flags.limit ?? 20), markDelivered: false });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`未知命令：${cmd}\n`);
    console.log(HELP);
    process.exitCode = 1;
  } finally {
    local.close();
  }
}

main().catch((err) => {
  console.error(`错误：${err.message}`);
  if (process.env.GROUPDIGEST_DEBUG) console.error(err.stack);
  process.exit(1);
});
