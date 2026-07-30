// popup.js — 弹幕过滤器设置面板

const STORAGE_KEY = "df_settings";
const api = (typeof browser !== "undefined" && browser.storage) || chrome.storage;

let ALL_NAMES = [];
let settings = { enabled: true, blocked: [], disabledHosts: [], mode: "normal", keepName: "" };
let currentHost = "";

const $ = (id) => document.getElementById(id);

function save() {
  api.local.set({ [STORAGE_KEY]: settings });
  updateStat();
}

function updateStat() {
  $("stat").textContent = `已屏蔽 ${settings.blocked.length} / ${ALL_NAMES.length}`;
}

function blockedSet() {
  return new Set(settings.blocked);
}

// 反选（仅保留某人）是一个“模式”：处于该模式时，反选按钮显示选中态。
// 一旦用户做其它操作（全选 / 清空 / 手动勾选），模式回到 normal，按钮取消选中。
function updateReverseBtn() {
  const btn = $("btnReverse");
  if (!btn) return;
  if (settings.mode === "reverse") {
    btn.classList.add("active");
    btn.textContent = settings.keepName
      ? `反选中：仅留「${settings.keepName}」`
      : "反选（仅留一人）";
  } else {
    btn.classList.remove("active");
    btn.textContent = "反选（仅留一人）";
  }
}

function renderList(filter = "") {
  const set = blockedSet();
  const ul = $("nameList");
  ul.innerHTML = "";
  const f = filter.trim().toLowerCase();
  ALL_NAMES.forEach((name, i) => {
    if (f && !name.toLowerCase().includes(f)) return;
    const li = document.createElement("li");
    li.className = "name-item" + (set.has(name) ? " checked" : "");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = set.has(name);
    cb.addEventListener("change", () => toggleName(name, cb.checked));

    const label = document.createElement("span");
    label.textContent = name;

    const rk = document.createElement("span");
    rk.className = "rk";
    rk.textContent = i + 1;

    li.appendChild(cb);
    li.appendChild(label);
    li.appendChild(rk);
    li.addEventListener("click", (e) => {
      if (e.target !== cb) {
        cb.checked = !cb.checked;
        toggleName(name, cb.checked);
      }
    });
    ul.appendChild(li);
  });
}

function toggleName(name, checked) {
  const set = blockedSet();
  if (checked) set.add(name);
  else set.delete(name);
  settings.blocked = [...set];
  // 手动勾选 => 退出反选模式（按钮不再保持选中）
  settings.mode = "normal";
  settings.keepName = "";
  save();
  updateReverseBtn();
  // 更新行的样式
  renderList($("search").value);
}

function selectAll() {
  settings.blocked = [...ALL_NAMES];
  settings.mode = "normal";
  settings.keepName = "";
  save();
  updateReverseBtn();
  renderList($("search").value);
}

function clearAll() {
  settings.blocked = [];
  settings.mode = "normal";
  settings.keepName = "";
  save();
  updateReverseBtn();
  renderList($("search").value);
}

// ---------- 反选（仅保留某人）----------
function openReverse() {
  $("reverseModal").hidden = false;
  $("reverseSearch").value = "";
  renderReverseList("");
  $("reverseSearch").focus();
}

function renderReverseList(filter = "") {
  const ul = $("reverseList");
  ul.innerHTML = "";
  const f = filter.trim().toLowerCase();
  ALL_NAMES.forEach((name) => {
    if (f && !name.toLowerCase().includes(f)) return;
    const li = document.createElement("li");
    li.className = "reverse-item";
    li.textContent = name;
    li.addEventListener("click", () => applyReverse(name));
    ul.appendChild(li);
  });
}

function applyReverse(keepName) {
  // 屏蔽除 keepName 之外的所有人
  settings.blocked = ALL_NAMES.filter((n) => n !== keepName);
  settings.enabled = true;
  settings.mode = "reverse";
  settings.keepName = keepName;
  $("enableToggle").checked = true;
  save();
  $("reverseModal").hidden = true;
  updateReverseBtn();
  renderList($("search").value);
}

// ---------- 站点级开关 ----------
function setupSiteToggle() {
  chrome.tabs &&
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.url) return;
      try {
        currentHost = new URL(tab.url).hostname;
      } catch (e) {
        return;
      }
      if (!currentHost) return;
      $("siteToggleWrap").hidden = false;
      $("siteHost").textContent = currentHost;
      const disabled = settings.disabledHosts.includes(currentHost);
      $("siteToggle").checked = disabled;
    });
}

function onSiteToggle(checked) {
  if (!currentHost) return;
  const arr = settings.disabledHosts.filter((h) => h !== currentHost);
  if (checked) arr.push(currentHost);
  settings.disabledHosts = arr;
  save();
}

// ---------- 屏蔽名单 展开/收起 ----------
function setupNameListToggle() {
  const toggle = $("namelistToggle");
  const wrap = $("nameListWrap");
  const chevron = $("namelistChevron");
  if (!toggle || !wrap) return;
  toggle.addEventListener("click", () => {
    const collapsed = wrap.hasAttribute("data-collapsed");
    if (collapsed) {
      wrap.removeAttribute("data-collapsed");
      if (chevron) chevron.textContent = "▾";
    } else {
      wrap.setAttribute("data-collapsed", "1");
      if (chevron) chevron.textContent = "▸";
    }
  });
}

