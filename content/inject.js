// content/inject.js — 注入页面主世界，拦截 B 站弹幕
//
// 架构（按“拦截点尽量靠前”原则，从「事后隐藏」改为「事前阻断」）：
//
//   弹幕请求(fetch/XHR)
//        ↓  [第 1 层 · 数据层] 拦截 seg.so(protobuf)/list.so(XML)，解析前整条剔除含屏蔽词弹幕
//   弹幕解析 / 入队（播放器内部 DanmakuEngine.add 等）
//        ↓  [第 2 层 · 逻辑层 · best-effort] 在弹幕进入渲染系统前判断并丢弃（hook 播放器 add/append）
//   渲染（Worker / Canvas）
//        ↓  [第 3 层 · 兜底] Canvas fillText / Worker 内 fetch+fillText —— 仅处理前两层漏掉的极少数路径
//
// 关键修复（相对旧版）：
//   1) 不再缓存初始的 fetch/XHR/Worker 引用。改用 getter/setter 自修复：页面若重新赋值 window.fetch，
//      新赋值会被自动包装，旧引用永远不会“失效”。这是「几秒后失效 / 拖动进度条失效」的根因之一。
//   2) 第 1 层在【Worker 内部】也包装 self.fetch，因此 B 站播放器在 Worker 里重新请求弹幕分段
//      （seek / 恢复 / 滚动加载）时，仍会在数据层被过滤，而不是等到 Canvas 绘制时才补刀。
//   3) 判定逻辑集中在 judge()/判定函数，与“如何渲染”解耦——未来可在此处替换为更丰富的语义判断，
//      而无需改动渲染层。
//
// 诊断：window.__DF_STATS 记录各层拦截计数，便于在仍失效时定位哪一层没兜住。

