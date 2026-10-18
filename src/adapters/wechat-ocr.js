/**
 * 微信 OCR 适配器（Windows UI + 系统中文 OCR）。
 *
 * 微信 4.x 不暴露 UIA 控件，数据库也加密，所以这里走屏幕级读取：
 *   1. 把微信窗口显示到前台，截图会话列表，OCR 出群名/时间/最后一条；
 *   2. 对用户在设置里勾选的群，点开会话再截图聊天区，OCR 出最近消息；
 *   3. 把一次聊天扫描作为一条快照消息入库（sender 记为“微信群”），
 *      摘要、报告、日程提取都能复用现有管道。
 *
 * 局限：不是协议级全量消息；一次扫描只覆盖当前可见的一屏；打开群会清未读。
 * 默认只有在你勾选至少一个群之后才会自动巡检，避免无意义地弹窗口。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { PKG_ROOT } from '../config.js';
import { normalizeSpace, stableId, truncate } from '../util/text.js';
import { resolveQqTime } from './qq-uia.js';

const SCRIPT = path.join(PKG_ROOT, 'scripts', 'wechat-scan.ps1');

/** OCR 常把汉字拆开，去掉汉字之间的空格，保留英文/数字间距。 */
export function cleanOcr(text) {
  return normalizeSpace(text)
    .replace(/(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '')
    .replace(/\s+([，。；：、）】])/g, '$1')
    .replace(/([（【])\s+/g, '$1')
    .replace(/^[．.·…]+/g, '')
    .replace(/[\s．.·…]+$/g, '')
    .trim();
}

function normalizeKey(text) {
  return cleanOcr(text).replace(/\s+/g, '').replace(/[．.·…]/g, '').toLowerCase();
}

function normalizeTime(text) {
  return String(text ?? '')
    .replace(/\s+/g, '')
    .replace(/[：]/g, ':')
    // OCR 常见误认：把数字认成形近字符。
    .replace(/[彐ヨ]{1,}/g, '3')
    .replace(/[Oo〇]/g, '0')
    .replace(/[lI|]/g, '1')
    .replace(/[S]/g, '5')
    .replace(/[B]/g, '8');
}

/** 纯时间：11:06 / 昨天17:49 / 星期三 / 10/06；允许 OCR 误认后的形态。 */
function isTimeText(text) {
  const t = normalizeTime(text);
  if (/^(\d{1,2}:\d{1,2}|昨天\d{1,2}:\d{1,2}|今天\d{1,2}:\d{1,2}|(星期|周)[一二三四五六日]|\d{1,2}\/\d{1,2})$/.test(t)) {
    return true;
  }
  // OCR 把数字认成形近字符时，去掉非数字后仍像 3~4 位时间。
  if (!/[:：]/.test(String(text ?? ''))) return false;
  const digits = t.replace(/[^\d:]/g, '');
  return /^\d{1,2}:\d{1,2}$/.test(digits);
}

/** 从 OCR 行里解析微信会话列表。 */
export function parseWechatSessions(lines, { width = 0 } = {}) {
  const list = (lines ?? []).filter((line) => line && line.text);
  const leftMax = Math.min(480, width * 0.42);
  const suffixRe =
    /\s*((?:(?:昨天|今天)\s*)?\d(?:\s*\d)?\s*[:：]\s*\d(?:\s*\d)?|(?:星期|周)[一二三四五六日]|\d{1,2}\s*\/\s*\d{1,2})\s*$/;
  const entries = [];

  for (const line of list) {
    if (line.x < 80 || line.x > leftMax || line.y < 80) continue;
    const raw = normalizeSpace(line.text);
    if (!raw || /搜索/.test(raw)) continue;
    const match = raw.match(suffixRe);
    const prefix = match ? raw.slice(0, match.index).trim() : '';
    if (isTimeText(raw)) {
      // 纯时间行；不要把它误当成“群名 + 时间”。
      entries.push({ timeText: raw, y: line.y, timeLine: line, order: 1 });
    } else if (match && prefix.length >= 2) {
      // 群名与时间被 OCR 合成同一行：Astra2027电控组培... 11:06
      entries.push({
        nameLine: { ...line, text: prefix },
        timeText: match[1],
        y: line.y,
        order: 0,
      });
    }
  }

  entries.sort((a, b) => a.y - b.y || a.order - b.order);
  const sessions = [];
  const seen = new Set();
  for (const entry of entries) {
    let nameLine = entry.nameLine;
    if (!nameLine) {
      const candidates = list.filter(
        (line) =>
          line.x < entry.timeLine.x - 20 &&
          line.x > 80 &&
          Math.abs(line.y - entry.timeLine.y) < 18 &&
          !isTimeText(line.text) &&
          cleanOcr(line.text).length >= 1,
      );
      if (!candidates.length) continue;
      candidates.sort((a, b) => b.w - a.w || Math.abs(a.y - entry.timeLine.y) - Math.abs(b.y - entry.timeLine.y));
      nameLine = candidates[0];
    }
    const name = cleanOcr(nameLine.text);
    if (!name || /^搜索/.test(name)) continue;
    const key = normalizeKey(name);
    if (seen.has(key)) continue;
    seen.add(key);

    const previewLines = list
      .filter(
        (line) =>
          line.x < Math.min(470, width * 0.4) &&
          line.y > entry.y + 16 &&
          line.y < entry.y + 58 &&
          !isTimeText(line.text) &&
          cleanOcr(line.text).length >= 1,
      )
      .sort((a, b) => a.y - b.y)
      .slice(0, 2);
    const preview = cleanOcr(previewLines.map((line) => line.text).join(' '));
    sessions.push({
      name,
      time: normalizeTime(entry.timeText),
      preview: truncate(preview, 80),
      x: Math.max(120, Math.round(width * 0.17)),
      y: entry.y + 12,
      rowY: entry.y,
    });
  }
  return sessions;
}

/** 从聊天区 OCR 行里尽量还原成逐条消息。 */
export function parseWechatMessages(lines, { width = 0, height = 0, now = Date.now(), offset = 480 } = {}) {
  const right = (lines ?? [])
    .filter((line) => line && line.text)
    .filter(
      (line) =>
        line.x > Math.min(430, width * 0.34) &&
        line.y > 100 &&
        line.y < Math.max(200, height - 130),
    )
    .sort((a, b) => a.y - b.y || a.x - b.x);

  const chatStart = Math.min(430, width * 0.34);
  const blocks = [];
  let current = null;
  let pendingTs = null;
  const push = () => {
    if (!current) return;
    const text = current.texts.map((t) => cleanOcr(t)).filter((t) => t && t.length > 1).join('\n');
    if (text) {
      blocks.push({
        senderName: current.senderName,
        text: truncate(text, 3000),
        ts: current.ts || null,
      });
    }
    current = null;
  };

  for (const line of right) {
    const text = cleanOcr(line.text);
    if (!text) continue;
    // 时间戳在消息上方，属于下一条。
    if (line.x > 700 && isTimeText(text)) {
      const ts = resolveQqTime(normalizeTime(text), now, offset);
      if (ts) pendingTs = ts;
      continue;
    }
    // 有些群消息会被 OCR 合成“发送者：正文”，先拆出发送者。
    const lead = text.match(/^([^：:，。！？]{1,8})[：:]\s*(.+)$/);
    if (
      lead &&
      !/^\d+$/.test(lead[1]) &&
      !/^(时间|地点|主题|注意|备注|关于)$/.test(lead[1]) &&
      (!current || current.senderName === '未知')
    ) {
      if (!current) current = { senderName: lead[1], texts: [lead[2]], ts: pendingTs };
      else {
        current.senderName = lead[1];
        current.texts = [lead[2], ...current.texts];
      }
      pendingTs = null;
      continue;
    }
    // 自己的消息靠右。
    if (line.x >= chatStart + (width - chatStart) * 0.48) {      push();
      current = { senderName: '我', texts: [text], ts: pendingTs };
      pendingTs = null;
      push();
      continue;
    }
    // 群聊里发送者名字单独一行，靠左且较短；正文在它下面，比名字右移约 15px。
    const looksLikeSender =
      line.x < chatStart + 145 &&
      text.length <= 24 &&
      !/[：:，。！？!?]/.test(text) &&
      !/^(聊天记录|以下为新消息|查看更多)/.test(text);
    if (looksLikeSender) {
      push();
      current = { senderName: text, texts: [], ts: pendingTs };
      pendingTs = null;
      continue;
    }
    if (!current) {
      current = { senderName: '未知', texts: [text], ts: pendingTs };
      pendingTs = null;
    } else {
      current.texts.push(text);
    }
  }
  push();
  return blocks;
}

/** 从 OCR 行里提取聊天区文本。 */
export function parseWechatChat(lines, { width = 0, height = 0 } = {}) {
  const right = (lines ?? [])
    .filter((line) => line && line.text)
    .filter(
      (line) =>
        line.x > Math.min(430, width * 0.34) &&
        line.y > 55 &&
        line.y < Math.max(200, height - 130),
    )
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const titleLine = right.find((line) => line.y < 110 && /（\s*\d+\s*）/.test(line.text));
  const body = right.filter((line) => line !== titleLine);
  const text = body.map((line) => cleanOcr(line.text)).filter((t) => t && t.length > 1).join('\n');
  return {
    title: titleLine ? cleanOcr(titleLine.text) : '',
    text: truncate(text, 6000),
    lines: body.length,
  };
}

function runScan(
  { clickX = -1, clickY = -1, outDir, pages = 1, chatPages = 1, groupName = '', since = null },
  { timeoutMs = 120000 } = {},
) {
  return new Promise((resolve, reject) => {
    const args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      SCRIPT,
      '-OutDir',
      outDir,
      '-ClickX',
      String(clickX),
      '-ClickY',
      String(clickY),
      '-Pages',
      String(pages),
      '-ChatPages',
      String(chatPages),
    ];
    if (groupName) {
      args.push('-GroupNameB64', Buffer.from(String(groupName), 'utf8').toString('base64'));
    }
    if (since) {
      args.push('-SinceB64', Buffer.from(String(since), 'utf8').toString('base64'));
    }
    const child = spawn('powershell.exe', args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`微信扫描超时（${timeoutMs}ms）`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')));
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
        reject(new Error(`微信扫描无输出${stderr ? `：${stderr.slice(0, 200)}` : ''}`));
        return;
      }
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error(`微信扫描返回非 JSON：${line.slice(0, 200)}`));
      }
    });
  });
}

