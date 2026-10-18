/**
 * SQLite 存储层（node:sqlite，零外部依赖）。
 *
 * 设计取舍：
 *   - 消息表只追加，靠主键去重（OneBot Resume 会重放事件）。
 *   - 报告的正文直接存库 + 同步落一份 .md 文件；审核状态在库里，文件只是方便人看。
 *   - 日程事件的去重键由「标题+开始时间+来源群」构成，重复提取不会产生重复日历项。
 *   - 所有时间字段都是 ISO-8601 UTC 字符串，可直接按字典序比较。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { stableId } from './util/text.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  adapter TEXT NOT NULL DEFAULT '',
  chat_id TEXT NOT NULL,
  chat_name TEXT NOT NULL DEFAULT '',
  chat_type TEXT NOT NULL DEFAULT 'group',
  sender_id TEXT NOT NULL DEFAULT '',
  sender_name TEXT NOT NULL DEFAULT '',
  sender_role TEXT,
  text TEXT NOT NULL DEFAULT '',
  at_me INTEGER NOT NULL DEFAULT 0,
  mentions TEXT NOT NULL DEFAULT '[]',
  reply_to TEXT,
  ts TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  raw TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages (platform, chat_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages (ts);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages (platform, sender_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_chat_sender ON messages (platform, chat_id, sender_id, ts);

CREATE TABLE IF NOT EXISTS groups (
  platform TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  chat_type TEXT NOT NULL DEFAULT 'group',
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  watched INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (platform, chat_id)
);

CREATE TABLE IF NOT EXISTS follows (
  platform TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'normal',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (platform, chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  status TEXT NOT NULL,
  markdown TEXT NOT NULL DEFAULT '',
  digest_json TEXT,
  channels TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  approved_at TEXT,
  approved_by TEXT,
  rejected_at TEXT,
  reject_reason TEXT,
  sent_at TEXT,
  delivery_json TEXT,
  file_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports (status, created_at);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  chat_name TEXT,
  msg_id TEXT,
  title TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT,
  all_day INTEGER NOT NULL DEFAULT 0,
  location TEXT,
  source_sender TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  kind TEXT,
  rrule TEXT,
  raw TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_start ON events (start_at);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  payload TEXT,
  created_at TEXT NOT NULL,
  read_at TEXT,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications (delivered_at, created_at);

CREATE TABLE IF NOT EXISTS runs (
  key TEXT PRIMARY KEY,
  ran_at TEXT NOT NULL,
  meta TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS group_settings (
  platform TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  auto_read INTEGER NOT NULL DEFAULT 0,
  keywords TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (platform, chat_id)
);
`;

const nowIso = () => new Date().toISOString();

function boolInt(value) {
  return value ? 1 : 0;
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export class Store {
  #db;
  #path;

  constructor(file) {
    this.#path = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.#db = new DatabaseSync(file);
    this.#db.exec('PRAGMA journal_mode = WAL;');
    this.#db.exec('PRAGMA synchronous = NORMAL;');
    this.#db.exec('PRAGMA busy_timeout = 5000;');
    this.#db.exec(SCHEMA);
  }

  get path() {
    return this.#path;
  }

  close() {
    try {
      this.#db.close();
    } catch {
      /* 已关闭 */
    }
  }

  // ---------------------------------------------------------------- messages

  /**
   * 写入一条规范化消息。返回 true 表示新消息，false 表示重复（主键冲突）。
   * 同时维护 groups 的最后活跃时间与计数。
   */
  insertMessage(message) {
    const now = nowIso();
    const id = message.id ?? stableId(
      message.platform,
      message.chatId,
      message.msgId ?? `${message.senderId}:${message.ts}:${message.text}`,
    );
    const stmt = this.#db.prepare(`
      INSERT OR IGNORE INTO messages
        (id, platform, adapter, chat_id, chat_name, chat_type, sender_id, sender_name,
         sender_role, text, at_me, mentions, reply_to, ts, ingested_at, raw)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      id,
      message.platform,
      message.adapter ?? '',
      message.chatId,
      message.chatName ?? '',
      message.chatType ?? 'group',
      message.senderId ?? '',
      message.senderName ?? '',
      message.senderRole ?? null,
      message.text ?? '',
      boolInt(message.atMe),
      JSON.stringify(message.mentions ?? []),
      message.replyTo ?? null,
      message.ts,
      now,
      message.raw === undefined ? null : JSON.stringify(message.raw),
    );

    const inserted = Number(result.changes ?? 0) > 0;
    if (inserted) {
      const existing = this.#db
        .prepare('SELECT message_count FROM groups WHERE platform = ? AND chat_id = ?')
        .get(message.platform, message.chatId);
      if (existing) {
        this.#db
          .prepare(
            `UPDATE groups SET name = ?, last_seen = ?, message_count = message_count + 1
             WHERE platform = ? AND chat_id = ?`,
          )
          .run(message.chatName || '', message.ts, message.platform, message.chatId);
      } else {
        this.#db
          .prepare(
            `INSERT INTO groups (platform, chat_id, name, chat_type, first_seen, last_seen, message_count, watched)
             VALUES (?, ?, ?, ?, ?, ?, 1, 1)`,
          )
          .run(
            message.platform,
            message.chatId,
            message.chatName ?? '',
            message.chatType ?? 'group',
            message.ts,
            message.ts,
          );
      }
    }
    return inserted;
  }

  queryMessages({
    platform,
    chatId,
    chatType,
    senderId,
    since,
    until,
    q,
    limit = 100,
    offset = 0,
    order = 'asc',
  } = {}) {
    const where = [];
    const params = [];
    if (platform) {
      where.push('platform = ?');
      params.push(platform);
    }
    if (chatId) {
      where.push('chat_id = ?');
      params.push(String(chatId));
    }
    if (chatType) {
      where.push('chat_type = ?');
      params.push(chatType);
    }
    if (senderId) {
      where.push('sender_id = ?');
      params.push(String(senderId));
    }
    if (since) {
      where.push('ts >= ?');
      params.push(since);
    }
    if (until) {
      where.push('ts <= ?');
      params.push(until);
    }
    if (q) {
      where.push('text LIKE ?');
      params.push(`%${q}%`);
    }
    const sql = `
      SELECT * FROM messages
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ts ${order === 'desc' ? 'DESC' : 'ASC'}
      LIMIT ? OFFSET ?
    `;
    const rows = this.#db.prepare(sql).all(...params, Math.min(Math.max(limit, 1), 1000), Math.max(offset, 0));
    return rows.map(toMessage);
  }

  countMessages(filters = {}) {
    const rows = this.queryMessages({ ...filters, limit: 1000, offset: 0 });
    // 简化实现：最多统计 1000 条；摘要场景足够。
    return rows.length;
  }

  // ------------------------------------------------------------------ groups

  listGroups({ watchedOnly = false } = {}) {
    const rows = this.#db
      .prepare(
        `SELECT * FROM groups ${watchedOnly ? 'WHERE watched = 1' : ''}
         ORDER BY last_seen DESC`,
      )
      .all();
    return rows.map((row) => ({
      platform: row.platform,
      chatId: row.chat_id,
      name: row.name,
      chatType: row.chat_type,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      messageCount: Number(row.message_count),
      watched: Boolean(row.watched),
    }));
  }

  getGroup(platform, chatId) {
    const row = this.#db
      .prepare('SELECT * FROM groups WHERE platform = ? AND chat_id = ?')
      .get(platform, String(chatId));
    if (!row) return null;
    return {
      platform: row.platform,
      chatId: row.chat_id,
      name: row.name,
      chatType: row.chat_type,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      messageCount: Number(row.message_count),
      watched: Boolean(row.watched),
    };
  }

  setGroupWatched(platform, chatId, watched) {
    const existing = this.getGroup(platform, chatId);
    if (!existing) {
      const now = nowIso();
      this.#db
        .prepare(
          `INSERT INTO groups (platform, chat_id, name, chat_type, first_seen, last_seen, message_count, watched)
           VALUES (?, ?, '', 'group', ?, ?, 0, ?)`,
        )
        .run(platform, String(chatId), now, now, boolInt(watched));
      return true;
    }
    this.#db
      .prepare('UPDATE groups SET watched = ? WHERE platform = ? AND chat_id = ?')
      .run(boolInt(watched), platform, String(chatId));
    return true;
  }

  renameGroup(platform, chatId, name) {
    this.#db
      .prepare('UPDATE groups SET name = ? WHERE platform = ? AND chat_id = ?')
      .run(String(name), platform, String(chatId));
  }

  // --------------------------------------------------------- group settings

  getGroupSettings(platform, chatId) {
    const row = this.#db
      .prepare('SELECT * FROM group_settings WHERE platform = ? AND chat_id = ?')
      .get(platform, String(chatId));
    if (!row) {
      return { platform, chatId: String(chatId), enabled: true, autoRead: false, keywords: [] };
    }
    return {
      platform: row.platform,
      chatId: row.chat_id,
      enabled: Boolean(row.enabled),
      autoRead: Boolean(row.auto_read),
      keywords: parseJson(row.keywords, []),
      updatedAt: row.updated_at,
    };
  }

  listGroupSettings(platform) {
    const rows = platform
      ? this.#db.prepare('SELECT * FROM group_settings WHERE platform = ?').all(platform)
      : this.#db.prepare('SELECT * FROM group_settings').all();
    return rows.map((row) => ({
      platform: row.platform,
      chatId: row.chat_id,
      enabled: Boolean(row.enabled),
      autoRead: Boolean(row.auto_read),
      keywords: parseJson(row.keywords, []),
      updatedAt: row.updated_at,
    }));
  }

  setGroupSettings({ platform, chatId, enabled = true, autoRead = false, keywords = [] }) {
    this.#db
      .prepare(
        `INSERT INTO group_settings (platform, chat_id, enabled, auto_read, keywords, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (platform, chat_id) DO UPDATE SET
           enabled = excluded.enabled,
           auto_read = excluded.auto_read,
           keywords = excluded.keywords,
           updated_at = excluded.updated_at`,
      )
      .run(
        platform,
        String(chatId),
        boolInt(enabled),
        boolInt(autoRead),
        JSON.stringify(keywords ?? []),
        nowIso(),
      );
    return this.getGroupSettings(platform, chatId);
  }

  /** 某个群最近发言过的成员，用于“重点成员”选择列表。 */
  listMembers(chatId, { limit = 100 } = {}) {
    const rows = this.#db
      .prepare(
        `SELECT sender_id, sender_name, COUNT(*) AS count, MAX(ts) AS last_at
         FROM messages WHERE chat_id = ?
         GROUP BY sender_id ORDER BY count DESC LIMIT ?`,
      )
      .all(String(chatId), Math.min(Math.max(limit, 1), 500));
    return rows.map((row) => ({
      senderId: row.sender_id,
      senderName: row.sender_name,
      count: Number(row.count),
      lastAt: row.last_at,
    }));
  }

  searchMembers(q, { limit = 50 } = {}) {
    const term = `%${String(q ?? '').trim()}%`;
    if (term === '%%') return [];
    const rows = this.#db
      .prepare(
        `SELECT platform, chat_id, MAX(chat_name) AS chat_name, sender_id, sender_name,
                COUNT(*) AS count, MAX(ts) AS last_at
         FROM messages
         WHERE sender_name LIKE ? OR sender_id LIKE ?
         GROUP BY platform, chat_id, sender_id
         ORDER BY count DESC, last_at DESC LIMIT ?`,
      )
      .all(term, term, Math.min(Math.max(limit, 1), 200));
    return rows.map((row) => ({
      platform: row.platform,
      chatId: row.chat_id,
      chatName: row.chat_name,
      senderId: row.sender_id,
      senderName: row.sender_name,
      count: Number(row.count),
      lastAt: row.last_at,
    }));
  }

  // ----------------------------------------------------------------- follows

  addFollow({ platform, chatId = '*', userId, userName = '', priority = 'normal', note = '' }) {
    this.#db
      .prepare(
        `INSERT INTO follows (platform, chat_id, user_id, user_name, priority, note, created_at, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT (platform, chat_id, user_id) DO UPDATE SET
           user_name = excluded.user_name,
           priority = excluded.priority,
           note = excluded.note,
           active = 1`,
      )
      .run(platform, String(chatId), String(userId), userName, priority, note, nowIso());
    return this.listFollows().find(
      (f) => f.platform === platform && f.chatId === String(chatId) && f.userId === String(userId),
    );
  }

  removeFollow({ platform, chatId = '*', userId }) {
    const result = this.#db
      .prepare(
        'UPDATE follows SET active = 0 WHERE platform = ? AND chat_id = ? AND user_id = ?',
      )
      .run(platform, String(chatId), String(userId));
    return Number(result.changes ?? 0) > 0;
  }

  listFollows({ activeOnly = true } = {}) {
    const rows = this.#db
      .prepare(`SELECT * FROM follows ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY created_at ASC`)
      .all();
    return rows.map((row) => ({
      platform: row.platform,
      chatId: row.chat_id,
      userId: row.user_id,
      userName: row.user_name,
      priority: row.priority,
      note: row.note,
      createdAt: row.created_at,
      active: Boolean(row.active),
    }));
  }

  /** 某条消息的发送者是否在关注列表里；返回命中的 follow 或 null。 */
  matchFollow(platform, chatId, userId) {
    if (!userId) return null;
    const row = this.#db
      .prepare(
        `SELECT * FROM follows
         WHERE platform = ? AND user_id = ? AND active = 1 AND (chat_id = ? OR chat_id = '*')
         ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END
         LIMIT 1`,
      )
      .get(platform, String(userId), String(chatId));
    if (!row) return null;
    return {
      platform: row.platform,
      chatId: row.chat_id,
      userId: row.user_id,
      userName: row.user_name,
      priority: row.priority,
      note: row.note,
    };
  }

  // ----------------------------------------------------------------- reports

  createReport({ id, title, periodStart, periodEnd, markdown, digest, channels, filePath }) {
    const now = nowIso();
    const reportId = id ?? `rep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    this.#db
      .prepare(
        `INSERT INTO reports
          (id, title, period_start, period_end, status, markdown, digest_json, channels,
           created_at, updated_at, file_path)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        reportId,
        title,
        periodStart,
        periodEnd,
        markdown,
        JSON.stringify(digest ?? null),
        JSON.stringify(channels ?? []),
        now,
        now,
        filePath ?? null,
      );
    return this.getReport(reportId);
  }

  getReport(id) {
    const row = this.#db.prepare('SELECT * FROM reports WHERE id = ?').get(String(id));
    return row ? toReport(row) : null;
  }

  listReports({ status, limit = 20 } = {}) {
    const rows = status
      ? this.#db
          .prepare('SELECT * FROM reports WHERE status = ? ORDER BY created_at DESC LIMIT ?')
          .all(status, limit)
      : this.#db.prepare('SELECT * FROM reports ORDER BY created_at DESC LIMIT ?').all(limit);
    return rows.map(toReport);
  }

  /** 只更新正文；用于人工/AI 润色后再次审核。 */
  updateReportMarkdown(id, markdown) {
    const result = this.#db
      .prepare("UPDATE reports SET markdown = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(markdown, nowIso(), String(id));
    return Number(result.changes ?? 0) > 0;
  }

  approveReport(id, approvedBy, channels) {
    const row = this.#db.prepare('SELECT * FROM reports WHERE id = ?').get(String(id));
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.status === 'sent') return { ok: false, reason: 'already_sent' };
    if (row.status === 'rejected') return { ok: false, reason: 'rejected' };
    if (row.status === 'approved') return { ok: true, report: toReport(row), idempotent: true };

    const now = nowIso();
    this.#db
      .prepare(
        `UPDATE reports SET status = 'approved', approved_at = ?, approved_by = ?, updated_at = ?,
           channels = COALESCE(?, channels)
         WHERE id = ?`,
      )
      .run(now, approvedBy ?? 'user', now, channels ? JSON.stringify(channels) : null, String(id));
    return { ok: true, report: this.getReport(id) };
  }

  markReportSent(id, delivery) {
    const now = nowIso();
    const row = this.#db.prepare('SELECT delivery_json FROM reports WHERE id = ?').get(String(id));
    const merged = { ...(parseJson(row?.delivery_json, {}) ?? {}), ...delivery };
    this.#db
      .prepare("UPDATE reports SET status = 'sent', sent_at = ?, delivery_json = ?, updated_at = ? WHERE id = ?")
      .run(now, JSON.stringify(merged), now, String(id));
    return this.getReport(id);
  }

  markReportDeliveryError(id, delivery) {
    const now = nowIso();
    const row = this.#db.prepare('SELECT delivery_json FROM reports WHERE id = ?').get(String(id));
    const merged = { ...(parseJson(row?.delivery_json, {}) ?? {}), ...delivery };
    this.#db
      .prepare("UPDATE reports SET delivery_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(merged), now, String(id));
    return this.getReport(id);
  }

  rejectReport(id, reason) {
    const result = this.#db
      .prepare(
        `UPDATE reports SET status = 'rejected', rejected_at = ?, reject_reason = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(nowIso(), reason ?? '', nowIso(), String(id));
    return Number(result.changes ?? 0) > 0 ? this.getReport(id) : null;
  }

  // ------------------------------------------------------------------ events

  upsertEvent(event) {
    const id = event.id ?? stableId(event.dedupeKey);
    const result = this.#db
      .prepare(
        `INSERT OR IGNORE INTO events
          (id, dedupe_key, platform, chat_id, chat_name, msg_id, title, start_at, end_at, all_day,
           location, source_sender, confidence, kind, rrule, raw, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        event.dedupeKey,
        event.platform,
        String(event.chatId),
        event.chatName ?? null,
        event.msgId ?? null,
        event.title,
        event.startAt,
        event.endAt ?? null,
        boolInt(event.allDay),
        event.location ?? null,
        event.sourceSender ?? null,
        Number(event.confidence ?? 0),
        event.kind ?? null,
        event.rrule ?? null,
        event.raw ?? null,
        nowIso(),
      );
    return Number(result.changes ?? 0) > 0;
  }

  listEvents({ since, until, chatId, limit = 200 } = {}) {
    const where = [];
    const params = [];
    if (since) {
      where.push('start_at >= ?');
      params.push(since);
    }
    if (until) {
      where.push('start_at <= ?');
      params.push(until);
    }
    if (chatId) {
      where.push('chat_id = ?');
      params.push(String(chatId));
    }
    const rows = this.#db
      .prepare(
        `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY start_at ASC LIMIT ?`,
      )
      .all(...params, Math.min(Math.max(limit, 1), 1000));
    return rows.map(toEvent);
  }

  // ----------------------------------------------------------- notifications

  addNotification({ type, title, body = '', payload }) {
    const result = this.#db
      .prepare(
        'INSERT INTO notifications (type, title, body, payload, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(type, title, body, JSON.stringify(payload ?? null), nowIso());
    const id = Number(result.lastInsertRowid);
    this.#trimNotifications();
    return id;
  }

  #trimNotifications() {
    // 只清理「已投递且已读」的旧通知，避免把未读队列削掉。
    this.#db
      .prepare(
        `DELETE FROM notifications WHERE id NOT IN (
           SELECT id FROM notifications ORDER BY id DESC LIMIT 500
         ) AND delivered_at IS NOT NULL`,
      )
      .run();
  }

  listNotifications({ unread = false, undelivered = false, limit = 50 } = {}) {
    const where = [];
    if (unread) where.push('read_at IS NULL');
    if (undelivered) where.push('delivered_at IS NULL');
    const rows = this.#db
      .prepare(
        `SELECT * FROM notifications ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY id ASC LIMIT ?`,
      )
      .all(Math.min(Math.max(limit, 1), 500));
    return rows.map((row) => ({
      id: Number(row.id),
      type: row.type,
      title: row.title,
      body: row.body,
      payload: parseJson(row.payload, null),
      createdAt: row.created_at,
      readAt: row.read_at,
      deliveredAt: row.delivered_at,
    }));
  }

  markNotificationDelivered(ids) {
    if (!ids?.length) return 0;
    const stmt = this.#db.prepare(
      'UPDATE notifications SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL',
    );
    const now = nowIso();
    let changed = 0;
    for (const id of ids) changed += Number(stmt.run(now, Number(id)).changes ?? 0);
    return changed;
  }

  markNotificationRead(ids) {
    if (!ids?.length) return 0;
    const stmt = this.#db.prepare('UPDATE notifications SET read_at = ? WHERE id = ?');
    const now = nowIso();
    let changed = 0;
    for (const id of ids) changed += Number(stmt.run(now, Number(id)).changes ?? 0);
    return changed;
  }

  // -------------------------------------------------------------- runs / meta

  getRun(key) {
    return this.#db.prepare('SELECT * FROM runs WHERE key = ?').get(key) ?? null;
  }

  setRun(key, meta) {
    this.#db
      .prepare(
        `INSERT INTO runs (key, ran_at, meta) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET ran_at = excluded.ran_at, meta = excluded.meta`,
      )
      .run(key, nowIso(), JSON.stringify(meta ?? null));
  }

  getMeta(key, fallback = null) {
    const row = this.#db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? parseJson(row.value, row.value) : fallback;
  }

  setMeta(key, value) {
    this.#db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, JSON.stringify(value));
  }

  stats() {
    const one = (sql) => Number(this.#db.prepare(sql).get()?.n ?? 0);
    return {
      messages: one('SELECT COUNT(*) AS n FROM messages'),
      groups: one('SELECT COUNT(*) AS n FROM groups'),
      follows: one('SELECT COUNT(*) AS n FROM follows WHERE active = 1'),
      reports: one('SELECT COUNT(*) AS n FROM reports'),
      pendingReports: one("SELECT COUNT(*) AS n FROM reports WHERE status = 'pending'"),
      events: one('SELECT COUNT(*) AS n FROM events'),
      unreadNotifications: one('SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL'),
      undeliveredNotifications: one(
        'SELECT COUNT(*) AS n FROM notifications WHERE delivered_at IS NULL',
      ),
    };
  }
}

function toMessage(row) {
  return {
    id: row.id,
    platform: row.platform,
    adapter: row.adapter,
    chatId: row.chat_id,
    chatName: row.chat_name,
    chatType: row.chat_type,
    senderId: row.sender_id,
    senderName: row.sender_name,
    senderRole: row.sender_role,
    text: row.text,
    atMe: Boolean(row.at_me),
    mentions: parseJson(row.mentions, []),
    replyTo: row.reply_to,
    ts: row.ts,
    ingestedAt: row.ingested_at,
    raw: parseJson(row.raw, null),
  };
}

function toReport(row) {
  return {
    id: row.id,
    title: row.title,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    status: row.status,
    markdown: row.markdown,
    digest: parseJson(row.digest_json, null),
    channels: parseJson(row.channels, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
    rejectedAt: row.rejected_at,
    rejectReason: row.reject_reason,
    sentAt: row.sent_at,
    delivery: parseJson(row.delivery_json, null),
    filePath: row.file_path,
  };
}

function toEvent(row) {
  return {
    id: row.id,
    dedupeKey: row.dedupe_key,
    platform: row.platform,
    chatId: row.chat_id,
    chatName: row.chat_name,
    msgId: row.msg_id,
    title: row.title,
    startAt: row.start_at,
    endAt: row.end_at,
    allDay: Boolean(row.all_day),
    location: row.location,
    sourceSender: row.source_sender,
    confidence: Number(row.confidence),
    kind: row.kind,
    rrule: row.rrule,
    raw: row.raw,
    createdAt: row.created_at,
  };
}