(function () {
  "use strict";

  // ===================== 纯函数（可在 Node 中单测）=====================

  function normalize(str) {
    return (str || "")
      .toLowerCase()
      .replace(/[　-]/g, "")
      .replace(/[^\p{L}\p{N}]/gu, "");
  }

  function walkFields(buf, start, end, cb) {
    let i = start;
    while (i < end) {
      const tagStart = i;
      let tag = 0,
        shift = 0,
        b;
      do {
        b = buf[i++];
        tag |= (b & 0x7f) << shift;
        shift += 7;
      } while (b & 0x80 && i < end);
      const fn = tag >>> 3;
      const wt = tag & 7;
      let vStart = i,
        vEnd = i,
        fieldEnd = i;
      if (wt === 0) {
        do {
          b = buf[i++];
        } while (b & 0x80 && i < end);
        fieldEnd = i;
        vStart = vEnd = i;
      } else if (wt === 1) {
        i += 8;
        fieldEnd = i;
        vStart = vEnd = i;
      } else if (wt === 5) {
        i += 4;
        fieldEnd = i;
        vStart = vEnd = i;
      } else if (wt === 2) {
        let len = 0,
          s = 0;
        do {
          b = buf[i++];
          len |= (b & 0x7f) << s;
          s += 7;
        } while (b & 0x80 && i < end);
        vStart = i;
        vEnd = i + len;
        i = vEnd;
        fieldEnd = vEnd;
      } else {
        break;
      }
      cb(fn, wt, tagStart, fieldEnd, vStart, vEnd);
    }
  }

  function elemContainsBlocked(buf, start, end, normalized, onHit) {
    let hit = false;
    let progressMs = 0; // 弹幕在视频中的时间（毫秒），对应 protobuf field 2
    const dec = new TextDecoder("utf-8");
    walkFields(buf, start, end, (fn, wt, ts, fe, vs, ve) => {
      // 提取 field 2(varint) = 弹幕进度（毫秒），用于「屏蔽弹幕在视频中的时间」展示
      if (fn === 2 && wt === 0) {
        let val = 0,
          shift = 0,
          p = ts + 1; // tag 为单字节 0x10
        while (p < fe) {
          const b = buf[p++];
          val |= (b & 0x7f) << shift;
          shift += 7;
        }
        progressMs = val;
      }
      if (hit) return;
      if (fn === 7 && wt === 2 && ve > vs) {
        const text = dec.decode(buf.subarray(vs, ve));
        const norm = normalize(text);
        for (const b of normalized) {
          if (norm.includes(b)) {
            hit = true;
            if (onHit) {
              try {
                onHit({ text: text, vt: progressMs / 1000 });
              } catch (e) {}
            }
            break;
          }
        }
      }
    });
    return hit;
  }

  function processDanmakuProtobuf(buf, blocked, onRemove) {
    const normalized = (blocked || []).map(normalize).filter(Boolean);
    if (!normalized.length) return buf;
    const kept = [];
    walkFields(buf, 0, buf.length, (fn, wt, tagStart, fieldEnd, vs, ve) => {
      if (fn === 1 && wt === 2) {
        if (
          elemContainsBlocked(buf, vs, ve, normalized, (info) => {
            if (onRemove) {
              try {
                onRemove(info);
              } catch (e) {}
            }
          })
        )
          return;
      }
      kept.push(buf.subarray(tagStart, fieldEnd));
    });
    let total = 0;
    for (const s of kept) total += s.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const s of kept) {
      out.set(s, off);
      off += s.length;
    }
    return out;
  }

  // XML 兜底（list.so 偶发 XML）。Worker 内无 DOMParser，故用正则路径。
  function filterXMLString(str, blocked, hasDOM) {
    const normalized = (blocked || []).map(normalize).filter(Boolean);
    if (!normalized.length) return str;
    if (hasDOM && typeof DOMParser !== "undefined") {
      const doc = new DOMParser().parseFromString(str, "application/xml");
      const ds = doc.getElementsByTagName("d");
      for (let i = ds.length - 1; i >= 0; i--) {
        const el = ds[i];
        const t = el.textContent || "";
        if (normalized.some((b) => normalize(t).includes(b))) {
          if (el.parentNode) el.parentNode.removeChild(el);
        }
      }
      return new XMLSerializer().serializeToString(doc);
    }
    return str.replace(/<d[^>]*>[\s\S]*?<\/d>/g, (m) =>
      normalized.some((b) => normalize(m).includes(b)) ? "" : m
    );
  }

  function isDanmakuUrl(u) {
    if (typeof u !== "string") return false;
    return (
      /api\.bilibili\.com\/.*\/dm\/.*\/seg\.so/.test(u) ||
      /api\.bilibili\.com\/.*\/dm\/list\.so/.test(u)
    );
  }

  // ===================== 浏览器引导 =====================

  function bootstrap() {
    if (typeof window === "undefined" || typeof chrome === "undefined") return;

    let CACHE = { enabled: true, blocked: [] };
    let NORM_BLOCKED = [];

    const STATS = (window.__DF_STATS = window.__DF_STATS || {
      net: 0, // 主线程数据层拦截次数
      netWorker: 0, // Worker 数据层拦截次数
      logic: 0, // 逻辑层（引擎 add）拦截次数
      mainHit: 0,
      mainTotal: 0,
      workerHit: 0,
      workerTotal: 0,
      refreshCount: 0, // 自愈式 refreshFilter() 执行次数
      scanHit: 0, // 扫描补偿机制隐藏的漏网弹幕数量
      blockedTotal: 0, // 累计屏蔽弹幕条数（供显示）
    });

    function applySettings(s) {
      if (!s || typeof s !== "object") return;
      const enabled = s.enabled !== false;
      const blocked = Array.isArray(s.blocked) ? s.blocked : CACHE.blocked || [];
      CACHE = { enabled, blocked };
      NORM_BLOCKED = blocked.map(normalize).filter(Boolean);
      if (typeof window.__dfPushBlockedToWorkers === "function") {
        window.__dfPushBlockedToWorkers();
      }
    }
    // ---- 设置获取：主世界(MAIN)拿不到 chrome.storage，必须经 content.js 桥接 ----
    // 关键修复：本脚本以 world:"MAIN" 注入页面主世界。页面里虽然存在 window.chrome 对象，
    // 但它【没有】storage / runtime.onMessage —— 扩展 API 只在隔离世界(ISOLATED)可用。
    // 旧代码直接 chrome.storage.local.get(...) 会抛：
    //   Uncaught TypeError: Cannot read properties of undefined (reading 'local')
    // 该异常发生在 bootstrap 早期，会中断后面所有 hook 安装 → 名单永远为空、统计也拿不到。
    // 现在：能用扩展 API 就直接用（Firefox 等情形），否则通过 postMessage 找 content.js 要。
    const HAS_EXT_STORAGE = !!(
      typeof chrome !== "undefined" &&
      chrome.storage &&
      chrome.storage.local &&
      typeof chrome.storage.local.get === "function"
    );

    let settingsReceived = false; // 是否已成功拿到设置（桥接或直读）
    let bridgeTries = 0;

    // 向隔离世界索要设置。content.js 在 document_idle 才运行，晚于本脚本(document_start)，
    // 故需重试（最多 ~20s），直到 content.js 上线并回传设置为止。
    function requestSettingsViaBridge() {
      if (settingsReceived || bridgeTries > 40) return;
      bridgeTries++;
      try {
        window.postMessage({ __dfType: "dfsettings-req" }, "*");
      } catch (e) {}
      setTimeout(requestSettingsViaBridge, 500);
    }

    function load() {
      if (HAS_EXT_STORAGE) {
        try {
          chrome.storage.local.get("df_settings", (r) => {
            settingsReceived = true;
            applySettings((r && r.df_settings) || {});
          });
          return;
        } catch (e) {}
      }
      requestSettingsViaBridge();
    }
    load();

    if (
      HAS_EXT_STORAGE &&
      chrome.storage.onChanged &&
      chrome.storage.onChanged.addListener
    ) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes.df_settings) {
          const nv = changes.df_settings.newValue;
          if (nv && typeof nv === "object") applySettings(nv);
        }
      });
    }

    // 统一判定：弹幕文本是否应被阻断（解耦渲染层，未来可替换为更丰富语义判断）
    function shouldFilter() {
      return CACHE.enabled && NORM_BLOCKED.length > 0;
    }
    function judge(text) {
      const n = normalize(text);
      if (!n) return false;
      for (let i = 0; i < NORM_BLOCKED.length; i++) {
        if (n.indexOf(NORM_BLOCKED[i]) >= 0) return true;
      }
      return false;
    }

    // 取当前视频播放进度（秒），用于「屏蔽弹幕在视频中的时间」展示；无视频时返回 0
    function getVideoTime() {
      try {
        const v = document.querySelector("video");
        if (
          v &&
          typeof v.currentTime === "number" &&
          isFinite(v.currentTime) &&
          v.currentTime > 0
        )
          return v.currentTime;
      } catch (e) {}
      return 0;
    }

    // ---- 屏蔽内容记录 + 频率统计（供「显示屏蔽成功的内容和频率」用）----
    const BLOCK_LOG = []; // 最近屏蔽的弹幕内容（含时间戳）
    const MAX_LOG = 200;
    const FREQ = Object.create(null); // 被屏蔽人名 -> 累计次数
    window.__DF_BLOCK_LOG = BLOCK_LOG; // 供控制台/调试读取
    window.__DF_FREQ = FREQ;
    function matchedName(text) {
      const n = normalize(text);
      if (!n) return "";
      for (let i = 0; i < NORM_BLOCKED.length; i++) {
        if (n.indexOf(NORM_BLOCKED[i]) >= 0) {
          // NORM_BLOCKED 与 CACHE.blocked 顺序对应，回查原始人名
          return (CACHE.blocked && CACHE.blocked[i]) || "";
        }
      }
      return "";
    }
    function recordBlock(text, name, vt) {
      if (!text) return;
      try {
        BLOCK_LOG.push({
          t: Date.now(),
          text: String(text).slice(0, 200),
          name: name || "",
          vt: typeof vt === "number" && isFinite(vt) && vt > 0 ? vt : 0,
        });
        if (BLOCK_LOG.length > MAX_LOG) BLOCK_LOG.shift();
        if (name) FREQ[name] = (FREQ[name] || 0) + 1;
        STATS.blockedTotal = (STATS.blockedTotal || 0) + 1;
      } catch (e) {}
    }

    const enc = new TextEncoder();
    const dec = new TextDecoder("utf-8");

    // 主线程数据层：把响应体按类型处理
    function processBufMain(buf, url) {
      if (url.indexOf("list.so") >= 0) {
        const out = enc.encode(filterXMLString(dec.decode(buf), CACHE.blocked, true));
        STATS.net++;
        return out;
      }
      const out = processDanmakuProtobuf(buf, CACHE.blocked, (info) => {
        try {
          recordBlock(info.text, matchedName(info.text), info.vt || getVideoTime());
        } catch (e) {}
      });
      STATS.net++;
      return out;
    }

    // ---------- 第 1 层 · 数据层：自修复 fetch/XHR（getter/setter，不缓存旧引用）----------

    // 读取对象在【原型链上】的原生 getter。
    // XHR 过滤必须靠它读原始响应：一旦在实例上 defineProperty 覆盖了
    // responseText/response，再写 x.responseText 读到的就是自己刚定义的 getter，
    // 会无限重入 → Maximum call stack size exceeded，页面所有脚本随之瘫痪。
    function nativeGetter(obj, name) {
      let p = Object.getPrototypeOf(obj);
      while (p) {
        const d = Object.getOwnPropertyDescriptor(p, name);
        if (d && typeof d.get === "function") return d.get;
        p = Object.getPrototypeOf(p);
      }
      return null;
    }

    function makeFetchWrapper(getReal) {
      const wrapper = function (input, init) {
        const real = getReal();
        let p;
        try {
          // fetch 对 this 敏感：绑到 window，避免 "Illegal invocation"
          p = real.call(this === undefined || this === wrapper ? window : this, input, init);
        } catch (e) {
          p = real(input, init);
        }
        if (!p || typeof p.then !== "function") return p;
        return p.then(async (resp) => {
          try {
            if (resp && isDanmakuUrl(resp.url) && shouldFilter()) {
              const buf = new Uint8Array(await resp.arrayBuffer());
              const out = processBufMain(buf, resp.url);
              const h = new Headers(resp.headers);
              h.delete("content-length");
              h.delete("content-encoding");
              return new Response(out, {
                status: resp.status,
                statusText: resp.statusText,
                headers: h,
              });
            }
          } catch (e) {}
          return resp;
        });
      };
      wrapper.__dfWrapped = true; // 幂等标记：防止 installAll 反复包装造成调用链无限加深
      return wrapper;
    }

    function makeXHRWrapper(getReal) {
      function PatchedXHR() {
        const Real = getReal();
        const x = new Real();

        // 原生 getter 必须在覆盖之前取好
        const rawText = nativeGetter(x, "responseText");
        const rawResp = nativeGetter(x, "response");
        function readRaw(kind) {
          const g = kind === "text" ? rawText : rawResp;
          if (!g) return undefined;
          try {
            return g.call(x);
          } catch (e) {
            return undefined;
          }
        }

        let url = "";
        let patched = false;
        let cacheText = null;
        let cacheBin = null;

        function getProcessed(kind) {
          const raw = readRaw(kind); // ← 关键：走原生 getter，绝不重入自己
          try {
            if (!isDanmakuUrl(url) || !shouldFilter()) return raw;
            if (kind === "text") {
              if (cacheText === null) {
                const t = raw == null ? "" : String(raw);
                cacheText =
                  url.indexOf("list.so") >= 0
                    ? filterXMLString(t, CACHE.blocked, true)
                    : t;
              }
              return cacheText;
            }
            if (cacheBin === null) {
              if (raw && typeof raw.byteLength === "number") {
                const out = processBufMain(new Uint8Array(raw), url);
                // 还原为 ArrayBuffer，保持与原生 responseType="arraybuffer" 一致
                const ab = new ArrayBuffer(out.length);
                new Uint8Array(ab).set(out);
                cacheBin = ab;
              } else {
                cacheBin = raw;
              }
            }
            return cacheBin;
          } catch (e) {
            return raw;
          }
        }
        // 只有确认是弹幕请求才覆盖响应属性。页面上绝大多数 XHR 因此保持原生行为，
        // 既避免误伤，也把风险面压到最小。
        function patchResponseProps() {
          if (patched) return;
          patched = true;
          [
            ["responseText", "text", rawText],
            ["response", "bin", rawResp],
          ].forEach(([prop, kind, g]) => {
            if (!g) return; // 拿不到原生 getter 就不碰，宁可不过滤也不能爆栈
            try {
              Object.defineProperty(x, prop, {
                configurable: true,
                enumerable: false,
                get() {
                  return getProcessed(kind);
                },
              });
            } catch (e) {}
          });
        }

        const oOpen = x.open;
        x.open = function () {
          url = String(arguments[1] == null ? "" : arguments[1]);
          if (isDanmakuUrl(url)) patchResponseProps();
          return oOpen.apply(x, arguments);
        };

        return x; // 构造函数返回对象 → new PatchedXHR() 即得到原生 x
      }
      PatchedXHR.__dfWrapped = true; // 幂等标记，防止包装层无限叠加
      try {
        // 保留原生静态常量与原型，页面里的 xhr instanceof XMLHttpRequest /
        // XMLHttpRequest.DONE 等用法才不会失效
        const Real0 = getReal();
        PatchedXHR.prototype = Real0.prototype;
        ["UNSENT", "OPENED", "HEADERS_RECEIVED", "LOADING", "DONE"].forEach((k) => {
          if (Real0[k] !== undefined) PatchedXHR[k] = Real0[k];
        });
      } catch (e) {}
      return PatchedXHR;
    }

    // 用 getter/setter 包装一个全局对象属性：无论页面何时重新赋值，都会被重新包装。
    // 这彻底解决了“缓存初始引用 → 页面重新赋值后 hook 失效”的问题。
    function defineSelfHealingHook(obj, prop, makeWrapper) {
      if (obj == null || typeof obj[prop] === "undefined") return false;
      if (obj[prop] && obj[prop].__dfWrapped) return true; // 已是我们的包装
      let real = obj[prop];
      let wrapped = makeWrapper(() => real);
      try {
        Object.defineProperty(obj, prop, {
          configurable: true,
          enumerable: true,
          get() {
            return wrapped;
          },
          set(v) {
            // 若页面把我们自己的包装又赋回来（常见于 a.fetch = b.fetch 这类透传），
            // 直接沿用，否则会出现「包装包着包装」，每次赋值调用链就深一层，
            // 长时间运行后必然 Maximum call stack size exceeded。
            if (v && v.__dfWrapped) {
              wrapped = v;
              return;
            }
            real = v;
            wrapped = makeWrapper(() => real);
          },
        });
        return true;
      } catch (e) {
        try {
          obj[prop] = wrapped;
          return true;
        } catch (e2) {
          return false;
        }
      }
    }

    function installDataHooks() {
      defineSelfHealingHook(window, "fetch", makeFetchWrapper);
      defineSelfHealingHook(window, "XMLHttpRequest", makeXHRWrapper);
    }

    // ---------- 第 2 层 · 逻辑层（best-effort）：hook 播放器弹幕引擎 add/append ----------
    // 这是“弹幕进入渲染系统前”最关键的一刀。能命中时，弹幕根本不会进入渲染/Worker。
    // 不同版本内部方法名不同，故轮询尝试，命中即用 __dfHooked 防重复。
    function installEngineHook() {
      try {
        const p = window.player;
        if (!p) return;
        const eng = p.danmaku || p.danmakuContainer || p.getDanmaku && p.getDanmaku();
        if (!eng) return;
        ["add", "append", "appendItem", "addElement", "send", "push"].forEach((m) => {
          try {
            if (typeof eng[m] === "function" && !eng[m].__dfHooked) {
              const orig = eng[m];
              eng[m] = function (item) {
                try {
                  let text = "";
                  if (item == null) text = "";
                  else if (typeof item === "string") text = item;
                  else
                    text =
                      item.text ||
                      item.content ||
                      item.msg ||
                      (item.info && item.info[1]) ||
                      (item.data && (item.data.text || item.data.content)) ||
                      "";
                  if (typeof text === "string" && shouldFilter() && judge(text)) {
                    STATS.logic++;
                    recordBlock(text, matchedName(text), getVideoTime());
                    return; // 丢弃该弹幕，不进入渲染
                  }
                } catch (e) {}
                return orig.apply(this, arguments);
              };
              eng[m].__dfHooked = true;
            }
          } catch (e) {}
        });
      } catch (e) {}
    }

    // ---------- 第 3 层 · 兜底：Canvas / Worker 渲染层 ----------

    function hookCtxProto(proto) {
      if (!proto || proto.__dfHooked) return;
      proto.__dfHooked = true;
      const origFill = proto.fillText;
      const origStroke = proto.strokeText;
      if (typeof origFill === "function") {
        proto.fillText = function (text, x, y, maxWidth) {
          try {
            if (typeof text === "string" && text) {
              STATS.mainTotal++;
              if (shouldFilter() && judge(text)) {
                STATS.mainHit++;
                recordBlock(text, matchedName(text), getVideoTime());
                return;
              }
            }
          } catch (e) {}
          return origFill.apply(this, arguments);
        };
      }
      if (typeof origStroke === "function") {
        proto.strokeText = function (text, x, y, maxWidth) {
          try {
            if (typeof text === "string" && text) {
              STATS.mainTotal++;
              if (shouldFilter() && judge(text)) {
                STATS.mainHit++;
                recordBlock(text, matchedName(text), getVideoTime());
                return;
              }
            }
          } catch (e) {}
          return origStroke.apply(this, arguments);
        };
      }
    }
    function installCanvasHook() {
      if (typeof window.CanvasRenderingContext2D !== "undefined") {
        hookCtxProto(window.CanvasRenderingContext2D.prototype);
      }
      if (typeof window.OffscreenCanvasRenderingContext2D !== "undefined") {
        hookCtxProto(window.OffscreenCanvasRenderingContext2D.prototype);
      }
    }

    // ---- Worker 内钩子（自包含字符串，注入 Worker 全局）----
    // 关键：在 Worker 内也包装 self.fetch，使得 Worker 自己重新请求弹幕分段时，
    // 数据在数据层就被过滤（而非等到 fillText 兜底）。
    function workerMain() {
      "use strict";
      var BLOCKED = [];
      var _hit = 0,
        _total = 0;

      function normalize(str) {
        return (str || "")
          .toLowerCase()
          .replace(/[　-]/g, "")
          .replace(/[^\p{L}\p{N}]/gu, "");
      }
      function walkFields(buf, start, end, cb) {
        var i = start;
        while (i < end) {
          var tagStart = i,
            tag = 0,
            shift = 0,
            b;
          do {
            b = buf[i++];
            tag |= (b & 0x7f) << shift;
            shift += 7;
          } while (b & 0x80 && i < end);
          var fn = tag >>> 3,
            wt = tag & 7;
          var vStart = i,
            vEnd = i,
            fieldEnd = i;
          if (wt === 0) {
            do {
              b = buf[i++];
            } while (b & 0x80 && i < end);
            fieldEnd = i;
            vStart = vEnd = i;
          } else if (wt === 1) {
            i += 8;
            fieldEnd = i;
            vStart = vEnd = i;
          } else if (wt === 5) {
            i += 4;
            fieldEnd = i;
            vStart = vEnd = i;
          } else if (wt === 2) {
            var len = 0,
              s = 0;
            do {
              b = buf[i++];
              len |= (b & 0x7f) << s;
              s += 7;
            } while (b & 0x80 && i < end);
            vStart = i;
            vEnd = i + len;
            i = vEnd;
            fieldEnd = vEnd;
          } else {
            break;
          }
          cb(fn, wt, tagStart, fieldEnd, vStart, vEnd);
        }
      }
      function elemContainsBlocked(buf, start, end, normalized, onHit) {
        var hit = false;
        var progressMs = 0; // 弹幕在视频中的时间（毫秒），field 2
        var dec = new TextDecoder("utf-8");
        walkFields(buf, start, end, function (fn, wt, ts, fe, vs, ve) {
          if (fn === 2 && wt === 0) {
            var val = 0, shift = 0, p = ts + 1;
            while (p < fe) {
              var b = buf[p++];
              val |= (b & 0x7f) << shift;
              shift += 7;
            }
            progressMs = val;
          }
          if (hit) return;
          if (fn === 7 && wt === 2 && ve > vs) {
            var text = dec.decode(buf.subarray(vs, ve));
            var norm = normalize(text);
            for (var k = 0; k < normalized.length; k++) {
              if (norm.indexOf(normalized[k]) >= 0) {
                hit = true;
                if (onHit) {
                  try { onHit({ text: text, vt: progressMs / 1000 }); } catch (e) {}
                }
                break;
              }
            }
          }
        });
        return hit;
      }
      function processDanmakuProtobuf(buf, blocked, onRemove) {
        var normalized = (blocked || []).map(normalize).filter(Boolean);
        if (!normalized.length) return buf;
        var kept = [];
        walkFields(buf, 0, buf.length, function (fn, wt, tagStart, fieldEnd, vs, ve) {
          if (fn === 1 && wt === 2) {
            if (
              elemContainsBlocked(buf, vs, ve, normalized, function (info) {
                if (onRemove) {
                  try { onRemove(info); } catch (e) {}
                }
              })
            )
              return;
          }
          kept.push(buf.subarray(tagStart, fieldEnd));
        });
        var total = 0,
          o;
        for (o = 0; o < kept.length; o++) total += kept[o].length;
        var out = new Uint8Array(total);
        var off = 0;
        for (o = 0; o < kept.length; o++) {
          out.set(kept[o], off);
          off += kept[o].length;
        }
        return out;
      }
      function filterXMLString(str, blocked) {
        var normalized = (blocked || []).map(normalize).filter(Boolean);
        if (!normalized.length) return str;
        return str.replace(/<d[^>]*>[\s\S]*?<\/d>/g, function (m) {
          return normalized.some(function (b) {
            return normalize(m).indexOf(b) >= 0;
          })
            ? ""
            : m;
        });
      }
      function isDanmakuUrl(u) {
        if (typeof u !== "string") return false;
        return (
          /api\.bilibili\.com\/.*\/dm\/.*\/seg\.so/.test(u) ||
          /api\.bilibili\.com\/.*\/dm\/list\.so/.test(u)
        );
      }
      function shouldFilter() {
        return BLOCKED.length > 0;
      }
      function judge(text) {
        var n = normalize(text);
        if (!n) return false;
        for (var i = 0; i < BLOCKED.length; i++) {
          if (n.indexOf(normalize(BLOCKED[i])) >= 0) return true;
        }
        return false;
      }

      // ---- Worker 内 · 数据层：包装 self.fetch ----
      (function () {
        var realFetch = self.fetch;
        var cachedWrapper = null; // 缓存：每次读 self.fetch 都新建函数既浪费又会破坏函数身份比较
        function wrapper() {
          if (cachedWrapper) return cachedWrapper;
          cachedWrapper = function (input, init) {
            return realFetch.call(this === undefined ? self : this, input, init).then(function (resp) {
              try {
                if (isDanmakuUrl(resp.url) && shouldFilter()) {
                  return resp.arrayBuffer().then(function (ab) {
                    var buf = new Uint8Array(ab);
                    var out =
                      resp.url.indexOf("list.so") >= 0
                        ? new TextEncoder().encode(
                            filterXMLString(new TextDecoder().decode(buf), BLOCKED)
                          )
                        : processDanmakuProtobuf(buf, BLOCKED, function (info) {
                            try {
                              self.postMessage({ __dfType: "dfblocked", text: info.text, vt: info.vt || 0 });
                            } catch (e) {}
                          });
                    var h = new Headers(resp.headers);
                    h.delete("content-length");
                    h.delete("content-encoding");
                    return new Response(out, {
                      status: resp.status,
                      statusText: resp.statusText,
                      headers: h,
                    });
                  });
                }
              } catch (e) {}
              return resp;
            });
          };
          cachedWrapper.__dfWrapped = true;
          return cachedWrapper;
        }
        try {
          Object.defineProperty(self, "fetch", {
            configurable: true,
            get: function () {
              return wrapper();
            },
            set: function (v) {
              // 不要把自己的包装再包一层，否则每次赋值调用链深一层，最终爆栈
              if (v && v.__dfWrapped) return;
              realFetch = v;
              cachedWrapper = null;
            },
          });
        } catch (e) {
          try {
            self.fetch = wrapper();
          } catch (e2) {}
        }
      })();

      // ---- Worker 内 · 渲染兜底：hook fillText / strokeText ----
      function hookCtx(proto) {
        if (!proto || proto.__dfHooked) return;
        proto.__dfHooked = true;
        var f = proto.fillText,
          s = proto.strokeText;
        if (typeof f === "function") {
          proto.fillText = function (t, x, y, m) {
            try {
              if (typeof t === "string" && t) {
                _total++;
                if (shouldFilter() && judge(t)) {
                  _hit++;
                  try { self.postMessage({ __dfType: "dfblocked", text: t, vt: 0 }); } catch (e) {}
                  return;
                }
              }
            } catch (e) {}
            return f.apply(this, arguments);
          };
        }
        if (typeof s === "function") {
          proto.strokeText = function (t, x, y, m) {
            try {
              if (typeof t === "string" && t) {
                _total++;
                if (shouldFilter() && judge(t)) {
                  _hit++;
                  try { self.postMessage({ __dfType: "dfblocked", text: t, vt: 0 }); } catch (e) {}
                  return;
                }
              }
            } catch (e) {}
            return s.apply(this, arguments);
          };
        }
      }
      if (typeof OffscreenCanvasRenderingContext2D !== "undefined")
        hookCtx(OffscreenCanvasRenderingContext2D.prototype);
      if (typeof CanvasRenderingContext2D !== "undefined")
        hookCtx(CanvasRenderingContext2D.prototype);

      // ---- 接收主线程下发的屏蔽名单 ----
      self.addEventListener("message", function (e) {
        try {
          var d = e.data;
          if (d && d.__dfType === "blocked") {
            BLOCKED = (d.list || []).slice();
          }
        } catch (err) {}
      });

      // ---- 统计回报 ----
      setInterval(function () {
        try {
          if (_hit || _total) {
            self.postMessage({ __dfType: "dfstat", dHit: _hit, dTotal: _total });
            _hit = 0;
            _total = 0;
          }
        } catch (e) {}
      }, 1000);
    }

    const workerRegistry = [];
    function pushBlockedToWorker(w) {
      try {
        w.postMessage({ __dfType: "blocked", list: CACHE.blocked });
      } catch (e) {}
    }
    window.__dfPushBlockedToWorkers = function () {
      workerRegistry.forEach(pushBlockedToWorker);
    };

    // 统一处理来自【Worker 实例】与【跨窗口】的回报消息（dfstat / dfblocked）。
    // 关键修复：Worker 内 self.postMessage 的消息会投递到【Worker 实例】的 message 事件，
    // 而非 window 的 message 事件。旧代码只在 window 上监听，导致 Worker 屏蔽的弹幕
    // 永远无法被统计（表现为「能看到屏蔽生效，但 popup 统计不到」）。
    // 因此 handleWorkerMessage 必须同时挂到 Worker 实例（见 makeHooked）和 window（跨世界桥接）。
    function handleWorkerMessage(d) {
      try {
        if (!d) return;
        if (d.__dfType === "dfstat") {
          STATS.workerHit += d.dHit || 0;
          STATS.workerTotal += d.dTotal || 0;
          if (d.dHit) STATS.netWorker += d.dHit;
        } else if (d.__dfType === "dfblocked") {
          // 来自 Worker 内（或 content.js 跨世界桥接）被拦截的弹幕内容
          recordBlock(d.text, d.name || matchedName(d.text), d.vt || getVideoTime());
        } else if (d.__dfType === "dfsettings") {
          // content.js（隔离世界）推送的设置：主世界唯一的设置来源
          settingsReceived = true;
          applySettings(d.settings || {});
        } else if (d.__dfType === "dfstats-req") {
          // popup → content.js → 此处；把统计快照回传给隔离世界再转给 popup
          window.postMessage(
            {
              __dfType: "dfstats-res",
              id: d.id,
              payload: {
                stats: STATS,
                log: BLOCK_LOG.slice(-50),
                freq: FREQ,
              },
            },
            "*"
          );
        }
      } catch (err) {}
    }

    window.addEventListener("message", function (e) {
      handleWorkerMessage(e.data);
    });

    // ---- 接收 popup 拉取统计/屏蔽记录 ----
    if (chrome.runtime && chrome.runtime.onMessage && chrome.runtime.onMessage.addListener) {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        try {
          if (msg && msg.type === "DF_GET_STATS") {
            sendResponse({
              stats: STATS,
              log: BLOCK_LOG.slice(-50),
              freq: FREQ,
            });
            return true;
          }
        } catch (e) {}
        return false;
      });
    }

    function buildWorkerHookCode() {
      return "(" + workerMain.toString() + ")();";
    }
    function makeHooked(scriptURL, options, realW) {
      const opts = options || {};
      const isModule = opts.type === "module";
      const loader = isModule
        ? "import(" + JSON.stringify(String(scriptURL)) + ");"
        : "try{importScripts(" +
          JSON.stringify(String(scriptURL)) +
          ");}catch(e){try{import(" +
          JSON.stringify(String(scriptURL)) +
          ");}catch(e2){}}";
      const code = buildWorkerHookCode() + "\n" + loader;
      const blob = new Blob([code], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      const w = new realW(url, opts);
      setTimeout(function () {
        try {
          URL.revokeObjectURL(url);
        } catch (e) {}
      }, 60000);
      workerRegistry.push(w);
      pushBlockedToWorker(w);
      // 关键：在 Worker 实例上监听消息，接收 Worker 内 self.postMessage 的 dfblocked / dfstat
      try {
        w.addEventListener("message", function (e) {
          handleWorkerMessage(e.data);
        });
      } catch (e) {}
      return w;
    }

    function installWorkerHook() {
      if (typeof window.Worker !== "function") return;
      if (window.Worker.__dfWrapped) return;
      let RealWorker = window.Worker;
      function buildWrapped(rw) {
        const Wrapped = function (scriptURL, options) {
          try {
            return makeHooked(scriptURL, options, rw);
          } catch (e) {
            try {
              return new rw(scriptURL, options || {});
            } catch (e2) {
              return new RealWorker(scriptURL, options || {});
            }
          }
        };
        try {
          Wrapped.prototype = rw.prototype;
        } catch (e) {}
        Wrapped.__dfWrapped = true;
        return Wrapped;
      }
      // 必须是 let：下面的 setter 会重新赋值。写成 const 时页面一旦执行
      // window.Worker = xxx 就会抛 "Assignment to constant variable"。
      let Wrapped = buildWrapped(RealWorker);
      try {
        Object.defineProperty(window, "Worker", {
          configurable: true,
          enumerable: true,
          get() {
            return Wrapped;
          },
          set(v) {
            // 已是我们的包装就直接沿用，避免包装套包装导致调用链无限加深
            if (v && v.__dfWrapped) {
              Wrapped = v;
              return;
            }
            if (v && v !== Wrapped) {
              RealWorker = v;
              Wrapped = buildWrapped(v);
            }
          },
        });
      } catch (e) {
        try {
          window.Worker = Wrapped;
        } catch (e2) {}
      }
    }

    // ---------- 安装 + 自修复循环 ----------
    function installAll() {
      installDataHooks(); // fetch / XHR（getter/setter，幂等自修复）
      installEngineHook(); // 逻辑层 best-effort（轮询命中）
      installCanvasHook(); // 渲染兜底（prototype，幂等）
      installWorkerHook(); // 把钩子注入 Worker（getter/setter，自修复）
    }
    installAll();
    // 每 1.5s 重新安装：即使播放器在 seek / 恢复 / 运行时重新赋值全局对象，
    // getter/setter 也会把最新值重新包装，hook 永不失效。
    setInterval(installAll, 1500);

    // ===================== 自愈式过滤机制（增量新增，不改动上述任何 hook 逻辑）=====================
    //
    // 现象：页面刷新后前几秒过滤正常，约 10s 后新弹幕不再被过滤——说明现有 hook 方式有效，
    // 但播放器动态加载弹幕后，新弹幕未再次经过过滤链路。
    // 解决：新增「周期性恢复 + 扫描补偿」，复用现有 installAll() 与 judge()，不新增任何 hook 点。
    //
    //   弹幕请求 → 原有过滤（fetch/XHR/Worker/Canvas + 逻辑层） → 播放器
    //        ↓
    //   定期 refreshFilter()（重新挂载 hook + 扫描漏网弹幕隐藏）
    //        ↓
    //   持续屏蔽

    // 扫描当前页面已存在的弹幕 DOM，命中规则则直接隐藏。复用已有 judge() 判断结果。
    function scanExistingDanmaku() {
      if (!shouldFilter()) return;
      const itemSelectors = [
        ".bili-dm",
        ".danmaku",
        ".dm-item",
        ".bili-danmaku-x-dm",
        "[class*=danmaku]",
        "[class*=dm]",
      ];
      const all = itemSelectors.join(",");
      let nodes;
      try {
        nodes = document.querySelectorAll(all);
      } catch (e) {
        return;
      }
      const seen = new Set();
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (seen.has(node)) continue;
        seen.add(node);
        // 若该节点是容器（含匹配的子元素），交给子节点单独判定，避免整层误隐藏
        try {
          if (node.querySelector && node.querySelector(all)) continue;
        } catch (e) {}
        const text = node.innerText || node.textContent || "";
        if (judge(text)) {
          const nm = matchedName(text);
          recordBlock(text, nm, getVideoTime());
          if (node.style.display !== "none") {
            node.style.display = "none";
            STATS.scanHit = (STATS.scanHit || 0) + 1;
          }
        }
      }
    }

    // 自愈恢复：重新挂载所有现有 hook + 扫描并隐藏漏网弹幕。
    function refreshFilter() {
      try {
        installAll(); // 重新执行现有初始化函数，重新挂载所有 hook（幂等自修复）
        scanExistingDanmaku(); // 扫描当前页面已有弹幕，命中规则则隐藏
      } catch (e) {}
      STATS.refreshCount = (STATS.refreshCount || 0) + 1;
    }

    // 视频时间轴触发：B 站弹幕按视频时间分段加载，故在 10s/20s/30s... 触发一次 refreshFilter()，
    // 以覆盖播放器重新加载弹幕的场景（固定定时器之外的一道保险）。
    function setupVideoTrigger() {
      const STEP = 10; // 每 10 秒触发一次
      const fired = new Set(); // 已触发的秒数阈值（避免重复触发）
      function attach(video) {
        if (video.__dfTimeTrigger) return;
        video.__dfTimeTrigger = true;
        video.addEventListener("timeupdate", function () {
          try {
            const t = video.currentTime || 0;
            const prev = video.__dfLastT || 0;
            if (t < prev - 1) fired.clear(); // 回拖进度条时重置触发点
            video.__dfLastT = t;
            const sec = Math.floor(t / STEP) * STEP;
            if (sec > 0 && !fired.has(sec)) {
              fired.add(sec);
              refreshFilter();
            }
          } catch (e) {}
        });
      }
      function poll() {
        try {
          const vids = document.querySelectorAll("video");
          for (let i = 0; i < vids.length; i++) attach(vids[i]);
        } catch (e) {}
      }
      poll();
      setInterval(poll, 2000);
    }

    // 启动自愈式过滤：每 10s 周期恢复一次 + 视频时间轴触发
    setInterval(refreshFilter, 10000);
    setupVideoTrigger();
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      normalize,
      walkFields,
      elemContainsBlocked,
      processDanmakuProtobuf,
      filterXMLString,
      isDanmakuUrl,
    };
  }

  bootstrap();
})();
