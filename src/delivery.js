/**
 * 外发通道：文件 / QQ 私聊 / 微信桥 / DSH 会话通知。
 *
 * 只有 report_approve 会触发这里；任何通道失败都不应让整个批准流程崩掉，
 * 失败原因会写进报告的 delivery 字段，用户可以修好后重试。
 */

import fs from 'node:fs';
import path from 'node:path';

import { truncate } from './util/text.js';

const TOKEN_TTL_MS = 7000_000;

export async function deliverReport({ report, config, paths, store, log = () => {}, channels }) {
  const selected = Array.isArray(channels) && channels.length ? channels : report.channels.length ? report.channels : config.delivery.channels;
  const results = {};

  for (const channel of selected) {
    try {
      if (channel === 'file') {
        results.file = deliverFile({ report, paths });
      } else if (channel === 'qq') {
        results.qq = await deliverQQ({ report, config, log });
      } else if (channel === 'wechat') {
        results.wechat = await deliverWeChat({ report, config, log });
      } else if (channel === 'dsh') {
        results.dsh = deliverDsh({ report, config });
      } else {
        results[channel] = { ok: false, skipped: true, reason: `未知通道：${channel}` };
      }
    } catch (err) {
      results[channel] = { ok: false, error: err.message };
      log(`通道 ${channel} 投递失败：${err.message}`);
    }
  }

  const attempted = Object.values(results).filter((r) => !r.skipped);
  const ok = attempted.length > 0 && attempted.every((r) => r.ok);
  const anyOk = attempted.some((r) => r.ok);
  return { ok, anyOk, results, channels: selected };
}

function deliverFile({ report, paths }) {
  const file = path.join(paths.reports, `${report.id}.md`);
  try {
    fs.mkdirSync(paths.reports, { recursive: true });
    fs.writeFileSync(file, report.markdown, 'utf8');
    return { ok: true, path: file };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** 从报告里抽一段适合私聊的正文。 */
export function buildPushText(report, { maxChars = 1800, full = false } = {}) {
  const header = `【${report.title}】\n`;
  const body = full ? report.markdown : report.markdown.replace(/^#\s+.*$/m, '').trim();
  const footer = `\n\n完整报告：${report.filePath ?? `报告 ${report.id}`}\n（状态：已审核 · ${report.id}）`;
  const budget = Math.max(200, maxChars - header.length - footer.length);
  return `${header}${truncate(body, budget)}${footer}`;
}

// ------------------------------------------------------------------- QQ

class QQClient {
  #cfg;
  #log;
  #token = null;
  #expiresAt = 0;

  constructor(cfg, log) {
    this.#cfg = cfg;
    this.#log = log;
  }

  async #accessToken() {
    if (this.#token && Date.now() < this.#expiresAt - 60_000) return this.#token;
    const res = await fetch(`${this.#cfg.apiBase}/app/getAppAccessToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ appId: this.#cfg.appId, clientSecret: this.#cfg.clientSecret }),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`QQ 凭证接口返回非 JSON（HTTP ${res.status}）`);
    }
    if (!json?.access_token) {
      throw new Error(
        `QQ 凭证获取失败：${json?.message ?? json?.msg ?? `HTTP ${res.status}`}（code=${json?.code ?? '?'}）`,
      );
    }
    this.#token = json.access_token;
    this.#expiresAt = Date.now() + (Number(json.expires_in) || 7200) * 1000;
    this.#log('QQ access_token 已刷新');
    return this.#token;
  }

  async sendPrivate(openid, content) {
    const token = await this.#accessToken();
    const res = await fetch(
      `${this.#cfg.apiBase}/v2/users/${encodeURIComponent(openid)}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `QQBot ${token}`,
        },
        body: JSON.stringify({ content, msg_type: 0 }),
        signal: AbortSignal.timeout(20000),
      },
    );
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`QQ 发送返回非 JSON（HTTP ${res.status}）：${truncate(text, 120)}`);
    }
    const code = typeof json?.code === 'number' ? json.code : json?.err_code;
    if (code !== undefined && code !== 0) {
      throw new Error(`QQ 发送失败 code=${code}：${json?.message ?? json?.msg ?? '无描述'}`);
    }
    if (!res.ok) throw new Error(`QQ 发送失败 HTTP ${res.status}：${truncate(text, 120)}`);
    return { id: json?.id ?? null, timestamp: json?.timestamp ?? null };
  }
}

