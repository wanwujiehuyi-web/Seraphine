/**
 * DSH 插件：group-digest 的会话侧唤醒器。
 *
 * 职责只有两件：
 *   1. 轮询 Hub 的未投递通知（待审报告、重点用户提醒、投递结果、调度错误），
 *      把每条渲染成一段提示注入指定会话；
 *   2. 可选地在 Hub 没跑时把它拉起来（detached，DSH 退出后继续采集）。
 *
 * 投递机制照抄 DSH 自身 dsh-schedule 与 qq-mcp-bridge/waker 的做法：
 *   resolveAgent(sessionId) → agent.followup(message) → ctx.sessions.flush()
 *
 * 本文件刻意不 import 任何 @deepseek-ai/* 包：插件从 profile 目录加载，
 * 那里的 Node 解析不到 DSH 内部包。只用内置模块 + 绝对路径。
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const name = 'group-digest-waker';

export const inject = ['sessionController', 'sessions'];

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

export function createInjectedMessage(text) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'webhook' },
  });
}

export function resolveTargetSession(configArray, config, bridgeDir) {
  const file =
    config.sessionFile ??
    (bridgeDir ? path.join(bridgeDir, 'state', 'target-session.txt') : null);
  if (file) {
    try {
      const first = fs
        .readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      if (first) return first;
    } catch {
      /* 文件不存在则退回配置 */
    }
  }
  return config.sessionId ?? null;
}

/** 把一条通知渲染成给模型看的提示。 */
export function renderNotification(notification, { hubUrl, token } = {}) {
  const payload = notification.payload ?? {};
  const lines = [];
  const reviewUrl =
    payload.reportId && hubUrl
      ? `${hubUrl}/review/${payload.reportId}?token=${encodeURIComponent(token ?? '')}`
      : null;

  if (notification.type === 'report_pending') {
    lines.push('【群聊情报 · 待审核报告】');
    lines.push('');
    lines.push(`报告：${notification.title.replace(/^待审核报告：/, '')}`);
    lines.push(`报告 ID：${payload.reportId}`);
    if (payload.filePath) lines.push(`文件：${payload.filePath}`);
    if (reviewUrl) lines.push(`审核页面：${reviewUrl}`);
    lines.push('');
    lines.push(notification.body ?? '');
    lines.push('');
    lines.push('下一步：把要点和审核链接给用户，等用户明确说「批准/发吧」。');
    lines.push('用户批准后才调用 mcp__group__group_report_approve（confirmed=true）；');
    lines.push('不要自行批准或发送。要改内容就先 group_reports action=update，再等批准。');
  } else if (notification.type === 'follow_alert') {
    lines.push('【群聊情报 · 重点用户发言】');
    lines.push('');
    lines.push(notification.body || notification.title);
    lines.push('');
    lines.push('（如需查看上下文：group_messages，按 chatId + userId 过滤。）');
  } else if (notification.type === 'report_delivered') {
    lines.push('【群聊情报 · 报告已投递】');
    lines.push('');
    lines.push(notification.body || notification.title);
  } else if (notification.type === 'report_delivery_failed') {
    lines.push('【群聊情报 · 报告投递失败】');
    lines.push('');
    lines.push(notification.body || notification.title);
    lines.push('');
    lines.push('排查外发配置（QQ/微信通道）后，可让用户决定是否重试。');
  } else if (notification.type === 'scheduler_error') {
    lines.push('【群聊情报 · 定时任务失败】');
    lines.push('');
    lines.push(notification.body || notification.title);
  } else {
    lines.push(`【群聊情报 · ${notification.title}】`);
    lines.push('');
    lines.push(notification.body ?? '');
  }

  lines.push('');
  lines.push('（本消息由 group-digest 自动注入，无需回复本条系统提示。）');
  return lines.join('\n');
}

function healthUrl(hubUrl) {
  return `${hubUrl.replace(/\/+$/, '')}/health`;
}

async function isHubUp(hubUrl) {
  try {
    const res = await fetch(healthUrl(hubUrl), { signal: AbortSignal.timeout(1200) });
    if (!res.ok) return false;
    const data = await res.json();
    return data?.name === 'group-digest';
  } catch {
    return false;
  }
}

async function api(hubUrl, token, method, pathname, body) {
  const res = await fetch(`${hubUrl.replace(/\/+$/, '')}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Hub 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`);
  }
  if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
  return json;
}

