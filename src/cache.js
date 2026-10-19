/**
 * 本地缓存清理：只动可再生成的缓存，不动消息库、报告、登录态。
 *
 * 目标：
 *   - state/exports 下微信 OCR 临时截图
 *   - state/browser-profile 下 Chromium 的 Cache/Code Cache/GPUCache 等
 *
 * 明确不碰：Cookies、Local Storage、History、Preferences、Login Data、
 * state/hub.db、state/reports、config.json。
 */

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_CACHE_CONFIG = {
  enabled: true,
  intervalMs: 6 * 60 * 60 * 1000,
  exportRetentionHours: 24,
  exportKeepLatest: 20,
  browserCacheMaxAgeHours: 24,
};

const BROWSER_CACHE_DIRS = [
  'Default/Cache',
  'Default/Code Cache',
  'Default/GPUCache',
  'Default/DawnGraphiteCache',
  'Default/DawnWebGPUCache',
  'Default/Service Worker/CacheStorage',
  'Default/Service Worker/ScriptCache',
  'Default/AutofillAiModelCache',
  'Default/optimization_guide_hint_cache_store',
];

function within(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function walkFiles(root, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function sizeOf(files) {
  let total = 0;
  for (const file of files) {
    try {
      total += fs.statSync(file).size;
    } catch {
      /* 文件可能已被浏览器删除 */
    }
  }
  return total;
}

function cacheFiles(paths) {
  const base = path.resolve(paths.base);
  const files = [];
  for (const rel of BROWSER_CACHE_DIRS) {
    const dir = path.join(base, 'browser-profile', rel);
    if (!within(base, dir)) continue;
    files.push(...walkFiles(dir));
  }
  return files;
}

export function cacheSummary({ paths }) {
  const exportsDir = path.join(paths.base, 'exports');
  const exportFiles = walkFiles(exportsDir);
  const browserFiles = cacheFiles(paths);
  return {
    exports: { files: exportFiles.length, bytes: sizeOf(exportFiles) },
    browserCache: { files: browserFiles.length, bytes: sizeOf(browserFiles) },
    totalBytes: sizeOf(exportFiles) + sizeOf(browserFiles),
  };
}

function readStats(paths) {
  try {
    return JSON.parse(fs.readFileSync(path.join(paths.base, 'cache-stats.json'), 'utf8'));
  } catch {
    return null;
  }
}

function writeStats(paths, value) {
  const file = path.join(paths.base, 'cache-stats.json');
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * 执行一次清理。返回可展示的统计；失败的文件跳过，不抛出。
 */
export function cleanupCache({ paths, config = {}, nowMs = Date.now(), log = () => {} } = {}) {
  const cfg = { ...DEFAULT_CACHE_CONFIG, ...(config.cache ?? {}) };
  if (cfg.enabled === false) {
    return { skipped: true, reason: 'cache.enabled=false' };
  }

  const startedAt = new Date(nowMs).toISOString();
  const removed = [];
  let freedBytes = 0;

  // 1) 微信 OCR 临时截图
  const exportsDir = path.join(paths.base, 'exports');
  const exportFiles = walkFiles(exportsDir).sort(
    (a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs,
  );
  const exportCutoff = nowMs - Math.max(1, Number(cfg.exportRetentionHours) || 24) * 3_600_000;
  const keepLatest = Math.max(0, Number(cfg.exportKeepLatest) || 0);
  for (let i = 0; i < exportFiles.length; i++) {
    const file = exportFiles[i];
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (i < keepLatest && stat.mtimeMs >= exportCutoff) continue;
    if (stat.mtimeMs >= exportCutoff) continue;
    try {
      fs.unlinkSync(file);
      removed.push(file);
      freedBytes += stat.size;
    } catch {
      /* 文件被占用，下次再试 */
    }
  }

  // 2) Chromium 可再生成的缓存目录
  const browserCutoff =
    nowMs - Math.max(1, Number(cfg.browserCacheMaxAgeHours) || 24) * 3_600_000;
  for (const file of cacheFiles(paths)) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (stat.mtimeMs >= browserCutoff) continue;
    try {
      fs.unlinkSync(file);
      removed.push(file);
      freedBytes += stat.size;
    } catch {
      /* 浏览器正在使用，跳过 */
    }
  }

  const summary = cacheSummary({ paths });
  const result = {
    at: startedAt,
    removedFiles: removed.length,
    freedBytes,
    summary,
    config: {
      exportRetentionHours: cfg.exportRetentionHours,
      exportKeepLatest: cfg.exportKeepLatest,
      browserCacheMaxAgeHours: cfg.browserCacheMaxAgeHours,
    },
  };
  writeStats(paths, result);
  log(`[cache] 清理 ${removed.length} 个文件，释放 ${freedBytes} 字节`);
  return result;
}

export function cacheStatus({ paths, config = {} } = {}) {
  const cfg = { ...DEFAULT_CACHE_CONFIG, ...(config.cache ?? {}) };
  const stored = readStats(paths);
  const summary = stored?.summary ?? cacheSummary({ paths });
  return {
    enabled: cfg.enabled !== false,
    intervalMs: cfg.intervalMs,
    retention: {
      exportRetentionHours: cfg.exportRetentionHours,
      exportKeepLatest: cfg.exportKeepLatest,
      browserCacheMaxAgeHours: cfg.browserCacheMaxAgeHours,
    },
    summary,
    lastCleanup: stored
      ? { at: stored.at, removedFiles: stored.removedFiles, freedBytes: stored.freedBytes }
      : null,
  };
}

/** hub 启动时挂定时器；返回 stop()。 */
export function startCacheCleaner({ paths, config, log = () => {}, intervalMs } = {}) {
  const cfg = { ...DEFAULT_CACHE_CONFIG, ...(config.cache ?? {}) };
  // 即使当前关闭也挂定时器：设置页重新开启后无需重启 Hub。
  const every = Math.max(60_000, Number(intervalMs) || Number(cfg.intervalMs) || DEFAULT_CACHE_CONFIG.intervalMs);
  let stopped = false;
  const run = () => {
    if (stopped) return;
    try {
      cleanupCache({ paths, config, log });
    } catch (err) {
      log(`[cache] 清理失败：${err.message}`);
    }
  };
  const timer = setInterval(run, every);
  timer.unref?.();
  const initial = setTimeout(run, 10_000);
  initial.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(initial);
  };
}
