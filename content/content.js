// content.js — 弹幕过滤核心逻辑（MV3 content script）
// 读取存储中的屏蔽名单，对页面中的弹幕 DOM 进行实时过滤。

(function () {
  "use strict";

  const STORAGE_KEY = "df_settings";

  let settings = {
    enabled: true,
    blocked: [],
    disabledHosts: [],
  };

  // 站点专属弹幕选择器（命中后只在该站点使用，降低开销）
  const SITE_SELECTORS = {
    "douyu.com": [".Barrage-listItem", ".PlayerBarrage-item", ".danmaku-item"],
    "huya.com": [".barrage-item", ".live-game--barrage-item", ".player-barrage-item"],
    "bilibili.com": [
      ".bilibili-live-player-danmaku-item",
      ".bili-danmaku-x-dm",
      ".danmaku-item",
    ],
    "kuaishou.com": [".living-danmaku-item", ".player-danmaku-item"],
    "iqiyi.com": [".danmaku-item", ".iqp-danmaku-item"],
    "youku.com": [".danmaku-item", ".yk-danmaku-item"],
    "qq.com": [".danmaku-item", ".txp-danmaku-item"],
    "weibo.com": [".danmaku-item", ".WB_danmaku"],
    "douyin.com": [".xg-danmaku-item", ".danmaku-item"],
    "toutiao.com": [".danmaku-item"],
  };

  // 通用兜底选择器（仅在未命中站点专属规则时使用）
  const GENERIC_SELECTORS = [
    '[class*="danmaku" i]',
    '[class*="barrage" i]',
    '[class*="bullet" i]',
    '[class*="dm-item" i]',
    '[data-*="danmaku" i]',
  ];

  let blockedNormalized = [];
  let scanScheduled = false;
  let hostDisabled = false;

  function normalize(str) {
    return (str || "")
      .toLowerCase()
      .replace(/[\s　-]/g, "")
      .replace(/[^\p{L}\p{N}]/gu, "");
  }

  function loadBlocked() {
    blockedNormalized = (settings.blocked || []).map(normalize).filter(Boolean);
  }

  function currentHost() {
    try {
      return new URL(location.href).hostname;
    } catch (e) {
      return location.hostname || "";
    }
  }

  function isActive() {
    if (!settings.enabled) return false;
    const host = currentHost();
    if ((settings.disabledHosts || []).some((h) => host.includes(h))) return false;
    return blockedNormalized.length > 0;
  }

  function getSelectors() {
    const host = currentHost();
    for (const key in SITE_SELECTORS) {
      if (host.includes(key)) return SITE_SELECTORS[key];
    }
    return GENERIC_SELECTORS;
  }

  function collectCandidates() {
    const selectors = getSelectors();
    const list = [];
    for (const sel of selectors) {
      try {
        const nodes = document.querySelectorAll(sel);
        for (const n of nodes) list.push(n);
      } catch (e) {
        /* 个别选择器语法问题，忽略 */
      }
    }
    return list;
  }

  // 归一化后判断单段文本是否包含任一被屏蔽人名（子串匹配）
  function matchesBlocked(text) {
    const norm = normalize(text);
    if (!norm) return false;
    for (const b of blockedNormalized) {
      if (norm.includes(b)) return true;
    }
    return false;
  }

  // 校验某个弹幕 DOM 元素：只要它自身或其任意后代文本节点包含被屏蔽人名，
  // 即认为该条弹幕命中 -> 整条屏蔽。遍历后代可避免"名字在子节点、textContent 混入其它文字"导致漏判。
  function elementMatchesBlocked(el) {
    if (!el) return false;
    if (matchesBlocked(el.textContent || "")) return true;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      if (matchesBlocked(node.nodeValue || "")) return true;
    }
    return false;
  }

  // 回查被命中弹幕对应的原始屏蔽人名（用于统计展示），与 inject.js matchedName 逻辑一致
  function matchedBlockedName(text) {
    const norm = normalize(text);
    if (!norm) return "";
    for (let i = 0; i < blockedNormalized.length; i++) {
      if (norm.includes(blockedNormalized[i])) {
        return (settings.blocked && settings.blocked[i]) || "";
      }
    }
    return "";
  }

  function applyFilter() {
    if (!isActive()) {
      restoreAll();
      return;
    }
    const candidates = collectCandidates();
    for (const el of candidates) {
      if (el.hasAttribute("data-df-hidden")) continue;
      // 命中规则：弹幕文本包含任一被屏蔽人名 -> 整条屏蔽
      if (elementMatchesBlocked(el)) {
        el.setAttribute("data-df-hidden", "1");
        el.classList.add("df-hidden"); // content.css: display:none !important 整条移除
        // 内联 !important 兜底：部分站点对自身弹幕元素设了 display:...!important，
        // 会盖过 class 样式；内联 !important 优先级更高，确保整条弹幕被移除。
        try {
          el.style.setProperty("display", "none", "important");
          el.style.setProperty("visibility", "hidden", "important");
        } catch (e) {}

        // 记录被屏蔽内容：本地留一份（无 inject.js 的站点也能看统计），
        // 同时桥接到 inject.js（主世界）以便与 B 站 Canvas/Worker 路径统一展示
        try {
          const txt = (el.textContent || "").trim().slice(0, 200);
          if (txt) {
            const nm = matchedBlockedName(txt);
            const vt = getVideoTimeLocal();
            recordLocalBlock(txt, nm, vt);
            window.postMessage(
              { __dfType: "dfblocked", text: txt, name: nm, vt: vt },
              "*"
            );
          }
        } catch (e) {}
      }
    }
  }

  function restoreAll() {
    const hidden = document.querySelectorAll('[data-df-hidden="1"]');
    hidden.forEach((el) => {
      el.removeAttribute("data-df-hidden");
      el.classList.remove("df-hidden");
      // 清除内联兜底样式，恢复站点原始展示
      try {
        el.style.removeProperty("display");
        el.style.removeProperty("visibility");
      } catch (e) {}
    });
    // 恢复后立刻按当前设置重新应用，避免已隐藏弹幕残留/复现
    if (isActive()) applyFilter();
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    (window.requestAnimationFrame || setTimeout)(() => {
      scanScheduled = false;
      applyFilter();
    });
  }

  let observer = null;
  function setupObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver(() => scheduleScan());
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  // ===== 本地屏蔽统计（DOM 过滤路径；无 inject.js 的站点靠它显示统计）=====
  const LOCAL_LOG = [];
  const LOCAL_FREQ = {};
  let localBlockedTotal = 0;

  function getVideoTimeLocal() {
    try {
      const v = document.querySelector("video");
      return v && isFinite(v.currentTime) ? v.currentTime : 0;
    } catch (e) {
      return 0;
    }
  }

  function recordLocalBlock(text, name, vt) {
    LOCAL_LOG.push({ t: Date.now(), text: text, name: name || "", vt: vt || 0 });
    if (LOCAL_LOG.length > 200) LOCAL_LOG.shift();
    if (name) LOCAL_FREQ[name] = (LOCAL_FREQ[name] || 0) + 1;
    localBlockedTotal++;
  }

  // ===== 跨世界桥接 =====
  // inject.js 运行在主世界(MAIN)，拿不到 chrome.storage / chrome.runtime。
  // 本文件运行在隔离世界，持有扩展 API，因此充当两个方向的中转：
  //   设置：storage → postMessage("dfsettings") → inject.js
  //   统计：popup → runtime.onMessage → postMessage("dfstats-req") → inject.js → "dfstats-res" → popup
  function broadcastSettings() {
    try {
      window.postMessage({ __dfType: "dfsettings", settings: settings }, "*");
    } catch (e) {}
  }

  function setupBridge() {
    window.addEventListener("message", (e) => {
      if (e.source !== window) return;
      const d = e.data;
      if (d && d.__dfType === "dfsettings-req") broadcastSettings();
    });

    const rt = (typeof browser !== "undefined" && browser.runtime) || chrome.runtime;
    if (!rt || !rt.onMessage || !rt.onMessage.addListener) return;
    rt.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.type !== "DF_GET_STATS") return false;
      const id = "df" + Date.now() + "_" + Math.random().toString(36).slice(2);
      let done = false;
      // all_frames:true 下每个 iframe 都会收到 popup 的查询。空数据的子框架若抢先应答，
      // 会把真正有数据的主框架结果顶掉，故子框架只在确实有统计时才回应。
      const isTop = window.top === window;
      const hasData = (p) =>
        !!(p && p.stats && p.stats.blockedTotal) ||
        !!(p && p.log && p.log.length);

      const onRes = (e) => {
        if (e.source !== window) return;
        const d = e.data;
        if (!d || d.__dfType !== "dfstats-res" || d.id !== id) return;
        done = true;
        window.removeEventListener("message", onRes);
        if (!isTop && !hasData(d.payload)) return;
        try {
          sendResponse(d.payload);
        } catch (err) {}
      };
      window.addEventListener("message", onRes);
      try {
        window.postMessage({ __dfType: "dfstats-req", id: id }, "*");
      } catch (err) {}
      // 该页没有 inject.js（非 B 站/测试站）时无人应答 → 回退到本地 DOM 统计
      setTimeout(() => {
        if (done) return;
        window.removeEventListener("message", onRes);
        if (!isTop && !localBlockedTotal) return;
        try {
          sendResponse({
            stats: { blockedTotal: localBlockedTotal },
            log: LOCAL_LOG.slice(-50),
            freq: LOCAL_FREQ,
          });
        } catch (err) {}
      }, 300);
      return true; // 异步响应
    });
  }

  function loadSettings(cb) {
    const api = (typeof browser !== "undefined" && browser.storage) || chrome.storage;
    api.local.get(STORAGE_KEY, (res) => {
      const saved = (res && res[STORAGE_KEY]) || {};
      settings = Object.assign(
        { enabled: true, blocked: [], disabledHosts: [] },
        saved
      );
      loadBlocked();
      if (cb) cb();
    });
  }

  function init() {
    if (window.__dfInited) return; // 防止重复注入导致观察者/定时器叠加
    window.__dfInited = true;

    setupBridge(); // 先建桥，才能接住 inject.js 早期发来的 dfsettings-req

    loadSettings(() => {
      broadcastSettings(); // 主世界的 inject.js 依赖这次推送才拿得到名单
      setupObserver();
      applyFilter();
      // 周期性兜底扫描（应对异步渲染/Canvas 外层 DOM 变化）
      setInterval(applyFilter, 1200);
    });

    // 监听设置变化（popup 修改后立即生效）
    // 修复：此前误用 api.local.onChanged，其回调签名为 (changes) 且无 area 参数，
    // 导致 area === "local" 恒为 false，改名单后页面不会实时生效。
    const api = (typeof browser !== "undefined" && browser.storage) || chrome.storage;
    const onSettingsChanged = (saved) => {
      settings = Object.assign(
        { enabled: true, blocked: [], disabledHosts: [] },
        saved || {}
      );
      loadBlocked();
      broadcastSettings(); // 同步给主世界，B 站 Worker/Canvas 路径立即换名单
      applyFilter();
    };
    if (api.onChanged && api.onChanged.addListener) {
      api.onChanged.addListener((changes, area) => {
        if (area === "local" && changes && changes[STORAGE_KEY]) {
          onSettingsChanged(changes[STORAGE_KEY].newValue);
        }
      });
    } else if (api.local.onChanged && api.local.onChanged.addListener) {
      api.local.onChanged.addListener((changes) => {
        if (changes && changes[STORAGE_KEY]) {
          onSettingsChanged(changes[STORAGE_KEY].newValue);
        }
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
