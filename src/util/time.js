/**
 * 时间工具：全部按「固定 UTC 偏移」计算，不依赖运行机器的系统时区。
 *
 * 约定：
 *   - 数据库/API 里的时间一律是 ISO-8601 UTC 字符串（...Z）。
 *   - 展示、解析、按天归档时，先换算到配置的本地偏移（默认 +08:00）。
 *   - 内部用「墙面时间」Date 表示本地时间：把本地字段塞进 UTC 槽位，
 *     这样可以直接用 getUTC* 读取，避免 Date 自动套用系统时区。
 */

const MINUTE = 60_000;
const DAY = 86_400_000;

export function toWallMs(utcMs, offsetMinutes) {
  return utcMs + offsetMinutes * MINUTE;
}

export function toUtcMs(wallMs, offsetMinutes) {
  return wallMs - offsetMinutes * MINUTE;
}

export function toIso(ms) {
  return new Date(ms).toISOString();
}

export function parseIso(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : NaN;
}

/** 本地字段。weekday: 0=周日 … 6=周六。 */
export function localParts(utcMs, offsetMinutes) {
  const d = new Date(toWallMs(utcMs, offsetMinutes));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay(),
    wallMs: d.getTime(),
  };
}

/** 由本地字段造 UTC 毫秒。 */
export function fromLocal(parts, offsetMinutes) {
  const { year, month = 1, day = 1, hour = 0, minute = 0, second = 0, ms = 0 } = parts;
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  return toUtcMs(wall, offsetMinutes);
}

export function startOfLocalDay(utcMs, offsetMinutes) {
  const p = localParts(utcMs, offsetMinutes);
  return fromLocal({ year: p.year, month: p.month, day: p.day }, offsetMinutes);
}

export function endOfLocalDay(utcMs, offsetMinutes) {
  return startOfLocalDay(utcMs, offsetMinutes) + DAY - 1;
}

export function addDaysLocal(utcMs, days, offsetMinutes) {
  return startOfLocalDay(utcMs, offsetMinutes) + days * DAY + 12 * 3_600_000;
}

export function addMinutes(utcMs, minutes) {
  return utcMs + minutes * MINUTE;
}

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function weekdayName(utcMs, offsetMinutes) {
  return WEEKDAY_NAMES[localParts(utcMs, offsetMinutes).weekday];
}

/** 支持 YYYY-MM-DD / YYYY-MM-DD HH:mm / ISO。返回 UTC 毫秒。 */
export function parseFlexible(value, offsetMinutes, { endOfDay = false } = {}) {
  if (value === undefined || value === null || value === '') return NaN;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split('-').map(Number);
    const base = fromLocal({ year, month, day }, offsetMinutes);
    return endOfDay ? base + DAY - 1 : base;
  }
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(text)) {
    const [datePart, timePart] = text.split(/[ T]/);
    const [year, month, day] = datePart.split('-').map(Number);
    const [hour, minute, second = 0] = timePart.split(':').map(Number);
    return fromLocal({ year, month, day, hour, minute, second }, offsetMinutes);
  }
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : NaN;
}

/** 解析 "09:00" / "9:00" 这样的每日时刻，返回本地当天分钟数。 */
export function parseSlot(slot) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(slot).trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute, minutes: hour * 60 + minute };
}

/** 计算期间：默认回看 N 小时到「现在」。 */
export function periodFromLookback(nowMs, hours) {
  const until = nowMs;
  const since = nowMs - Math.max(1, hours) * 3_600_000;
  return { since, until };
}

const PAD = (n, w = 2) => String(n).padStart(w, '0');

/** 'YYYY-MM-DD' */
export function formatDate(utcMs, offsetMinutes) {
  const p = localParts(utcMs, offsetMinutes);
  return `${p.year}-${PAD(p.month)}-${PAD(p.day)}`;
}

/** 'MM-DD HH:mm' */
export function formatShort(utcMs, offsetMinutes) {
  const p = localParts(utcMs, offsetMinutes);
  return `${PAD(p.month)}-${PAD(p.day)} ${PAD(p.hour)}:${PAD(p.minute)}`;
}

/** 'HH:mm' */
export function formatClock(utcMs, offsetMinutes) {
  const p = localParts(utcMs, offsetMinutes);
  return `${PAD(p.hour)}:${PAD(p.minute)}`;
}

/** 'YYYY-MM-DD HH:mm' */
export function formatDateTime(utcMs, offsetMinutes) {
  return `${formatDate(utcMs, offsetMinutes)} ${formatClock(utcMs, offsetMinutes)}`;
}

/** 'YYYYMMDDTHHMMSSZ'，用于 ICS。 */
export function formatIcsUtc(utcMs) {
  const d = new Date(utcMs);
  return (
    `${d.getUTCFullYear()}${PAD(d.getUTCMonth() + 1)}${PAD(d.getUTCDate())}` +
    `T${PAD(d.getUTCHours())}${PAD(d.getUTCMinutes())}${PAD(d.getUTCSeconds())}Z`
  );
}

/** 'YYYYMMDD'，用于 ICS 全天事件。 */
export function formatIcsDate(utcMs, offsetMinutes) {
  const p = localParts(utcMs, offsetMinutes);
  return `${p.year}${PAD(p.month)}${PAD(p.day)}`;
}

export function minutesOfDay(utcMs, offsetMinutes) {
  const p = localParts(utcMs, offsetMinutes);
  return p.hour * 60 + p.minute;
}

export function isSameLocalDay(aMs, bMs, offsetMinutes) {
  return formatDate(aMs, offsetMinutes) === formatDate(bMs, offsetMinutes);
}

/** 本地当天某时刻的 UTC 毫秒。 */
export function atLocalTime(dayUtcMs, hour, minute, offsetMinutes) {
  const p = localParts(dayUtcMs, offsetMinutes);
  return fromLocal({ year: p.year, month: p.month, day: p.day, hour, minute }, offsetMinutes);
}

/** 可读时长：'2 小时 15 分钟'。 */
export function humanDuration(ms) {
  const totalMinutes = Math.max(0, Math.round(ms / MINUTE));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days} 天`);
  if (hours) parts.push(`${hours} 小时`);
  if (minutes || parts.length === 0) parts.push(`${minutes} 分钟`);
  return parts.join(' ');
}