export async function apply(ctx, config) {
  const log = (message) =>
    ctx.logger?.info ? ctx.logger.info(`[group-digest] ${message}`) : console.log(`[group-digest] ${message}`);
  const warn = (message) =>
    ctx.logger?.warn ? ctx.logger.warn(`[group-digest] ${message}`) : console.warn(`[group-digest] ${message}`);

  const hubUrl = String(config.hubUrl ?? 'http://127.0.0.1:8791').replace(/\/+$/, '');
  const token = String(config.token ?? '');
  if (!token) throw new Error('group-digest-waker: 必须配置 token（与 config.json 的 server.token 一致）');

  const sessionFile = config.sessionFile ?? null;
  const sessionId = config.sessionId ?? null;
  const resolveSession = () => resolveTargetSession(null, { sessionFile, sessionId }, null);
  if (!resolveSession()) {
    throw new Error(
      `group-digest-waker: 无法确定目标会话 —— 请设置 config.sessionId，或把会话 ID 写进 ${sessionFile ?? 'sessionFile'}`,
    );
  }

  // 启动 Hub（可选）。已经在跑就什么都不做。
  let startedHub = false;
  if (!(await isHubUp(hubUrl))) {
    if (config.autoStart && config.hubEntry) {
      try {
        // 注意：DSH 桌面端里 process.execPath 是 Electron 可执行文件，
        // 直接用它跑 JS 会再开一个应用实例。这里显式用 PATH 里的 node。
        const child = spawn(config.nodePath ?? 'node', [config.hubEntry], {
          cwd: path.dirname(config.hubEntry),
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: {
            ...process.env,
            ...(config.configPath ? { GROUPDIGEST_CONFIG: config.configPath } : {}),
          },
        });
        child.unref();
        startedHub = true;
        for (let i = 0; i < 30; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          if (await isHubUp(hubUrl)) break;
        }
        if (await isHubUp(hubUrl)) log(`已启动 Hub：${hubUrl}`);
        else warn(`Hub 启动超时，先继续；稍后自动重试（${hubUrl}）`);
      } catch (err) {
        warn(`拉起 Hub 失败：${err.message}`);
      }
    } else {
      warn(`Hub 未运行且未启用 autoStart（${hubUrl}）；通知轮询会空转。`);
    }
  } else {
    log(`Hub 已在运行：${hubUrl}`);
  }

  const deliver = async (text) => {
    const target = resolveSession();
    const resolved = await ctx.sessionController.resolveAgent(target);
    if (resolved && 'error' in resolved) throw resolved.error;
    const message = createInjectedMessage(text);
    resolved.agent.followup(message);
    if (typeof ctx.sessions?.flush === 'function') {
      const ok = await ctx.sessions.flush(resolved.agent.session);
      if (!ok) throw new Error('会话 flush 未被确认');
    }
    return message;
  };

  let stopped = false;
  let delivering = false;
  let lastDownLog = 0;

  const poll = async () => {
    if (stopped || delivering) return;
    delivering = true;
    try {
      if (!(await isHubUp(hubUrl))) {
        if (Date.now() - lastDownLog > 300_000) {
          lastDownLog = Date.now();
          warn(`Hub 不可达，等待恢复：${hubUrl}`);
        }
        return;
      }
      const result = await api(hubUrl, token, 'GET', '/api/notifications?limit=10');
      const notifications = result?.notifications ?? [];
      if (!notifications.length) return;

      const deliveredIds = [];
      const staleIds = [];
      for (const notification of notifications.slice(0, 5)) {
        // 报告可能已经在本会话里被批准/驳回；不要再把旧的「待审核」提醒推进去。
        if (notification.type === 'report_pending') {
          const reportId = notification.payload?.reportId;
          let stillPending = false;
          if (reportId) {
            try {
              const report = await api(hubUrl, token, 'GET', `/api/reports/${encodeURIComponent(reportId)}`);
              stillPending = report?.status === 'pending';
            } catch {
              stillPending = false;
            }
          }
          if (!stillPending) {
            staleIds.push(notification.id);
            log(`跳过过期通知 #${notification.id}（报告 ${reportId ?? '?'} 已不是待审核）`);
            continue;
          }
        }
        const text = renderNotification(notification, { hubUrl, token });
        try {
          await deliver(text);
          deliveredIds.push(notification.id);
          log(`已注入通知 #${notification.id}（${notification.type}）`);
        } catch (err) {
          warn(`注入通知 #${notification.id} 失败：${err.message}`);
        }
      }
      const settled = [...new Set([...deliveredIds, ...staleIds])];
      if (settled.length) {
        await api(hubUrl, token, 'POST', '/api/notifications/delivered', { ids: settled });
      }
    } catch (err) {
      warn(`轮询失败：${err.message}`);
    } finally {
      delivering = false;
    }
  };

  const pollMs = Math.max(5000, Number(config.pollMs ?? 20000));
  const timer = setInterval(poll, pollMs);
  timer.unref?.();
  ctx.effect(
    () => () => {
      stopped = true;
      clearInterval(timer);
      log(`已停止（${startedHub ? 'Hub 继续保持后台运行' : '未启动 Hub'}）`);
    },
    'group-digest-waker.poll',
  );

  // 启动后先跑一次，但错开 DSH 自己的启动高峰。
  setTimeout(() => poll().catch((err) => warn(`首次轮询失败：${err.message}`)), 2500).unref?.();
  log(`已启用。目标会话：${resolveSession()}，轮询间隔 ${pollMs}ms`);
}
