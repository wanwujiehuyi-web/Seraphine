/**
 * 本机 HTTP API + Webhook 入口 + 人工审核页面。
 *
 * 只监听 127.0.0.1。所有 /api 与 /ingest 请求都要带 token：
 *   Authorization: Bearer <token>
 *   x-group-token: <token>
 *   ?token=<token>            （给发不出自定义头的微信桥用）
 *
 * /health 与 /review 页面不需要 token，方便存活探测与人工审核；
 * /review 页面本身只展示报告，不泄露其他数据。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';

import { PKG_ROOT, saveConfig } from './config.js';
import { cacheStatus, cleanupCache } from './cache.js';
import { normalizeOneBot, normalizeWebhook } from './ingest.js';
import { formatDateTime } from './util/time.js';

const VERSION = '0.1.0';
const MAX_BODY = 2 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data ?? null);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(text), ...extra });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new HttpError(400, `请求体不是合法 JSON：${err.message}`);
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function authorized(req, url, token) {
  const header = req.headers.authorization ?? '';
  if (header === `Bearer ${token}`) return true;
  if (req.headers['x-group-token'] === token) return true;
  const query = url.searchParams.get('token');
  return Boolean(query) && query === token;
}

/**
 * @param {object} deps
 * @param {import('./service.js').GroupDigestService} deps.service
 * @param {object} deps.config
 * @param {object} deps.ingest Ingest 实例
 * @param {object} deps.log
 * @param {() => object} deps.runtime 适配器状态
 * @param {() => string} deps.mockMode 是否 mock
 */