export class WechatOcrAdapter {
  #cfg;
  #store;
  #paths;
  #log;
  #onMessage;
  #timer = null;
  #running = false;
  #status = 'idle';
  #lastError = null;
  #lastScanAt = null;
  #groups = [];
  #lastChat = null;
  #seenMessages = new Set();
  #lastSignature = new Map();
  #stats = { scans: 0, chats: 0, messages: 0, errors: 0 };

  constructor({ config, store, paths, log = () => {}, onMessage }) {
    this.#cfg = config.adapters.wechatOcr;
    this.#store = store;
    this.#paths = paths;
    this.#log = log;
    this.#onMessage = onMessage;
  }

  get stats() {
    return {
      enabled: this.#cfg.enabled,
      status: this.#status,
      groups: this.#groups.length,
      monitored: this.#store.listGroupSettings('wechat').filter((item) => item.enabled).length,
      lastScanAt: this.#lastScanAt,
      lastChat: this.#lastChat,
      lastError: this.#lastError,
      ...this.#stats,
    };
  }

  start() {
    if (this.#timer) return;
    this.#status = 'starting';
    this.#timer = setInterval(() => {
      this.#poll().catch((err) => this.#log(`微信巡检失败：${err.message}`));
    }, Math.max(30_000, Number(this.#cfg.intervalMs) || 120_000));
    this.#timer.unref?.();
    this.#log(`微信 OCR 已启用（间隔 ${this.#cfg.intervalMs}ms，勾选群后才会自动打开）`);
  }

  stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#status = 'stopped';
  }

  async #poll() {
    if (this.#running || !this.#cfg.enabled) return;
    const monitored = this.#store.listGroupSettings('wechat').filter((item) => item.enabled);
    if (!monitored.length) return; // 没勾选任何群时不弹微信
    this.#running = true;
    try {
      const scan = await this.#scanList();
      const sessions = scan.sessions;
      this.#groups = sessions;
      this.#lastScanAt = new Date().toISOString();
      this.#status = 'ready';
      this.#stats.scans += 1;
      this.#lastError = null;

      let opened = 0;
      for (const setting of monitored) {
        if (opened >= 2) break;
        const key = normalizeKey(setting.chatId.replace(/^wechat:/, ''));
        const session = sessions.find((item) => normalizeKey(item.name) === key) ??
          sessions.find((item) => normalizeKey(item.name).startsWith(key.slice(0, 6)));
        if (!session) continue;
        const signature = `${session.time}|${session.preview}`;
        if (this.#lastSignature.get(key) === signature) continue;
        try {
          await this.scanGroup(session.name, { x: session.x, y: session.y });
          this.#lastSignature.set(key, signature);
          opened += 1;
        } catch (err) {
          this.#stats.errors += 1;
          this.#log(`打开微信群 ${session.name} 失败：${err.message}`);
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

  #cleanupShots() {
    const dir = path.join(this.#paths.exports, 'wechat');
    try {
      const files = fs.readdirSync(dir)
        .filter((name) => name.endsWith('.png'))
        .map((name) => ({ name, full: path.join(dir, name), stat: fs.statSync(path.join(dir, name)) }))
        .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
      const cutoff = Date.now() - 2 * 60 * 60 * 1000;
      for (const file of files) {
        if (file.stat.mtimeMs < cutoff || files.indexOf(file) >= 40) {
          fs.unlinkSync(file.full);
        }
      }
    } catch {
      /* 清理失败不影响读取 */
    }
  }

  async #scanList() {
    const result = await runScan({ outDir: path.join(this.#paths.exports, 'wechat'), pages: 3 });
    if (!result.ok) throw new Error(result.hint || result.error || 'wechat_scan_failed');
    this.#cleanupShots();
    const pages = result.list?.pages?.length ? result.list.pages : [{ lines: result.list?.lines }];
    const merged = new Map();
    for (const page of pages) {
      const sessions = parseWechatSessions(page.lines, {
        width: result.width,
        height: result.height,
      });
      for (const session of sessions) {
        const key = normalizeKey(session.name);
        if (!merged.has(key)) merged.set(key, session);
      }
    }
    return { ...result, sessions: [...merged.values()] };
  }

  /** 手动刷新会话列表（设置页按钮）。会短暂弹出微信窗口。 */
  async listGroups() {
    const scan = await this.#scanList();
    this.#groups = scan.sessions;
    this.#lastScanAt = new Date().toISOString();
    this.#status = 'ready';
    return {
      groups: scan.sessions,
      image: scan.list?.image,
      at: this.#lastScanAt,
    };
  }

  /** 打开并扫描某个群；name 可以来自 listGroups，x/y 是列表行坐标。 */
  async scanGroup(name, { x = null, y = null, chatPages = 1, since = null } = {}) {
    const direct = Number.isFinite(x) && Number.isFinite(y);
    let result = null;
    let chat = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      result = await runScan({
        clickX: direct ? x : -1,
        clickY: direct ? y : -1,
        groupName: direct ? '' : name,
        pages: direct ? 1 : 3,
        chatPages,
        since,
        outDir: path.join(this.#paths.exports, 'wechat'),
      });
      if (!result.ok) {
        throw new Error(result.hint || (result.error === 'group_not_found' ? `没有在微信会话列表里找到：${name}` : (result.error || 'wechat_chat_scan_failed')));
      }
      chat = parseWechatChat(result.chat?.lines, {
        width: result.width,
        height: result.height,
      });
      if (chat.text) break;
      // 刚点开时聊天区偶尔还在加载，等一下重试一次。
      await new Promise((resolve) => setTimeout(resolve, 1800));
    }
    if (!chat?.text) throw new Error('聊天区没有识别到文字');
    const session = this.#groups.find((item) => normalizeKey(item.name) === normalizeKey(name)) ?? { name };
    const chatName = chat.title || session.name;
    // 用聊天区标题做 canonical ID，避免会话列表 OCR 抖动（Astra…相戒/电控）导致重复入库。
    const chatId = `wechat:${normalizeKey(chatName)}`;
    const now = Date.now();
    const pages = result.chat?.pages?.length ? result.chat.pages : [{ lines: result.chat?.lines }];
    let blocks = [];
    for (const page of pages) {
      blocks.push(...parseWechatMessages(page.lines, {
        width: result.width,
        height: result.height,
        now,
        offset: 480,
      }));
    }
    // 多页会重叠，先按发送者+正文+时间戳去重，再按 since 过滤。
    const seenBlocks = new Set();
    blocks = blocks.filter((block) => {
      if (!block.text) return false;
      if (since && block.ts && Date.parse(block.ts) < Date.parse(since) - 60_000) return false;
      const key = `${block.senderName}|${block.text}`;
      if (seenBlocks.has(key)) return false;
      seenBlocks.add(key);
      return true;
    });
    // 兜底：识别不出气泡结构时，至少保留整屏文本。
    if (!blocks.length) {
      const fallback = pages.map((page) => parseWechatChat(page.lines, {
        width: result.width,
        height: result.height,
      }).text).filter(Boolean).join('\n');
      if (fallback) blocks = [{ senderName: '微信群', text: fallback, ts: new Date(now).toISOString() }];
    }

    let count = 0;
    for (const block of blocks) {
      if (!block.text) continue;
      const ts = block.ts || new Date(now).toISOString();
      const id = stableId('wechat-ocr', chatId, block.senderName, block.text);
      if (this.#seenMessages.has(id)) continue;
      this.#seenMessages.add(id);
      this.#onMessage?.({
        id,
        msgId: id,
        platform: 'wechat',
        adapter: 'wechat-ocr',
        chatId,
        chatName,
        chatType: 'group',
        senderId: `name:${block.senderName}`,
        senderName: block.senderName,
        senderRole: null,
        text: block.text,
        atMe: false,
        mentions: [],
        replyTo: null,
        ts,
        raw: { source: 'wechat-ocr', image: result.chat?.image ?? null, chars: block.text.length },
      });
      count += 1;
    }
    if (this.#seenMessages.size > 5000) {
      this.#seenMessages = new Set([...this.#seenMessages].slice(-3000));
    }
    this.#stats.chats += 1;
    this.#stats.messages += count;
    this.#lastChat = {
      name: chatName,
      at: new Date().toISOString(),
      chars: blocks.reduce((sum, block) => sum + block.text.length, 0),
      count,
    };
    this.#status = 'ready';
    this.#cleanupShots();
    return {
      chatName,
      chatId,
      count,
      duplicate: count === 0,
      text: blocks.map((block) => `${block.senderName}：${block.text}`).join('\n'),
      image: result.chat?.image ?? null,
    };
  }

  /** 报告/日程点击时，主动补采所有已勾选群在 since 之后的消息。 */
  async collectMonitored({ since = null, maxGroups = 20, chatPages = 8 } = {}) {
    const monitored = this.#store.listGroupSettings('wechat').filter((item) => item.enabled);
    if (!monitored.length) return { groups: 0, messages: 0, note: '没有勾选微信监控群' };
    if (this.#running) throw new Error('微信正在巡检，请稍后再点一次');
    this.#running = true;
    try {
      const scan = await this.#scanList();
      this.#groups = scan.sessions;
      const sessions = scan.sessions;
      let total = 0;
      let groups = 0;
      const details = [];
      for (const setting of monitored.slice(0, Math.max(1, maxGroups))) {
        const key = normalizeKey(setting.chatId.replace(/^wechat:/, ''));
        const session = sessions.find((item) => normalizeKey(item.name) === key) ??
          sessions.find((item) => normalizeKey(item.name).startsWith(key.slice(0, 6)));
        if (!session) {
          details.push({ group: setting.chatId, ok: false, error: '不在当前会话列表' });
          continue;
        }
        try {
          const result = await this.scanGroup(session.name, {
            x: session.x,
            y: session.y,
            chatPages,
            since,
          });
          total += result.count;
          groups += 1;
          details.push({ group: result.chatName, ok: true, count: result.count });
          this.#lastSignature.set(key, `${session.time}|${session.preview}`);
        } catch (err) {
          details.push({ group: session.name, ok: false, error: err.message });
        }
      }
      this.#status = 'ready';
      return { groups, messages: total, details, at: new Date().toISOString() };
    } finally {
      this.#running = false;
    }
  }

  setIntervalMs(ms) {
    const next = Math.max(30_000, Number(ms) || 120_000);
    this.#cfg.intervalMs = next;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = setInterval(() => {
        this.#poll().catch((err) => this.#log(`微信巡检失败：${err.message}`));
      }, next);
      this.#timer.unref?.();
    }
    return next;
  }
}

export { runScan };
