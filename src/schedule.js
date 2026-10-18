/**
 * 从群消息中提取日程。
 *
 * 这是一个「够用且可解释」的中文时间解析器，不是通用 NLP：
 *   - 支持 今天/明天/后天、本周三/下周三/周三、10月20日、10/20、3天后
 *   - 支持 下午3点 / 15:30 / 晚上8点半 / 周三下午两点
 *   - 支持 时间区间（15:00-17:00）与日期区间（10月20日-10月22日）
 *   - 支持 每周三 这样的周重复（写入 RRULE）
 *   - 不支持的复杂表达会以较低置信度保留原文，而不是猜。
 *
 * 所有事件都带 dedupeKey，重复提取不会产生重复日历项。
 */

import {
  addDaysLocal,
  atLocalTime,
  formatClock,
  formatDate,
  formatDateTime,
  formatIcsDate,
  formatIcsUtc,
  fromLocal,
  localParts,
  startOfLocalDay,
} from './util/time.js';
import { escapeIcs, foldIcsLine, normalizeSpace, stableId, tableCell, truncate } from './util/text.js';

const SENTENCE_DELIM = /[。；;！!？?\n\r]/;

const WEEKDAY_CHAR = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0, 末: 6 };
const RRULE_DAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function sentenceRange(text, index) {
  let start = 0;
  for (let i = index; i >= 0; i -= 1) {
    if (SENTENCE_DELIM.test(text[i])) {
      start = i + 1;
      break;
    }
  }
  let end = text.length;
  for (let i = index; i < text.length; i += 1) {
    if (SENTENCE_DELIM.test(text[i])) {
      end = i;
      break;
    }
  }
  // 句子过长时只取时间词附近，避免把整段话当标题。
  const window = 48;
  return {
    start: Math.max(start, index - window),
    end: Math.min(end, index + window),
  };
}

