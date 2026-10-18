/**
 * 消息规范化与入库管道。
 *
 * 所有适配器最终都产出同一种结构（见 normalizeOneBot / normalizeWebhook），
 * 下游摘要、日程、报告只认这一种结构，不再关心消息来自 QQ 还是微信。
 */

import { normalizeSpace, stableId, truncate } from './util/text.js';

const CQ_LABELS = {
  image: '[图片]',
  face: '[表情]',
  mface: '[表情包]',
  record: '[语音]',
  video: '[视频]',
  file: '[文件]',
  json: '[卡片]',
  xml: '[卡片]',
  forward: '[聊天记录]',
  dice: '[骰子]',
  rps: '[猜拳]',
  share: '[分享]',
  music: '[音乐]',
  location: '[位置]',
  contact: '[名片]',
  reply: '[回复]',
};

/** 把 OneBot v11 的 message 段数组渲染成纯文本。 */
export function renderSegments(segments, selfId) {
  if (typeof segments === 'string') return stripCq(segments);
  if (!Array.isArray(segments)) return '';
  const parts = [];
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object') continue;
    const type = seg.type;
    const data = seg.data ?? {};
    if (type === 'text') {
      parts.push(String(data.text ?? ''));
    } else if (type === 'at') {
      const qq = String(data.qq ?? '');
      if (qq === 'all') parts.push('@全体成员');
      else if (selfId && qq === String(selfId)) parts.push('@我');
      else parts.push(`@${data.name ?? qq}`);
    } else if (type === 'reply') {
      // 引用关系单独存在 replyTo 里，正文不重复占位。
      continue;
    } else {
      parts.push(CQ_LABELS[type] ?? `[${type}]`);
    }
  }
  return normalizeSpace(parts.join(''));
}

/** 没有段数组时，从 raw_message 里剥掉 CQ 码。 */
export function stripCq(raw) {
  const text = String(raw ?? '').replace(/\[CQ:([a-zA-Z_]+)(?:,[^\]]*)?\]/g, (_, type) => {
    if (type === 'at') return '@';
    return CQ_LABELS[type] ?? '';
  });
  return normalizeSpace(text);
}

function pickMentionNames(segments) {
  if (!Array.isArray(segments)) return [];
  return segments
    .filter((seg) => seg?.type === 'at' && String(seg?.data?.qq ?? '') !== 'all')
    .map((seg) => ({ id: String(seg.data.qq ?? ''), name: String(seg.data.name ?? '') }));
}

const toIsoSeconds = (seconds) => {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return new Date().toISOString();
  return new Date(n * 1000).toISOString();
};

/**
 * OneBot 11 事件 → 统一消息。
 * 私聊与群聊都会返回结构；非消息事件返回 null。
 */
export function normalizeOneBot(event, { platform = 'qq', adapter = 'onebot', selfId = null } = {}) {
  if (!event || event.post_type !== 'message') return null;
  const isGroup = event.message_type === 'group';
  const isPrivate = event.message_type === 'private';
  if (!isGroup && !isPrivate) return null;

  const groupId = isGroup ? String(event.group_id ?? '') : null;
  const userId = String(event.user_id ?? event.sender?.user_id ?? '');
  if (!userId) return null;

  const segments = event.message;
  const text = renderSegments(segments, selfId ?? event.self_id);
  const mentions = pickMentionNames(segments);
  const self = String(selfId ?? event.self_id ?? '');
  const atMe =
    Boolean(self) &&
    Array.isArray(segments) &&
    segments.some((seg) => seg?.type === 'at' && String(seg?.data?.qq ?? '') === self);

  const sender = event.sender ?? {};
  const senderName =
    normalizeSpace(sender.card || sender.nickname || sender.name || '') || `用户${userId}`;
  const chatId = isGroup ? groupId : `private:${userId}`;
  const chatName = isGroup
    ? normalizeSpace(event.group_name || sender.group_name || '') || `QQ群 ${groupId}`
    : `与 ${senderName} 的私聊`;

  return {
    id: stableId(platform, chatId, event.message_id ?? `${userId}:${event.time}:${text}`),
    msgId: event.message_id === undefined ? null : String(event.message_id),
    platform,
    adapter,
    chatId,
    chatName,
    chatType: isGroup ? 'group' : 'private',
    senderId: userId,
    senderName,
    senderRole: isGroup ? (sender.role ?? null) : null,
    text,
    atMe,
    mentions,
    replyTo: Array.isArray(segments)
      ? String(segments.find((seg) => seg?.type === 'reply')?.data?.id ?? '') || null
      : null,
    ts: toIsoSeconds(event.time),
    raw: event,
    msgSeq: null,
  };
}

/**
 * 通用 Webhook 载荷 → 统一消息。用于微信桥或自定义采集器。
 *
 * 兼容字段：
 *   chatId/chat_id/groupId/roomId, chatName/chat_name/groupName,
 *   senderId/sender_id/from, senderName/sender_name/nickname,
 *   text/content/message, ts/timestamp/time
 */