export function createHttpServer({ service, config, ingest, log = () => {}, runtime = () => ({}), qq = null, wechat = null, paths = null, configPath = null }) {
  const token = config.server.token;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';

    try {
      if (method === 'GET' && pathname === '/health') {
        sendJson(res, 200, {
          ok: true,
          name: 'group-digest',
          version: VERSION,
          time: new Date().toISOString(),
          uptimeSeconds: Math.round(process.uptime()),
        });
        return;
      }

      if (method === 'GET' && pathname === '/app/seraphine-bg.jpg') {
        try {
          const data = fs.readFileSync(path.join(PKG_ROOT, 'app', 'seraphine-bg.jpg'));
          res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Content-Length': data.length,
            'Cache-Control': 'public, max-age=86400',
          });
          res.end(data);
        } catch {
          throw new HttpError(404, '背景不存在');
        }
        return;
      }

      if (method === 'GET' && pathname === '/app/seraphine-bg.svg') {
        try {
          const data = fs.readFileSync(path.join(PKG_ROOT, 'app', 'seraphine-bg.svg'));
          res.writeHead(200, {
            'Content-Type': 'image/svg+xml; charset=utf-8',
            'Content-Length': data.length,
            'Cache-Control': 'public, max-age=86400',
          });
          res.end(data);
        } catch {
          throw new HttpError(404, '背景不存在');
        }
        return;
      }

      if (
        method === 'GET' &&
        (pathname === '/app/icon.png' ||
          pathname === '/app/icon.ico' ||
          pathname === '/app/seraphine-icon.png' ||
          pathname === '/app/seraphine-icon.ico' ||
          pathname === '/app/seraphine-avatar.png' ||
          pathname === '/app/seraphine-avatar.ico' ||
          pathname === '/app/seraphine-final.png' ||
          pathname === '/app/seraphine-final.ico')
      ) {
        const final = pathname.includes('seraphine-final');
        const avatar = pathname.includes('seraphine-avatar');
        const seraphine = pathname.includes('seraphine-icon');
        const isPng = pathname.endsWith('.png');
        const file = final
          ? (isPng ? 'seraphine-final.png' : 'seraphine-final.ico')
          : avatar
            ? (isPng ? 'seraphine-avatar.png' : 'seraphine-avatar.ico')
            : seraphine
              ? (isPng ? 'seraphine-icon.png' : 'seraphine-icon.ico')
              : (isPng ? 'icon.png' : 'icon.ico');
        const full = path.join(PKG_ROOT, 'app', file);
        try {
          const data = fs.readFileSync(full);
          res.writeHead(200, {
            'Content-Type': isPng ? 'image/png' : 'image/x-icon',
            'Content-Length': data.length,
            'Cache-Control': 'public, max-age=86400',
          });
          res.end(data);
        } catch {
          throw new HttpError(404, '图标不存在');
        }
        return;
      }

      if (method === 'GET' && pathname === '/app') {
        if (!authorized(req, url, token)) throw new HttpError(401, '缺少或错误的 token');
        try {
          const html = fs.readFileSync(path.join(PKG_ROOT, 'app', 'index.html'), 'utf8');
          sendText(res, 200, html, 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' });
        } catch {
          throw new HttpError(500, 'app/index.html 不存在');
        }
        return;
      }

      if (method === 'GET' && pathname === '/setup') {
        if (!authorized(req, url, token)) throw new HttpError(401, '缺少或错误的 token');
        sendText(res, 200, renderSetupPage({ config, token }), 'text/html; charset=utf-8');
        return;
      }

      if (method === 'GET' && pathname.startsWith('/review/')) {
        const id = pathname.slice('/review/'.length);
        sendText(res, 200, renderReviewPage({ report: service.getReport(id), token, config }), 'text/html; charset=utf-8');
        return;
      }

      if (!pathname.startsWith('/api/') && !pathname.startsWith('/ingest/')) {
        throw new HttpError(404, '未知路径');
      }

      if (!authorized(req, url, token)) {
        throw new HttpError(401, '缺少或错误的 token');
      }

      // ------------------------------------------------------------ 缓存
      if (method === 'GET' && pathname === '/api/cache') {
        sendJson(res, 200, cacheStatus({ paths, config }));
        return;
      }
      if (method === 'POST' && pathname === '/api/cache/clean') {
        sendJson(res, 200, cleanupCache({ paths, config, log }));
        return;
      }

      // ------------------------------------------------------------ 状态
      if (method === 'GET' && pathname === '/api/status') {
        sendJson(res, 200, { ...service.publicStatus(), adapters: runtime() });
        return;
      }

      // ------------------------------------------------------------- 群
      if (method === 'GET' && pathname === '/api/qq/sessions') {
        if (!qq) throw new HttpError(503, 'QQ UIA 适配器未启用');
        sendJson(res, 200, { sessions: qq.listSessions() });
        return;
      }
      if (method === 'POST' && pathname === '/api/qq/read') {
        if (!qq) throw new HttpError(503, 'QQ UIA 适配器未启用');
        const body = await readJson(req);
        const result = await qq.readGroup(body.group ?? body.chatName, {
          limit: Number(body.limit) || 30,
        });
        sendJson(res, 200, result);
        return;
      }
      if (method === 'POST' && pathname === '/api/wechat/preview') {
        const result = await runWechatOcr(paths);
        sendJson(res, 200, result);
        return;
      }
      if (method === 'GET' && pathname === '/api/groups') {
        sendJson(res, 200, service.listGroups());
        return;
      }
      if (method === 'POST' && pathname === '/api/groups/watch') {
        const body = await readJson(req);
        if (!body.platform || !body.chatId) throw new HttpError(400, '需要 platform 与 chatId');
        sendJson(res, 200, {
          group: service.setWatch(body.platform, String(body.chatId), body.watched !== false),
        });
        return;
      }

      // ----------------------------------------------------------- 关注
      if (method === 'GET' && pathname === '/api/follows') {
        sendJson(res, 200, service.listFollows());
        return;
      }
      if (method === 'POST' && pathname === '/api/follows') {
        const body = await readJson(req);
        sendJson(res, 200, {
          follow: service.addFollow({
            platform: body.platform,
            chatId: body.chatId,
            userId: body.userId,
            userName: body.userName,
            priority: body.priority,
            note: body.note,
          }),
        });
        return;
      }
      if (method === 'POST' && pathname === '/api/follows/remove') {
        const body = await readJson(req);
        sendJson(res, 200, service.removeFollow(body));
        return;
      }
      if (method === 'GET' && pathname === '/api/members') {
        const chatId = url.searchParams.get('chatId');
        sendJson(res, 200, service.listMembers({ chatId, limit: Number(url.searchParams.get('limit') ?? 100) }));
        return;
      }
      if (method === 'GET' && pathname === '/api/members/search') {
        sendJson(res, 200, service.searchMembers({
          q: url.searchParams.get('q') ?? '',
          limit: Number(url.searchParams.get('limit') ?? 50),
        }));
        return;
      }

      // ------------------------------------------------------- 群级设置
      if (method === 'GET' && pathname === '/api/group-settings') {
        sendJson(
          res,
          200,
          service.groupSettings(
            url.searchParams.get('platform') || 'qq',
            url.searchParams.get('chatId'),
          ),
        );
        return;
      }
      if (method === 'POST' && pathname === '/api/group-settings') {
        const body = await readJson(req);
        sendJson(res, 200, {
          settings: service.setGroupSettings({
            platform: body.platform || 'qq',
            chatId: body.chatId,
            enabled: body.enabled !== false,
            autoRead: body.autoRead === true,
            keywords: Array.isArray(body.keywords) ? body.keywords : [],
          }),
        });
        return;
      }

      // ------------------------------------------------------ 微信 OCR
      if (method === 'GET' && pathname === '/api/wechat/groups') {
        if (!wechat) throw new HttpError(503, '微信 OCR 适配器未启用');
        const result = await wechat.listGroups();
        sendJson(res, 200, result);
        return;
      }
      if (method === 'POST' && pathname === '/api/wechat/scan') {
        if (!wechat) throw new HttpError(503, '微信 OCR 适配器未启用');
        const body = await readJson(req);
        const result = await wechat.scanGroup(body.group, {
          x: Number.isFinite(Number(body.x)) ? Number(body.x) : null,
          y: Number.isFinite(Number(body.y)) ? Number(body.y) : null,
        });
        sendJson(res, 200, result);
        return;
      }

      // --------------------------------------------------- 自定义关注规则
      if (method === 'GET' && pathname === '/api/custom-rules') {
        sendJson(res, 200, { rules: config.watch.customRules ?? [] });
        return;
      }
      if (method === 'POST' && pathname === '/api/custom-rules') {
        const body = await readJson(req);
        const rule = {
          name: String(body.name ?? '').trim() || String(body.pattern ?? '').trim(),
          pattern: String(body.pattern ?? '').trim(),
          type: body.type === 'regex' ? 'regex' : 'keyword',
          weight: Math.max(1, Math.min(10, Number(body.weight) || 3)),
          note: String(body.note ?? ''),
        };
        if (!rule.pattern) throw new HttpError(400, 'pattern 不能为空');
        if (rule.type === 'regex') {
          try {
            new RegExp(rule.pattern, 'i');
          } catch (err) {
            throw new HttpError(400, `正则不合法：${err.message}`);
          }
        }
        const rules = [...(config.watch.customRules ?? [])];
        const index = rules.findIndex((item) => item.name === rule.name);
        if (index >= 0) rules[index] = rule;
        else rules.push(rule);
        config.watch.customRules = rules;
        if (configPath) saveConfig(config, configPath);
        sendJson(res, 200, { rules });
        return;
      }
      if (method === 'DELETE' && pathname === '/api/custom-rules') {
        const name = url.searchParams.get('name');
        config.watch.customRules = (config.watch.customRules ?? []).filter((rule) => rule.name !== name);
        if (configPath) saveConfig(config, configPath);
        sendJson(res, 200, { rules: config.watch.customRules });
        return;
      }

      // ------------------------------------------------------------ 设置
      if (method === 'GET' && pathname === '/api/config') {
        sendJson(res, 200, {
          adapters: {
            qqUia: config.adapters.qqUia,
            wechatOcr: config.adapters.wechatOcr,
            onebot: { enabled: config.adapters.onebot.enabled, url: config.adapters.onebot.url },
            webhook: config.adapters.webhook,
          },
          watch: {
            keywords: config.watch.keywords,
            customRules: config.watch.customRules ?? [],
            followAlerts: config.watch.followAlerts,
            includePrivate: config.watch.includePrivate,
          },
          digest: config.digest,
          schedule: config.schedule,
          cache: config.cache,
          delivery: {
            channels: config.delivery.channels,
            qq: { enabled: config.delivery.qq.enabled },
            wechat: { enabled: config.delivery.wechat.enabled },
            dsh: config.delivery.dsh,
          },
          review: config.review,
        });
        return;
      }
      if (method === 'POST' && pathname === '/api/config') {
        const body = await readJson(req);
        if (body.adapters?.qqUia) {
          const patch = body.adapters.qqUia;
          if (Number.isFinite(Number(patch.intervalMs))) {
            config.adapters.qqUia.intervalMs = Math.max(1500, Number(patch.intervalMs));
          }
          if (typeof patch.readCurrentChat === 'boolean') {
            config.adapters.qqUia.readCurrentChat = patch.readCurrentChat;
          }
          if (typeof patch.autoOpenUnread === 'boolean') {
            config.adapters.qqUia.autoOpenUnread = patch.autoOpenUnread;
          }
        }
        if (body.adapters?.wechatOcr) {
          const patch = body.adapters.wechatOcr;
          if (typeof patch.enabled === 'boolean') config.adapters.wechatOcr.enabled = patch.enabled;
          if (Number.isFinite(Number(patch.intervalMs))) {
            config.adapters.wechatOcr.intervalMs = Math.max(30000, Number(patch.intervalMs));
          }
        }
        if (Array.isArray(body.watch?.keywords)) {
          config.watch.keywords = body.watch.keywords.map(String).filter(Boolean);
        }
        if (Array.isArray(body.watch?.customRules)) {
          config.watch.customRules = body.watch.customRules;
        }
        if (body.watch?.followAlerts) {
          config.watch.followAlerts = String(body.watch.followAlerts);
        }
        if (body.digest) {
          if (Array.isArray(body.digest.slots)) {
            config.digest.slots = body.digest.slots.map(String).filter((s) => /^\d{1,2}:\d{2}$/.test(s));
          }
          if (Number.isFinite(Number(body.digest.lookbackHours))) {
            config.digest.lookbackHours = Math.max(1, Math.min(336, Number(body.digest.lookbackHours)));
          }
          if (Array.isArray(body.digest.channels)) {
            config.digest.channels = body.digest.channels.map(String);
          }
        }
        if (body.delivery && Array.isArray(body.delivery.channels)) {
          config.delivery.channels = body.delivery.channels.map(String);
        }
        if (body.cache) {
          const patch = body.cache;
          if (typeof patch.enabled === 'boolean') config.cache.enabled = patch.enabled;
          if (Number.isFinite(Number(patch.intervalMs))) {
            config.cache.intervalMs = Math.max(60_000, Math.min(7 * 24 * 60 * 60 * 1000, Number(patch.intervalMs)));
          }
          if (Number.isFinite(Number(patch.exportRetentionHours))) {
            config.cache.exportRetentionHours = Math.max(1, Math.min(24 * 30, Number(patch.exportRetentionHours)));
          }
          if (Number.isFinite(Number(patch.browserCacheMaxAgeHours))) {
            config.cache.browserCacheMaxAgeHours = Math.max(1, Math.min(24 * 30, Number(patch.browserCacheMaxAgeHours)));
          }
        }
        // 轮询间隔即时生效，不再要求重启 Hub。
        if (config.adapters.qqUia) qq?.setIntervalMs?.(config.adapters.qqUia.intervalMs);
        if (config.adapters.wechatOcr) wechat?.setIntervalMs?.(config.adapters.wechatOcr.intervalMs);
        if (configPath) saveConfig(config, configPath);
        sendJson(res, 200, { ok: true });
        return;
      }

      // ----------------------------------------------------------- 消息
      if (method === 'GET' && pathname === '/api/messages') {
        sendJson(
          res,
          200,
          service.queryMessages({
            platform: url.searchParams.get('platform') ?? undefined,
            chatId: url.searchParams.get('chatId') ?? undefined,
            userId: url.searchParams.get('userId') ?? undefined,
            since: url.searchParams.get('since') ?? undefined,
            until: url.searchParams.get('until') ?? undefined,
            q: url.searchParams.get('q') ?? undefined,
            limit: url.searchParams.get('limit') ?? undefined,
          }),
        );
        return;
      }

      // ----------------------------------------------------------- 摘要
      if (method === 'POST' && pathname === '/api/digest/preview') {
        const body = await readJson(req);
        sendJson(res, 200, service.previewDigest(body));
        return;
      }

      // ----------------------------------------------------------- 报告
      if (method === 'POST' && pathname === '/api/reports') {
        const body = await readJson(req);
        const since = body.since || service.resolveSince('report');
        let wechatResult = null;
        if (body.refreshWeChat && wechat) {
          try {
            wechatResult = await wechat.collectMonitored({ since });
          } catch (err) {
            log.warn?.(`微信补采失败：${err.message}`);
            wechatResult = { error: err.message };
          }
        }
        const result = service.createReport({ ...body, since });
        sendJson(res, result.created ? 201 : 200, { ...result, wechat: wechatResult });
        return;
      }
      if (method === 'GET' && pathname === '/api/reports') {
        sendJson(
          res,
          200,
          service.listReports({
            status: url.searchParams.get('status') ?? undefined,
            limit: Number(url.searchParams.get('limit') ?? 20),
          }),
        );
        return;
      }

      const reportMatch = /^\/api\/reports\/([^/]+)(\/[a-z-]+)?$/.exec(pathname);
      if (reportMatch) {
        const id = reportMatch[1];
        const action = reportMatch[2] ?? '';
        if (method === 'GET' && action === '') {
          sendJson(res, 200, service.getReport(id));
          return;
        }
        if (method === 'GET' && action === '/download') {
          const report = service.getReport(id);
          sendText(res, 200, report.markdown, 'text/markdown; charset=utf-8', {
            'Content-Disposition': `attachment; filename="${report.id}.md"`,
          });
          return;
        }
        if (method === 'POST' && action === '/update') {
          const body = await readJson(req);
          sendJson(res, 200, { report: service.updateReport(id, body.markdown) });
          return;
        }
        if (method === 'POST' && action === '/approve') {
          const body = await readJson(req);
          const result = await service.approveReport(id, {
            approvedBy: body.approvedBy,
            channels: body.channels,
            confirmed: body.confirmed === true,
          });
          sendJson(res, 200, result);
          return;
        }
        if (method === 'POST' && action === '/reject') {
          const body = await readJson(req);
          sendJson(res, 200, { report: service.rejectReport(id, body.reason ?? '') });
          return;
        }
      }

      // ----------------------------------------------------------- 日程
      if (method === 'GET' && pathname === '/api/schedule') {
        sendJson(
          res,
          200,
          service.schedule({
            since: url.searchParams.get('since') ?? undefined,
            until: url.searchParams.get('until') ?? undefined,
            persist: url.searchParams.get('persist') !== '0',
          }),
        );
        return;
      }
      if (method === 'GET' && pathname === '/api/schedule/upcoming') {
        sendJson(res, 200, service.listUpcomingEvents({ days: Number(url.searchParams.get('days') ?? 14) }));
        return;
      }
      if (method === 'POST' && pathname === '/api/schedule/generate') {
        const body = await readJson(req);
        const since = body.since || service.resolveSince('schedule');
        let wechatResult = null;
        if (body.refreshWeChat && wechat) {
          try {
            wechatResult = await wechat.collectMonitored({ since });
          } catch (err) {
            log.warn?.(`微信补采失败：${err.message}`);
            wechatResult = { error: err.message };
          }
        }
        const result = service.generateSchedule({ since, until: body.until, persist: true });
        sendJson(res, 200, { ...result, wechat: wechatResult });
        return;
      }
      if (method === 'POST' && pathname === '/api/schedule/export') {
        const body = await readJson(req);
        const result = service.exportSchedule({
          since: body.since,
          until: body.until,
          format: body.format ?? 'ics',
        });
        sendJson(res, 200, result);
        return;
      }

      // ----------------------------------------------------------- 通知
      if (method === 'GET' && pathname === '/api/notifications') {
        const undelivered = url.searchParams.get('all') !== '1';
        sendJson(res, 200, service.listNotifications({
          undelivered,
          limit: Number(url.searchParams.get('limit') ?? 50),
        }));
        return;
      }
      if (method === 'POST' && pathname === '/api/notifications/drain') {
        const body = await readJson(req);
        sendJson(res, 200, service.drainNotifications({ limit: body.limit ?? 20 }));
        return;
      }
      if (method === 'POST' && pathname === '/api/notifications/read') {
        const body = await readJson(req);
        sendJson(res, 200, service.markNotificationRead(body.ids ?? []));
        return;
      }
      if (method === 'POST' && pathname === '/api/notifications/delivered') {
        const body = await readJson(req);
        sendJson(res, 200, service.markNotificationDelivered(body.ids ?? []));
        return;
      }

      // ----------------------------------------------------------- 采集
      if (method === 'POST' && (pathname === '/api/ingest/onebot' || pathname === '/api/ingest/generic')) {
        const payload = await readJson(req);
        const events = Array.isArray(payload) ? payload : [payload];
        const results = [];
        for (const event of events) {
          const message = normalizeOneBot(event, { platform: 'qq', adapter: 'onebot' });
          results.push(acceptMessage(message));
        }
        sendJson(res, 200, { count: results.length, results });
        return;
      }
      if (method === 'POST' && pathname === '/api/ingest/wechat') {
        const payload = await readJson(req);
        const events = Array.isArray(payload) ? payload : [payload];
        const results = [];
        for (const event of events) {
          const message = normalizeWebhook(event, {
            platform: event.platform ?? 'wechat',
            adapter: 'webhook',
          });
          results.push(acceptMessage(message));
        }
        sendJson(res, 200, { count: results.length, results });
        return;
      }

      throw new HttpError(404, `未知接口：${method} ${pathname}`);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) log(`HTTP 500 ${method} ${pathname}：${err.stack ?? err.message}`);
      if (!res.headersSent) {
        sendJson(res, status, { error: err.message });
      } else {
        res.end();
      }
    }
  });

  function acceptMessage(message, options = {}) {
    if (!message) return { accepted: false, reason: '无法识别的消息格式' };
    const include = config.adapters.onebot.includeGroups ?? [];
    if (include.length && message.chatType === 'group' && !include.includes(message.chatId)) {
      return { accepted: false, reason: '群不在 includeGroups 白名单内', chatId: message.chatId };
    }
    const result = ingest.ingest(message);
    return {
      accepted: true,
      inserted: result.inserted,
      id: message.id,
      chatId: message.chatId,
      chatName: message.chatName,
      follow: result.follow ? result.follow.userName || result.follow.userId : null,
      ...options,
    };
  }

  return server;
}

