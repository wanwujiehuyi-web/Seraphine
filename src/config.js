/**
 * 配置加载与初始化。
 *
 * 配置优先级：环境变量 GROUPDIGEST_CONFIG 指定的文件 > 包根目录 config.json。
 * 除配置外，运行时只用 `storage.dir` 下的状态目录（数据库、报告、导出）。
 *
 * 所有对外展示的配置快照都必须经过 redactConfig()，避免把 QQ clientSecret /
 * Webhook token 回显给模型或写进日志。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function defaultConfigPath(env = process.env) {
  return env.GROUPDIGEST_CONFIG
    ? path.resolve(env.GROUPDIGEST_CONFIG)
    : path.join(PKG_ROOT, 'config.json');
}

export const DEFAULT_CONFIG = {
  version: 1,
  server: {
    host: '127.0.0.1',
    port: 8791,
    // 本机 API / Webhook 共用一个 token。生成的配置里会是随机值。
    token: '',
  },
  timezone: {
    // 只用固定偏移，不依赖系统时区；中国无夏令时，默认 +8。
    utcOffsetMinutes: 480,
    label: 'Asia/Shanghai',
  },
  storage: {
    dir: 'state',
  },
  adapters: {
    onebot: {
      enabled: false,
      // NapCat / Lagrange 的「正向 WebSocket」地址。
      url: 'ws://127.0.0.1:3001',
      accessToken: '',
      reconnectMs: 3000,
      // 可选：只接收这些群/用户（空数组 = 全部）。成员 ID 用字符串。
      includeGroups: [],
    },
    webhook: {
      enabled: true,
    },
    mock: {
      enabled: false,
    },
    // 直接读取已登录 QQ 的界面（需要 QQ 以 --force-renderer-accessibility 启动）。
    // 只读会话列表与当前聊天；打开指定群会标记该群已读。
    qqUia: {
      enabled: true,
      intervalMs: 5000,
      readCurrentChat: true,
      autoOpenUnread: false,
      // 留空则自动探测；用于启动器重启 QQ。
      qqPath: '',
      restartIfNeeded: true,
    },
    // 微信 4.x：屏幕 OCR 巡检。默认不扫描，直到用户在设置里勾选群。
    wechatOcr: {
      enabled: true,
      intervalMs: 120000,
    },
  },
  watch: {
    keywords: ['截止', '报名', '会议', '开会', '比赛', '答辩', '提交', 'ddl', 'DDL', '确认', '重要'],
    // 群默认全部纳入摘要；unwatch 的群会进 excludedGroups。
    excludedGroups: [],
    follows: [],
    includePrivate: false,
    // instant: 重点用户一说话就提醒；digest: 只在摘要中体现；off: 关闭。
    followAlerts: 'digest',
    followAlertDebounceMinutes: 10,
    // 用户自定义关注规则：{ name, pattern, type: 'keyword'|'regex', weight, note }
    customRules: [],
  },
  digest: {
    slots: ['09:00', '21:30'],
    lookbackHours: 12,
    maxKeyMessages: 40,
    topHighlights: 15,
    minMessages: 1,
    autoCreateReport: true,
    reportTitle: '群聊情报',
    // 新建报告时默认走的通道；审核通过后按此投递。
    channels: ['file', 'dsh'],
  },
  schedule: {
    enabled: true,
    lookaheadDays: 14,
    defaultDurationMinutes: 60,
    // 少于该置信度的事件不写进 ICS，只留在 Markdown 里。
    minConfidence: 0.5,
  },
  cache: {
    enabled: true,
    // 自动清理间隔：6 小时。
    intervalMs: 6 * 60 * 60 * 1000,
    // 微信 OCR 临时截图保留 24 小时，并最多保留最近 20 张。
    exportRetentionHours: 24,
    exportKeepLatest: 20,
    // 浏览器 Cache/Code Cache/GPUCache 只删 24 小时前的文件。
    browserCacheMaxAgeHours: 24,
  },
  delivery: {
    channels: ['file', 'dsh'],
    dsh: {
      enabled: true,
      // 报告批准后向 DSH 会话推送一条简短通知（完整正文在文件里）。
      notify: true,
    },
    qq: {
      enabled: false,
      appId: '',
      clientSecret: '',
      apiBase: 'https://api.bot.qq.com',
      // "latest" 表示自动用 qq-mcp-bridge/state/contacts.json 里最近活跃的 openid。
      userOpenId: 'latest',
      contactsFile: '',
      // 私聊消息长度上限，超出会截断并提示看完整文件。
      maxChars: 1800,
    },
    wechat: {
      enabled: false,
      // 由你的微信桥实现的发送接口：POST { to, text }。
      sendUrl: '',
      token: '',
      to: '',
      maxChars: 1500,
    },
  },
  review: {
    // 强制人工批准：为 true 时，report_approve 之外没有任何路径能触发外发。
    required: true,
    // 允许批准报告的人/标识，仅用于审计记录。
    approver: 'user',
  },
  notifications: {
    // 保留最近多少条通知。
    limit: 500,
  },
  launcher: {
    openBrowser: true,
  },
  logging: {
    level: 'info',
  },
};

/** 深合并：数组整体替换，对象递归。 */
function merge(base, patch) {
  if (Array.isArray(base) || Array.isArray(patch)) return patch === undefined ? base : patch;
  if (isPlainObject(base) && isPlainObject(patch)) {
    const out = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      out[key] = key in base ? merge(base[key], value) : value;
    }
    return out;
  }
  return patch === undefined ? base : patch;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function generateToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/** 读取配置文件；不存在时返回默认配置（不落盘）。 */
