/**
 * 业务服务层：HTTP、MCP、CLI 共用同一套逻辑，避免三处各写一遍。
 *
 * 审核约束：报告只有 `pending` 状态才能修改/驳回；只有 `approveReport`
 * 能触发外发，且调用方必须显式传 confirmed=true。定时任务只创建待审报告，
 * 永远不会自己发送。
 */

import fs from 'node:fs';
import path from 'node:path';

import { buildDigest, defaultPeriod, digestToSummaryText, renderReport } from './digest.js';
import { deliverReport } from './delivery.js';
import { extractEvents, exportCsv, exportIcs, eventsToMarkdown, persistEvents } from './schedule.js';
import {
  formatDate,
  formatDateTime,
  formatShort,
  parseFlexible,
} from './util/time.js';
import { stableId, truncate } from './util/text.js';

const REPORT_ID_RE = /^rep_[A-Za-z0-9_-]+$/;

/** 微信 OCR 的图片/聊天记录/错位行经常被误识别成日程，先过滤掉这些噪音。 */
function isWechatNoise(message) {
  if (message.platform !== 'wechat') return false;
  const text = String(message.text ?? '');
  const sender = String(message.senderName ?? '');
  if (/self|^\[?0(?:\s|\]|$)/i.test(sender)) return true;
  if (/^\[?\s*片?\s*\]|聊天记录|共\s*\d+\s*条|^\[?(图片|视频|文件|语音)\]?/.test(text)) return true;
  const symbols = (text.match(/[^\u4e00-\u9fffA-Za-z0-9，。！？、：；（）()【】\s]/g) || []).length;
  return text.length > 0 && symbols / text.length > 0.35;
}

export class GroupDigestService {
  #config;
  #store;
  #paths;
  #log;
  #runtime;

  constructor({ config, store, paths, log = () => {} }) {
    this.#config = config;
    this.#store = store;
    this.#paths = paths;
    this.#log = log;
    this.#runtime = () => ({});
  }

  get config() {
    return this.#config;
  }

  get store() {
    return this.#store;
  }

  get paths() {
    return this.#paths;
  }

  setRuntime(fn) {
    this.#runtime = fn;
  }

  // ------------------------------------------------------------------ 状态

  status() {
    return {
      ok: true,
      now: new Date().toISOString(),
      timezone: this.#config.timezone,
      storage: { dir: this.#paths.base, db: this.#paths.db },
      stats: this.#store.stats(),
      adapters: this.#runtime(),
      review: { required: this.#config.review.required },
      delivery: {
        channels: this.#config.delivery.channels,
        qq: { enabled: this.#config.delivery.qq.enabled },
        wechat: { enabled: this.#config.delivery.wechat.enabled },
        dsh: this.#config.delivery.dsh,
      },
      scheduler: this.#store.getMeta('scheduler', null),
    };
  }

  // ---------------------------------------------------------------- 群/关注

  listGroups() {
    const groups = this.#store.listGroups();
    if (!groups.length) {
      return {
        count: 0,
        groups: [],
        note: '还没有收到任何群消息。先确认 OneBot 已连接，并让群里有人说话。',
      };
    }
    return { count: groups.length, groups };
  }

  setWatch(platform, chatId, watched) {
    this.#store.setGroupWatched(platform, String(chatId), watched);
    return this.#store.getGroup(platform, String(chatId));
  }

  addFollow({ platform, chatId = '*', userId, userName, priority = 'normal', note = '' }) {
    if (!platform || !userId) throw new Error('follow 需要 platform 与 userId');
    let name = userName;
    if (!name) {
      const recent = this.#store.queryMessages({
        platform,
        senderId: String(userId),
        limit: 1,
      });
      name = recent.at(-1)?.senderName ?? '';
    }
    const follow = this.#store.addFollow({
      platform,
      chatId: chatId || '*',
      userId: String(userId),
      userName: name ?? '',
      priority,
      note,
    });
    return follow;
  }

  removeFollow({ platform, chatId = '*', userId }) {
    const removed = this.#store.removeFollow({ platform, chatId: chatId || '*', userId: String(userId) });
    return { removed };
  }

