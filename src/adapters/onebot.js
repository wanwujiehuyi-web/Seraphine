/**
 * OneBot 11 适配器（正向 WebSocket 客户端）。
 *
 * 适用于 NapCat / Lagrange.OneBot / LLOneBot 等实现了 OneBot 11 的 QQ 桥。
 * 它负责两件事：
 *   1. 接收群/私聊消息事件，交给 Ingest 入库；
 *   2. 通过同一连接调用 OneBot API（get_group_list / get_group_member_list /
 *      send_group_msg / send_private_msg 等），供主动拉取群资料或外发使用。
 *
 * 连接参数里的 access_token 走查询串（NapCat 支持 `?access_token=`），
 * 因为 Node 内置 WebSocket 的握手头注入在不同版本上不一致，查询串最稳。
 */

export class OneBotError extends Error {
  constructor(message, { action, retcode, data } = {}) {
    super(message);
    this.name = 'OneBotError';
    this.action = action;
    this.retcode = retcode;
    this.data = data;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class OneBotAdapter {
  #cfg;
  #log;
  #onEvent;
  #onReady;
  #ws = null;
  #closed = true;
  #reconnectTimer = null;
  #attempts = 0;
  #pending = new Map();
  #echoSeq = 0;
  #status = 'idle';
  #lastEventAt = null;
  #selfId = null;
  #eventCount = 0;
  #createSocket;

  constructor({ config, log = () => {}, onEvent, onReady, createSocket }) {
    this.#cfg = config;
    this.#log = log;
    this.#onEvent = onEvent;
    this.#onReady = onReady;
    this.#createSocket = createSocket ?? ((url) => new WebSocket(url));
  }

  get status() {
    return this.#status;
  }

  get connected() {
    return this.#ws !== null && this.#ws.readyState === 1;
  }

  get stats() {
    return {
      status: this.#status,
      connected: this.connected,
      url: this.#safeUrl(),
      selfId: this.#selfId,
      lastEventAt: this.#lastEventAt,
      eventCount: this.#eventCount,
      pendingCalls: this.#pending.size,
    };
  }

  #safeUrl() {
    try {
      const url = new URL(this.#cfg.url);
      url.searchParams.delete('access_token');
      return url.toString();
    } catch {
      return this.#cfg.url;
    }
  }

  start() {
    this.#closed = false;
    this.#attempts = 0;
    this.#connect();
  }

  async #connect() {
    if (this.#closed) return;
    const base = String(this.#cfg.url ?? '').trim();
    if (!base) {
      this.#status = '未配置 url';
      this.#log('OneBot 未配置 url，跳过连接');
      return;
    }
    this.#status = 'connecting';
    let url = base;
    try {
      if (this.#cfg.accessToken) {
        const u = new URL(base);
        u.searchParams.set('access_token', this.#cfg.accessToken);
        url = u.toString();
      }
    } catch {
      this.#status = `url 非法：${base}`;
      this.#log(`OneBot url 非法：${base}`);
      return;
    }

    this.#log(`OneBot 连接 ${this.#safeUrl()}`);
    let ws;
    try {
      ws = this.#createSocket(url);
    } catch (err) {
      this.#status = `连接失败：${err.message}`;
      this.#scheduleReconnect();
      return;
    }
    this.#ws = ws;

    ws.addEventListener('open', () => {
      this.#attempts = 0;
      this.#status = 'ready';
      this.#log('OneBot 已连接');
      try {
        this.#onReady?.();
      } catch (err) {
        this.#log(`OneBot onReady 回调异常：${err.message}`);
      }
    });

    ws.addEventListener('message', (event) => {
      let payload;
      try {
        payload = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        this.#log('OneBot 收到非 JSON 数据，已忽略');
        return;
      }
      this.#handlePayload(payload);
    });

    ws.addEventListener('error', (event) => {
      this.#status = `错误：${event?.message ?? '未知'}`;
      this.#log(`OneBot 连接错误：${event?.message ?? '未知'}`);
    });

    ws.addEventListener('close', (event) => {
      if (this.#ws === ws) this.#ws = null;
      this.#rejectPending(new OneBotError(`OneBot 连接已断开（code=${event?.code ?? '?'}）`));
      if (this.#closed) {
        this.#status = 'closed';
        return;
      }
      this.#status = `closed(${event?.code ?? '?'})`;
      this.#log(`OneBot 连接断开 code=${event?.code ?? '?'}，准备重连`);
      this.#scheduleReconnect();
    });
  }

  #handlePayload(payload) {
    if (payload && payload.post_type) {
      this.#lastEventAt = new Date().toISOString();
      this.#eventCount += 1;
      if (payload.post_type === 'meta_event') {
        if (payload.meta_event_type === 'lifecycle' && payload.self_id) {
          this.#selfId = String(payload.self_id);
        }
        return;
      }
      try {
        this.#onEvent?.(payload);
      } catch (err) {
        this.#log(`OneBot 事件处理异常：${err.message}`);
      }
      return;
    }

    if (payload && payload.echo !== undefined) {
      const waiter = this.#pending.get(String(payload.echo));
      if (!waiter) return;
      this.#pending.delete(String(payload.echo));
      clearTimeout(waiter.timer);
      if (payload.status === 'failed' || (payload.retcode !== undefined && payload.retcode !== 0)) {
        waiter.reject(
          new OneBotError(`OneBot API 失败：${payload.wording ?? payload.message ?? '未知错误'}`, {
            action: waiter.action,
            retcode: payload.retcode,
            data: payload.data,
          }),
        );
      } else {
        waiter.resolve(payload.data);
      }
    }
  }

  /** 调用 OneBot API；未连接时直接失败，由调用方决定降级。 */
  call(action, params = {}, { timeoutMs = 15000 } = {}) {
    if (!this.connected) {
      return Promise.reject(new OneBotError('OneBot 未连接，无法调用 API', { action }));
    }
    const echo = `g${++this.#echoSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(echo);
        reject(new OneBotError(`OneBot API 超时（${timeoutMs}ms）`, { action }));
      }, timeoutMs);
      this.#pending.set(echo, { resolve, reject, timer, action });
      try {
        this.#ws.send(JSON.stringify({ action, params, echo }));
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(echo);
        reject(new OneBotError(`OneBot 发送失败：${err.message}`, { action }));
      }
    });
  }

  /** 拉取群列表，用来补全群名。失败不致命。 */
  async syncGroupList() {
    try {
      const data = await this.call('get_group_list');
      if (!Array.isArray(data)) return [];
      return data.map((group) => ({
        chatId: String(group.group_id ?? group.groupId ?? ''),
        name: String(group.group_name ?? group.groupName ?? ''),
        memberCount: Number(group.member_count ?? 0),
      }));
    } catch (err) {
      this.#log(`拉取群列表失败（不影响收消息）：${err.message}`);
      return [];
    }
  }

  async sendGroupMessage(groupId, text) {
    return this.call('send_group_msg', { group_id: Number(groupId) || groupId, message: text });
  }

  async sendPrivateMessage(userId, text) {
    return this.call('send_private_msg', { user_id: Number(userId) || userId, message: text });
  }

  #rejectPending(error) {
    for (const waiter of this.#pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#pending.clear();
  }

  #scheduleReconnect() {
    if (this.#closed || this.#reconnectTimer) return;
    this.#attempts += 1;
    const delay = Math.min((this.#cfg.reconnectMs ?? 3000) * 2 ** (this.#attempts - 1), 60000);
    this.#status = `等待重连（${delay}ms）`;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
    this.#reconnectTimer.unref?.();
  }

  async stop() {
    this.#closed = true;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#rejectPending(new OneBotError('OneBot 适配器已停止'));
    try {
      this.#ws?.close();
    } catch {
      /* 忽略 */
    }
    this.#ws = null;
    this.#status = 'closed';
    await sleep(0);
  }
}
