/**
 * 摘要引擎：把一段时间的群消息压成「重点用户动态 + 关键消息 + 公告 +
 * 问题 + 链接 + 日程 + 群活跃度」。
 *
 * 刻意做成确定性的（不用 LLM）：这样定时任务零成本、结果可复现、每条都能
 * 追溯到原消息。需要更高质量的「提炼」时，DSH 里的模型可以在这些结构化
 * 结果之上改写报告；事实来源仍然是这里。
 */

import { extractEvents, eventsToMarkdown, kindLabel } from './schedule.js';
import {
  clamp,
  extractUrls,
  looksLikeQuestion,
  normalizeSpace,
  sumBy,
  tableCell,
  truncate,
  uniqBy,
} from './util/text.js';
import { formatDateTime, formatShort } from './util/time.js';

const DEADLINE_RE = /截止|截至|ddl|deadline|报名截止|提交截止|最后期限/i;
const ANNOUNCE_RE = /通知|公告|决定|安排|要求|请注意|重要|统一|务必|必须/;
const NOISE_RE = /^(收到|好的?|ok|嗯+|哦+|啊+|哈+|1|👍|👌|。|…|在吗|有人吗)$/i;

export function isLowSignal(text) {
  const value = normalizeSpace(text);
  if (!value) return true;
  if (NOISE_RE.test(value)) return true;
  if (value.length <= 1) return true;
  return false;
}

function followKey(follow) {
  return `${follow.platform}:${follow.chatId}:${follow.userId}`;
}

/** 建关注索引：同时支持群级与全局（chatId='*'）关注。 */
function buildFollowIndex(follows) {
  const map = new Map();
  for (const follow of follows) {
    map.set(`${follow.platform}:${follow.chatId}:${follow.userId}`, follow);
  }
  return function lookup(platform, chatId, userId) {
    return (
      map.get(`${platform}:${chatId}:${userId}`) ?? map.get(`${platform}:*:${userId}`) ?? null
    );
  };
}

function scoreMessage(message, follow, keywords, customRules = []) {
  let score = 0;
  const reasons = [];
  const ruleHits = [];

  if (follow) {
    score += follow.priority === 'high' ? 6 : 4;
    reasons.push(follow.priority === 'high' ? '重点用户' : '关注用户');
  }
  if (message.atMe) {
    score += 6;
    reasons.push('@我');
  }
  if (message.senderRole === 'owner') {
    score += 3;
    reasons.push('群主');
  } else if (message.senderRole === 'admin') {
    score += 2;
    reasons.push('管理员');
  }

  const lower = message.text.toLowerCase();
  let keywordHits = 0;
  for (const keyword of keywords) {
    if (!keyword) continue;
    if (lower.includes(String(keyword).toLowerCase())) {
      keywordHits += 1;
      if (reasons.length < 6) reasons.push(`关键词:${keyword}`);
      if (keywordHits >= 3) break;
    }
  }
  score += keywordHits * 2;

  if (DEADLINE_RE.test(message.text)) {
    score += 3;
    reasons.push('截止时间');
  }
  if (ANNOUNCE_RE.test(message.text)) {
    score += 2;
    reasons.push('通知/决定');
  }
  if (extractUrls(message.text).length) {
    score += 1;
    reasons.push('链接');
  }
  if (looksLikeQuestion(message.text)) {
    score += 1;
    reasons.push('提问');
  }
  if (message.text.length >= 40) score += 1;

  for (const rule of customRules) {
    if (!rule?.pattern) continue;
    let matched = false;
    try {
      matched = rule.regex
        ? rule.regex.test(message.text)
        : message.text.toLowerCase().includes(String(rule.pattern).toLowerCase());
    } catch {
      matched = false;
    }
    if (matched) {
      score += Number(rule.weight) || 3;
      reasons.push(`自定义:${rule.name || rule.pattern}`);
      ruleHits.push({ name: rule.name || rule.pattern, pattern: rule.pattern });
    }
  }

  return { score, reasons: [...new Set(reasons)], ruleHits };
}

function fetchAllMessages(store, filters) {
  const pageSize = 1000;
  const out = [];
  for (let offset = 0; offset < 20_000; offset += pageSize) {
    const page = store.queryMessages({ ...filters, limit: pageSize, offset });
    out.push(...page);
    if (page.length < pageSize) break;
  }
  return out;
}

