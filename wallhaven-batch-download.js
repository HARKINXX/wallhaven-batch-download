// ==UserScript==
// @name         Wallhaven 批量下载原图
// @namespace    local.wallhaven.batch
// @version      5.0
// @description  下载 wallhaven.cc 列表页的高清原图：可设数量上限/翻页页数/下载子目录，并自动跳过已下过的壁纸
// @author       doubao
// @match        https://wallhaven.cc/*
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @connect      wallhaven.cc
// @connect      w.wallhaven.cc
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  if (document.querySelectorAll('figure.thumb').length === 0) return;

  const CFG_KEY = 'wh_dl_cfg_v4';
  const DONE_KEY = 'wh_dl_done_v4';
  const RESUME_KEY = 'wh_dl_resume_v4';
  const POS_KEY = 'wh_dl_pos_v5';
  const DELAY = 600;
  const RESUME_TTL = 10 * 60 * 1000;
  const DONE_LIMIT = 10000;

  const DEFAULTS = { count: 0, pages: 0, dir: '', skipDone: true, logCollapsed: false };

  function loadCfg() {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(CFG_KEY) || '{}')); }
    catch (e) { return Object.assign({}, DEFAULTS); }
  }
  function saveCfg(c) {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch (e) {}
  }

  /* ---------------------------------------------------------------- *
   * 去重记录：id -> 下载时间戳，存在 localStorage
   * ---------------------------------------------------------------- */
  function loadDone() {
    try {
      const obj = JSON.parse(localStorage.getItem(DONE_KEY) || '{}');
      const m = new Map();
      Object.keys(obj).forEach(k => m.set(k, obj[k]));
      return m;
    } catch (e) { return new Map(); }
  }
  const doneMap = loadDone();

  function saveDone() {
    try {
      const obj = {};
      doneMap.forEach((v, k) => { obj[k] = v; });
      localStorage.setItem(DONE_KEY, JSON.stringify(obj));
      return true;
    } catch (e) {
      log('去重记录写入失败（本地存储可能已满），本次仍会继续下载', 'warn');
      return false;
    }
  }

  function markDone(id) {
    doneMap.set(id, Date.now());
    if (doneMap.size > DONE_LIMIT) {
      // 超出上限时丢掉最早的记录
      const keys = Array.from(doneMap.keys());
      const excess = doneMap.size - DONE_LIMIT;
      for (let i = 0; i < excess; i++) doneMap.delete(keys[i]);
    }
    saveDone();
  }

  function clearDone() {
    doneMap.clear();
    try { localStorage.removeItem(DONE_KEY); } catch (e) {}
  }

  /* ---------------------------------------------------------------- *
   * 条目采集
   * ---------------------------------------------------------------- */
  function collectItems() {
    const list = [];
    document.querySelectorAll('figure.thumb').forEach(fig => {
      const a = fig.querySelector('a.preview');
      if (!a) return;
      const id = (fig.dataset && fig.dataset.wallpaperId) ||
                 (a.getAttribute('href') || '').split('/').filter(Boolean).pop();
      if (!id) return;
      const resEl = fig.querySelector('.wall-res');
      const m = (resEl ? resEl.textContent : '').match(/(\d+)\s*[x×]\s*(\d+)/);
      list.push({ id, pageUrl: a.href, res: m ? `${m[1]}x${m[2]}` : '' });
    });
    return list;
  }

  /* ---------------------------------------------------------------- *
   * 详情页 -> 原图直链
   * ---------------------------------------------------------------- */
  function gmGet(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 20000,
        headers: { Referer: 'https://wallhaven.cc/' },
        onload: r => (r.status >= 200 && r.status < 400)
          ? resolve(r.responseText || '')
          : reject(new Error('HTTP ' + r.status)),
        onerror: () => reject(new Error('网络错误')),
        ontimeout: () => reject(new Error('请求超时'))
      });
    });
  }

  function extractFullUrl(html) {
    let doc = null;
    try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch (e) {}
    if (doc) {
      const img = doc.querySelector('#wallpaper');
      const src = img && img.getAttribute('src');
      if (src) return new URL(src, 'https://wallhaven.cc').href;
    }
    const m = html.match(/<img[^>]*id="wallpaper"[^>]*src="([^"]+)"/i) ||
              html.match(/<img[^>]*src="([^"]+)"[^>]*id="wallpaper"/i) ||
              html.match(/src="(https:\/\/w\.wallhaven\.cc\/full\/[^"]+)"/i);
    return m ? m[1] : null;
  }

  /* ---------------------------------------------------------------- *
   * 下载位置（相对 Edge 默认下载目录的子路径）
   * ---------------------------------------------------------------- */
  function sanitizeDir(raw) {
    let d = String(raw || '').trim().replace(/\\/g, '/');
    let absolute = false;
    if (/^[a-zA-Z]:\//.test(d)) { absolute = true; d = d.replace(/^[a-zA-Z]:\//, ''); }
    d = d.replace(/^\/+|\/+$/g, '');
    const segs = d.split('/')
      .map(s => s.replace(/[<>:"|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim())
      .filter(s => s && s !== '.' && s !== '..')
      .slice(0, 4);
    return { dir: segs.join('/'), absolute };
  }

  function extOf(url) {
    const m = (url || '').match(/\.(jpe?g|png|webp|gif|bmp)(?:$|\?)/i);
    return m ? m[1].toLowerCase() : 'jpg';
  }

  /* ---------------------------------------------------------------- *
   * 下载
   * ---------------------------------------------------------------- */
  function download(full, nameWithDir) {
    return new Promise(resolve => {
      let settled = false;
      const finish = v => { if (!settled) { settled = true; resolve(v); } };

      if (typeof GM_download === 'function') {
        try {
          GM_download({
            url: full,
            name: nameWithDir,
            saveAs: false,
            onload: () => finish('ok'),
            onerror: e => finish('err:' + ((e && e.error) || 'download_failed')),
            ontimeout: () => finish('err:timeout')
          });
          return;
        } catch (e) { /* 走回退 */ }
      }

      fetch(full, { credentials: 'omit' })
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
        .then(blob => {
          const u = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = u;
          a.download = nameWithDir.split('/').pop();
          a.style.display = 'none';
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(u), 15000);
          finish('ok');
        })
        .catch(e => finish('err:' + (e && e.message)));
    });
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ---------------------------------------------------------------- *
   * 界面
   * ---------------------------------------------------------------- */
  const style = document.createElement('style');
  style.textContent = `
  #wh-panel{position:fixed;right:16px;bottom:16px;z-index:2147483000;width:282px;
    background:#1b1f27;color:#e8ecf3;border:1px solid #333c4a;border-radius:10px;
    box-shadow:0 8px 28px rgba(0,0,0,.45);font:12px/1.6 "Segoe UI",system-ui,sans-serif;
    overflow:hidden;user-select:none}
  #wh-panel header{display:flex;align-items:center;justify-content:space-between;
    padding:8px 10px;background:#232a35;font-weight:600;font-size:12.5px;
    cursor:move;touch-action:none}
  #wh-panel header button{background:none;border:0;color:#9aa7b8;cursor:pointer;font-size:14px}
  #wh-body{padding:10px}
  #wh-panel.hide #wh-body{display:none}
  .wh-f{display:flex;align-items:center;gap:6px;margin-bottom:7px;color:#c7d2e0}
  .wh-f>span:first-child{flex:1}
  .wh-f input[type=text],.wh-f input[type=number]{background:#11151b;border:1px solid #3a4454;
    color:#e8ecf3;border-radius:5px;padding:2px 6px;font-size:12px;min-width:0}
  .wh-f input[type=number]{width:64px}
  .wh-f input[type=text]{flex:1}
  .wh-f input[type=checkbox]{accent-color:#4c8dff;margin:0}
  .wh-hint{font-size:10.5px;color:#66748a;margin:-2px 0 8px}
  .wh-sep{height:1px;background:#2b3341;margin:8px 0 7px}
  #wh-clear{width:100%;margin-top:2px;padding:4px 0;border-radius:6px;border:1px solid #3a4454;
    background:transparent;color:#8a97a8;cursor:pointer;font-size:11px}
  #wh-clear:hover{color:#e8ecf3;border-color:#55627a}
  .wh-b{display:flex;gap:8px;margin-top:8px}
  .wh-b button{flex:1;padding:6px 0;border-radius:6px;border:1px solid #3a4454;
    background:#2b3442;color:#e8ecf3;cursor:pointer;font-size:12px;font-weight:600}
  .wh-b button#wh-go{background:#3b82f6;border-color:#3b82f6}
  .wh-b button#wh-stop{flex:0 0 62px}
  .wh-b button:disabled{opacity:.45;cursor:not-allowed}
  #wh-status{font-size:11.5px;color:#9fb0c4;margin-top:7px;word-break:break-all;min-height:16px}
  #wh-logbar{display:flex;align-items:center;gap:4px;margin-top:7px;padding-top:5px;
    border-top:1px solid #2b3341;font-size:11px;color:#8a97a8;cursor:pointer}
  #wh-logbar .wh-count{color:#5f6d82}
  #wh-logbar .wh-arrow{margin-left:auto;transform:rotate(90deg);transition:transform .15s;color:#7c8a9d}
  #wh-logbar.collapsed .wh-arrow{transform:rotate(0deg)}
  #wh-log{max-height:88px;overflow:auto;margin-top:2px;font-size:11px;color:#8a97a8;display:none}
  #wh-log div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #wh-log div.err{color:#ff8080}
  #wh-log div.warn{color:#e0b050}`;
  document.head.appendChild(style);

  const panel = document.createElement('div');
  panel.id = 'wh-panel';
  panel.innerHTML = `
    <header><span>Wallhaven 批量下载</span><button id="wh-min">—</button></header>
    <div id="wh-body">
      <div class="wh-f"><span>下载数量</span>
        <input id="wh-count" type="number" min="0" step="1" title="0 = 不限"> 张</div>
      <div class="wh-hint">0 = 不限，跨页累计</div>
      <div class="wh-f"><span>翻页次数</span>
        <input id="wh-pages" type="number" min="0" step="1" title="0 = 只下当前页"> 页</div>
      <div class="wh-hint">0 = 只下本页；N = 再往后翻 N 页</div>
      <div class="wh-f"><span>下载到</span>
        <input id="wh-dir" type="text" placeholder="子目录，如 wallpaper/4k"></div>
      <div class="wh-hint">相对 Edge 默认下载目录，留空 = 默认目录</div>
      <div class="wh-sep"></div>
      <div class="wh-f"><label><input id="wh-skip" type="checkbox"> 跳过已下载过的壁纸</label></div>
      <button id="wh-clear">清空去重记录（0 张）</button>
      <div class="wh-b">
        <button id="wh-go">开始下载</button>
        <button id="wh-stop" disabled>停止</button>
      </div>
      <div id="wh-status">就绪</div>
      <div id="wh-logbar"><span>下载记录</span><span class="wh-count" id="wh-logcount"></span><span class="wh-arrow">▸</span></div>
      <div id="wh-log"></div>
    </div>`;
  document.body.appendChild(panel);

  const $ = id => panel.querySelector('#' + id);
  const elCount = $('wh-count'), elPages = $('wh-pages'), elDir = $('wh-dir'),
        elSkip = $('wh-skip'), elClear = $('wh-clear'),
        elGo = $('wh-go'), elStop = $('wh-stop'),
        elStatus = $('wh-status'), elLog = $('wh-log'),
        elLogBar = $('wh-logbar'), elLogCount = $('wh-logcount');

  $('wh-min').addEventListener('click', () => panel.classList.toggle('hide'));

  function status(t) { elStatus.textContent = t; }

  let logCollapsed = false;

  function applyLogState() {
    elLog.style.display = logCollapsed || elLog.children.length === 0 ? 'none' : 'block';
    elLogBar.classList.toggle('collapsed', logCollapsed);
    elLogCount.textContent = elLog.children.length ? `（${elLog.children.length}）` : '';
  }

  function log(text, kind) {
    const d = document.createElement('div');
    if (kind) d.className = kind;
    d.textContent = text;
    elLog.appendChild(d);
    elLog.scrollTop = elLog.scrollHeight;
    while (elLog.children.length > 60) elLog.removeChild(elLog.firstChild);
    applyLogState();
  }
  function refreshClearLabel() {
    elClear.textContent = `清空去重记录（${doneMap.size} 张）`;
  }

  /* ---------------------------------------------------------------- *
   * 设置读写
   * ---------------------------------------------------------------- */
  const saved = loadCfg();
  elCount.value = saved.count || '';
  elPages.value = saved.pages || '';
  elDir.value = saved.dir || '';
  elSkip.checked = saved.skipDone !== false;
  logCollapsed = saved.logCollapsed === true;
  refreshClearLabel();
  applyLogState();

  // 下载记录：点标题栏收起 / 展开
  elLogBar.addEventListener('click', () => {
    logCollapsed = !logCollapsed;
    applyLogState();
    saveCfg(Object.assign(readSettings(), { logCollapsed }));
  });

  /* ---------------------------------------------------------------- *
   * 浮窗拖动（位置会记住）
   * ---------------------------------------------------------------- */
  function placePanel(left, top) {
    const maxL = Math.max(0, window.innerWidth - panel.offsetWidth - 4);
    const maxT = Math.max(0, window.innerHeight - 38);
    const l = Math.min(Math.max(0, left), maxL);
    const t = Math.min(Math.max(0, top), maxT);
    panel.style.left = l + 'px';
    panel.style.top = t + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    return { left: l, top: t };
  }

  try {
    const p = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    if (p && typeof p.left === 'number' && typeof p.top === 'number') {
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.left = p.left + 'px';
      panel.style.top = p.top + 'px';
      requestAnimationFrame(() => placePanel(p.left, p.top));
    }
  } catch (e) {}

  const headerEl = panel.querySelector('header');
  let drag = null;

  headerEl.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;   // 别干扰收起面板按钮
    const r = panel.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false };
    placePanel(r.left, r.top);
    headerEl.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  window.addEventListener('pointermove', e => {
    if (!drag) return;
    drag.moved = true;
    placePanel(e.clientX - drag.dx, e.clientY - drag.dy);
  });

  window.addEventListener('pointerup', () => {
    if (!drag) return;
    headerEl.style.cursor = '';
    document.body.style.userSelect = '';
    if (drag.moved) {
      try {
        localStorage.setItem(POS_KEY, JSON.stringify({
          left: panel.offsetLeft, top: panel.offsetTop
        }));
      } catch (e) {}
    }
    drag = null;
  });

  // 窗口尺寸变化时把面板拉回可视区
  window.addEventListener('resize', () => {
    if (panel.style.left) placePanel(panel.offsetLeft, panel.offsetTop);
  });

  function readSettings() {
    const cfg = {
      count: Math.max(0, parseInt(elCount.value, 10) || 0),
      pages: Math.max(0, parseInt(elPages.value, 10) || 0),
      dir: sanitizeDir(elDir.value).dir,
      skipDone: elSkip.checked,
      logCollapsed
    };
    saveCfg(cfg);
    return cfg;
  }

  elClear.addEventListener('click', () => {
    if (doneMap.size === 0) { status('去重记录本来就是空的'); return; }
    if (!confirm(`确定清空 ${doneMap.size} 条“已下载”记录？\n清空后这些壁纸会被认为没下载过，可能重新下载一遍。`)) return;
    clearDone();
    refreshClearLabel();
    status('去重记录已清空');
  });

  /* ---------------------------------------------------------------- *
   * 运行
   * ---------------------------------------------------------------- */
  const S = { running: false, ok: 0, fail: 0, skip: 0, stopped: false, total: 0, budget: -1, dir: '' };

  async function run(resume) {
    if (S.running) return;

    const cfg = readSettings();
    const rawDir = elDir.value;
    const budget = resume ? resume.budget : (cfg.count > 0 ? cfg.count : -1);
    const pagesLeft = resume ? resume.pages : cfg.pages;
    const dir = resume ? resume.dir : cfg.dir;

    if (sanitizeDir(rawDir).absolute) {
      log('提示：扩展无法写入绝对路径，已改为默认下载目录下的子目录；改盘符请到 edge://settings/downloads', 'warn');
    }

    S.running = true;
    S.stopped = false;
    S.ok = 0; S.fail = 0; S.skip = 0;
    S.budget = budget;
    S.dir = dir;

    // 去重过滤
    let all = collectItems();
    let items = all;
    if (cfg.skipDone && !resume) {
      items = all.filter(it => {
        if (doneMap.has(it.id)) { S.skip++; return false; }
        return true;
      });
    }
    // 额度截断
    if (S.budget > 0) items = items.slice(0, S.budget);
    S.total = items.length;

    elGo.disabled = true; elStop.disabled = false;

    const budgetText = S.budget > 0 ? `上限 ${S.budget} 张` : '不限量';
    const pageText = pagesLeft > 0 ? `再翻 ${pagesLeft} 页` : '只下本页';
    const skipText = S.skip > 0 ? `，跳过已下过 ${S.skip} 张` : '';
    status(`本页 ${all.length} 张${skipText}，本次入选 ${S.total} 张（${budgetText}｜${pageText}）`);

    if (S.total === 0) {
      S.running = false;
      elGo.disabled = false; elStop.disabled = true;
      status(S.skip > 0
        ? `本页 ${S.skip} 张都已下载过，没有新壁纸可下`
        : '本页没有可下载的条目');
      return;
    }

    for (let i = 0; i < items.length; i++) {
      if (S.stopped || S.budget === 0) break;
      const it = items[i];

      status(`[${i + 1}/${S.total}] 解析原图地址 ${it.id} ...`);
      let full = null;
      try {
        full = extractFullUrl(await gmGet(it.pageUrl));
      } catch (e) {
        S.fail++; log(`✗ ${it.id} 详情页失败：${e.message}`, 'err'); continue;
      }
      if (!full) {
        S.fail++; log(`✗ ${it.id} 取不到原图（需登录的受限内容）`, 'err'); continue;
      }

      const base = `wallhaven-${it.id}${it.res ? '-' + it.res : ''}.${extOf(full)}`;
      const nameWithDir = dir ? dir + '/' + base : base;

      status(`[${i + 1}/${S.total}] 下载 ${base} ...`);
      const r = await download(full, nameWithDir);

      if (r === 'ok') {
        S.ok++;
        if (S.budget > 0) S.budget--;
        markDone(it.id);          // 成功即记账，中途关掉页面也不会丢
        refreshClearLabel();
        log('✓ ' + (dir ? dir + '/' : '') + base);
      } else {
        S.fail++;
        log(`✗ ${base} ${r}`, 'err');
      }

      status(`进度 ${S.ok + S.fail}/${S.total} ｜ 成功 ${S.ok} ｜ 失败 ${S.fail}` +
             (S.budget >= 0 ? ` ｜ 剩 ${S.budget} 张额度` : ''));
      await sleep(DELAY + Math.random() * 200);
    }

    S.running = false;
    elGo.disabled = false; elStop.disabled = true;

    const doneMsg = `本页结束：成功 ${S.ok}，失败 ${S.fail}${S.skip ? `，跳过 ${S.skip}` : ''}`;
    status(doneMsg + (S.stopped ? '（已手动停止）' : '') + (S.budget === 0 ? '（已达数量上限）' : ''));
    log(doneMsg);

    // 继续翻页
    if (!S.stopped && S.budget !== 0 && pagesLeft > 0) {
      const next = document.querySelector('a[rel="next"]');
      if (!next || !next.href) {
        status('已经是最后一页了');
        try { sessionStorage.removeItem(RESUME_KEY); } catch (e) {}
        return;
      }
      try {
        sessionStorage.setItem(RESUME_KEY, JSON.stringify({
          budget: S.budget, pages: pagesLeft - 1, dir, ts: Date.now()
        }));
      } catch (e) {}
      status(`3 秒后翻到下一页（还剩 ${pagesLeft - 1} 次翻页）...`);
      setTimeout(() => { location.href = next.href; }, 3000);
    } else {
      try { sessionStorage.removeItem(RESUME_KEY); } catch (e) {}
    }
  }

  elGo.addEventListener('click', () => {
    elLog.textContent = '';
    applyLogState();
    run(null);
  });
  elStop.addEventListener('click', () => {
    S.stopped = true;
    elStop.disabled = true;
    status('正在停止（当前这张完成后停止）...');
  });

  /* 翻页后自动接着跑 */
  try {
    const raw = sessionStorage.getItem(RESUME_KEY);
    if (raw) {
      const st = JSON.parse(raw);
      if (st && Date.now() - (st.ts || 0) < RESUME_TTL) {
        sessionStorage.removeItem(RESUME_KEY);
        status('延续上一次的翻页任务，3 秒后开始 ...');
        setTimeout(() => { elLog.textContent = ''; run(st); }, 3000);
      }
    }
  } catch (e) {}

  document.addEventListener('keydown', e => {
    if (e.altKey && (e.key === 'q' || e.key === 'Q')) panel.classList.toggle('hide');
  });
})();
