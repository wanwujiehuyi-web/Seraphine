/**
 * QQ UIA 适配器（无需插件、无需额外登录）。
 *
 * 原理：让 QQ 以 `--force-renderer-accessibility` 启动后，Chromium 会把
 * 会话列表与聊天区暴露成 Windows UI Automation 树。本适配器用 PowerShell
 * 脚本（scripts/qq-uia.ps1）读取：
 *   - 会话列表：所有群的名称、最后一条消息、发送者、时间、未读数（只读，不影响已读状态）
 *   - 当前打开的会话：完整消息气泡（只读）
 *   - 指定群：调用 InvokePattern 打开后读取（会将该群标记为已读，属于用户主动操作）
 *
 * 它是「尽力而为」的屏幕级读取：同一轮询间隔内一个群连续发多条时，会话列表
 * 只能看到最后一条；要完整读取请用 group_qq_read 打开该群。
 */

import { spawn } from 'node:child_process';
import path from 'node:path';

import { PKG_ROOT } from '../config.js';
import {
  addDaysLocal,
  formatDate,
  fromLocal,
  localParts,
  startOfLocalDay,
} from '../util/time.js';
import { stableId, normalizeSpace } from '../util/text.js';

const SCRIPT = path.join(PKG_ROOT, 'scripts', 'qq-uia.ps1');