/**
 * @param {object} args
 * @param {object} args.store Store
 * @param {object} args.config 规范化配置
 * @param {string} args.since ISO
 * @param {string} args.until ISO
 * @param {string[]|null} args.chatIds 只统计指定群
 */
export function buildDigest({ store, config, since, until, chatIds = null, nowMs = Date.now() }) {
  const offset = config.timezone.utcOffsetMinutes;
  const sinceIso = new Date(Date.parse(since)).toISOString();
  const untilIso = new Date(Date.parse(until)).toISOString();
  if (!Number.isFinite(Date.parse(sinceIso)) || !Number.isFinite(Date.parse(untilIso))) {
    throw new Error('时间范围无效：需要可解析的 since / until');
  }
  if (Date.parse(sinceIso) >= Date.parse(untilIso)) {
    throw new Error('时间范围无效：since 必须早于 until');
  }

  const follows = store.listFollows();
  const lookupFollow = buildFollowIndex(follows);
  const excluded = new Set(config.watch.excludedGroups ?? []);
  const keywordList = config.watch.keywords ?? [];
  const groupKeywordMap = new Map(
    store.listGroupSettings('qq').map((item) => [item.chatId, item.keywords ?? []]),
  );
  const customRules = (config.watch.customRules ?? [])
    .filter((rule) => rule?.pattern)
    .map((rule) => {
      let regex = null;
      if (rule.type === 'regex') {
        try {
          regex = new RegExp(rule.pattern, 'i');
        } catch {
          regex = null;
        }
      }
      return { ...rule, regex };
    });

  let messages = fetchAllMessages(store, {
    since: sinceIso,
    until: untilIso,
    chatType: config.watch.includePrivate ? undefined : 'group',
  });

  messages = messages.filter((m) => !excluded.has(`${m.platform}:${m.chatId}`));
  if (Array.isArray(chatIds) && chatIds.length) {
    const wanted = new Set(chatIds.map(String));
    messages = messages.filter((m) => wanted.has(m.chatId));
  }

  const stats = {
    total: messages.length,
    groups: 0,
    senders: 0,
    keyUserMessages: 0,
    lowSignal: 0,
  };

  const groupMap = new Map();
  const senderSet = new Set();
  const keywordCounts = new Map();
  const enriched = [];

  for (const message of messages) {
    const follow = lookupFollow(message.platform, message.chatId, message.senderId);
    const effectiveKeywords = [...keywordList, ...(groupKeywordMap.get(message.chatId) ?? [])];
    const { score, reasons, ruleHits } = scoreMessage(message, follow, effectiveKeywords, customRules);
    const lowSignal = isLowSignal(message.text);
    if (lowSignal) stats.lowSignal += 1;

    const item = {
      ...message,
      score,
      reasons,
      ruleHits,
      lowSignal,
      follow: follow
        ? {
            userId: follow.userId,
            userName: follow.userName,
            priority: follow.priority,
            note: follow.note,
          }
        : null,
    };
    enriched.push(item);

    const groupKey = `${message.platform}:${message.chatId}`;
    if (!groupMap.has(groupKey)) {
      groupMap.set(groupKey, {
        platform: message.platform,
        chatId: message.chatId,
        name: message.chatName,
        count: 0,
        senders: new Set(),
        firstAt: message.ts,
        lastAt: message.ts,
      });
    }
    const group = groupMap.get(groupKey);
    group.count += 1;
    group.senders.add(message.senderId);
    group.lastAt = message.ts;
    if (!group.name && message.chatName) group.name = message.chatName;

    senderSet.add(`${message.platform}:${message.senderId}`);

    const lower = message.text.toLowerCase();
    for (const keyword of keywordList) {
      if (keyword && lower.includes(String(keyword).toLowerCase())) {
        keywordCounts.set(keyword, (keywordCounts.get(keyword) ?? 0) + 1);
      }
    }
  }

  stats.groups = groupMap.size;
  stats.senders = senderSet.size;

  // ---- 重点用户 ----
  const byKeyUser = new Map();
  for (const item of enriched) {
    if (!item.follow) continue;
    const key = `${item.platform}:${item.follow.userId}`;
    if (!byKeyUser.has(key)) {
      byKeyUser.set(key, {
        userId: item.follow.userId,
        userName: item.follow.userName || item.senderName,
        priority: item.follow.priority,
        note: item.follow.note,
        platform: item.platform,
        messages: [],
        groups: new Set(),
      });
    }
    const entry = byKeyUser.get(key);
    entry.messages.push(item);
    entry.groups.add(item.chatName || item.chatId);
    if (!entry.userName) entry.userName = item.senderName;
  }

  const maxKey = Math.max(0, Number(config.digest.maxKeyMessages) || 40);
  const perUserCap = byKeyUser.size ? Math.max(5, Math.ceil(maxKey / byKeyUser.size)) : maxKey;
  const keyUsers = [...byKeyUser.values()]
    .sort((a, b) => {
      const rank = { high: 0, normal: 1, low: 2 };
      return (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1) || b.messages.length - a.messages.length;
    })
    .map((entry) => {
      const messages = entry.messages
        .filter((m) => !m.lowSignal)
        .sort((a, b) => a.ts.localeCompare(b.ts))
        .slice(-perUserCap);
      stats.keyUserMessages += messages.length;
      return {
        ...entry,
        groups: [...entry.groups],
        count: entry.messages.length,
        messages,
      };
    })
    .filter((entry) => entry.messages.length > 0);

  // ---- 关键消息 ----
  const keyMessageIds = new Set(keyUsers.flatMap((u) => u.messages.map((m) => m.id)));
  const highlights = enriched
    .filter((m) => !m.lowSignal && !keyMessageIds.has(m.id) && m.score > 0)
    .sort((a, b) => b.score - a.score || b.ts.localeCompare(a.ts))
    .slice(0, Math.max(0, Number(config.digest.topHighlights) || 15))
    .sort((a, b) => a.ts.localeCompare(b.ts));

  // ---- 公告 / 问题 / 链接 ----
  const announcements = enriched
    .filter(
      (m) =>
        !m.lowSignal &&
        (m.senderRole === 'owner' ||
          m.senderRole === 'admin' ||
          (ANNOUNCE_RE.test(m.text) && !looksLikeQuestion(m.text))),
    )
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .slice(0, 12);

  const questions = enriched
    .filter((m) => !m.lowSignal && looksLikeQuestion(m.text))
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, 10)
    .reverse();

  const links = [];
  for (const message of enriched) {
    for (const url of extractUrls(message.text)) {
      links.push({
        url,
        text: truncate(message.text, 100),
        sender: message.senderName,
        chatName: message.chatName,
        ts: message.ts,
      });
    }
  }
  const dedupedLinks = uniqBy(links, (link) => link.url).slice(0, 20);

  // ---- 日程 ----
  const extracted = extractEvents(
    messages.map((m) => ({
      ...m,
      platform: m.platform,
      chatId: m.chatId,
      chatName: m.chatName,
      senderName: m.senderName,
      ts: m.ts,
    })),
    {
      offsetMinutes: offset,
      nowMs,
      pastGraceHours: 2,
      defaultDurationMinutes: config.schedule.defaultDurationMinutes,
      minConfidence: 0.45,
    },
  );
  const lookaheadMs = Math.max(1, Number(config.schedule.lookaheadDays) || 14) * 86_400_000;
  const upcomingStored = store.listEvents({
    since: new Date(nowMs - 2 * 3_600_000).toISOString(),
    until: new Date(nowMs + lookaheadMs).toISOString(),
    limit: 200,
  });
  const events = uniqBy(
    [...extracted, ...upcomingStored].filter((e) => e.confidence >= 0.45),
    (e) => e.dedupeKey,
  )
    .sort((a, b) => a.startAt.localeCompare(b.startAt))
    .slice(0, 50);

  const groups = [...groupMap.values()]
    .map((group) => ({
      platform: group.platform,
      chatId: group.chatId,
      name: group.name || group.chatId,
      count: group.count,
      senders: group.senders.size,
      lastAt: group.lastAt,
    }))
    .sort((a, b) => b.count - a.count);

  const keywords = [...keywordCounts.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  const nearestDeadline = events.find((e) => e.kind === 'deadline' && Date.parse(e.startAt) >= nowMs - 3_600_000);

  const customHits = enriched
    .filter((m) => !m.lowSignal && m.ruleHits?.length)
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .slice(0, 30)
    .map((m) => ({ ...m, matchedRules: m.ruleHits.map((r) => r.name) }));

  const overview = buildOverview({ stats, keyUsers, events, nearestDeadline, untilIso, offset });

  return {
    generatedAt: new Date(nowMs).toISOString(),
    since: sinceIso,
    until: untilIso,
    timezoneOffset: offset,
    stats,
    groups,
    keyUsers,
    highlights,
    announcements,
    questions,
    links: dedupedLinks,
    events,
    keywords,
    customHits,
    overview,
    nearestDeadline: nearestDeadline ?? null,
    messageCount: messages.length,
  };
}