// ---------- 屏蔽记录 / 频率显示 ----------
function loadBlockStats() {
  if (!chrome.tabs || !chrome.tabs.sendMessage) return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || tab.id == null) return;
    try {
      chrome.tabs.sendMessage(tab.id, { type: "DF_GET_STATS" }, (resp) => {
        if (chrome.runtime.lastError || !resp) return; // 当前页未注入脚本则忽略
        renderBlockStats(resp);
      });
    } catch (e) {}
  });
}

function fmtVt(sec) {
  if (!sec || sec <= 0 || !isFinite(sec)) return "--:--";
  sec = Math.floor(sec);
  const s = sec % 60;
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function renderBlockStats(resp) {
  const stats = resp.stats || {};
  $("blockTotal").textContent = `（已屏蔽 ${stats.blockedTotal || 0} 条）`;

  // 频率：按被屏蔽人名统计（降序）
  const freq = resp.freq || {};
  const entries = Object.keys(freq)
    .map((k) => [k, freq[k]])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30);
  const fl = $("freqList");
  fl.innerHTML = "";
  if (!entries.length) {
    fl.innerHTML = '<div class="muted">暂无屏蔽记录</div>';
  } else {
    for (const [name, c] of entries) {
      const row = document.createElement("div");
      row.className = "freq-row";
      const nm = document.createElement("span");
      nm.className = "freq-name";
      nm.textContent = name;
      const ct = document.createElement("span");
      ct.className = "freq-count";
      ct.textContent = c + " 次";
      row.appendChild(nm);
      row.appendChild(ct);
      fl.appendChild(row);
    }
  }

  // 最近屏蔽的弹幕内容
  const log = resp.log || [];
  const ll = $("logList");
  ll.innerHTML = "";
  if (!log.length) {
    ll.innerHTML = '<div class="muted">暂无</div>';
  } else {
    for (const item of log.slice().reverse()) {
      const row = document.createElement("div");
      row.className = "log-row";
      const time = document.createElement("span");
      time.className = "log-time";
      time.textContent = new Date(item.t).toLocaleTimeString();
      const txt = document.createElement("span");
      txt.className = "log-text";
      txt.textContent =
        item.text +
        (item.name ? `（${item.name}）` : "") +
        (item.vt ? ` @${fmtVt(item.vt)}` : "");
      row.appendChild(time);
      row.appendChild(txt);
      ll.appendChild(row);
    }
  }

  // 屏蔽拦截成功关键字列表：每条含 屏蔽关键字 + 该弹幕在视频中出现的时间（最新在上）
  const kw = (resp.log || []).filter((it) => it.name);
  $("kwTotal").textContent = kw.length ? `（共 ${kw.length} 条）` : "";
  const kl = $("kwList");
  kl.innerHTML = "";
  if (!kw.length) {
    kl.innerHTML = '<div class="muted">暂无</div>';
  } else {
    for (const item of kw.slice().reverse()) {
      const row = document.createElement("div");
      row.className = "kw-row";
      const time = document.createElement("span");
      time.className = "kw-time";
      time.textContent = fmtVt(item.vt);
      const nm = document.createElement("span");
      nm.className = "kw-name";
      nm.textContent = item.name;
      const txt = document.createElement("span");
      txt.className = "kw-text";
      txt.textContent = item.text;
      row.appendChild(time);
      row.appendChild(nm);
      row.appendChild(txt);
      kl.appendChild(row);
    }
  }
}

// ---------- 初始化 ----------
function init() {
  api.local.get(STORAGE_KEY, (res) => {
    const saved = (res && res[STORAGE_KEY]) || {};
    settings = Object.assign({ enabled: true, blocked: [], disabledHosts: [] }, saved);

    fetch(chrome.runtime.getURL("data/celebrities.json"))
      .then((r) => r.json())
      .then((names) => {
        ALL_NAMES = names;
        $("enableToggle").checked = settings.enabled;
        renderList("");
        updateStat();
        updateReverseBtn(); // 反映已保存的反选模式，避免按钮状态与实际不符
        setupSiteToggle();
        loadBlockStats(); // 拉取并显示当前页的屏蔽记录/频率
        // 打开 popup 期间每 1.5s 自动刷新统计，便于实时查看屏蔽计数（测试用）
        const statsTimer = setInterval(loadBlockStats, 1500);
        window.addEventListener("unload", () => clearInterval(statsTimer));
      });
  });

  $("enableToggle").addEventListener("change", (e) => {
    settings.enabled = e.target.checked;
    save();
  });
  $("search").addEventListener("input", (e) => renderList(e.target.value));
  $("btnAll").addEventListener("click", selectAll);
  $("btnClear").addEventListener("click", clearAll);
  $("btnReverse").addEventListener("click", openReverse);
  $("btnRefreshStats").addEventListener("click", loadBlockStats);
  $("btnRefreshKw").addEventListener("click", loadBlockStats);
  setupNameListToggle();
  $("reverseSearch").addEventListener("input", (e) => renderReverseList(e.target.value));
  $("reverseCancel").addEventListener("click", () => {
    $("reverseModal").hidden = true;
  });
  $("siteToggle").addEventListener("change", (e) => onSiteToggle(e.target.checked));
}

document.addEventListener("DOMContentLoaded", init);