function runUia(mode, { index = -1, groupName = '' } = {}, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      SCRIPT,
      '-Mode',
      mode,
    ];
    if (index >= 0) args.push('-Index', String(index));
    // 中文群名用 Base64 传参，绕开 Windows PowerShell 5.1 的 argv 编码差异。
    if (groupName) {
      args.push('-GroupNameB64', Buffer.from(String(groupName), 'utf8').toString('base64'));
    }
    const child = spawn('powershell.exe', args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`QQ UIA 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const line = stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .at(-1);
      if (!line) {
        reject(new Error(`QQ UIA 无输出${stderr ? `：${stderr.slice(0, 200)}` : ''}`));
        return;
      }
      try {
        resolve(JSON.parse(line));
      } catch (err) {
        reject(new Error(`QQ UIA 返回非 JSON：${line.slice(0, 200)}`));
      }
    });
  });
}

/** 解析 QQ 的相对时间（HH:mm / 昨天 HH:mm / 星期X / M/D）。 */
export function resolveQqTime(text, nowMs, offsetMinutes) {
  const value = String(text ?? '').trim();
  if (!value) return null;
  const now = localParts(nowMs, offsetMinutes);
  const today = startOfLocalDay(nowMs, offsetMinutes);

  const clock = /(\d{1,2}):(\d{2})/.exec(value);
  const hour = clock ? Number(clock[1]) : null;
  const minute = clock ? Number(clock[2]) : null;

  if (/^昨天/.test(value)) {
    return new Date(addDaysLocal(today, -1, offsetMinutes) - 12 * 3_600_000 + (hour ?? 0) * 3_600_000 + (minute ?? 0) * 60_000).toISOString();
  }
  if (/^今天/.test(value)) {
    return new Date(today + (hour ?? 0) * 3_600_000 + (minute ?? 0) * 60_000).toISOString();
  }
  const week = /(?:星期|周)([一二三四五六日])/.exec(value);
  if (week) {
    const target = '一二三四五六日'.indexOf(week[1]) + 1;
    const current = now.weekday === 0 ? 7 : now.weekday;
    let delta = (current - target + 7) % 7;
    if (delta === 0 && hour !== null) {
      const candidate = today + hour * 3_600_000 + (minute ?? 0) * 60_000;
      if (candidate > nowMs + 5 * 60_000) delta = 7;
    }
    const day = today - delta * 86_400_000;
    return new Date(day + (hour ?? 0) * 3_600_000 + (minute ?? 0) * 60_000).toISOString();
  }
  const md = /^(\d{1,2})\/(\d{1,2})$/.exec(value);
  if (md) {
    const month = Number(md[1]);
    const day = Number(md[2]);
    let year = now.year;
    let ms = fromLocal({ year, month, day }, offsetMinutes);
    if (ms > nowMs + 86_400_000) {
      year -= 1;
      ms = fromLocal({ year, month, day }, offsetMinutes);
    }
    return new Date(ms).toISOString();
  }
  if (hour !== null) {
    let ts = today + hour * 3_600_000 + minute * 60_000;
    if (ts > nowMs + 5 * 60_000) ts -= 86_400_000;
    return new Date(ts).toISOString();
  }
  return null;
}

export class QqUiaAdapter {
  #cfg;
  #log;
  #offset;
  #onMessage;
  #timer = null;
  #running = false;
  #status = 'idle';
  #lastSessions = [];
  #lastError = null;
  #lastPollAt = null;
  #hwnd = null;
  #sessionSeen = new Map();
  #chatSeen = new Set();
  #lastChat = null;
  #store = null;
  #stats = { sessionMessages: 0, chatMessages: 0, polls: 0, errors: 0 };

  constructor({ config, log = () => {}, onMessage, store = null }) {
    this.#cfg = config.adapters.qqUia;
    this.#offset = config.timezone.utcOffsetMinutes;
    this.#log = log;
    this.#onMessage = onMessage;
    this.#store = store;
  }

  get stats() {
    return {
      status: this.#status,
      enabled: this.#cfg.enabled,
      hwnd: this.#hwnd,
      sessions: this.#lastSessions.length,
      lastChat: this.#lastChat?.chatName ?? null,
      lastPollAt: this.#lastPollAt,
      lastError: this.#lastError,
      ...this.#stats,
    };
  }

  start() {
    if (this.#timer) return;
    this.#status = 'starting';
    this.#poll().catch((err) => this.#log(`QQ UIA 首次轮询失败：${err.message}`));
    const interval = Math.max(1500, Number(this.#cfg.intervalMs) || 5000);
    this.#timer = setInterval(() => {
      this.#poll().catch((err) => this.#log(`QQ UIA 轮询失败：${err.message}`));
    }, interval);
    this.#timer.unref?.();
    this.#log(`QQ UIA 已启动，间隔 ${interval}ms`);
  }

  stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#status = 'stopped';
  }

  setIntervalMs(ms) {
    const next = Math.max(1500, Number(ms) || 5000);
    this.#cfg.intervalMs = next;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = setInterval(() => {
        this.#poll().catch((err) => this.#log(`QQ UIA 轮询失败：${err.message}`));
      }, next);
      this.#timer.unref?.();
    }
    return next;
  }

  async #poll() {
    if (this.#running) return;
    this.#running = true;
    try {
      const sessions = await runUia('sessions');
      this.#stats.polls += 1;
      this.#lastPollAt = new Date().toISOString();
      if (!sessions.ok) {
        this.#status = sessions.error ?? 'unavailable';
        this.#lastError = sessions.error ?? null;
        return;
      }
      this.#status = 'ready';
      this.#lastError = null;
      this.#hwnd = sessions.hwnd ?? null;
      this.#lastSessions = sessions.sessions ?? [];
      const now = Date.now();
      const autoRead = [];
      for (const session of this.#lastSessions) {
        if (!session?.name) continue;
        const settings = this.#store?.getGroupSettings('qq', `uia:${session.name}`);
        if (settings && settings.enabled === false) continue;
        this.#ingestSession(session, now);
        if (session.unread > 0 && (settings?.autoRead || this.#cfg.autoOpenUnread)) {
          autoRead.push(session);
        }
      }
      if (this.#cfg.readCurrentChat !== false) {
        await this.#pollChat(now);
      }
      for (const session of autoRead.slice(0, 2)) {
        try {
          await this.readGroup(session.name, { limit: 20 });
        } catch (err) {
          this.#log(`自动读取 ${session.name} 失败：${err.message}`);
        }
      }
    } catch (err) {
      this.#stats.errors += 1;
      this.#status = `error: ${err.message}`;
      this.#lastError = err.message;
    } finally {
      this.#running = false;
    }
  }

  #ingestSession(session, now) {
    if (!session?.name) return;
    const ts = resolveQqTime(session.time, now, this.#offset) ?? new Date(now).toISOString();
    const text = normalizeSpace(session.preview || '');
    if (!text) return;
    const key = `${session.name}|${session.time}|${session.sender}|${text}`;
    if (this.#sessionSeen.get(session.name) === key) return;
    this.#sessionSeen.set(session.name, key);

    const message = {
      id: stableId('qq-uia-session', session.name, key),
      msgId: `uia-session-${stableId(session.name, key, 12)}`,
      platform: 'qq',
      adapter: 'qq-uia',
      chatId: `uia:${session.name}`,
      chatName: session.name,
      chatType: 'group',
      senderId: session.sender ? `name:${session.sender}` : `name:未知`,
      senderName: session.sender || '未知',
      senderRole: null,
      text,
      atMe: false,
      mentions: [],
      replyTo: null,
      ts,
      raw: { source: 'session-list', unread: session.unread, time: session.time },
    };
    this.#onMessage?.(message);
    this.#stats.sessionMessages += 1;
  }

  async #pollChat(now) {
    let chat;
    try {
      chat = await runUia('chat');
    } catch {
      return;
    }
    if (!chat?.ok || !chat.chatName) return;
    const chatSettings = this.#store?.getGroupSettings('qq', `uia:${chat.chatName}`);
    if (chatSettings && chatSettings.enabled === false) return;
    this.#lastChat = { chatName: chat.chatName, hwnd: chat.hwnd, count: (chat.messages ?? []).length };
    let lastTs = null;
    for (const item of chat.messages ?? []) {
      let ts = resolveQqTime(item.timestamp, now, this.#offset);
      if (!ts) ts = lastTs ?? new Date(now).toISOString();
      lastTs = ts;
      const sender = normalizeSpace(item.sender || '') || '未知';
      const text = normalizeSpace(item.text || '');
      if (!text) continue;
      const key = stableId(chat.chatName, ts, sender, text);
      if (this.#chatSeen.has(key)) continue;
      this.#chatSeen.add(key);
      if (this.#chatSeen.size > 5000) {
        this.#chatSeen = new Set([...this.#chatSeen].slice(-3000));
      }
      this.#onMessage?.({
        id: key,
        msgId: key,
        platform: 'qq',
        adapter: 'qq-uia',
        chatId: `uia:${chat.chatName}`,
        chatName: chat.chatName,
        chatType: 'group',
        senderId: `name:${sender}`,
        senderName: sender,
        senderRole: null,
        text,
        atMe: false,
        mentions: [],
        replyTo: null,
        ts,
        raw: { source: 'chat-pane', system: item.isSystem === true },
      });
      this.#stats.chatMessages += 1;
    }
  }

  /**
   * 用户主动读取某个群：打开会话 → 读取当前消息区。
   * 注意：打开会话会把该群标记为已读。
   */
  async readGroup(groupName, { limit = 30 } = {}) {
    if (!groupName) throw new Error('需要群名（从 group_list 或会话列表里取）');
    const opened = await runUia('open', { groupName });
    if (!opened.ok) throw new Error(`打开群失败：${opened.error ?? 'unknown'}`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const chat = await runUia('chat');
    if (!chat.ok) throw new Error(`读取群消息失败：${chat.error ?? 'unknown'}`);
    const now = Date.now();
    let lastTs = null;
    const messages = [];
    for (const item of (chat.messages ?? []).slice(-limit)) {
      let ts = resolveQqTime(item.timestamp, now, this.#offset);
      if (!ts) ts = lastTs ?? new Date(now).toISOString();
      lastTs = ts;
      const sender = normalizeSpace(item.sender || '') || '未知';
      const text = normalizeSpace(item.text || '');
      if (!text) continue;
      const key = stableId(chat.chatName, ts, sender, text);
      messages.push({ key, ts, sender, text, system: item.isSystem === true });
      if (!this.#chatSeen.has(key)) {
        this.#chatSeen.add(key);
        this.#onMessage?.({
          id: key,
          msgId: key,
          platform: 'qq',
          adapter: 'qq-uia',
          chatId: `uia:${chat.chatName}`,
          chatName: chat.chatName,
          chatType: 'group',
          senderId: `name:${sender}`,
          senderName: sender,
          senderRole: null,
          text,
          atMe: false,
          mentions: [],
          replyTo: null,
          ts,
          raw: { source: 'chat-pane', system: item.isSystem === true },
        });
      }
    }
    return { chatName: chat.chatName, count: messages.length, messages };
  }

  listSessions() {
    return this.#lastSessions;
  }
}

export { runUia };