function buildOverview({ stats, keyUsers, events, nearestDeadline, untilIso, offset }) {
  if (stats.total === 0) return `本时段（截至 ${formatShort(Date.parse(untilIso), offset)}）没有新群消息。`;
  const parts = [
    `共 ${stats.total} 条群消息，来自 ${stats.groups} 个群、${stats.senders} 位成员。`,
  ];
  if (keyUsers.length) {
    parts.push(
      `重点关注 ${keyUsers.length} 位成员，共 ${sumBy(keyUsers, (u) => u.messages.length)} 条重要发言。`,
    );
  }
  if (events.length) {
    const upcoming = events.filter((e) => Date.parse(e.startAt) >= Date.now() - 3_600_000).length;
    parts.push(upcoming ? `识别到 ${upcoming} 项待发生日程。` : `识别到 ${events.length} 项日程。`);
  }
  if (nearestDeadline) {
    parts.push(
      `最近的截止事项：${nearestDeadline.title}（${formatDateTime(Date.parse(nearestDeadline.startAt), offset)}）。`,
    );
  }
  if (stats.lowSignal > stats.total * 0.7) {
    parts.push('本时段低信息量消息占比较高。');
  }
  return parts.join('');
}

function mdMessageLine(message, offset, { showGroup = true } = {}) {
  const time = formatShort(Date.parse(message.ts), offset);
  const tags = [];
  if (message.reasons?.length) {
    tags.push(...message.reasons.filter((r) => !/关注用户|重点用户/.test(r)).slice(0, 3));
  }
  if (message.senderRole === 'owner') tags.push('群主');
  const tagText = tags.length ? `〔${[...new Set(tags)].join(' · ')}〕` : '';
  const group = showGroup ? `@${message.chatName || message.chatId} ` : '';
  return `- **${time}** ${group}${message.senderName}${tagText}：${truncate(
    normalizeSpace(message.text),
    280,
  )}`;
}

