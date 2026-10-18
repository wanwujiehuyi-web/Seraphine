#!/usr/bin/env node
/**
 * 微信收发中继（参考实现，无第三方依赖）。
 *
 * 作用：把「读微信」和「发微信」这两个必须依赖具体自动化库的动作，
 * 收敛成两个 HTTP 接口，其余全部交给 group-digest Hub：
 *
 *   你的采集器 ──POST /ingest──> 中继 ──> Hub /api/ingest/wechat
 *   Hub ──POST /send（报告批准后）──> 中继 ──> WECHAT_SEND_CMD（stdin 传文本）
 *
 * 启动：
 *   $env:GROUPDIGEST_TOKEN='<config.json 里的 server.token>'
 *   $env:WECHAT_SEND_CMD='python send_wechat.py'   # 可选，从 stdin 读文本
 *   node bridges/wechat-relay.mjs
 *
 * 然后把 config.json 的 delivery.wechat.sendUrl 指到 http://127.0.0.1:8899/send。
 *
 * ⚠️ 只监听 127.0.0.1。不要把中继暴露到公网，也不要把微信桥装到不信任的机器上。
 */

import { spawn } from 'node:child_process';
import http from 'node:http';

const PORT = Number(process.env.RELAY_PORT ?? 8899);
const HUB_URL = (process.env.GROUPDIGEST_URL ?? 'http://127.0.0.1:8791').replace(/\/+$/, '');
const HUB_TOKEN = process.env.GROUPDIGEST_TOKEN ?? '';
const RELAY_TOKEN = process.env.RELAY_TOKEN ?? HUB_TOKEN;
const SEND_CMD = process.env.WECHAT_SEND_CMD ?? '';
const SEND_TIMEOUT_MS = Number(process.env.WECHAT_SEND_TIMEOUT_MS ?? 20000);

if (!HUB_TOKEN) {
  console.error('缺少 GROUPDIGEST_TOKEN（config.json 的 server.token）');
  process.exit(1);
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`JSON 解析失败：${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

function authorized(req) {
  if (!RELAY_TOKEN) return true;
  const header = req.headers.authorization ?? '';
  if (header === `Bearer ${RELAY_TOKEN}`) return true;
  return req.headers['x-relay-token'] === RELAY_TOKEN;
}

/** 调外部命令发送文本：文本走 stdin，避免命令行转义问题。 */
function runSendCommand(text) {
  return new Promise((resolve) => {
    const child = spawn(SEND_CMD, {
      shell: true,
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, error: `发送命令超时（${SEND_TIMEOUT_MS}ms）` });
    }, SEND_TIMEOUT_MS);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: `发送命令退出码 ${code}：${stderr.slice(0, 300)}` });
    });
    child.stdin.end(text, 'utf8');
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true, name: 'wechat-relay', sendConfigured: Boolean(SEND_CMD) });
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { error: '缺少或错误的 token' });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/ingest') {
      const payload = await readJson(req);
      const upstream = await fetch(`${HUB_URL}/api/ingest/wechat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${HUB_TOKEN}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      const text = await upstream.text();
      res.writeHead(upstream.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(text);
      console.log(`[relay] ingest → Hub HTTP ${upstream.status}`);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/send') {
      const payload = await readJson(req);
      const text = String(payload.text ?? '');
      if (!text) {
        sendJson(res, 400, { error: 'text 不能为空' });
        return;
      }
      console.log(
        `[relay] send → ${payload.to ?? '(默认)'} report=${payload.reportId ?? '-'} chars=${text.length}`,
      );
      if (!SEND_CMD) {
        console.log('----- 待发送内容 -----');
        console.log(text);
        console.log('----------------------');
        sendJson(res, 200, { ok: true, note: '未配置 WECHAT_SEND_CMD，仅打印' });
        return;
      }
      const result = await runSendCommand(text);
      if (result.ok) sendJson(res, 200, { ok: true });
      else sendJson(res, 502, { error: result.error });
      return;
    }

    sendJson(res, 404, { error: '未知路径' });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[relay] 微信中继：http://127.0.0.1:${PORT}`);
  console.log(`[relay] Hub：${HUB_URL}`);
  console.log(`[relay] 发送命令：${SEND_CMD ? SEND_CMD : '（未配置，只打印）'}`);
  console.log('[relay] 采集器请 POST /ingest，Hub 会 POST /send。');
});
