#!/usr/bin/env node
/**
 * 极简 OneBot 11 服务端模拟器（正向 WebSocket）。
 *
 * 用途：没有 NapCat/Lagrange 时，也能端到端验证
 *   OneBot 事件 → Hub 入库 → 摘要 → 报告 → 日程
 *
 * 启动：node test/onebot-simulator.js
 * 然后：node src/hub.js
 *
 * 它会在 127.0.0.1:3001 监听（可用 PORT 覆盖），连接后：
 *   - 回复 get_group_list / get_group_member_list 等只读 API
 *   - 每 1.2 秒推送一条演示群消息
 *   - 收到 send_group_msg / send_private_msg 时打印到终端
 *
 * 只实现 text / close / ping 帧，够用即可。
 */

import crypto from 'node:crypto';
import http from 'node:http';

import { demoMessages } from '../fixtures/demo.js';

const PORT = Number(process.env.PORT ?? 3001);
const STEP_MS = Number(process.env.STEP_MS ?? 1200);
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const sockets = new Set();

function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const length = data.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, data]);
}

function sendJson(socket, value) {
  try {
    socket.write(encodeFrame(JSON.stringify(value)));
  } catch {
    /* 连接可能已断 */
  }
}

/** 解析客户端发来的帧（客户端帧一定带 mask）。 */
function createParser(onText, onClose) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const first = buffer[0];
      const second = buffer[1];
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLength = masked ? 4 : 0;
      if (buffer.length < offset + maskLength + length) return;
      let payload = buffer.subarray(offset + maskLength, offset + maskLength + length);
      if (masked) {
        const mask = buffer.subarray(offset, offset + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      }
      buffer = buffer.subarray(offset + maskLength + length);
      if (opcode === 0x8) {
        onClose();
        return;
      }
      if (opcode === 0x9) {
        // ping → pong 由外层 socket 处理，这里忽略
        continue;
      }
      if (opcode === 0x1) onText(payload.toString('utf8'));
    }
  };
}

const server = http.createServer((req, res) => {
  res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('这是 OneBot WebSocket 模拟器，请用 WebSocket 连接。\n');
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'),
  );
  sockets.add(socket);
  console.log(`[sim] 客户端已连接（当前 ${sockets.size} 个）`);

  let messageId = 10_000;
  let groupSeq = 0;
  const groups = [
    { group_id: 900001, group_name: '模拟 · 算法竞赛群', member_count: 8 },
    { group_id: 900002, group_name: '模拟 · 项目组', member_count: 5 },
  ];

  const send = (event) => sendJson(socket, event);

  send({
    post_type: 'meta_event',
    meta_event_type: 'lifecycle',
    sub_type: 'connect',
    time: Math.floor(Date.now() / 1000),
    self_id: 999999,
  });

  const queue = demoMessages(Date.now());
  const timer = setInterval(() => {
    if (queue.length === 0) return;
    const item = queue.shift();
    // 保留演示文案与发送者，但群 ID 换成模拟群，时间改为现在。
    const groupId = item.chatId.includes('project') ? 900002 : 900001;
    groupSeq += 1;
    send({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      time: Math.floor(Date.now() / 1000),
      self_id: 999999,
      group_id: groupId,
      group_name: groups.find((g) => g.group_id === groupId).group_name,
      user_id: Number(item.senderId),
      message: [{ type: 'text', data: { text: item.text } }],
      raw_message: item.text,
      message_id: messageId++,
      sender: {
        user_id: Number(item.senderId),
        nickname: item.senderName,
        card: item.senderName,
        role: item.senderRole ?? 'member',
      },
    });
    console.log(`[sim] → ${item.senderName}: ${item.text.slice(0, 40)}`);
  }, STEP_MS);

  const cleanup = () => {
    clearInterval(timer);
    sockets.delete(socket);
    console.log(`[sim] 客户端断开（剩余 ${sockets.size} 个）`);
  };

  socket.on(
    'data',
    createParser(
      (text) => {
        let request;
        try {
          request = JSON.parse(text);
        } catch {
          return;
        }
        const { action, echo, params } = request;
        console.log(`[sim] API ${action} ${JSON.stringify(params ?? {})}`);
        if (action === 'get_group_list') {
          sendJson(socket, { status: 'ok', retcode: 0, data: groups, echo });
        } else if (action === 'get_group_member_list') {
          sendJson(socket, {
            status: 'ok',
            retcode: 0,
            data: [
              { user_id: 10001, nickname: '队长', card: '队长', role: 'owner' },
              { user_id: 10002, nickname: '指导老师', card: '指导老师', role: 'admin' },
            ],
            echo,
          });
        } else if (action === 'send_group_msg' || action === 'send_private_msg') {
          console.log(`[sim] ← 发送：${params?.message}`);
          sendJson(socket, { status: 'ok', retcode: 0, data: { message_id: messageId++ }, echo });
        } else {
          sendJson(socket, { status: 'ok', retcode: 0, data: null, echo });
        }
      },
      () => {
        cleanup();
        socket.end();
      },
    ),
  );
  socket.on('close', cleanup);
  socket.on('error', cleanup);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[sim] OneBot 模拟器：ws://127.0.0.1:${PORT}`);
  console.log('[sim] 把它填进 config.json 的 adapters.onebot.url，然后启动 Hub。');
});

process.on('SIGINT', () => {
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
});