/** 把摘要渲染成可审核的 Markdown 报告。 */
export function renderReport(digest, { config, title, reportId = null, status = 'pending' } = {}) {
  const offset = config.timezone.utcOffsetMinutes;
  const lines = [];
  const range = `${formatDateTime(Date.parse(digest.since), offset)} — ${formatDateTime(
    Date.parse(digest.until),
    offset,
  )}`;

  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`> 时间范围：${range}（UTC${offset >= 0 ? '+' : '-'}${Math.abs(offset / 60)}）`);
  lines.push(`> 生成时间：${formatDateTime(Date.parse(digest.generatedAt), offset)}`);
  lines.push('');
  lines.push('## 一句话概览');
  lines.push('');
  lines.push(digest.overview);
  lines.push('');

  if (digest.keyUsers.length) {
    lines.push('## 重点用户动态');
    lines.push('');
    for (const user of digest.keyUsers) {
      const meta = [user.priority === 'high' ? '重点' : '关注', user.note].filter(Boolean).join(' · ');
      lines.push(`### ${user.userName || user.userId}${meta ? `（${meta}）` : ''}`);
      if (user.groups.length) lines.push(`> 涉及群：${user.groups.join('、')}`);
      for (const message of user.messages) {
        lines.push(mdMessageLine(message, offset, { showGroup: user.groups.length > 1 }));
      }
      lines.push('');
    }
  }

  if (digest.highlights.length) {
    lines.push('## 关键消息');
    lines.push('');
    for (const message of digest.highlights) {
      lines.push(mdMessageLine(message, offset));
    }
    lines.push('');
  }

  if (digest.announcements.length) {
    lines.push('## 公告与决定');
    lines.push('');
    for (const message of digest.announcements) {
      lines.push(mdMessageLine(message, offset));
    }
    lines.push('');
  }

  if (digest.questions.length) {
    lines.push('## 待确认问题');
    lines.push('');
    for (const message of digest.questions) {
      lines.push(mdMessageLine(message, offset));
    }
    lines.push('');
  }

  if (digest.links.length) {
    lines.push('## 链接与资料');
    lines.push('');
    for (const link of digest.links) {
      lines.push(`- [${truncate(link.text, 60)}](${link.url}) — ${link.sender} @ ${link.chatName}`);
    }
    lines.push('');
  }

  if (digest.customHits?.length) {
    lines.push('## 自定义关注');
    lines.push('');
    for (const message of digest.customHits) {
      const rules = message.matchedRules?.length ? `〔${message.matchedRules.join(' · ')}〕` : '';
      lines.push(
        `- **${formatShort(Date.parse(message.ts), offset)}** @${message.chatName} ${message.senderName}${rules}：${truncate(
          normalizeSpace(message.text),
          280,
        )}`,
      );
    }
    lines.push('');
  }

  lines.push('## 日程');
  lines.push('');
  if (digest.events.length) {
    lines.push(eventsToMarkdown(digest.events, { offsetMinutes: offset }));
    lines.push('');
    const deadlines = digest.events.filter((e) => e.kind === 'deadline');
    if (deadlines.length) {
      lines.push('**截止事项**');
      lines.push('');
      for (const event of deadlines) {
        lines.push(
          `- ⏰ ${formatDateTime(Date.parse(event.startAt), offset)} ${event.title}（${event.chatName || ''}）`,
        );
      }
      lines.push('');
    }
  } else {
    lines.push('_本时段没有识别到日程。_');
    lines.push('');
  }

  if (digest.keywords.length) {
    lines.push('## 热点关键词');
    lines.push('');
    lines.push(digest.keywords.map((k) => `\`${k.word}\` ×${k.count}`).join(' · '));
    lines.push('');
  }

  lines.push('## 群活跃度');
  lines.push('');
  lines.push('| 群 | 消息数 | 发言人数 | 最后活跃 |');
  lines.push('| --- | --- | --- | --- |');
  for (const group of digest.groups) {
    lines.push(
      `| ${tableCell(group.name, 30)} | ${group.count} | ${group.senders} | ${formatShort(
        Date.parse(group.lastAt),
        offset,
      )} |`,
    );
  }
  lines.push('');

  lines.push('---');
  lines.push('');
  const statusLabel = {
    pending: '待审核',
    approved: '已批准，待发送',
    sent: '已发送',
    rejected: '已驳回',
  }[status] ?? status;
  lines.push(
    `> 报告 ID：${reportId ?? '（未入库）'} · 状态：${statusLabel} · 审核策略：${
      config.review.required ? '外发前必须人工批准' : '免审'
    }`,
  );
  lines.push('> 数据来源：已采集的群消息。每条都可追溯到原消息时间与发送者；置信度较低的日程请人工确认。');
  lines.push('');

  return lines.join('\n');
}