export function normalizeWebhook(payload, { platform = 'wechat', adapter = 'webhook' } = {}) {
  if (!payload || typeof payload !== 'object') return null;
  const pick = (...keys) => {
    for (const key of keys) {
      const value = payload[key];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return null;
  };

  const chatIdRaw = pick('chatId', 'chat_id', 'groupId', 'group_id', 'roomId', 'room_id');
  const senderIdRaw = pick('senderId', 'sender_id', 'from', 'userId', 'user_id');
  if (chatIdRaw === null || senderIdRaw === null) return null;

  const text = normalizeSpace(pick('text', 'content', 'message', 'msg') ?? '');
  if (!text) return null;

  const isGroup = payload.chatType
    ? String(payload.chatType) === 'group'
    : !/^private/i.test(String(chatIdRaw));

  const chatId = isGroup ? String(chatIdRaw) : `private:${String(chatIdRaw)}`;
  const chatName =
    normalizeSpace(pick('chatName', 'chat_name', 'groupName', 'group_name', 'roomName') ?? '') ||
    (isGroup ? `群 ${chatIdRaw}` : `与 ${pick('senderName', 'sender_name', 'nickname') ?? senderIdRaw} 的私聊`);

  let ts = payload.ts ?? payload.timestamp ?? payload.time ?? null;
  let tsMs = null;
  if (typeof ts === 'number') {
    // 兼容秒与毫秒时间戳。
    tsMs = ts < 1e12 ? ts * 1000 : ts;
  } else if (ts) {
    tsMs = Date.parse(String(ts));
  }
  if (!Number.isFinite(tsMs)) tsMs = Date.now();
  const iso = new Date(tsMs).toISOString();

  const msgId = pick('msgId', 'msg_id', 'messageId', 'message_id', 'id');
  const textRaw = String(pick('text', 'content', 'message', 'msg') ?? '');
  const senderName =
    normalizeSpace(pick('senderName', 'sender_name', 'nickname', 'card') ?? '') ||
    `用户${senderIdRaw}`;

  return {
    id: stableId(platform, chatId, msgId ?? `${senderIdRaw}:${iso}:${textRaw}`),
    msgId: msgId === null ? null : String(msgId),
    platform,
    adapter,
    chatId,
    chatName,
    chatType: isGroup ? 'group' : 'private',
    senderId: String(senderIdRaw),
    senderName,
    senderRole: payload.senderRole ?? payload.sender_role ?? null,
    text,
    atMe: Boolean(payload.atMe ?? payload.at_me ?? /@我|@所有人|@全体成员/.test(text)),
    mentions: Array.isArray(payload.mentions) ? payload.mentions : [],
    replyTo: payload.replyTo ?? payload.reply_to ?? null,
    ts: iso,
    raw: payload,
  };
}

/**
 * 入库管道：写库 + 重点用户即时提醒（可选）。
 *
 * 提醒在这里做而不是在摘要里做，是为了满足「关注的人一说话我就知道」；
 * 但默认 followAlerts='digest'，只在摘要里体现，避免消息风暴。
 */
export class Ingest {
  #store;
  #config;
  #log;
  #notificationSink;
  #lastAlertAt = new Map();

  constructor({ store, config, log = () => {}, onNotification = null }) {
    this.#store = store;
    this.#config = config;
    this.#log = log;
    this.#notificationSink = onNotification;
  }

  get store() {
    return this.#store;
  }

  /** @returns {{inserted: boolean, message: object, follow: object|null}} */
  ingest(message) {
    if (!message) return { inserted: false, message: null, follow: null };

    const follow = this.#store.matchFollow(message.platform, message.chatId, message.senderId);
    if (follow && !message.senderRole) {
      // 关注用户也可能是管理员；不覆盖 OneBot 给的 role。
    }

    const inserted = this.#store.insertMessage(message);
    if (!inserted) {
      return { inserted: false, message, follow };
    }

    if (follow && this.#shouldAlert(follow, message)) {
      this.#alert(follow, message);
    }

    return { inserted: true, message, follow };
  }

  #shouldAlert(follow, message) {
    if (this.#config.watch.followAlerts !== 'instant') return false;
    if (message.chatType !== 'group') return false;
    const key = `${message.platform}:${message.chatId}:${follow.userId}`;
    const debounceMs =
      Math.max(1, Number(this.#config.watch.followAlertDebounceMinutes ?? 10)) * 60_000;
    const last = this.#lastAlertAt.get(key) ?? 0;
    const ts = Date.parse(message.ts);
    if (Number.isFinite(ts) && ts - last < debounceMs) return false;
    this.#lastAlertAt.set(key, Number.isFinite(ts) ? ts : Date.now());
    return true;
  }

  #alert(follow, message) {
    const title = `重点用户发言：${follow.userName || follow.userId}`;
    const body =
      `${message.chatName} · ${message.senderName}\n` +
      `${truncate(message.text, 300)}\n` +
      `（${message.ts}）`;
    const id = this.#store.addNotification({
      type: 'follow_alert',
      title,
      body,
      payload: {
        reportId: null,
        platform: message.platform,
        chatId: message.chatId,
        chatName: message.chatName,
        senderId: message.senderId,
        senderName: message.senderName,
        msgId: message.msgId,
        priority: follow.priority,
      },
    });
    this.#log(`重点用户提醒 #${id}：${follow.userName || follow.userId} @ ${message.chatName}`);
    try {
      this.#notificationSink?.({ id, type: 'follow_alert', title, body });
    } catch {
      /* 通知投递失败不影响入库 */
    }
  }
}