/** 标题优先取「逗号分隔的小句」，避免把整段解释都塞进日程名。 */
function clauseRange(text, index) {
  const delims = /[，,。；;！!？?\n\r]/;
  let start = 0;
  for (let i = index; i >= 0; i -= 1) {
    if (delims.test(text[i])) {
      start = i + 1;
      break;
    }
  }
  let end = text.length;
  for (let i = index; i < text.length; i += 1) {
    if (delims.test(text[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function overlaps(a, b) {
  return a.index < b.end && b.index < a.end;
}

function pushNonOverlapping(list, item) {
  if (list.some((existing) => overlaps(existing, item))) return false;
  list.push(item);
  return true;
}

/**
 * 收集日期短语。每个结果带 startMs（本地当天 0 点对应的 UTC 毫秒）。
 */
export function collectDates(text, refMs, offsetMinutes) {
  const results = [];
  const ref = localParts(refMs, offsetMinutes);
  const push = (item) => pushNonOverlapping(results, item);

  // 2026年10月20日 / 2026-10-20
  for (const m of text.matchAll(/(\d{4})\s*[年/-]\s*(\d{1,2})\s*[月/-]\s*(\d{1,2})\s*[日号]?/g)) {
    const [, y, mo, d] = m;
    const year = Number(y);
    const month = Number(mo);
    const day = Number(d);
    if (!validDate(year, month, day)) continue;
    push({
      index: m.index,
      end: m.index + m[0].length,
      startMs: fromLocal({ year, month, day }, offsetMinutes),
      confidence: 0.95,
      raw: m[0],
      explicitYear: true,
    });
  }

  // 10月20日 / 10月20号
  for (const m of text.matchAll(/(?<!\d)(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g)) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (!validDate(ref.year, month, day)) continue;
    let year = ref.year;
    let startMs = fromLocal({ year, month, day }, offsetMinutes);
    if (startMs < startOfLocalDay(refMs, offsetMinutes) - 86_400_000) {
      year += 1;
      startMs = fromLocal({ year, month, day }, offsetMinutes);
    }
    push({
      index: m.index,
      end: m.index + m[0].length,
      startMs,
      confidence: 0.92,
      raw: m[0],
    });
  }

  // 10/20
  for (const m of text.matchAll(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/g)) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (!validDate(ref.year, month, day)) continue;
    if (results.some((r) => overlaps(r, { index: m.index, end: m.index + m[0].length }))) continue;
    let startMs = fromLocal({ year: ref.year, month, day }, offsetMinutes);
    if (startMs < startOfLocalDay(refMs, offsetMinutes) - 86_400_000) {
      startMs = fromLocal({ year: ref.year + 1, month, day }, offsetMinutes);
    }
    push({
      index: m.index,
      end: m.index + m[0].length,
      startMs,
      confidence: 0.8,
      raw: m[0],
    });
  }

  // 今天/明天/后天/大后天
  const RELATIVE = [
    ['大后天', 3],
    ['后天', 2],
    ['明天', 1],
    ['明日', 1],
    ['今天', 0],
    ['今日', 0],
  ];
  for (const [word, offsetDays] of RELATIVE) {
    for (const m of text.matchAll(new RegExp(word, 'g'))) {
      push({
        index: m.index,
        end: m.index + word.length,
        startMs: addDaysLocal(refMs, offsetDays, offsetMinutes),
        confidence: 0.9,
        raw: word,
      });
    }
  }

  // 今晚/明晚/今早/明早/今天下午 —— 日期 + 默认时刻
  for (const m of text.matchAll(/(今|明|后)(晚|早)/g)) {
    const dayOffset = m[1] === '今' ? 0 : m[1] === '明' ? 1 : 2;
    const isEvening = m[2] === '晚';
    push({
      index: m.index,
      end: m.index + m[0].length,
      startMs: addDaysLocal(refMs, dayOffset, offsetMinutes),
      confidence: 0.88,
      raw: m[0],
      hourHint: isEvening ? 20 : 8,
      minuteHint: 0,
      pmHint: isEvening,
    });
  }

  // 周/星期/礼拜，支持 本周三、下周三、下下周三、周三
  for (const m of text.matchAll(/(下下周|下个?星期|下个?礼拜|下?周|本星期|本周|这周|这个?星期|这个?礼拜|星期|礼拜)([一二三四五六日天末])/g)) {
    const prefix = m[1];
    const weekday = WEEKDAY_CHAR[m[2]];
    if (weekday === undefined) continue;
    const today = ref.weekday;
    let targetUtc;
    let confidence = 0.85;

    if (/下下周/.test(prefix)) {
      targetUtc = mondayOfWeek(refMs, offsetMinutes, 2) + dayOffsetFromMonday(weekday) * 86_400_000;
    } else if (/下/.test(prefix)) {
      targetUtc = mondayOfWeek(refMs, offsetMinutes, 1) + dayOffsetFromMonday(weekday) * 86_400_000;
      confidence = 0.9;
    } else if (/本周|这周|这个?星期|这个?礼拜/.test(prefix)) {
      targetUtc = mondayOfWeek(refMs, offsetMinutes, 0) + dayOffsetFromMonday(weekday) * 86_400_000;
      confidence = 0.82;
    } else {
      // 无前缀：最近的未来那天（含今天）
      const delta = (weekday - today + 7) % 7;
      targetUtc = addDaysLocal(refMs, delta, offsetMinutes);
      confidence = delta === 0 ? 0.8 : 0.86;
    }

    push({
      index: m.index,
      end: m.index + m[0].length,
      startMs: startOfLocalDay(targetUtc, offsetMinutes),
      confidence,
      raw: m[0],
    });
  }

  // 3天后 / 3天之后 / 两周后
  for (const m of text.matchAll(/(\d{1,3})\s*天\s*(?:之)?后/g)) {
    push({
      index: m.index,
      end: m.index + m[0].length,
      startMs: addDaysLocal(refMs, Number(m[1]), offsetMinutes),
      confidence: 0.85,
      raw: m[0],
    });
  }
  for (const m of text.matchAll(/(\d{1,2})\s*(?:周|个星期|个礼拜)\s*(?:之)?后/g)) {
    push({
      index: m.index,
      end: m.index + m[0].length,
      startMs: addDaysLocal(refMs, Number(m[1]) * 7, offsetMinutes),
      confidence: 0.8,
      raw: m[0],
    });
  }

  // 日期区间：10月20日-10月22日
  const ranges = [];
  for (const date of results) {
    const after = text.slice(date.end);
    const m = /^\s*(?:到|至|-|—|~|～|–)\s*/.exec(after);
    if (!m) continue;
    const nextStart = date.end + m[0].length;
    const next = results.find((r) => r.index === nextStart && r.startMs > date.startMs);
    if (!next) continue;
    ranges.push({
      index: date.index,
      end: next.end,
      startMs: date.startMs,
      endMs: next.startMs,
      confidence: Math.min(date.confidence, next.confidence) - 0.05,
      raw: text.slice(date.index, next.end),
      range: true,
    });
  }
  // 区间整体替换掉内部两个日期
  if (ranges.length) {
    return [
      ...results.filter((r) => !ranges.some((range) => range.index <= r.index && r.end <= range.end)),
      ...ranges,
    ].sort((a, b) => a.index - b.index);
  }

  return results.sort((a, b) => a.index - b.index);
}

function validDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function mondayOfWeek(refMs, offsetMinutes, weeksAhead) {
  const p = localParts(refMs, offsetMinutes);
  const daysSinceMonday = (p.weekday + 6) % 7;
  return startOfLocalDay(refMs, offsetMinutes) - daysSinceMonday * 86_400_000 + weeksAhead * 7 * 86_400_000;
}

function dayOffsetFromMonday(weekday) {
  return (weekday + 6) % 7;
}

const PERIOD_RE = /(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|夜间)/;

function resolveHour(hour, period) {
  if (!period) return { hour, dayShift: 0 };
  if (/下午|傍晚|晚上|夜里|夜间/.test(period)) {
    if (hour === 12) return { hour: 0, dayShift: 1 };
    return { hour: hour < 12 ? hour + 12 : hour, dayShift: 0 };
  }
  if (/中午/.test(period)) {
    if (hour === 12) return { hour: 12, dayShift: 0 };
    return { hour: hour < 6 ? hour + 12 : hour, dayShift: 0 };
  }
  if (/凌晨/.test(period)) return { hour: hour === 12 ? 0 : hour, dayShift: 0 };
  return { hour, dayShift: 0 };
}

/** 收集时间短语（不依赖日期）。 */
export function collectTimes(text) {
  const results = [];
  const push = (item) => pushNonOverlapping(results, item);

  // 15:30 / 下午3:05
  for (const m of text.matchAll(/(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|夜间)?\s*(\d{1,2})\s*[:：]\s*(\d{2})/g)) {
    const period = m[1] ?? null;
    let hour = Number(m[2]);
    const minute = Number(m[3]);
    if (hour > 24 || minute > 59) continue;
    const resolved = resolveHour(hour, period);
    hour = resolved.hour;
    push({
      index: m.index,
      end: m.index + m[0].length,
      hour,
      minute,
      dayShift: resolved.dayShift,
      hasPeriod: Boolean(period),
      confidence: period ? 0.93 : 0.85,
      raw: normalizeSpace(m[0]),
    });
  }

  // 下午3点 / 晚上8点半 / 8点45分 / 两点
  for (const m of text.matchAll(/(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|夜间)?\s*(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*[点時时]\s*(半|一刻|三刻|(\d{1,2})\s*分?)?/g)) {
    const period = m[1] ?? null;
    let hour = parseChineseNumber(m[2]);
    if (hour === null || hour > 24) continue;
    let minute = 0;
    if (m[3] === '半') minute = 30;
    else if (m[3] === '一刻') minute = 15;
    else if (m[3] === '三刻') minute = 45;
    else if (m[4] !== undefined) minute = Number(m[4]);
    if (minute > 59) continue;
    const resolved = resolveHour(hour, period);
    push({
      index: m.index,
      end: m.index + m[0].length,
      hour: resolved.hour,
      minute,
      dayShift: resolved.dayShift,
      hasPeriod: Boolean(period),
      confidence: period ? 0.9 : 0.72,
      raw: normalizeSpace(m[0]),
    });
  }

  return results.sort((a, b) => a.index - b.index);
}

const CN_DIGITS = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function parseChineseNumber(value) {
  const text = String(value);
  if (/^\d+$/.test(text)) return Number(text);
  if (text.length === 1) return CN_DIGITS[text] ?? null;
  if (text === '十' || text.startsWith('十')) {
    const rest = text.slice(1);
    return 10 + (rest ? CN_DIGITS[rest] ?? 0 : 0);
  }
  if (text.endsWith('十')) {
    return (CN_DIGITS[text[0]] ?? 0) * 10;
  }
  if (text.includes('十')) {
    const [a, b] = text.split('十');
    return (CN_DIGITS[a] ?? 0) * 10 + (CN_DIGITS[b] ?? 0);
  }
  // 二三 这类不常见写法不猜
  return null;
}

const LEAD_FILLER =
  /^(?:大家|各位|咱们|我们|同学们|同志们|请注意|注意一下|注意|提醒一下|提醒|记得|别忘了|别忘记|安排|定在|定为|决定|时间|地点|于|在|是|为|把|将|请|要|会|有|的|了|个|就|还|先|再|约|大概|左右)+/;
const TRAIL_FILLER = /(?:吧|哦|啊|呢|哈|呀|咯|嘛|了|的|到|至|于|在|前|之前|为止|左右|哦哦)+$/;

function stripFillers(text) {
  let out = normalizeSpace(text);
  out = out.replace(LEAD_FILLER, '');
  out = out.replace(TRAIL_FILLER, '');
  out = out.replace(/^[，,、:：\-—~～\s]+/, '').replace(/[，,、:：\-—~～\s]+$/, '');
  return out.trim();
}

/**
 * 从一条消息中提取候选事件。
 *
 * @param message 统一消息结构
 * @param options.offsetMinutes 时区偏移
 * @param options.nowMs 用于过滤过去事件
 * @param options.defaultDurationMinutes 未给结束时间时的默认时长
 */
export function extractEventsFromMessage(message, options = {}) {
  const {
    offsetMinutes = 480,
    nowMs = Date.now(),
    defaultDurationMinutes = 60,
    pastGraceHours = 2,
  } = options;

  const text = normalizeSpace(message.text ?? '');
  if (!text || !/[\d一二两三四五六七八九十今明后周星期礼拜点:：/]/.test(text)) return [];

  const refMs = Number.isFinite(Date.parse(message.ts)) ? Date.parse(message.ts) : nowMs;
  const dates = collectDates(text, refMs, offsetMinutes);
  const times = collectTimes(text);

  const usedTimes = new Set();
  const usedDates = new Set();
  const events = [];
  const minStart = nowMs - pastGraceHours * 3_600_000;
  const durationMs = Math.max(15, Number(defaultDurationMinutes) || 60) * 60_000;

  const claimTimeNear = (date) => {
    const sentence = sentenceRange(text, date.index);
    let best = null;
    let bestScore = Infinity;
    times.forEach((time, i) => {
      if (usedTimes.has(i)) return;
      if (time.index < sentence.start || time.end > sentence.end) return;
      let score = Infinity;
      if (time.index >= date.end) score = time.index - date.end;
      else if (time.end <= date.index) score = (date.index - time.end) * 1.5;
      else score = 0; // 日期与时间重叠（如「今晚8点」）
      if (score <= 16 && score < bestScore) {
        best = i;
        bestScore = score;
      }
    });
    return best;
  };

  const claimRangeEnd = (timeIndex) => {
    const time = times[timeIndex];
    const after = text.slice(time.end);
    const m = /^\s*(?:到|至|-|—|~|～|–)\s*/.exec(after);
    if (!m) return null;
    const nextStart = time.end + m[0].length;
    const nextIndex = times.findIndex((t) => t.index === nextStart && !usedTimes.has(times.indexOf(t)));
    if (nextIndex < 0) return null;
    const next = times[nextIndex];
    if (next.index !== nextStart) return null;
    return nextIndex;
  };

  for (let di = 0; di < dates.length; di += 1) {
    const date = dates[di];
    const claimSpans = [date];
    let startMs;
    let endMs;
    let allDay = false;
    let confidence = date.confidence;

    if (date.range) {
      allDay = true;
      startMs = startOfLocalDay(date.startMs, offsetMinutes);
      endMs = startOfLocalDay(date.endMs, offsetMinutes) + 86_400_000 - 1;
      confidence = Math.max(0.5, confidence);
    } else {
      const ti = claimTimeNear(date);
      if (ti !== null) {
        const time = times[ti];
        usedTimes.add(ti);
        claimSpans.push(time);
        let hour = time.hour;
        let dayShift = time.dayShift;
        // 「今晚8点」里的 8 点没有上下午标记，用日期短语的 pmHint 补全。
        if (date.pmHint && !time.hasPeriod && hour < 12) {
          const resolved = resolveHour(hour, '晚上');
          hour = resolved.hour;
          dayShift += resolved.dayShift;
        }
        const base = localParts(date.startMs, offsetMinutes);
        startMs = fromLocal(
          {
            year: base.year,
            month: base.month,
            day: base.day,
            hour,
            minute: time.minute,
          },
          offsetMinutes,
        );
        if (dayShift) startMs += dayShift * 86_400_000;
        const endTi = claimRangeEnd(ti);
        if (endTi !== null) {
          const endTime = times[endTi];
          usedTimes.add(endTi);
          claimSpans.push(endTime);
          const endBase = localParts(startMs, offsetMinutes);
          endMs = fromLocal(
            {
              year: endBase.year,
              month: endBase.month,
              day: endBase.day,
              hour: endTime.hour,
              minute: endTime.minute,
            },
            offsetMinutes,
          );
          if (endMs <= startMs) endMs += 86_400_000;
        } else {
          endMs = startMs + durationMs;
        }
        confidence = Math.min(0.96, date.confidence * 0.55 + time.confidence * 0.45 + 0.05);
      } else if (date.hourHint !== undefined) {
        const base = localParts(date.startMs, offsetMinutes);
        startMs = fromLocal(
          {
            year: base.year,
            month: base.month,
            day: base.day,
            hour: date.hourHint,
            minute: date.minuteHint ?? 0,
          },
          offsetMinutes,
        );
        endMs = startMs + durationMs;
        confidence = date.confidence * 0.95;
      } else {
        allDay = true;
        startMs = startOfLocalDay(date.startMs, offsetMinutes);
        endMs = startMs + 86_400_000 - 1;
      }
    }

    usedDates.add(di);
    if (startMs < minStart) continue;

    const sentence = sentenceRange(text, date.index);
    const clause = clauseRange(text, date.index);
    const spansIn = (range) =>
      [...dates, ...times].filter((span) => span.index < range.end && span.end > range.start);
    const cleanRange = (range) => {
      let source = text.slice(range.start, range.end);
      for (const span of spansIn(range).sort((a, b) => b.index - a.index)) {
        const relStart = Math.max(0, span.index - range.start);
        const relEnd = Math.min(source.length, span.end - range.start);
        source = source.slice(0, relStart) + ' ' + source.slice(relEnd);
      }
      return source;
    };

    // 先试日期所在小句，再试时间所在小句，最后退回整句。
    let titleSource = cleanRange(clause);
    if (stripFillers(titleSource).length < 2) {
      for (const span of spansIn(clause)) {
        const candidate = cleanRange(clauseRange(text, span.index));
        if (stripFillers(candidate).length >= 2) {
          titleSource = candidate;
          break;
        }
      }
    }
    if (stripFillers(titleSource).length < 2) {
      const before = cleanRange(clauseRange(text, Math.max(0, date.index - 1)));
      if (stripFillers(before).length >= 2) titleSource = before;
    }
    if (stripFillers(titleSource).length < 2) {
      titleSource = cleanRange(sentence);
    }
    titleSource = titleSource.replace(/每(?:周|星期|礼拜)[一二三四五六日天末]/g, '');
    // 地点短语单独存进 location，不重复塞进标题。
    titleSource = titleSource
      .replace(/(?:地点|地址|场地)\s*[:：]\s*[^\s，。；;]{2,30}/g, ' ')
      .replace(/在\s*[^\s，。；;]{2,20}?(?=开会|集合|举行|举办|进行|见|碰头)/g, ' ')
      .replace(/(?:^|\s)每(?=\s|$)/g, ' ');
    let title = stripFillers(titleSource);
    if (title.length < 2) {
      title = stripFillers(text.replace(new RegExp(escapeRegExp(date.raw), 'g'), ''));
    }
    if (title.length < 2) title = '待确认事项';
    title = truncate(title.replace(/\s+/g, ' '), 40);

    const recurrence = detectRecurrence(text);
    const kind = detectKind(text);
    const location = detectLocation(text);

    const startIso = new Date(startMs).toISOString();
    const dedupeKey = stableId(
      message.platform ?? 'qq',
      message.chatId ?? '',
      title,
      startIso,
      recurrence ?? '',
    );

    events.push({
      dedupeKey,
      platform: message.platform ?? 'qq',
      chatId: message.chatId ?? '',
      chatName: message.chatName ?? '',
      msgId: message.msgId ?? null,
      title,
      startAt: startIso,
      endAt: new Date(endMs).toISOString(),
      allDay,
      location,
      sourceSender: message.senderName ?? '',
      confidence: Number(confidence.toFixed(2)),
      kind,
      rrule: recurrence,
      raw: normalizeSpace(message.text),
    });
  }

  return events;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectRecurrence(text) {
  if (/每天|每日/.test(text)) return 'FREQ=DAILY';
  const m = /每(?:周|星期|礼拜)([一二三四五六日天末])/.exec(text);
  if (m) {
    const weekday = WEEKDAY_CHAR[m[1]];
    if (weekday !== undefined) return `FREQ=WEEKLY;BYDAY=${RRULE_DAY[weekday]}`;
  }
  return null;
}

function detectKind(text) {
  if (/截止|截至|ddl|deadline|报名截止|提交截止|最后期限/i.test(text)) return 'deadline';
  if (/开会|会议|例会|碰头|讨论|答辩|汇报|评审/.test(text)) return 'meeting';
  if (/比赛|竞赛|考试|测试/.test(text)) return 'contest';
  if (/集合|出发|活动|聚餐|团建/.test(text)) return 'activity';
  return 'event';
}

function detectLocation(text) {
  const explicit = /(?:地点|地址|场地)\s*[:：]\s*([^\s，。；;]{2,30})/.exec(text);
  if (explicit) return explicit[1];
  const inPlace = /在\s*([^\s，。；;]{2,20}?)(?:开会|集合|举行|举办|进行|见|碰头)/.exec(text);
  if (inPlace) return inPlace[1];
  return null;
}

/**
 * 批量提取并去重。默认只保留「未来或刚过去」的事件。
 */
export function extractEvents(messages, options = {}) {
  const { nowMs = Date.now(), pastGraceHours = 2, minConfidence = 0 } = options;
  const byKey = new Map();
  for (const message of messages) {
    const events = extractEventsFromMessage(message, { ...options, nowMs, pastGraceHours });
    for (const event of events) {
      if (event.confidence < minConfidence) continue;
      if (!byKey.has(event.dedupeKey)) byKey.set(event.dedupeKey, event);
    }
  }
  return [...byKey.values()].sort((a, b) => a.startAt.localeCompare(b.startAt));
}

/** 写入数据库，返回新增条数。 */
export function persistEvents(store, events) {
  let inserted = 0;
  for (const event of events) {
    if (store.upsertEvent(event)) inserted += 1;
  }
  return inserted;
}

/** 生成 ICS 文本。时间统一转成 UTC，避免各客户端时区解释不一致。 */
export function exportIcs(events, { offsetMinutes = 480, calendarName = '群聊日程', nowMs = Date.now() } = {}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//group-digest//群聊日程//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcs(calendarName)}`,
  ];

  for (const event of events) {
    const startMs = Date.parse(event.startAt);
    if (!Number.isFinite(startMs)) continue;
    const endMs = event.endAt ? Date.parse(event.endAt) : startMs + 3_600_000;
    const description = [
      event.location ? `地点：${event.location}` : null,
      event.chatName ? `来源群：${event.chatName}` : null,
      event.sourceSender ? `发言人：${event.sourceSender}` : null,
      `置信度：${Math.round((event.confidence ?? 0) * 100)}%`,
      event.raw ? `原文：${truncate(event.raw, 200)}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${event.id ?? stableId(event.dedupeKey)}@group-digest`);
    lines.push(`DTSTAMP:${formatIcsUtc(nowMs)}`);
    if (event.allDay) {
      const startDate = formatIcsDate(startMs, offsetMinutes);
      const endDateMs = Number.isFinite(endMs) ? endMs + 86_400_000 : startMs + 86_400_000;
      lines.push(`DTSTART;VALUE=DATE:${startDate}`);
      lines.push(`DTEND;VALUE=DATE:${formatIcsDate(endDateMs, offsetMinutes)}`);
    } else {
      lines.push(`DTSTART:${formatIcsUtc(startMs)}`);
      lines.push(`DTEND:${formatIcsUtc(Number.isFinite(endMs) ? endMs : startMs + 3_600_000)}`);
    }
    lines.push(`SUMMARY:${escapeIcs(event.title)}`);
    if (description) lines.push(`DESCRIPTION:${escapeIcs(description)}`);
    if (event.location) lines.push(`LOCATION:${escapeIcs(event.location)}`);
    if (event.rrule) lines.push(`RRULE:${event.rrule}`);
    lines.push(`STATUS:${event.confidence >= 0.7 ? 'CONFIRMED' : 'TENTATIVE'}`);
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`;
}

/** CSV：可直接用 Excel 打开。 */
export function exportCsv(events, { offsetMinutes = 480 } = {}) {
  const escape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const header = ['开始', '结束', '全天', '事项', '类型', '群', '发言人', '地点', '置信度', '原文'];
  const rows = events.map((event) => [
    formatDateTime(Date.parse(event.startAt), offsetMinutes),
    event.endAt ? formatDateTime(Date.parse(event.endAt), offsetMinutes) : '',
    event.allDay ? '是' : '否',
    event.title,
    kindLabel(event.kind),
    event.chatName ?? '',
    event.sourceSender ?? '',
    event.location ?? '',
    String(event.confidence ?? ''),
    event.raw ?? '',
  ]);
  return [header, ...rows].map((row) => row.map(escape).join(',')).join('\r\n');
}

export function kindLabel(kind) {
  return (
    {
      deadline: '截止',
      meeting: '会议',
      contest: '比赛/考试',
      activity: '活动',
      event: '事项',
    }[kind] ?? '事项'
  );
}

/** Markdown 表格，供报告与 CLI 使用。 */
export function eventsToMarkdown(events, { offsetMinutes = 480 } = {}) {
  if (!events.length) return '_本时段没有识别到日程。_';
  const lines = ['| 时间 | 事项 | 类型 | 来源 | 置信度 |', '| --- | --- | --- | --- | --- |'];
  for (const event of events) {
    const start = formatDateTime(Date.parse(event.startAt), offsetMinutes);
    const time = event.allDay ? `${formatDate(Date.parse(event.startAt), offsetMinutes)}（全天）` : start;
    const source = [event.chatName, event.sourceSender].filter(Boolean).join(' · ');
    lines.push(
      `| ${tableCell(time, 32)} | ${tableCell(event.title, 40)} | ${kindLabel(event.kind)} | ${tableCell(source, 40)} | ${Math.round((event.confidence ?? 0) * 100)}% |`,
    );
  }
  return lines.join('\n');
}

/** 纯文本日程（QQ/微信推送用）。 */
export function eventsToText(events, { offsetMinutes = 480 } = {}) {
  if (!events.length) return '本时段没有识别到日程。';
  return events
    .map((event, index) => {
      const when = event.allDay
        ? `${formatDate(Date.parse(event.startAt), offsetMinutes)} 全天`
        : formatDateTime(Date.parse(event.startAt), offsetMinutes);
      const icon = event.kind === 'deadline' ? '⏰' : event.kind === 'meeting' ? '📌' : '•';
      return `${index + 1}. ${icon} ${when} ${event.title}${event.location ? `（${event.location}）` : ''}`;
    })
    .join('\n');
}

export { atLocalTime, formatClock };

/** 同一场会议常因群改名/OCR 多个 chatId 出现；用语义键做展示与落库去重。 */
export function eventSemanticKey(event) {
  const title = String(event.title ?? '')
    .replace(/^群主\s*/, '')
    .replace(/^(?:明天|今天|后天|大后天|周[一二三四五六日天])?/, '')
    .replace(/^(?:早上|上午|中午|下午|晚上|凌晨)?[0-9一二三四五六七八九十]+点(?:半|整)?/, '')
    .replace(/\s+/g, '')
    .trim();
  return [event.startAt, event.kind ?? '', event.sourceSender ?? '', title, event.location ?? ''].join('|');
}