function resolveQQOpenId(cfg) {
  const raw = String(cfg.userOpenId ?? '').trim();
  if (raw && raw !== 'latest') return { openid: raw, source: 'config' };
  const file = cfg.contactsFile
    ? path.resolve(cfg.contactsFile)
    : null;
  if (!file || !fs.existsSync(file)) {
    return { openid: null, error: '未配置 qq.userOpenId，也找不到 contactsFile' };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const contacts = Array.isArray(parsed?.contacts) ? parsed.contacts : [];
    const latest = contacts
      .filter((c) => c?.openid)
      .sort((a, b) => String(b.lastSeenAt ?? '').localeCompare(String(a.lastSeenAt ?? '')))[0];
    if (!latest) return { openid: null, error: '联系人文件里还没有任何 openid（先让用户私聊一次机器人）' };
    return { openid: latest.openid, source: `latest:${latest.lastSeenAt ?? ''}` };
  } catch (err) {
    return { openid: null, error: `联系人文件读取失败：${err.message}` };
  }
}

let qqClient = null;
let qqClientKey = '';

async function deliverQQ({ report, config, log }) {
  const cfg = config.delivery.qq;
  if (!cfg.enabled) return { ok: false, skipped: true, reason: 'delivery.qq.enabled=false' };
  if (!cfg.appId || !cfg.clientSecret) {
    return { ok: false, skipped: true, reason: '缺少 QQ appId / clientSecret' };
  }
  const target = resolveQQOpenId(cfg);
  if (!target.openid) return { ok: false, skipped: true, reason: target.error };

  const key = `${cfg.apiBase}|${cfg.appId}|${cfg.clientSecret}`;
  if (!qqClient || qqClientKey !== key) {
    qqClient = new QQClient(cfg, log);
    qqClientKey = key;
  }
  const text = buildPushText(report, { maxChars: Number(cfg.maxChars) || 1800 });
  const sent = await qqClient.sendPrivate(target.openid, text);
  log(`报告 ${report.id} 已推送到 QQ ${target.openid}`);
  return { ok: true, openid: target.openid, targetSource: target.source, ...sent };
}

// ---------------------------------------------------------------- WeChat

async function deliverWeChat({ report, config, log }) {
  const cfg = config.delivery.wechat;
  if (!cfg.enabled) return { ok: false, skipped: true, reason: 'delivery.wechat.enabled=false' };
  if (!cfg.sendUrl) return { ok: false, skipped: true, reason: '未配置 wechat.sendUrl' };

  const text = buildPushText(report, { maxChars: Number(cfg.maxChars) || 1500 });
  const res = await fetch(cfg.sendUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
    },
    body: JSON.stringify({ to: cfg.to || undefined, text, reportId: report.id }),
    signal: AbortSignal.timeout(20000),
  });
  const body = truncate(await res.text().catch(() => ''), 200);
  if (!res.ok) throw new Error(`微信桥返回 HTTP ${res.status}：${body}`);
  log(`报告 ${report.id} 已推送到微信桥`);
  return { ok: true, status: res.status, response: body };
}

// ------------------------------------------------------------------- DSH

function deliverDsh({ config }) {
  if (!config.delivery.dsh.enabled || !config.delivery.dsh.notify) {
    return { ok: false, skipped: true, reason: 'delivery.dsh.notify=false' };
  }
  // 真正的通知由 service.approveReport 统一入队，避免同一次批准产生两条。
  return { ok: true, deferred: true, note: '会话通知由服务层入队' };
}
