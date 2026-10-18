#!/usr/bin/env node
/**
 * MCP stdio 服务器：把群聊情报能力暴露给 DSH。
 *
 * 工具直接读写本地数据库（不依赖 Hub 是否在跑），只有适配器状态会去探测 Hub。
 * stdout 只能出现 JSON-RPC 消息，日志一律走 stderr。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { createLogger, defaultConfigPath, ensureDirs, initConfig, loadConfig, resolvePaths } from './config.js';
import { GroupDigestService } from './service.js';
import { Store } from './store.js';

const SERVER_NAME = 'group-digest';
const SERVER_VERSION = '0.1.0';
const SUPPORTED_PROTOCOLS = ['2026-07-28', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];
const FALLBACK_PROTOCOL = '2025-06-18';

const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

const writeStderr = (line) => process.stderr.write(`[group-digest-mcp] ${line}\n`);

let configPath = defaultConfigPath();
let loaded = loadConfig(configPath);
if (!loaded.exists) {
  // npm 全局安装时包目录通常只读，配置落到用户目录；本机开发仍优先包根 config.json。
  if (!process.env.GROUPDIGEST_CONFIG) {
    const userConfig = path.join(os.homedir(), '.seraphine', 'config.json');
    if (!fs.existsSync(userConfig)) initConfig(userConfig);
    configPath = userConfig;
    loaded = loadConfig(configPath);
  }
}
if (!loaded.exists) {
  writeStderr(`找不到配置文件 ${configPath}。先运行：seraphine init`);
  process.exit(1);
}
const config = loaded.config;
const paths = resolvePaths(config, configPath);
ensureDirs(paths);
const log = createLogger({ level: config.logging.level, file: paths.logs });
const store = new Store(paths.db);
const service = new GroupDigestService({ config, store, paths, log });

writeStderr(`启动：db=${paths.db} node=${process.version}`);

// --------------------------------------------------------------------- 工具

const TOOLS = [
  {
    name: 'group_status',
    description:
      '查看群聊情报服务的状态：采集适配器是否连接、消息/群/关注/报告统计、时区、外发通道、审核策略。排查问题先看这个。',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'group_list',
    description: '列出已采集到的群（按最后活跃时间排序），包含群名、消息数、是否纳入摘要（watched）。',
    inputSchema: {
      type: 'object',
      properties: {
        watchedOnly: { type: 'boolean', description: '只列出纳入摘要的群，默认 false。' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'group_watch',
    description:
      '把某个群纳入或移出摘要范围。chatId 用 group_list 返回的值；watched=false 表示以后不再统计这个群。',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', description: 'qq 或 wechat。' },
        chatId: { type: 'string', description: '群 ID（group_list 的 chatId）。' },
        watched: { type: 'boolean', description: 'true 纳入摘要，false 排除。默认 true。' },
      },
      required: ['platform', 'chatId'],
      additionalProperties: false,
    },
  },
  {
    name: 'group_follow',
    description:
      '关注群内重点用户。之后该用户的发言会进入「重点用户动态」，可选即时提醒。chatId 传 * 表示所有群；priority=high 会排在最前。',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', description: 'qq 或 wechat。' },
        userId: { type: 'string', description: '用户 ID（消息里的 senderId）。' },
        chatId: { type: 'string', description: '限定群 ID；* 表示所有群。默认 *。' },
        name: { type: 'string', description: '显示名，便于报告可读。' },
        priority: { type: 'string', enum: ['high', 'normal', 'low'], description: '默认 normal。' },
        note: { type: 'string', description: '备注，例如「队长，通知以他为准」。' },
      },
      required: ['platform', 'userId'],
      additionalProperties: false,
    },
  },
  {
    name: 'group_unfollow',
    description: '取消关注某个用户。',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string' },
        userId: { type: 'string' },
        chatId: { type: 'string', description: '默认 *。' },
      },
      required: ['platform', 'userId'],
      additionalProperties: false,
    },
  },
  {
    name: 'group_follows',
    description: '列出当前关注的重点用户。',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'group_messages',
    description:
      '检索群消息。可按群、发送者、时间范围、关键词过滤。用于核对细节、找原话。返回每条消息的时间、群、发送者与正文。',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', description: 'qq / wechat，可选。' },
        chatId: { type: 'string', description: '群 ID，可选。' },
        userId: { type: 'string', description: '发送者 ID，可选。' },
        since: { type: 'string', description: '开始时间，YYYY-MM-DD 或 ISO。' },
        until: { type: 'string', description: '结束时间，YYYY-MM-DD 或 ISO。' },
        q: { type: 'string', description: '正文关键词。' },
        limit: { type: 'number', description: '最多返回多少条，默认 100，上限 500。' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'group_digest',
    description:
      '生成一段时间的群聊摘要（不入库、不外发）：重点用户动态、关键消息、公告、待确认问题、链接、日程、群活跃度，并渲染成 Markdown。适合先给用户看要点。',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: '开始时间；不传则回看 digest.lookbackHours。' },
        until: { type: 'string', description: '结束时间；默认现在。' },
        chatIds: { type: 'array', items: { type: 'string' }, description: '只统计这些群。' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'group_report_create',
    description:
      '创建一份待审核报告（会落库并生成 .md 文件，但绝不会自动发送）。创建后把摘要给用户看，等待用户明确批准。定时任务也是走这条路径。',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: '开始时间；默认回看 lookbackHours。' },
        until: { type: 'string', description: '结束时间；默认现在。' },
        title: { type: 'string', description: '报告标题，可选。' },
        channels: {
          type: 'array',
          items: { type: 'string', enum: ['file', 'dsh', 'qq', 'wechat'] },
          description: '批准后投递的通道；不传用配置默认值。',
        },
        chatIds: { type: 'array', items: { type: 'string' }, description: '只统计这些群。' },
        allowEmpty: { type: 'boolean', description: '没有消息也生成空报告，默认 false。' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'group_reports',
    description:
      '报告队列操作。action=list 列出报告；get 看正文；update 用新 Markdown 覆盖待审报告；reject 驳回。批准发送请用 group_report_approve。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'update', 'reject'] },
        id: { type: 'string', description: '报告 ID（get/update/reject 必填）。' },
        markdown: { type: 'string', description: 'update 时的新正文（完整替换）。' },
        reason: { type: 'string', description: 'reject 原因。' },
        status: { type: 'string', enum: ['pending', 'approved', 'sent', 'rejected'], description: 'list 过滤。' },
        limit: { type: 'number', description: 'list 条数，默认 20。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'group_report_approve',
    description:
      '【仅在用户明确批准后调用】批准报告并按通道发送（文件 / DSH / QQ / 微信）。必须传 confirmed=true。没有用户这一轮的明确同意，绝不能调用；也不要因为「报告看起来没问题」自行批准。发送失败会返回每个通道的原因。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '报告 ID。' },
        confirmed: { type: 'boolean', description: '必须为 true，表示用户已明确批准。' },
        channels: {
          type: 'array',
          items: { type: 'string', enum: ['file', 'dsh', 'qq', 'wechat'] },
          description: '覆盖投递通道，可选。',
        },
      },
      required: ['id', 'confirmed'],
      additionalProperties: false,
    },
  },
  {
    name: 'group_schedule',
    description:
      '从群消息提取日程 / 查看未来日程 / 导出日历。action=list 看未来 N 天；extract 从指定时段消息重新提取；export 生成 .ics（默认）或 .csv/.md 文件并返回路径。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'extract', 'export'] },
        since: { type: 'string', description: 'extract/export 的开始时间。' },
        until: { type: 'string', description: 'extract/export 的结束时间。' },
        days: { type: 'number', description: 'list 时看未来多少天，默认 14。' },
        format: { type: 'string', enum: ['ics', 'csv', 'md'], description: 'export 格式，默认 ics。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'group_qq_read',
    description:
      '直接读取本机已登录 QQ 的当前界面。传 group（群名）会打开该群并读取最近消息（会将该群标记为已读）；不传则只读当前已打开的会话。用于补全会话列表只能看到最后一条的缺口。',
    inputSchema: {
      type: 'object',
      properties: {
        group: { type: 'string', description: '群名，例如 group_list 返回的 name；不传则读当前会话。' },
        limit: { type: 'number', description: '最多返回多少条，默认 30。' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'group_wechat_preview',
    description:
      '截取本机已登录微信的窗口并做中文 OCR，返回识别文字与截图路径。窗口会短暂弹出再恢复。只能读到当前可见内容（会话列表 + 当前聊天），属于预览，不是完整消息流。',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'group_notifications',
    description:
      '查看或取出内部通知（待审报告、重点用户提醒、投递结果、调度错误）。action=list 只查看；drain 取出并标记已投递（通常由 DSH 唤醒插件自动做）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'drain'] },
        limit: { type: 'number', description: '默认 20。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
];

function jsonText(value) {
  return JSON.stringify(value, null, 2);
}

function reviewUrl(reportId) {
  return `http://${config.server.host}:${config.server.port}/review/${reportId}?token=${config.server.token}`;
}

async function probeAdapterStatus() {
  try {
    const res = await fetch(`http://${config.server.host}:${config.server.port}/api/status`, {
      headers: { Authorization: `Bearer ${config.server.token}` },
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return { hub: 'unreachable', httpStatus: res.status };
    const data = await res.json();
    return { hub: 'running', adapters: data.adapters };
  } catch {
    return {
      hub: 'down',
      note: 'Hub 未运行：不会采集新消息，定时摘要也不会触发。启动 node src/hub.js，或让 DSH 插件 autoStart。',
    };
  }
}

const handlers = {
  async group_status() {
    const status = service.publicStatus();
    return jsonText({ ...status, hub: await probeAdapterStatus() });
  },

  async group_list(args = {}) {
    const result = service.listGroups();
    return jsonText(
      args.watchedOnly ? { ...result, groups: result.groups.filter((g) => g.watched) } : result,
    );
  },

  async group_watch(args = {}) {
    const group = service.setWatch(args.platform, args.chatId, args.watched !== false);
    return jsonText({ ok: true, group });
  },

  async group_follow(args = {}) {
    const follow = service.addFollow({
      platform: args.platform,
      userId: args.userId,
      chatId: args.chatId ?? '*',
      userName: args.name,
      priority: args.priority ?? 'normal',
      note: args.note ?? '',
    });
    return jsonText({ ok: true, follow, hint: '之后的摘要会把这些人的发言单列。' });
  },

  async group_unfollow(args = {}) {
    return jsonText({ ok: true, ...service.removeFollow({ platform: args.platform, userId: args.userId, chatId: args.chatId ?? '*' }) });
  },

  async group_follows() {
    return jsonText(service.listFollows());
  },

  async group_messages(args = {}) {
    const result = service.queryMessages(args);
    return jsonText(result);
  },

  async group_qq_read(args = {}) {
    const base = `http://${config.server.host}:${config.server.port}`;
    let res;
    try {
      res = await fetch(`${base}/api/qq/read`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${config.server.token}`,
        },
        body: JSON.stringify({ group: args.group, limit: args.limit ?? 30 }),
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      return jsonText({
        ok: false,
        error: 'Hub 未运行或 QQ 适配器未启用。先启动 Hub，并确认 QQ 以 --force-renderer-accessibility 启动。',
      });
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`Hub 返回非 JSON：${text.slice(0, 200)}`);
    }
    if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
    return jsonText(json);
  },

  async group_wechat_preview() {
    const base = `http://${config.server.host}:${config.server.port}`;
    let res;
    try {
      res = await fetch(`${base}/api/wechat/preview`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${config.server.token}`,
        },
        body: '{}',
        signal: AbortSignal.timeout(50000),
      });
    } catch {
      return jsonText({ ok: false, error: 'Hub 未运行，无法截取微信窗口。' });
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`Hub 返回非 JSON：${text.slice(0, 200)}`);
    }
    if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
    return jsonText(json);
  },

  async group_digest(args = {}) {
    const digest = service.previewDigest({ since: args.since, until: args.until, chatIds: args.chatIds });
    return jsonText({
      overview: digest.overview,
      stats: digest.stats,
      keyUsers: digest.keyUsers.map((u) => ({ name: u.userName, userId: u.userId, count: u.messages.length })),
      eventCount: digest.events.length,
      markdown: digest.markdown,
    });
  },

  async group_report_create(args = {}) {
    const result = service.createReport({
      since: args.since,
      until: args.until,
      title: args.title,
      channels: args.channels,
      chatIds: args.chatIds,
      allowEmpty: args.allowEmpty === true,
      source: 'mcp',
    });
    if (!result.created) return jsonText(result);
    return jsonText({
      created: true,
      report: {
        id: result.report.id,
        title: result.report.title,
        status: result.report.status,
        filePath: result.report.filePath,
        periodStart: result.report.periodStart,
        periodEnd: result.report.periodEnd,
        channels: result.report.channels,
      },
      summary: result.summary,
      reviewUrl: reviewUrl(result.report.id),
      markdown: result.report.markdown,
      next:
        '把摘要与审核链接给用户。等用户明确说「批准/发吧」后，再调用 group_report_approve（confirmed=true）。不要自行批准。',
    });
  },

  async group_reports(args = {}) {
    const action = args.action;
    if (action === 'list') {
      return jsonText(service.listReports({ status: args.status, limit: args.limit ?? 20 }));
    }
    if (!args.id) throw new Error(`${action} 需要 id`);
    if (action === 'get') {
      const report = service.getReport(args.id);
      return jsonText({
        id: report.id,
        title: report.title,
        status: report.status,
        periodStart: report.periodStart,
        periodEnd: report.periodEnd,
        filePath: report.filePath,
        delivery: report.delivery,
        markdown: report.markdown,
        reviewUrl: reviewUrl(report.id),
      });
    }
    if (action === 'update') {
      const report = service.updateReport(args.id, args.markdown ?? '');
      return jsonText({ ok: true, report: { id: report.id, status: report.status, filePath: report.filePath } });
    }
    if (action === 'reject') {
      const report = service.rejectReport(args.id, args.reason ?? '');
      return jsonText({ ok: true, report: { id: report.id, status: report.status } });
    }
    throw new Error(`未知 action：${action}`);
  },

  async group_report_approve(args = {}) {
    const result = await service.approveReport(args.id, {
      confirmed: args.confirmed === true,
      channels: args.channels,
      approvedBy: 'mcp',
    });
    return jsonText({
      ok: result.ok,
      report: {
        id: result.report.id,
        status: result.report.status,
        sentAt: result.report.sentAt,
      },
      delivery: result.delivery,
    });
  },

  async group_schedule(args = {}) {
    if (args.action === 'list') {
      return jsonText(service.listUpcomingEvents({ days: args.days ?? 14 }));
    }
    if (args.action === 'extract') {
      return jsonText(service.schedule({ since: args.since, until: args.until }));
    }
    if (args.action === 'export') {
      return jsonText(service.exportSchedule({ since: args.since, until: args.until, format: args.format ?? 'ics' }));
    }
    throw new Error(`未知 action：${args.action}`);
  },

  async group_notifications(args = {}) {
    if (args.action === 'drain') {
      return jsonText(service.drainNotifications({ limit: args.limit ?? 20 }));
    }
    return jsonText(service.listNotifications({ undelivered: true, limit: args.limit ?? 20 }));
  },
};

// ------------------------------------------------------------------ JSON-RPC

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

async function handleRequest(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      sendResult(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : FALLBACK_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          '萨勒芬妮：读取已采集的 QQ/微信 群消息，跟踪重点用户，生成摘要与待审报告，提取日程。' +
          '外发前必须由用户明确批准：创建报告后把摘要给用户看，用户说批准后再调用 group_report_approve(confirmed=true)。' +
          `当前时区偏移 ${config.timezone.utcOffsetMinutes} 分钟。`,
      });
      return;
    }
    case 'ping':
      sendResult(id, {});
      return;
    case 'tools/list':
      sendResult(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      const handler = handlers[name];
      if (!handler) {
        sendError(id, RPC.INVALID_PARAMS, `未知工具：${name}`);
        return;
      }
      try {
        const text = await handler(args);
        sendResult(id, { content: [{ type: 'text', text }] });
      } catch (err) {
        writeStderr(`工具 ${name} 失败：${err.message}`);
        sendResult(id, { content: [{ type: 'text', text: `执行失败：${err.message}` }], isError: true });
      }
      return;
    }
    default:
      sendError(id, RPC.METHOD_NOT_FOUND, `未实现的方法：${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
let pending = 0;
let shuttingDown = false;
let exiting = false;

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    sendError(null, RPC.PARSE_ERROR, 'JSON 解析失败');
    return;
  }
  if (msg.id === undefined || msg.id === null) return;
  pending += 1;
  Promise.resolve()
    .then(() => handleRequest(msg))
    .catch((err) => {
      writeStderr(`处理 ${msg.method} 内部错误：${err.stack ?? err.message}`);
      sendError(msg.id, RPC.INTERNAL_ERROR, err.message);
    })
    .finally(() => {
      pending -= 1;
      maybeExit();
    });
});

function maybeExit() {
  if (shuttingDown && pending === 0 && !exiting) {
    exiting = true;
    store.close();
    log.close();
    setTimeout(() => process.exit(0), 10).unref();
  }
}

rl.on('close', () => {
  shuttingDown = true;
  maybeExit();
});
process.on('SIGINT', () => {
  shuttingDown = true;
  maybeExit();
});
process.on('SIGTERM', () => {
  shuttingDown = true;
  maybeExit();
});
