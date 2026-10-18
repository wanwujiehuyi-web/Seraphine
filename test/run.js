/**
 * 零依赖测试：node test/run.js
 *
 * 覆盖：
 *   - 时间工具 / 中文日程解析 / ICS
 *   - SQLite 存储与去重
 *   - 摘要与报告渲染
 *   - 审核门禁（未确认拒绝、驳回、修改、投递）
 *   - HTTP API 与 Webhook 入库
 *   - 定时调度器的幂等性
 *   - OneBot 适配器的连接/事件/API 调用
 *   - MCP stdio 协议
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import {
  DEFAULT_CONFIG,
  normalizeConfig,
  PKG_ROOT,
  resolvePaths,
} from '../src/config.js';
import { demoFollows, demoMessages } from '../fixtures/demo.js';
import { renderNotification } from '../dsh/group-waker.js';
import { OneBotAdapter } from '../src/adapters/onebot.js';
import { resolveQqTime } from '../src/adapters/qq-uia.js';
import { cleanOcr, parseWechatChat, parseWechatMessages, parseWechatSessions } from '../src/adapters/wechat-ocr.js';
import { buildDigest, renderReport } from '../src/digest.js';
import { startHub } from '../src/hub.js';
import { Ingest, normalizeOneBot, normalizeWebhook } from '../src/ingest.js';
import { Scheduler } from '../src/scheduler.js';
import {
  collectDates,
  collectTimes,
  exportCsv,
  exportIcs,
  extractEventsFromMessage,
} from '../src/schedule.js';
import { GroupDigestService } from '../src/service.js';
import { Store } from '../src/store.js';
import {
  formatDateTime,
  formatIcsUtc,
  fromLocal,
  localParts,
} from '../src/util/time.js';

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

function tempDir(prefix = 'gd-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeConfig(dir, overrides = {}) {
  return normalizeConfig({
    ...structuredClone(DEFAULT_CONFIG),
    server: { host: '127.0.0.1', port: 0, token: 'test-token' },
    storage: { dir: path.join(dir, 'state') },
    adapters: {
      onebot: { enabled: false, url: 'ws://127.0.0.1:1', reconnectMs: 10, includeGroups: [] },
      webhook: { enabled: true },
      mock: { enabled: false },
      qqUia: { enabled: false },
    },
    watch: { ...DEFAULT_CONFIG.watch },
    digest: { ...DEFAULT_CONFIG.digest, slots: [], lookbackHours: 24 },
    delivery: {
      channels: ['file'],
      dsh: { enabled: true, notify: true },
      qq: { enabled: false },
      wechat: { enabled: false },
    },
    logging: { level: 'silent' },
    ...overrides,
  });
}

function writeConfig(dir, config) {
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return configPath;
}

function seed(store, config, nowMs = Date.now()) {
  const ingest = new Ingest({ store, config });
  let inserted = 0;
  for (const message of demoMessages(nowMs)) {
    if (ingest.ingest(message).inserted) inserted += 1;
  }
  for (const follow of demoFollows()) store.addFollow(follow);
  return inserted;
}

function openService(dir, overrides = {}) {
  const config = makeConfig(dir, overrides);
  const configPath = writeConfig(dir, config);
  const paths = resolvePaths(config, configPath);
  fs.mkdirSync(paths.reports, { recursive: true });
  const store = new Store(paths.db);
  const service = new GroupDigestService({ config, store, paths, log: () => {} });
  return { config, configPath, paths, store, service, close: () => store.close() };
}

// ---------------------------------------------------------------- 时间工具

await test('时间：本地字段与 UTC 互转', () => {
  const utc = fromLocal({ year: 2026, month: 10, day: 20, hour: 15, minute: 30 }, 480);
  assert.equal(new Date(utc).toISOString(), '2026-10-20T07:30:00.000Z');
  const p = localParts(utc, 480);
  assert.deepEqual(
    { y: p.year, m: p.month, d: p.day, h: p.hour, mi: p.minute },
    { y: 2026, m: 10, d: 20, h: 15, mi: 30 },
  );
  assert.equal(formatDateTime(utc, 480), '2026-10-20 15:30');
  assert.equal(formatIcsUtc(utc), '20261020T073000Z');
});

// ---------------------------------------------------------------- 日程解析

await test('日程：日期/时间/区间/重复/低置信度', () => {
  const now = fromLocal({ year: 2026, month: 10, day: 18, hour: 10, minute: 0 }, 480);
  const msg = (text) => ({
    platform: 'qq',
    chatId: 'g1',
    chatName: '测试群',
    senderName: '队长',
    text,
    ts: new Date(now).toISOString(),
  });

  const meeting = extractEventsFromMessage(msg('周五下午3点在A楼302开会，讨论方案'), {
    offsetMinutes: 480,
    nowMs: now,
  });
  assert.equal(meeting.length, 1);
  assert.equal(meeting[0].title, '开会');
  assert.equal(meeting[0].location, 'A楼302');
  assert.equal(formatDateTime(Date.parse(meeting[0].startAt), 480), '2026-10-23 15:00');

  const deadline = extractEventsFromMessage(msg('报名截止到10月20日晚上8点，没交的抓紧'), {
    offsetMinutes: 480,
    nowMs: now,
  });
  assert.equal(deadline[0].kind, 'deadline');
  assert.equal(deadline[0].title, '报名截止');
  assert.equal(formatDateTime(Date.parse(deadline[0].startAt), 480), '2026-10-20 20:00');

  const range = extractEventsFromMessage(msg('10月20日-10月22日 比赛'), {
    offsetMinutes: 480,
    nowMs: now,
  });
  assert.equal(range[0].allDay, true);
  assert.equal(formatDateTime(Date.parse(range[0].startAt), 480), '2026-10-20 00:00');

  const weekly = extractEventsFromMessage(msg('每周三晚上8点例会'), {
    offsetMinutes: 480,
    nowMs: now,
  });
  assert.equal(weekly[0].rrule, 'FREQ=WEEKLY;BYDAY=WE');
  assert.equal(formatDateTime(Date.parse(weekly[0].startAt), 480), '2026-10-21 20:00');

  const tonight = extractEventsFromMessage(msg('今晚8点开短会'), {
    offsetMinutes: 480,
    nowMs: now,
  });
  assert.equal(formatDateTime(Date.parse(tonight[0].startAt), 480), '2026-10-18 20:00');

  // 过去太久的事件应被过滤（now 前 2 小时是宽限）
  const past = extractEventsFromMessage(msg('昨天下午3点开会'), {
    offsetMinutes: 480,
    nowMs: now,
  });
  assert.equal(past.length, 0);
});

await test('日程：collectDates / collectTimes 基本形状', () => {
  const now = fromLocal({ year: 2026, month: 10, day: 18, hour: 10 }, 480);
  const dates = collectDates('下周三 10点', now, 480);
  assert.equal(dates.length, 1);
  assert.match(dates[0].raw, /下周三/);
  const times = collectTimes('下午3点半');
  assert.equal(times.length, 1);
  assert.equal(times[0].hour, 15);
  assert.equal(times[0].minute, 30);
});

await test('日程：ICS 结构、转义、RRULE、CSV', () => {
  const now = fromLocal({ year: 2026, month: 10, day: 18, hour: 10 }, 480);
  const events = extractEventsFromMessage(
    {
      platform: 'qq',
      chatId: 'g',
      chatName: '群;A',
      senderName: '队长',
      text: '每周三晚上8点例会，讨论 A,B; C',
      ts: new Date(now).toISOString(),
    },
    { offsetMinutes: 480, nowMs: now },
  );
  const ics = exportIcs(events, { offsetMinutes: 480, nowMs: now });
  assert.match(ics, /^BEGIN:VCALENDAR/);
  assert.match(ics, /RRULE:FREQ=WEEKLY;BYDAY=WE/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
  assert.ok(ics.includes('\r\n'));
  const csv = exportCsv(events, { offsetMinutes: 480 });
  assert.match(csv, /"事项"/);
  assert.match(csv, /"例会"/);
});

// ---------------------------------------------------------------- 存储

await test('存储：消息去重、群统计、关注匹配', () => {
  const dir = tempDir();
  const config = makeConfig(dir);
  const store = new Store(path.join(dir, 'test.db'));
  const ingest = new Ingest({ store, config });
  const [first] = demoMessages(Date.now());
  assert.equal(ingest.ingest(first).inserted, true);
  assert.equal(ingest.ingest(first).inserted, false, '同一 id 第二次应被去重');

  const group = store.getGroup('qq', first.chatId);
  assert.equal(group.messageCount, 1);
  assert.equal(group.watched, true);

  store.addFollow({ platform: 'qq', chatId: first.chatId, userId: '10001', userName: '队长', priority: 'high' });
  assert.ok(store.matchFollow('qq', first.chatId, '10001'));
  assert.ok(store.matchFollow('qq', 'other-group', '10001') === null);
  store.addFollow({ platform: 'qq', chatId: '*', userId: '10001', userName: '队长' });
  assert.ok(store.matchFollow('qq', 'other-group', '10001'));

  store.setGroupWatched('qq', first.chatId, false);
  assert.equal(store.getGroup('qq', first.chatId).watched, false);
  store.close();
});

await test('存储：群设置与成员列表', () => {
  const dir = tempDir();
  const config = makeConfig(dir);
  const store = new Store(path.join(dir, 'test.db'));
  const ingest = new Ingest({ store, config });
  const messages = demoMessages(Date.now());
  for (const message of messages.slice(0, 6)) ingest.ingest(message);
  const chatId = messages[0].chatId;

  const saved = store.setGroupSettings({
    platform: 'qq',
    chatId,
    enabled: false,
    autoRead: true,
    keywords: ['比赛', '截止'],
  });
  assert.equal(saved.enabled, false);
  assert.equal(saved.autoRead, true);
  assert.deepEqual(saved.keywords, ['比赛', '截止']);
  assert.equal(store.getGroupSettings('qq', chatId).autoRead, true);

  const members = store.listMembers(chatId);
  assert.ok(members.length >= 2);
  assert.ok(members.every((m) => m.senderName && m.count >= 1));
  const found = store.searchMembers('队长');
  assert.ok(found.length >= 1);
  assert.ok(found[0].chatName);
  store.close();
});

await test('存储：报告状态机与通知', () => {
  const dir = tempDir();
  const store = new Store(path.join(dir, 'test.db'));
  const report = store.createReport({
    title: 't',
    periodStart: new Date().toISOString(),
    periodEnd: new Date().toISOString(),
    markdown: '# t',
    digest: {},
    channels: ['file'],
    filePath: path.join(dir, 't.md'),
  });
  assert.equal(report.status, 'pending');
  assert.equal(store.updateReportMarkdown(report.id, '# t2'), true);
  assert.ok(store.getReport(report.id).markdown.includes('t2'));
  const approved = store.approveReport(report.id, 'user', null);
  assert.equal(approved.ok, true);
  assert.equal(store.getReport(report.id).status, 'approved');
  store.markReportSent(report.id, { ok: true, results: {} });
  assert.equal(store.getReport(report.id).status, 'sent');

  store.addNotification({ type: 'x', title: 'hello' });
  const unread = store.listNotifications({ undelivered: true });
  assert.equal(unread.length, 1);
  store.markNotificationDelivered([unread[0].id]);
  assert.equal(store.listNotifications({ undelivered: true }).length, 0);
  store.close();
});

// ---------------------------------------------------------------- 摘要/报告

await test('摘要：重点用户、关键消息、日程、概览', () => {
  const dir = tempDir();
  const local = openService(dir, {
    watch: {
      ...DEFAULT_CONFIG.watch,
      customRules: [{ name: '截止规则', pattern: '截止', type: 'keyword', weight: 5 }],
    },
  });
  const now = Date.now();
  seed(local.store, local.config, now);
  const digest = buildDigest({
    store: local.store,
    config: local.config,
    since: new Date(now - 12 * 3_600_000).toISOString(),
    until: new Date(now).toISOString(),
    nowMs: now,
  });
  assert.equal(digest.stats.total, 22);
  assert.equal(digest.stats.groups, 2);
  assert.equal(digest.keyUsers.length, 3);
  assert.ok(digest.keyUsers.some((u) => u.userName === '队长'));
  assert.ok(digest.highlights.length > 0);
  assert.ok(digest.events.length >= 5);
  assert.ok(digest.links.some((l) => l.url.includes('dataset-v2')));
  assert.ok(digest.customHits.length > 0);
  assert.match(digest.overview, /22 条群消息/);

  const markdown = renderReport(digest, {
    config: local.config,
    title: '测试报告',
    reportId: 'rep_test',
  });
  for (const section of ['## 一句话概览', '## 重点用户动态', '## 关键消息', '## 自定义关注', '## 日程', '## 群活跃度']) {
    assert.ok(markdown.includes(section), `报告缺少 ${section}`);
  }
  assert.match(markdown, /状态：待审核/);
  local.close();
});

// ---------------------------------------------------------------- 审核/投递

await test('审核门禁：未确认拒绝、修改仅限 pending、批准后投递文件', async () => {
  const dir = tempDir();
  const local = openService(dir);
  const now = Date.now();
  seed(local.store, local.config, now);
  const result = local.service.createReport({
    since: new Date(now - 12 * 3_600_000).toISOString(),
    until: new Date(now).toISOString(),
    title: '审核测试',
  });
  assert.equal(result.created, true);
  assert.equal(result.report.status, 'pending');
  assert.ok(fs.existsSync(result.report.filePath));

  await assert.rejects(
    () => local.service.approveReport(result.report.id, { confirmed: false }),
    /confirmed=true/,
  );
  assert.equal(local.service.getReport(result.report.id).status, 'pending');

  const updated = local.service.updateReport(result.report.id, '# 改过的正文\n');
  assert.equal(updated.markdown, '# 改过的正文\n');

  const approved = await local.service.approveReport(result.report.id, {
    confirmed: true,
    approvedBy: 'test',
  });
  assert.equal(approved.ok, true);
  const final = local.service.getReport(result.report.id);
  assert.equal(final.status, 'sent');
  assert.equal(final.delivery.results.file.ok, true);
  assert.equal(fs.readFileSync(final.filePath, 'utf8'), '# 改过的正文\n');
  await assert.rejects(
    async () => local.service.updateReport(result.report.id, 'x'),
    /只有 pending/,
  );

  const rejectTarget = local.service.createReport({
    since: new Date(now - 12 * 3_600_000).toISOString(),
    until: new Date(now).toISOString(),
  });
  const pendingNote = local.store
    .listNotifications({ undelivered: true })
    .find((item) => item.payload?.reportId === rejectTarget.report.id);
  assert.ok(pendingNote, '创建报告后应有待审核通知');
  const rejected = local.service.rejectReport(rejectTarget.report.id, '不需要');
  assert.equal(rejected.status, 'rejected');
  const dismissed = local.store
    .listNotifications({ limit: 100 })
    .filter((item) => item.payload?.reportId === rejectTarget.report.id);
  assert.ok(dismissed.length > 0);
  assert.ok(dismissed.every((item) => item.readAt && item.deliveredAt), '驳回后提醒应被标记已读/已投递');
  await assert.rejects(
    () => local.service.approveReport(rejectTarget.report.id, { confirmed: true }),
    /驳回/,
  );
  local.close();
});

await test('投递：QQ 通道构造正确的请求（假 fetch）', async () => {
  const dir = tempDir();
  const contactsFile = path.join(dir, 'contacts.json');
  fs.writeFileSync(
    contactsFile,
    JSON.stringify({ contacts: [{ openid: 'OPENID_TEST', lastSeenAt: '2026-10-10T00:00:00Z' }] }),
  );
  const local = openService(dir, {
    delivery: {
      channels: ['qq'],
      dsh: { enabled: false, notify: false },
      qq: {
        enabled: true,
        appId: 'app',
        clientSecret: 'secret',
        apiBase: 'https://api.example.test',
        userOpenId: 'latest',
        contactsFile,
        maxChars: 1800,
      },
      wechat: { enabled: false },
    },
  });
  const now = Date.now();
  seed(local.store, local.config, now);
  const created = local.service.createReport({
    since: new Date(now - 12 * 3_600_000).toISOString(),
    until: new Date(now).toISOString(),
  });

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options, body: options.body ? JSON.parse(options.body) : null });
    if (String(url).includes('getAppAccessToken')) {
      return new Response(JSON.stringify({ access_token: 'TOKEN', expires_in: 7200 }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: 'MSG1', timestamp: '123' }), { status: 200 });
  };
  try {
    const approved = await local.service.approveReport(created.report.id, {
      confirmed: true,
      channels: ['qq'],
    });
    assert.equal(approved.ok, true);
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /getAppAccessToken/);
    assert.equal(calls[0].body.appId, 'app');
    assert.match(calls[1].url, /\/v2\/users\/OPENID_TEST\/messages/);
    assert.equal(calls[1].options.headers.Authorization, 'QQBot TOKEN');
    assert.ok(calls[1].body.content.includes('审核测试') || calls[1].body.content.includes('群聊情报'));
  } finally {
    globalThis.fetch = originalFetch;
    local.close();
  }
});

await test('投递：微信桥失败不吞掉其它通道', async () => {
  const dir = tempDir();
  const local = openService(dir, {
    delivery: {
      channels: ['file', 'wechat'],
      dsh: { enabled: false, notify: false },
      qq: { enabled: false },
      wechat: { enabled: true, sendUrl: 'https://wechat.example.test/send', token: 't', to: 'room' },
    },
  });
  const now = Date.now();
  seed(local.store, local.config, now);
  const created = local.service.createReport({
    since: new Date(now - 12 * 3_600_000).toISOString(),
    until: new Date(now).toISOString(),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('bridge down', { status: 502 });
  try {
    const approved = await local.service.approveReport(created.report.id, {
      confirmed: true,
      channels: ['file', 'wechat'],
    });
    assert.equal(approved.ok, false);
    assert.equal(approved.delivery.results.file.ok, true);
    assert.equal(approved.delivery.results.wechat.ok, false);
    assert.equal(local.service.getReport(created.report.id).status, 'sent', '只要有一个通道成功就应标记 sent');
  } finally {
    globalThis.fetch = originalFetch;
    local.close();
  }
});

// ---------------------------------------------------------------- HTTP

await test('HTTP：鉴权、Webhook 入库、报告审核、审核页', async () => {
  const dir = tempDir();
  const config = makeConfig(dir, { digest: { ...DEFAULT_CONFIG.digest, slots: [], lookbackHours: 24 } });
  const configPath = writeConfig(dir, config);
  const hub = await startHub({ configPath, config, startScheduler: false });
  try {
    const base = hub.url;
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/api/status`)).status, 401);

    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' };
    const now = new Date().toISOString();
    const onebotEvent = {
      post_type: 'message',
      message_type: 'group',
      time: Math.floor(Date.parse(now) / 1000),
      self_id: 999,
      group_id: 555,
      group_name: 'HTTP 测试群',
      user_id: 10001,
      message: [
        { type: 'text', data: { text: '周五下午3点开会 ' } },
        { type: 'at', data: { qq: '999' } },
      ],
      raw_message: '周五下午3点开会',
      sender: { user_id: 10001, nickname: '队长', role: 'owner' },
      message_id: 777,
    };
    const ingestRes = await fetch(`${base}/api/ingest/onebot`, {
      method: 'POST',
      headers,
      body: JSON.stringify(onebotEvent),
    });
    assert.equal(ingestRes.status, 200);
    const ingestJson = await ingestRes.json();
    assert.equal(ingestJson.results[0].inserted, true);

    const groups = await (await fetch(`${base}/api/groups`, { headers })).json();
    assert.equal(groups.count, 1);
    assert.equal(groups.groups[0].name, 'HTTP 测试群');

    const appPage = await fetch(`${base}/app?token=test-token`);
    assert.equal(appPage.status, 200);
    assert.match(await appPage.text(), /萨勒芬妮/);
    assert.equal((await fetch(`${base}/app/icon.png`)).status, 200);

    const members = await (
      await fetch(`${base}/api/members?chatId=555`, { headers })
    ).json();
    assert.equal(members.count, 1);
    assert.equal(members.members[0].senderName, '队长');
    const searched = await (
      await fetch(`${base}/api/members/search?q=${encodeURIComponent('队长')}`, { headers })
    ).json();
    assert.ok(searched.count >= 1);
    assert.equal(searched.members[0].senderName, '队长');
    const saveSettings = await fetch(`${base}/api/group-settings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ chatId: '555', enabled: true, autoRead: true, keywords: ['比赛'] }),
    });
    assert.equal(saveSettings.status, 200);
    const savedSettings = await (await fetch(`${base}/api/group-settings?chatId=555`, { headers })).json();
    assert.equal(savedSettings.autoRead, true);
    assert.deepEqual(savedSettings.keywords, ['比赛']);

    const reportRes = await fetch(`${base}/api/reports`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ since: new Date(Date.now() - 3_600_000).toISOString() }),
    });
    assert.equal(reportRes.status, 201);
    const created = await reportRes.json();
    assert.equal(created.report.status, 'pending');

    const page = await fetch(`${base}/review/${created.report.id}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /批准并发送/);

    const denied = await fetch(`${base}/api/reports/${created.report.id}/approve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ confirmed: false }),
    });
    assert.equal(denied.status, 500);
    const deniedJson = await denied.json();
    assert.match(deniedJson.error, /confirmed=true/);

    const approved = await fetch(`${base}/api/reports/${created.report.id}/approve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ confirmed: true, approvedBy: 'http-test' }),
    });
    assert.equal(approved.status, 200);
    const approvedJson = await approved.json();
    assert.equal(approvedJson.ok, true);
  } finally {
    await hub.close();
  }
});

await test('HTTP：Webhook 规范化（微信字段）', async () => {
  const dir = tempDir();
  const config = makeConfig(dir);
  const configPath = writeConfig(dir, config);
  const hub = await startHub({ configPath, config, startScheduler: false });
  try {
    const res = await fetch(`${hub.url}/api/ingest/wechat?token=test-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId: 'room-1',
        roomName: '微信群 A',
        senderId: 'wx-1',
        senderName: '老王',
        content: '下周三上午10点开会',
        timestamp: Date.now(),
      }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.results[0].inserted, true);
    const messages = await (
      await fetch(`${hub.url}/api/messages?chatId=room-1`, {
        headers: { Authorization: 'Bearer test-token' },
      })
    ).json();
    assert.equal(messages.count, 1);
    assert.equal(messages.messages[0].senderName, '老王');
  } finally {
    await hub.close();
  }
});

// ---------------------------------------------------------------- 调度器

await test('调度器：到点生成待审报告且幂等', async () => {
  const dir = tempDir();
  const local = openService(dir, {
    digest: { ...DEFAULT_CONFIG.digest, slots: ['09:00'], catchUpHours: 24, lookbackHours: 24 },
  });
  const now = Date.now();
  seed(local.store, local.config, now);

  const offset = 480;
  const p = localParts(now, offset);
  const slotMs = fromLocal({ year: p.year, month: p.month, day: p.day, hour: 9, minute: 0 }, offset);
  // 如果本地时间还没到 9 点，用明天 9 点之后的 1 分钟。
  const tickNow = now > slotMs ? now : slotMs + 60_000;

  const scheduler = new Scheduler({ config: local.config, service: local.service, now: () => tickNow });
  await scheduler.tick();
  const reports = local.service.listReports({ limit: 10 });
  const pending = reports.reports.filter((r) => r.status === 'pending');
  assert.equal(pending.length, 1, '第一次 tick 应生成一份待审报告');

  await scheduler.tick();
  const after = local.service.listReports({ limit: 10 });
  assert.equal(after.count, 1, '第二次 tick 不应重复生成');
  scheduler.stop();
  local.close();
});

// ---------------------------------------------------------------- OneBot

await test('OneBot：事件规范化、API 往返、access_token 查询串', async () => {
  class FakeSocket {
    readyState = 0;
    listeners = new Map();
    sent = [];
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    emit(type, event = {}) {
      for (const fn of this.listeners.get(type) ?? []) fn(event);
    }
    send(data) {
      this.sent.push(JSON.parse(data));
    }
    close() {
      this.readyState = 3;
      this.emit('close', { code: 1000 });
    }
  }

  const socket = new FakeSocket();
  const events = [];
  let urls = [];
  const adapter = new OneBotAdapter({
    config: { url: 'ws://127.0.0.1:3001', accessToken: 'tok', reconnectMs: 10 },
    log: () => {},
    onEvent: (event) => events.push(event),
    createSocket: (url) => {
      urls.push(url);
      return socket;
    },
  });
  adapter.start();
  socket.readyState = 1;
  socket.emit('open');
  assert.equal(adapter.connected, true);
  assert.match(urls[0], /access_token=tok/);

  socket.emit('message', {
    data: JSON.stringify({
      post_type: 'message',
      message_type: 'group',
      time: Math.floor(Date.now() / 1000),
      self_id: 999,
      group_id: 1,
      group_name: '群',
      user_id: 2,
      message: [{ type: 'text', data: { text: '你好' } }],
      sender: { user_id: 2, nickname: '甲' },
      message_id: 3,
    }),
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].group_id, 1);

  const pending = adapter.call('get_group_list');
  const request = socket.sent.at(-1);
  assert.equal(request.action, 'get_group_list');
  socket.emit('message', {
    data: JSON.stringify({ status: 'ok', retcode: 0, data: [{ group_id: 1, group_name: '群' }], echo: request.echo }),
  });
  const groups = await pending;
  assert.equal(groups[0].group_name, '群');

  await adapter.stop();
  await assert.rejects(() => adapter.call('send_group_msg', { group_id: 1, message: 'x' }), /未连接/);
});

// ---------------------------------------------------------------- 规范化

await test('QQ UIA：相对时间解析', () => {
  const now = fromLocal({ year: 2026, month: 10, day: 18, hour: 11, minute: 30 }, 480);
  assert.equal(resolveQqTime('11:10', now, 480), '2026-10-18T03:10:00.000Z');
  assert.equal(resolveQqTime('昨天 22:00', now, 480), '2026-10-17T14:00:00.000Z');
  assert.equal(resolveQqTime('星期三 10:00', now, 480), '2026-10-14T02:00:00.000Z');
  assert.equal(resolveQqTime('10/06', now, 480), '2026-10-05T16:00:00.000Z');
  assert.equal(resolveQqTime('', now, 480), null);
});

await test('微信 OCR：会话列表与聊天区解析', () => {
  const listLines = [
    { text: 'Astra2027 电 控 组 培 ．', x: 188, y: 144, w: 189, h: 20 },
    { text: '1 1 ： 06', x: 406, y: 149, w: 36, h: 11 },
    { text: '鱼 蛋 捶 不 醒 ： @所有人 电 控 第 ．', x: 188, y: 175, w: 234, h: 18 },
    { text: '创 窖 空 间 2026', x: 188, y: 242, w: 133, h: 20 },
    { text: '02 ： 42', x: 405, y: 246, w: 37, h: 11 },
  ];
  const sessions = parseWechatSessions(listLines, { width: 1350 });
  assert.equal(sessions.length, 2);
  assert.ok(sessions[0].name.startsWith('Astra2027'));
  assert.equal(sessions[0].time, '11:06');
  assert.match(sessions[0].preview, /鱼蛋捶不醒/);
  assert.ok(sessions[1].name.includes('创窖'));

  const merged = parseWechatSessions(
    [
      { text: 'Astra2027 电 控 组 培 ． 1 1 ： 06', x: 160, y: 149, w: 330, h: 20 },
      { text: '鱼 蛋 睡 不 醒 ： @所有人 电 控 第', x: 160, y: 175, w: 300, h: 18 },
    ],
    { width: 1350 },
  );
  assert.equal(merged.length, 1);
  assert.ok(merged[0].name.startsWith('Astra2027'));
  assert.equal(merged[0].time, '11:06');

  const chatLines = [
    { text: 'Astra2027 电 控 组 培 训 群 （ 172 ）', x: 485, y: 72, w: 281, h: 22 },
    { text: '鱼 蛋 捶 不 醒 ： @所有人 今 天 的 课 裎 回 放 录', x: 584, y: 142, w: 331, h: 19 },
    { text: '2026 一 09 一 23 1 5 ： 46 ： 28', x: 585, y: 190, w: 259, h: 18 },
  ];
  const chat = parseWechatChat(chatLines, { width: 1350, height: 902 });
  assert.match(chat.title, /Astra2027/);
  assert.match(chat.text, /回放/);
  assert.ok(cleanOcr('你 好 世 界') === '你好世界');

  const now = fromLocal({ year: 2026, month: 10, day: 18, hour: 11, minute: 30 }, 480);
  const blocks = parseWechatMessages(
    [
      { text: '鱼 蛋 捶 不 醒', x: 566, y: 313, w: 90, h: 18 },
      { text: '之 前 二 次 课 的 回 放 有 需 要 的 同 学 自 取', x: 584, y: 358, w: 362, h: 21 },
      { text: '收 到', x: 584, y: 390, w: 40, h: 20 },
      { text: '1 1 ： 06', x: 875, y: 437, w: 44, h: 14 },
      { text: '鱼 蛋 捶 不 醒', x: 566, y: 490, w: 90, h: 18 },
      { text: '@所有人 电 控 第 三 次 课 结 束', x: 586, y: 535, w: 514, h: 21 },
      { text: '有 意 愿 的 同 学 请 私 信 我', x: 584, y: 563, w: 300, h: 21 },
      { text: '我 来 了', x: 900, y: 650, w: 80, h: 20 },
    ],
    { width: 1350, height: 902, now, offset: 480 },
  );
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].senderName, '鱼蛋捶不醒');
  assert.match(blocks[0].text, /收到/);
  assert.equal(blocks[1].senderName, '鱼蛋捶不醒');
  assert.equal(blocks[1].ts, '2026-10-18T03:06:00.000Z');
  assert.equal(blocks[2].senderName, '我');
});

await test('规范化：OneBot / Webhook 字段兼容', () => {
  const onebot = normalizeOneBot(
    {
      post_type: 'message',
      message_type: 'group',
      time: 1_700_000_000,
      self_id: 1,
      group_id: 2,
      group_name: 'G',
      user_id: 3,
      message: [
        { type: 'at', data: { qq: '1', name: '机器人' } },
        { type: 'text', data: { text: ' 看下 ' } },
        { type: 'image', data: {} },
      ],
      sender: { user_id: 3, card: '卡片名', role: 'admin' },
      message_id: 4,
    },
    { platform: 'qq' },
  );
  assert.equal(onebot.atMe, true);
  assert.equal(onebot.senderName, '卡片名');
  assert.equal(onebot.senderRole, 'admin');
  assert.match(onebot.text, /@我/);
  assert.match(onebot.text, /\[图片\]/);

  const webhook = normalizeWebhook({
    roomId: 'r',
    roomName: 'R',
    senderId: 's',
    senderName: 'S',
    content: 'hi',
    ts: 1_700_000_000,
  });
  assert.equal(webhook.chatType, 'group');
  assert.equal(webhook.platform, 'wechat');
  assert.equal(webhook.ts, '2023-11-14T22:13:20.000Z');
});

// ---------------------------------------------------------------- MCP

await test('DSH 插件：通知渲染包含审核指令与链接', () => {
  const text = renderNotification(
    {
      type: 'report_pending',
      title: '待审核报告：群聊情报 · 10-18',
      body: '共 22 条消息',
      payload: { reportId: 'rep_1' },
    },
    { hubUrl: 'http://127.0.0.1:8791', token: 'tok' },
  );
  assert.match(text, /group_report_approve/);
  assert.match(text, /review\/rep_1/);
  assert.match(text, /不要自行批准/);

  const alert = renderNotification(
    { type: 'follow_alert', title: '重点用户发言：队长', body: '队长：周五开会', payload: {} },
    {},
  );
  assert.match(alert, /重点用户发言/);
  assert.match(alert, /周五开会/);
});

await test('MCP：initialize / tools/list / tools/call', async () => {
  const dir = tempDir();
  const config = makeConfig(dir);
  const configPath = writeConfig(dir, config);
  // 先放一条消息，确保工具能拿到数据。
  const localStore = new Store(path.join(dir, 'state', 'hub.db'));
  seed(localStore, config);
  localStore.close();

  const child = spawn(process.execPath, [path.join(PKG_ROOT, 'src', 'mcp-server.js')], {
    env: { ...process.env, GROUPDIGEST_CONFIG: configPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const responses = new Map();
  const waiting = new Map();
  let nextId = 1;
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      responses.set(msg.id, msg);
      const waiter = waiting.get(msg.id);
      if (waiter) {
        waiting.delete(msg.id);
        waiter(msg);
      }
    }
  });
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
  child.on('exit', () => {
    for (const [, waiter] of waiting) waiter(null);
  });

  function rpc(method, params, timeoutMs = 5000) {
    const id = nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP 超时：${method}；stderr=${stderr.join('')}`)), timeoutMs);
      waiting.set(id, (msg) => {
        clearTimeout(timer);
        if (!msg) reject(new Error(`MCP 进程退出：${stderr.join('')}`));
        else resolve(msg);
      });
    });
  }

  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
    assert.equal(init.result.serverInfo.name, 'group-digest');
    const list = await rpc('tools/list', {});
    const names = list.result.tools.map((t) => t.name);
    assert.ok(names.includes('group_status'));
    assert.ok(names.includes('group_report_approve'));
    assert.ok(names.includes('group_schedule'));
    assert.ok(names.includes('group_qq_read'));
    assert.ok(names.includes('group_wechat_preview'));

    const status = await rpc('tools/call', { name: 'group_status', arguments: {} });
    const statusJson = JSON.parse(status.result.content[0].text);
    assert.equal(statusJson.ok, true);
    assert.equal(statusJson.stats.messages, 22);

    const create = await rpc('tools/call', {
      name: 'group_report_create',
      arguments: { since: new Date(Date.now() - 12 * 3_600_000).toISOString() },
    });
    const createJson = JSON.parse(create.result.content[0].text);
    assert.equal(createJson.created, true);
    assert.match(createJson.next, /不要自行批准/);

    const denied = await rpc('tools/call', {
      name: 'group_report_approve',
      arguments: { id: createJson.report.id, confirmed: false },
    });
    assert.equal(denied.result.isError, true);
    assert.match(denied.result.content[0].text, /confirmed=true/);
  } finally {
    child.kill();
    rl.close();
  }
});

// ---------------------------------------------------------------- 结果

console.log('');
if (failed) {
  console.log(`${failed} 项失败，${passed} 项通过`);
  for (const failure of failures) {
    console.log(`\n--- ${failure.name}\n${failure.err.stack}`);
  }
  process.exit(1);
}
console.log(`全部通过：${passed} 项`);