export function loadConfig(configPath = defaultConfigPath()) {
  if (!fs.existsSync(configPath)) {
    return { config: merge(DEFAULT_CONFIG, {}), configPath, exists: false };
  }
  const raw = fs.readFileSync(configPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`配置文件 ${configPath} 不是合法 JSON：${err.message}`);
  }
  return { config: normalizeConfig(merge(DEFAULT_CONFIG, parsed)), configPath, exists: true };
}

/** 补齐派生字段并做基本校验；不合法直接抛错，避免带病运行。 */
export function normalizeConfig(cfg) {
  const out = merge(DEFAULT_CONFIG, cfg);
  const offset = Number(out.timezone?.utcOffsetMinutes);
  if (!Number.isFinite(offset) || Math.abs(offset) > 840) {
    throw new Error('timezone.utcOffsetMinutes 必须是 -840..840 之间的分钟数');
  }
  out.timezone.utcOffsetMinutes = offset;

  const port = Number(out.server?.port);
  // 0 表示让系统分配临时端口（测试与嵌入式使用）。
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('server.port 必须是 0..65535 的整数（0 = 自动分配）');
  }
  out.server.port = port;
  out.server.host = String(out.server.host || '127.0.0.1');

  if (!Array.isArray(out.watch.keywords)) out.watch.keywords = [];
  if (!Array.isArray(out.watch.customRules)) out.watch.customRules = [];
  if (!Array.isArray(out.watch.follows)) out.watch.follows = [];
  if (!Array.isArray(out.watch.excludedGroups)) out.watch.excludedGroups = [];
  if (!Array.isArray(out.digest.slots)) out.digest.slots = [];
  out.digest.slots = out.digest.slots
    .map((s) => String(s).trim())
    .filter((s) => /^\d{1,2}:\d{2}$/.test(s))
    .map((s) => s.padStart(5, '0'));

  out.adapters.onebot.url = String(out.adapters.onebot.url || '');
  out.adapters.onebot.includeGroups = (out.adapters.onebot.includeGroups ?? []).map(String);

  return out;
}

/** 初始化：生成带随机 token 的 config.json（已存在则不覆盖）。 */
export function initConfig(configPath = defaultConfigPath()) {
  if (fs.existsSync(configPath)) {
    return { created: false, configPath };
  }
  const cfg = merge(DEFAULT_CONFIG, {});
  cfg.server.token = generateToken();
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  return { created: true, configPath };
}

export function saveConfig(cfg, configPath = defaultConfigPath()) {
  const normalized = normalizeConfig(cfg);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}

/** 状态目录与常用路径（全部相对包根，避免受 cwd 影响）。 */
export function resolvePaths(cfg, configPath = defaultConfigPath()) {
  const base = path.isAbsolute(cfg.storage.dir)
    ? cfg.storage.dir
    : path.resolve(path.dirname(configPath), cfg.storage.dir);
  return {
    base,
    db: path.join(base, 'hub.db'),
    reports: path.join(base, 'reports'),
    exports: path.join(base, 'exports'),
    logs: path.join(base, 'hub.log'),
    targetSession: path.join(base, 'target-session.txt'),
    pid: path.join(base, 'hub.pid'),
  };
}

export function ensureDirs(paths) {
  for (const key of ['base', 'reports', 'exports']) {
    fs.mkdirSync(paths[key], { recursive: true });
  }
}

const SECRET_KEYS = /secret|token|password|apptoken|accessToken/i;

/** 递归替换敏感字段，返回可安全展示的副本。 */
export function redactConfig(cfg) {
  function walk(value, key = '') {
    if (Array.isArray(value)) return value.map((v) => walk(v, key));
    if (isPlainObject(value)) {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        if (SECRET_KEYS.test(k) && typeof v === 'string' && v) {
          out[k] = `***（${v.length} 字符，已隐藏）`;
        } else {
          out[k] = walk(v, k);
        }
      }
      return out;
    }
    return value;
  }
  return walk(cfg);
}

/** 日志级别过滤。返回的函数本身可直接调用（默认 info），同时带级别方法。 */
export function createLogger({ level = 'info', file = null } = {}) {
  const order = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
  const threshold = order[level] ?? 20;
  let stream = null;
  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      stream = fs.createWriteStream(file, { flags: 'a' });
    } catch {
      stream = null;
    }
  }
  const write = (lvl, msg) => {
    if ((order[lvl] ?? 20) < threshold) return;
    const line = `${new Date().toISOString()} [${lvl}] ${msg}`;
    process.stderr.write(`[group-digest] ${line}\n`);
    try {
      stream?.write(`${line}\n`);
    } catch {
      /* 日志失败不影响主流程 */
    }
  };

  function logger(message) {
    write('info', message);
  }
  logger.debug = (m) => write('debug', m);
  logger.info = (m) => write('info', m);
  logger.warn = (m) => write('warn', m);
  logger.error = (m) => write('error', m);
  logger.close = () => stream?.end();
  return logger;
}
