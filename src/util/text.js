/**
 * 文本处理小工具：截断、URL 提取、ID 生成、ICS 转义。
 * 刻意保持无依赖，方便在 MCP 子进程与插件里复用。
 */

import crypto from 'node:crypto';

export function normalizeSpace(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

export function truncate(text, max = 120, suffix = '…') {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - suffix.length)) + suffix;
}

/** 按「行」截断，保留前 maxLines 行。 */
export function truncateLines(text, maxLines) {
  const lines = String(text ?? '').split('\n');
  if (lines.length <= maxLines) return lines.join('\n');
  return `${lines.slice(0, maxLines).join('\n')}\n…（已截断）`;
}

export function shortHash(input, length = 12) {
  return crypto.createHash('sha256').update(String(input)).digest('hex').slice(0, length);
}

export function stableId(...parts) {
  return shortHash(parts.map((p) => String(p ?? '')).join('\u0000'), 24);
}

export function extractUrls(text) {
  const matches = String(text ?? '').match(/https?:\/\/[^\s<>"'）)】\]]+/gi) ?? [];
  const seen = new Set();
  const out = [];
  for (const raw of matches) {
    const url = raw.replace(/[.,;:!?]+$/, '');
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/** 判断是否像在提问。 */
export function looksLikeQuestion(text) {
  const value = String(text ?? '');
  if (!/[?？]/.test(value) && !/(吗|呢|谁|怎么|如何|哪[个里]|是否|能不能|有没有|什么)/.test(value)) {
    return false;
  }
  return value.length >= 4;
}

/** ICS 文本转义：反斜杠、分号、逗号、换行。 */
export function escapeIcs(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** ICS 每行最多 75 字节，继续行以空格开头。 */
export function foldIcsLine(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const out = [];
  let current = Buffer.alloc(0);
  let first = true;
  for (const char of Array.from(line)) {
    const buf = Buffer.from(char, 'utf8');
    const limit = first ? 75 : 74;
    if (current.length + buf.length > limit) {
      out.push((first ? '' : ' ') + current.toString('utf8'));
      current = Buffer.alloc(0);
      first = false;
    }
    current = Buffer.concat([current, buf]);
  }
  out.push((first ? '' : ' ') + current.toString('utf8'));
  return out.join('\r\n');
}

/** 去掉 Markdown 表格里会破坏结构的字符。 */
export function tableCell(value, max = 60) {
  return truncate(String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' '), max);
}

export function uniqBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

export function sumBy(items, fn) {
  return items.reduce((acc, item) => acc + (fn(item) || 0), 0);
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