function renderReviewPage({ report, token, config }) {
  const offset = config.timezone.utcOffsetMinutes;
  const period = `${formatDateTime(Date.parse(report.periodStart), offset)} — ${formatDateTime(
    Date.parse(report.periodEnd),
    offset,
  )}`;
  const statusLabel = {
    pending: '待审核',
    approved: '已批准',
    sent: '已发送',
    rejected: '已驳回',
  }[report.status] ?? report.status;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>审核报告 · ${escapeHtml(report.title)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font: 15px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
         background: #0f1115; color: #e6e8ee; }
  header { position: sticky; top: 0; background: #171a21; border-bottom: 1px solid #262b36;
           padding: 14px 20px; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
  header h1 { font-size: 17px; margin: 0; flex: 1; }
  .meta { color: #9aa3b2; font-size: 13px; }
  .badge { padding: 2px 8px; border-radius: 999px; background: #2a2f3a; font-size: 12px; }
  main { max-width: 980px; margin: 0 auto; padding: 20px; }
  pre { white-space: pre-wrap; word-break: break-word; background: #141821; border: 1px solid #262b36;
        border-radius: 10px; padding: 20px; font-family: "Cascadia Mono", Consolas, monospace; font-size: 13px; }
  .actions { display: flex; gap: 10px; margin: 16px 0; flex-wrap: wrap; }
  button { font: inherit; padding: 9px 18px; border-radius: 8px; border: 1px solid #3a4150;
           background: #222834; color: #e6e8ee; cursor: pointer; }
  button.primary { background: #2f6feb; border-color: #2f6feb; }
  button.danger { background: #3a2027; border-color: #6b2a35; color: #ff9aa8; }
  button:disabled { opacity: .5; cursor: wait; }
  #msg { margin-left: 8px; color: #9aa3b2; }
  .warn { background: #2a2314; border: 1px solid #5c4a1e; color: #ffd479; padding: 10px 14px; border-radius: 8px; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(report.title)}</h1>
  <span class="badge">${statusLabel}</span>
  <span class="meta">${escapeHtml(period)} · ${report.id}</span>
</header>
<main>
  ${report.status === 'pending' ? '<p class="warn">审核通过后才会真正外发（文件 / QQ / 微信 / DSH）。批准动作会记入报告审计字段。</p>' : ''}
  <div class="actions">
    <button class="primary" id="approve" ${report.status === 'pending' ? '' : 'disabled'}>批准并发送</button>
    <button class="danger" id="reject" ${report.status === 'pending' ? '' : 'disabled'}>驳回</button>
    <button id="download">下载 Markdown</button>
    <span id="msg"></span>
  </div>
  <pre id="content">${escapeHtml(report.markdown)}</pre>
</main>
<script>
const REPORT_ID = ${JSON.stringify(report.id)};
const TOKEN = ${JSON.stringify(token)};
const msg = document.getElementById('msg');
function setMsg(text) { msg.textContent = text; }
async function call(action, body) {
  const res = await fetch('/api/reports/' + encodeURIComponent(REPORT_ID) + '/' + action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}
document.getElementById('approve').addEventListener('click', async (e) => {
  e.target.disabled = true; setMsg('发送中…');
  try {
    const data = await call('approve', { confirmed: true, approvedBy: 'review-page' });
    const results = data.delivery?.results || {};
    setMsg('已批准。' + Object.entries(results).map(([k, v]) => k + ':' + (v.ok ? '成功' : v.skipped ? '跳过' : '失败')).join(' · '));
    setTimeout(() => location.reload(), 1200);
  } catch (err) { setMsg('失败：' + err.message); e.target.disabled = false; }
});
document.getElementById('reject').addEventListener('click', async (e) => {
  const reason = prompt('驳回原因（可留空）') ?? '';
  e.target.disabled = true; setMsg('驳回中…');
  try { await call('reject', { reason }); setMsg('已驳回。'); setTimeout(() => location.reload(), 800); }
  catch (err) { setMsg('失败：' + err.message); e.target.disabled = false; }
});
document.getElementById('download').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/reports/' + encodeURIComponent(REPORT_ID) + '/download', {
      headers: { 'Authorization': 'Bearer ' + TOKEN },
    });
    const text = await res.text();
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = REPORT_ID + '.md';
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) { setMsg('下载失败：' + err.message); }
});
</script>
</body>
</html>`;
}

function runWechatOcr(paths) {
  return new Promise((resolve, reject) => {
    const outDir = paths?.exports ?? path.join(PKG_ROOT, 'state', 'exports');
    const script = path.join(PKG_ROOT, 'scripts', 'wechat-ocr.ps1');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-OutDir', outDir],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('微信 OCR 超时（45s）'));
    }, 45_000);
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
        reject(new Error(`微信 OCR 无输出${stderr ? `：${stderr.slice(0, 200)}` : ''}`));
        return;
      }
      try {
        const parsed = JSON.parse(line);
        // 中文 OCR 常在汉字之间插空格，这里压掉，读起来更接近原文。
        if (typeof parsed.text === 'string') {
          parsed.text = parsed.text
            .replace(/(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '')
            .replace(/[ \t]{2,}/g, ' ');
        }
        resolve(parsed);
      } catch {
        reject(new Error(`微信 OCR 返回非 JSON：${line.slice(0, 200)}`));
      }
    });
  });
}

function renderSetupPage({ config, token }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>萨勒芬妮 · 本机监控</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; background: #0f1115; color: #e6e8ee; }
  header { padding: 18px 24px; border-bottom: 1px solid #262b36; background: #171a21; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  header h1 { font-size: 18px; margin: 0; flex: 1; }
  header .hint { color: #9aa3b2; font-size: 13px; }
  main { max-width: 1180px; margin: 0 auto; padding: 22px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .card { background: #151923; border: 1px solid #262b36; border-radius: 10px; padding: 14px 16px; }
  .card .k { color: #9aa3b2; font-size: 12px; }
  .card .v { font-size: 20px; font-weight: 600; margin-top: 4px; }
  .ok { color: #6ee7a8; } .bad { color: #ff9aa8; } .muted { color: #9aa3b2; }
  .toolbar { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
  button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 1px solid #3a4150; background: #222834; color: #e6e8ee; cursor: pointer; }
  button.primary { background: #2f6feb; border-color: #2f6feb; }
  button:disabled { opacity: .5; cursor: wait; }
  table { width: 100%; border-collapse: collapse; background: #141821; border: 1px solid #262b36; border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid #222834; vertical-align: top; }
  th { color: #9aa3b2; font-weight: 500; font-size: 12px; }
  td.name { max-width: 240px; }
  .preview { color: #9aa3b2; max-width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .unread { color: #ffd479; }
  pre { background: #141821; border: 1px solid #262b36; border-radius: 10px; padding: 16px; white-space: pre-wrap; word-break: break-word; max-height: 460px; overflow: auto; }
  #msg { color: #9aa3b2; margin-left: 6px; }
  .footer { margin-top: 20px; color: #6f7888; font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>萨勒芬妮 <span class="muted" style="font-weight:400;font-size:13px">本机监控</span></h1>
  <span class="hint">QQ 界面读取：只读会话列表与当前聊天；打开指定群会标记该群已读。</span>
</header>
<main>
  <div class="cards">
    <div class="card"><div class="k">Hub</div><div class="v" id="hub">—</div></div>
    <div class="card"><div class="k">QQ 会话</div><div class="v" id="sessions">—</div></div>
    <div class="card"><div class="k">已采集消息</div><div class="v" id="messages">—</div></div>
    <div class="card"><div class="k">待审报告</div><div class="v" id="pending">—</div></div>
  </div>

  <div class="toolbar">
    <button class="primary" id="refresh">刷新状态</button>
    <button id="report">生成今日汇报</button>
    <button id="wechat">扫描微信窗口</button>
    <button id="openQq" disabled title="启动器负责重启 QQ">QQ 无障碍模式</button>
    <span id="msg"></span>
  </div>

  <h3 style="margin:18px 0 10px">QQ 会话</h3>
  <table>
    <thead><tr><th>群 / 会话</th><th>时间</th><th>最后一条</th><th>未读</th><th></th></tr></thead>
    <tbody id="rows"><tr><td colspan="5" class="muted">加载中…</td></tr></tbody>
  </table>

  <h3 style="margin:18px 0 10px">读取结果</h3>
  <pre id="output">点击某个群的「读取」，这里会显示最近消息。读取会打开该群，因此会清除它的未读标记。</pre>
  <div class="footer">数据只在本机：SQLite + 127.0.0.1。报告外发前仍需人工批准。token 已包含在当前页面地址中，不要分享这个链接。</div>
</main>
<script>
const TOKEN = ${JSON.stringify(token)};
const $ = (id) => document.getElementById(id);
const msg = (t) => { $('msg').textContent = t || ''; };
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Authorization': 'Bearer ' + TOKEN, ...(options.headers || {}) },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) throw new Error(data?.error || ('HTTP ' + res.status));
  return data;
}
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

async function loadStatus() {
  try {
    const status = await api('/api/status');
    $('hub').textContent = '运行中';
    $('hub').className = 'v ok';
    $('messages').textContent = status.stats?.messages ?? 0;
    $('pending').textContent = status.stats?.pendingReports ?? 0;
    const qq = status.adapters?.qqUia;
    $('sessions').textContent = qq?.sessions ?? 0;
    $('sessions').className = 'v ' + (qq?.status === 'ready' ? 'ok' : 'bad');
  } catch (err) {
    $('hub').textContent = '不可用';
    $('hub').className = 'v bad';
    msg(err.message);
  }
}

async function loadSessions() {
  const body = $('rows');
  body.innerHTML = '<tr><td colspan="5" class="muted">加载中…</td></tr>';
  try {
    const data = await api('/api/qq/sessions');
    const sessions = data.sessions || [];
    if (!sessions.length) {
      body.innerHTML = '<tr><td colspan="5" class="muted">没有读到会话。请用启动器重启 QQ（无障碍模式），并确认 QQ 已登录。</td></tr>';
      return;
    }
    body.innerHTML = sessions.map((s, i) =>
      '<tr>' +
      '<td class="name">' + esc(s.name) + '</td>' +
      '<td class="muted">' + esc(s.time) + '</td>' +
      '<td class="preview">' + esc((s.sender ? s.sender + '：' : '') + s.preview) + '</td>' +
      '<td class="' + (s.unread ? 'unread' : 'muted') + '">' + (s.unread || '') + '</td>' +
      '<td><button data-i="' + i + '">读取</button></td>' +
      '</tr>'
    ).join('');
    for (const btn of body.querySelectorAll('button[data-i]')) {
      btn.addEventListener('click', () => readGroup(sessions[Number(btn.dataset.i)], btn));
    }
  } catch (err) {
    body.innerHTML = '<tr><td colspan="5" class="bad">' + esc(err.message) + '</td></tr>';
  }
}

async function readGroup(session, btn) {
  btn.disabled = true; msg('读取 ' + session.name + ' …');
  try {
    const data = await api('/api/qq/read', { method: 'POST', body: JSON.stringify({ group: session.name, limit: 30 }) });
    $('output').textContent = (data.chatName || session.name) + '（' + data.count + ' 条）\n\n' +
      (data.messages || []).map((m) => (m.timestamp || '') + '  ' + m.sender + '：' + m.text).join('\n');
    msg('已读取 ' + data.count + ' 条');
    await loadSessions();
  } catch (err) {
    $('output').textContent = '读取失败：' + err.message;
    msg('读取失败');
  } finally {
    btn.disabled = false;
  }
}

$('refresh').addEventListener('click', () => { loadStatus(); loadSessions(); });
$('wechat').addEventListener('click', async (e) => {
  e.target.disabled = true; msg('正在截图并识别微信窗口…（窗口会短暂弹出）');
  try {
    const data = await api('/api/wechat/preview', { method: 'POST' });
    if (!data.ok) throw new Error(data.error || '识别失败');
    $('output').textContent = '微信窗口 OCR（' + data.chars + ' 字）\n截图：' + data.image + '\n\n' + data.text;
    msg('微信预览完成');
  } catch (err) { msg('微信预览失败：' + err.message); }
  finally { e.target.disabled = false; }
});
$('report').addEventListener('click', async (e) => {
  e.target.disabled = true; msg('生成中…');
  try {
    const now = Date.now();
    const data = await api('/api/reports', { method: 'POST', body: JSON.stringify({ since: new Date(now - 12 * 3600 * 1000).toISOString() }) });
    if (!data.created) { msg(data.message || '没有生成报告'); return; }
    msg('已生成待审报告');
    $('output').textContent = '待审报告：' + data.report.id + '\n' + (data.summary || '') + '\n\n审核：/review/' + data.report.id;
  } catch (err) { msg(err.message); }
  finally { e.target.disabled = false; }
});

loadStatus();
loadSessions();
</script>
</body>
</html>`;
}
