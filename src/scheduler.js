/**
 * 定时摘要调度器。
 *
 * 行为：到点后只「创建待审报告」，绝不自动外发。每个时间槽用
 * `slot:<日期>:<HH:mm>` 记账，重启不会重复生成；错过的槽在追补窗口内
 * （默认 6 小时）会补一次，超过就跳过，避免一开机刷出一堆旧报告。
 */

import { fromLocal, formatDate, localParts, startOfLocalDay } from './util/time.js';

const TICK_MS = 30_000;

export class Scheduler {
  #config;
  #service;
  #log;
  #timer = null;
  #running = false;
  #now;

  constructor({ config, service, log = () => {}, now = () => Date.now() }) {
    this.#config = config;
    this.#service = service;
    this.#log = log;
    this.#now = now;
  }

  get slots() {
    return this.#config.digest.slots ?? [];
  }

  start() {
    if (this.#timer) return;
    this.tick().catch((err) => this.#log(`调度器首次检查失败：${err.message}`));
    this.#timer = setInterval(() => {
      this.tick().catch((err) => this.#log(`调度器检查失败：${err.message}`));
    }, TICK_MS);
    this.#timer.unref?.();
    this.#log(`调度器已启动，时间槽：${this.slots.join(', ') || '（未配置）'}`);
  }

  stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async tick() {
    if (this.#running) return;
    this.#running = true;
    try {
      const now = this.#now();
      const results = [];
      for (const slot of this.slots) {
        const result = await this.#maybeRunSlot(slot, now);
        if (result) results.push(result);
      }
      this.#service.store.setMeta('scheduler', {
        lastTickAt: new Date(now).toISOString(),
        slots: this.slots,
        lastResults: results,
      });
    } finally {
      this.#running = false;
    }
  }

  async #maybeRunSlot(slot, now) {
    const minutes = parseSlotMinutes(slot);
    if (minutes === null) return null;

    const offset = this.#config.timezone.utcOffsetMinutes;
    const parts = localParts(now, offset);
    const dayStart = startOfLocalDay(now, offset);
    const slotMs = dayStart + minutes * 60_000;
    if (now < slotMs) return null;

    const catchUpMs = Math.max(1, Number(this.#config.digest.catchUpHours) || 6) * 3_600_000;
    if (now - slotMs > catchUpMs) return null;

    const date = formatDate(slotMs, offset);
    const key = `slot:${date}:${slot}`;
    if (this.#service.store.getRun(key)) return null;

    try {
      const result = this.#service.createReport({
        nowMs: now,
        source: `slot:${slot}`,
        title: undefined,
      });
      if (result.created) {
        this.#service.store.setRun(key, { reportId: result.report.id, status: 'pending' });
        this.#log(`定时摘要已生成：${result.report.id}（${slot}）`);
        return { slot, reportId: result.report.id };
      }
      this.#service.store.setRun(key, { skipped: result.reason ?? 'not_created' });
      this.#log(`定时摘要跳过（${slot}）：${result.reason ?? '未创建'}`);
      return { slot, skipped: result.reason ?? 'not_created' };
    } catch (err) {
      // 不记账，下一轮还会重试；错误写进通知，避免静默失败。
      this.#log(`定时摘要失败（${slot}）：${err.message}`);
      this.#service.store.addNotification({
        type: 'scheduler_error',
        title: `定时摘要失败：${slot}`,
        body: err.message,
        payload: { slot },
      });
      return { slot, error: err.message };
    }
  }
}

export function parseSlotMinutes(slot) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(slot).trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/** 测试辅助：给定本地年月日与时刻，算 UTC 毫秒。 */
export function slotUtcMs({ year, month, day, hour, minute }, offsetMinutes) {
  return fromLocal({ year, month, day, hour, minute }, offsetMinutes);
}