  listFollows() {
    const follows = this.#store.listFollows();
    return {
      count: follows.length,
      follows,
      note: follows.length
        ? undefined
        : '还没有关注任何用户。用 group_follow 加人，chatId 传 * 表示所有群。',
    };
  }

  // ------------------------------------------------------------- 群级设置

  groupSettings(platform = 'qq', chatId = null) {
    const p = platform || 'qq';
    if (chatId) return this.#store.getGroupSettings(p, String(chatId));
    return { settings: this.#store.listGroupSettings(p) };
  }

  setGroupSettings({ platform = 'qq', chatId, enabled = true, autoRead = false, keywords = [] }) {
    if (!chatId) throw new Error('需要 chatId');
    return this.#store.setGroupSettings({
      platform: platform || 'qq',
      chatId: String(chatId),
      enabled,
      autoRead,
      keywords: Array.isArray(keywords) ? keywords : [],
    });
  }

  listMembers({ chatId, limit = 100 }) {
    if (!chatId) throw new Error('需要 chatId');
    const members = this.#store.listMembers(String(chatId), { limit });
    const follows = new Map(
      this.#store
        .listFollows()
        .filter((f) => f.chatId === '*' || f.chatId === String(chatId))
        .map((f) => [f.userId, f]),
    );
    return {
      count: members.length,
      members: members.map((m) => ({
        ...m,
        follow: follows.get(m.senderId)
          ? {
              priority: follows.get(m.senderId).priority,
              note: follows.get(m.senderId).note,
            }
          : null,
      })),
    };
  }

  searchMembers({ q, limit = 50 } = {}) {
    const query = String(q ?? '').trim();
    if (!query) return { count: 0, members: [] };
    const follows = new Map(this.#store.listFollows().map((f) => [`${f.chatId}:${f.userId}`, f]));
    const rows = this.#store.searchMembers(query, { limit });
    return {
      count: rows.length,
      members: rows.map((m) => {
        const follow = follows.get(`${m.chatId}:${m.senderId}`) ?? follows.get(`*:${m.senderId}`);
        return {
          ...m,
          follow: follow ? { priority: follow.priority, note: follow.note } : null,
        };
      }),
    };
  }

  // ------------------------------------------------------------------ 消息

  queryMessages({
    platform,
    chatId,
    userId,
    since,
    until,
    q,
    limit = 100,
    includePrivate = this.#config.watch.includePrivate,
  } = {}) {
    const sinceIso = since ? new Date(parseFlexible(since, this.#config.timezone.utcOffsetMinutes)).toISOString() : undefined;
    const untilIso = until ? new Date(parseFlexible(until, this.#config.timezone.utcOffsetMinutes, { endOfDay: true })).toISOString() : undefined;
    const rows = this.#store.queryMessages({
      platform,
      chatId,
      senderId: userId,
      since: sinceIso,
      until: untilIso,
      q,
      limit: Math.min(Math.max(Number(limit) || 100, 1), 500),
      chatType: includePrivate ? undefined : 'group',
    });
    return {
      count: rows.length,
      messages: rows.map((m) => ({
        id: m.id,
        platform: m.platform,
        chatId: m.chatId,
        chatName: m.chatName,
        senderId: m.senderId,
        senderName: m.senderName,
        senderRole: m.senderRole,
        text: truncate(m.text, 500),
        atMe: m.atMe,
        ts: m.ts,
        time: formatShort(Date.parse(m.ts), this.#config.timezone.utcOffsetMinutes),
        follow: Boolean(this.#store.matchFollow(m.platform, m.chatId, m.senderId)),
      })),
    };
  }

  // ------------------------------------------------------------- 摘要/报告

  digest({ since, until, chatIds = null, nowMs = Date.now() } = {}) {
    const range = this.#resolvePeriod(since, until, nowMs);
    return buildDigest({
      store: this.#store,
      config: this.#config,
      since: range.since,
      until: range.until,
      chatIds,
      nowMs,
    });
  }

  #resolvePeriod(since, until, nowMs = Date.now()) {
    if (!since && !until) return defaultPeriod(this.#config, nowMs);
    const offset = this.#config.timezone.utcOffsetMinutes;
    const sinceMs = since
      ? parseFlexible(since, offset)
      : parseFlexible(until, offset) - (Number(this.#config.digest.lookbackHours) || 12) * 3_600_000;
    const untilMs = until ? parseFlexible(until, offset, { endOfDay: false }) : nowMs;
    if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs)) {
      throw new Error('时间范围无效：since / until 需要 YYYY-MM-DD 或 ISO 时间');
    }
    if (sinceMs >= untilMs) throw new Error('时间范围无效：since 必须早于 until');
    return {
      since: new Date(sinceMs).toISOString(),
      until: new Date(untilMs).toISOString(),
    };
  }

  /**
   * 创建待审报告（不会外发）。
   */
  createReport({ since, until, title, channels, chatIds, allowEmpty = false, source = 'manual', nowMs = Date.now() } = {}) {
    const range = this.#resolvePeriod(since || this.resolveSince('report', nowMs), until, nowMs);
    const digest = buildDigest({
      store: this.#store,
      config: this.#config,
      since: range.since,
      until: range.until,
      chatIds,
      nowMs,
    });

    if (digest.messageCount < Math.max(1, Number(this.#config.digest.minMessages) || 1) && !allowEmpty) {
      return {
        created: false,
        reason: 'no_messages',
        message: `该时段（${formatDateTime(Date.parse(range.since), this.#config.timezone.utcOffsetMinutes)} — ${formatDateTime(
          Date.parse(range.until),
          this.#config.timezone.utcOffsetMinutes,
        )}）没有群消息，未生成报告。`,
        digest,
      };
    }

    const offset = this.#config.timezone.utcOffsetMinutes;
    const reportId = `rep_${formatDate(Date.parse(range.until), offset).replace(/-/g, '')}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const finalTitle =
      title ||
      `${this.#config.digest.reportTitle} · ${formatShort(Date.parse(range.until), offset)}`;
    const selectedChannels =
      Array.isArray(channels) && channels.length ? channels : this.#config.digest.channels;
    const markdown = renderReport(digest, {
      config: this.#config,
      title: finalTitle,
      reportId,
      status: 'pending',
    });

    fs.mkdirSync(this.#paths.reports, { recursive: true });
    const filePath = path.join(this.#paths.reports, `${reportId}.md`);
    fs.writeFileSync(filePath, markdown, 'utf8');

    const report = this.#store.createReport({
      id: reportId,
      title: finalTitle,
      periodStart: range.since,
      periodEnd: range.until,
      markdown,
      digest,
      channels: selectedChannels,
      filePath,
    });

    // 顺带把摘要里识别到的日程落库，供「日程表」与后续去重使用。
    persistEvents(this.#store, digest.events);

    const summary = digestToSummaryText(digest, { config: this.#config, maxChars: 500 });
    this.#store.addNotification({
      type: 'report_pending',
      title: `待审核报告：${finalTitle}`,
      body: `${summary}\n\n报告文件：${filePath}\n回复「批准」后可发送；回复修改意见可先改再发。`,
      payload: {
        reportId: report.id,
        filePath,
        periodStart: range.since,
        periodEnd: range.until,
        source,
        channels: selectedChannels,
      },
    });
    this.#log(`已创建待审报告 ${report.id}（${digest.messageCount} 条消息）`);

    return {
      created: true,
      report,
      digest,
      range: { since: range.since, until: range.until },
      summary,
      reviewHint: '报告已进入待审队列。请把摘要给用户看，得到明确批准后再调用 group_report_approve。',
    };
  }

  listReports({ status, limit = 20 } = {}) {
    const reports = this.#store.listReports({ status, limit });
    return {
      count: reports.length,
      reports: reports.map((r) => ({
        id: r.id,
        title: r.title,
        status: r.status,
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        createdAt: r.createdAt,
        sentAt: r.sentAt,
        filePath: r.filePath,
      })),
    };
  }

  getReport(id) {
    if (!REPORT_ID_RE.test(String(id))) throw new Error(`报告 ID 格式不对：${id}`);
    const report = this.#store.getReport(id);
    if (!report) throw new Error(`找不到报告 ${id}`);
    return report;
  }

  updateReport(id, markdown) {
    const report = this.getReport(id);
    if (report.status !== 'pending') {
      throw new Error(`报告当前状态是 ${report.status}，只有 pending 可以修改`);
    }
    if (!String(markdown ?? '').trim()) throw new Error('markdown 不能为空');
    const ok = this.#store.updateReportMarkdown(id, markdown);
    if (!ok) throw new Error('报告更新失败（可能已不是 pending）');
    try {
      fs.writeFileSync(this.getReport(id).filePath, markdown, 'utf8');
    } catch (err) {
      this.#log(`报告文件改写失败（数据库已更新）：${err.message}`);
    }
    return this.getReport(id);
  }

  async approveReport(id, { approvedBy, channels, confirmed = false } = {}) {
    const report = this.getReport(id);
    if (!confirmed) {
      throw new Error('必须显式传 confirmed=true，且仅在用户明确批准后调用');
    }
    if (report.status === 'sent') {
      return { report, alreadySent: true, delivery: report.delivery };
    }
    if (report.status === 'rejected') throw new Error('报告已被驳回，不能发送');

    // 批准后取消这条报告可能还在队列里的「待审核」提醒，避免重复弹。
    this.dismissReportNotifications(id);

    const approved = this.#store.approveReport(id, approvedBy || this.#config.review.approver, channels);
    if (!approved.ok) throw new Error(`批准失败：${approved.reason}`);

    const delivery = await deliverReport({
      report: approved.report,
      config: this.#config,
      paths: this.#paths,
      store: this.#store,
      log: this.#log,
      channels,
    });

    if (delivery.anyOk) {
      const sent = this.#store.markReportSent(id, {
        ok: delivery.ok,
        channels: delivery.channels,
        results: delivery.results,
        at: new Date().toISOString(),
      });
      if (this.#config.delivery.dsh.enabled && this.#config.delivery.dsh.notify) {
        this.#store.addNotification({
          type: 'report_delivered',
          title: `报告已投递：${sent.title}`,
          body: Object.entries(delivery.results)
            .map(([channel, result]) =>
              result.ok
                ? `- ${channel}：成功${result.path ? `（${result.path}）` : ''}`
                : result.skipped
                  ? `- ${channel}：跳过（${result.reason}）`
                  : `- ${channel}：失败（${result.error}）`,
            )
            .join('\n'),
          payload: { reportId: id, results: delivery.results },
        });
      }
      this.#log(`报告 ${id} 已投递：${delivery.channels.join(', ')}`);
      return { report: sent, delivery, ok: delivery.ok };
    }

    this.#store.markReportDeliveryError(id, {
      ok: false,
      channels: delivery.channels,
      results: delivery.results,
      at: new Date().toISOString(),
    });
    this.#store.addNotification({
      type: 'report_delivery_failed',
      title: `报告投递失败：${report.title}`,
      body: Object.entries(delivery.results)
        .map(([channel, result]) => `- ${channel}：${result.error ?? result.reason ?? '失败'}`)
        .join('\n'),
      payload: { reportId: id, results: delivery.results },
    });
    this.#log(`报告 ${id} 投递失败：所有通道均未成功`);
    return { report: this.getReport(id), delivery, ok: false };
  }

  rejectReport(id, reason = '') {
    const report = this.getReport(id);
    if (report.status !== 'pending') throw new Error(`报告当前状态是 ${report.status}，不能驳回`);
    const rejected = this.#store.rejectReport(id, reason);
    this.dismissReportNotifications(id);
    this.#log(`报告 ${id} 已驳回：${reason || '未说明原因'}`);
    return rejected;
  }

  /** 把某份报告的待审核提醒标记为已读/已投递，防止驳回后还被推去审核。 */
  dismissReportNotifications(reportId) {
    const notifications = this.#store
      .listNotifications({ limit: 500 })
      .filter((item) => item.payload?.reportId === reportId);
    const ids = notifications.map((item) => item.id);
    if (ids.length) {
      this.#store.markNotificationRead(ids);
      this.#store.markNotificationDelivered(ids);
    }
    return ids.length;
  }

  // ------------------------------------------------------------------ 日程

  schedule({ since, until, chatIds = null, persist = true, nowMs = Date.now() } = {}) {
    const range = this.#resolvePeriod(since, until, nowMs);
    const messages = this.#store.queryMessages({
      since: range.since,
      until: range.until,
      limit: 500,
      chatType: this.#config.watch.includePrivate ? undefined : 'group',
    });
    const filtered = (Array.isArray(chatIds) && chatIds.length
      ? messages.filter((m) => chatIds.map(String).includes(m.chatId))
      : messages)
      .filter((m) => !isWechatNoise(m));
    const events = extractEvents(
      filtered.map((m) => ({
        ...m,
        senderName: m.senderName,
        chatName: m.chatName,
      })),
      {
        offsetMinutes: this.#config.timezone.utcOffsetMinutes,
        nowMs,
        pastGraceHours: 2,
        defaultDurationMinutes: this.#config.schedule.defaultDurationMinutes,
        minConfidence: this.#config.schedule.minConfidence,
      },
    );
    if (persist) persistEvents(this.#store, events);
    return {
      since: range.since,
      until: range.until,
      count: events.length,
      events,
      markdown: eventsToMarkdown(events, { offsetMinutes: this.#config.timezone.utcOffsetMinutes }),
    };
  }

  lastReportEnd() {
    const latest = this.#store.listReports({ limit: 1 })[0];
    return latest?.periodEnd ?? null;
  }

  /** 默认从“上次查看/生成”开始；没有历史就回看 lookbackHours。 */
  resolveSince(kind = 'report', nowMs = Date.now()) {
    const lookback = Math.max(1, Number(this.#config.digest.lookbackHours) || 12);
    let candidate = null;
    if (kind === 'schedule') candidate = this.#store.getMeta('schedule.lastAt', null);
    if (!candidate) candidate = this.lastReportEnd();
    const parsed = candidate ? Date.parse(candidate) : NaN;
    if (!Number.isFinite(parsed) || parsed >= nowMs || nowMs - parsed > 30 * 86_400_000) {
      return new Date(nowMs - lookback * 3_600_000).toISOString();
    }
    return new Date(parsed).toISOString();
  }

  generateSchedule({ since, until, chatIds = null, persist = true, nowMs = Date.now() } = {}) {
    const start = since || this.resolveSince('schedule', nowMs);
    const result = this.schedule({ since: start, until, chatIds, persist, nowMs });
    this.#store.setMeta('schedule.lastAt', new Date(nowMs).toISOString());
    return { ...result, since: start };
  }

  listUpcomingEvents({ days = 14, nowMs = Date.now() } = {}) {    const until = new Date(nowMs + Math.max(1, days) * 86_400_000).toISOString();
    const events = this.#store.listEvents({
      since: new Date(nowMs - 3_600_000).toISOString(),
      until,
      limit: 200,
    });
    return {
      count: events.length,
      events,
      markdown: eventsToMarkdown(events, { offsetMinutes: this.#config.timezone.utcOffsetMinutes }),
    };
  }

  exportSchedule({ since, until, format = 'ics', nowMs = Date.now() } = {}) {
    const range = this.#resolvePeriod(since, until, nowMs);
    const stored = this.#store.listEvents({ since: range.since, until: range.until, limit: 1000 });
    const messages = this.#store.queryMessages({
      since: range.since,
      until: range.until,
      limit: 1000,
      chatType: this.#config.watch.includePrivate ? undefined : 'group',
    });
    const extracted = extractEvents(messages.filter((m) => !isWechatNoise(m)), {
      offsetMinutes: this.#config.timezone.utcOffsetMinutes,
      nowMs,
      pastGraceHours: 2,
      defaultDurationMinutes: this.#config.schedule.defaultDurationMinutes,
      minConfidence: this.#config.schedule.minConfidence,
    });
    const byKey = new Map();
    for (const event of [...stored, ...extracted]) {
      if (!byKey.has(event.dedupeKey)) byKey.set(event.dedupeKey, event);
    }
    const events = [...byKey.values()].sort((a, b) => a.startAt.localeCompare(b.startAt));
    if (!events.length) return { count: 0, events: [], path: null, message: '该时间范围内没有识别到日程。' };

    fs.mkdirSync(this.#paths.exports, { recursive: true });
    const base = `schedule-${formatDate(nowMs, this.#config.timezone.utcOffsetMinutes).replace(/-/g, '')}-${String(
      new Date(nowMs).getHours(),
    ).padStart(2, '0')}${String(new Date(nowMs).getMinutes()).padStart(2, '0')}`;

    let filePath;
    let content;
    if (format === 'csv') {
      filePath = path.join(this.#paths.exports, `${base}.csv`);
      content = `\uFEFF${exportCsv(events, { offsetMinutes: this.#config.timezone.utcOffsetMinutes })}`;
    } else if (format === 'md' || format === 'markdown') {
      filePath = path.join(this.#paths.exports, `${base}.md`);
      content = `# 群聊日程\n\n${eventsToMarkdown(events, {
        offsetMinutes: this.#config.timezone.utcOffsetMinutes,
      })}\n`;
    } else {
      filePath = path.join(this.#paths.exports, `${base}.ics`);
      content = exportIcs(events, {
        offsetMinutes: this.#config.timezone.utcOffsetMinutes,
        calendarName: `${this.#config.digest.reportTitle} · 日程`,
        nowMs,
      });
    }
    fs.writeFileSync(filePath, content, 'utf8');
    this.#log(`日程已导出：${filePath}（${events.length} 项）`);
    return { count: events.length, events, path: filePath, format };
  }

  // ------------------------------------------------------------------ 通知

  listNotifications({ undelivered = true, limit = 50 } = {}) {
    return {
      count: this.#store.listNotifications({ undelivered, limit }).length,
      notifications: this.#store.listNotifications({ undelivered, limit }),
    };
  }

  /** 供 DSH 唤醒插件拉取：取出未投递的通知并标记已投递。 */
  drainNotifications({ limit = 20, markDelivered = true } = {}) {
    const notifications = this.#store.listNotifications({ undelivered: true, limit });
    if (markDelivered && notifications.length) {
      this.#store.markNotificationDelivered(notifications.map((n) => n.id));
    }
    return { count: notifications.length, notifications };
  }

  markNotificationRead(ids) {
    return { updated: this.#store.markNotificationRead(ids) };
  }

  markNotificationDelivered(ids) {
    return { updated: this.#store.markNotificationDelivered(ids) };
  }

  // -------------------------------------------------------------- 运维信息

  reportMarkdown(id) {
    return this.getReport(id).markdown;
  }

  /** 摘要预览（不入库），给 MCP 的 group_digest 用。 */
  previewDigest({ since, until, chatIds } = {}) {
    const digest = this.digest({ since, until, chatIds });
    return {
      ...digest,
      markdown: renderReport(digest, {
        config: this.#config,
        title: `${this.#config.digest.reportTitle} · 预览`,
        status: 'pending',
      }),
    };
  }

  /** 给 MCP 的简短状态，token 等敏感信息不出现。 */
  publicStatus() {
    const full = this.status();
    return {
      ...full,
      config: {
        adapters: this.#config.adapters,
        watch: {
          keywords: this.#config.watch.keywords,
          excludedGroups: this.#config.watch.excludedGroups,
          followAlerts: this.#config.watch.followAlerts,
          includePrivate: this.#config.watch.includePrivate,
        },
        digest: this.#config.digest,
        schedule: this.#config.schedule,
        delivery: {
          channels: this.#config.delivery.channels,
          qq: { enabled: this.#config.delivery.qq.enabled },
          wechat: { enabled: this.#config.delivery.wechat.enabled },
          dsh: this.#config.delivery.dsh,
        },
        review: this.#config.review,
      },
    };
  }
}