/** 通知/推送用短摘要。 */
export function digestToSummaryText(digest, { config, maxChars = 600 } = {}) {
  const offset = config.timezone.utcOffsetMinutes;
  const lines = [digest.overview];
  if (digest.keyUsers.length) {
    lines.push('', '重点用户：');
    for (const user of digest.keyUsers.slice(0, 5)) {
      const last = user.messages.at(-1);
      if (!last) continue;
      lines.push(`- ${user.userName}：${truncate(last.text, 80)}`);
    }
  }
  const upcoming = digest.events.filter((e) => Date.parse(e.startAt) >= Date.now() - 3_600_000).slice(0, 5);
  if (upcoming.length) {
    lines.push('', '日程：');
    for (const event of upcoming) {
      lines.push(
        `- ${formatDateTime(Date.parse(event.startAt), offset)} ${kindLabel(event.kind)}：${event.title}`,
      );
    }
  }
  return truncate(lines.join('\n'), maxChars);
}

/** 计算「最近一次摘要」的默认时间窗口。 */
export function defaultPeriod(config, nowMs = Date.now()) {
  const hours = clamp(Number(config.digest.lookbackHours) || 12, 1, 24 * 14);
  return {
    since: new Date(nowMs - hours * 3_600_000).toISOString(),
    until: new Date(nowMs).toISOString(),
  };
}
