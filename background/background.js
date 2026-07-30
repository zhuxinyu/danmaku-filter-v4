// background.js — MV3 service worker
// 负责初始化默认设置，并响应 popup 的"在任意已授权页面注入"请求。

const STORAGE_KEY = "df_settings";

const DEFAULT_SETTINGS = {
  enabled: true,
  blocked: [],
  disabledHosts: [],
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(STORAGE_KEY, (res) => {
    if (!res || !res[STORAGE_KEY]) {
      chrome.storage.local.set({ [STORAGE_KEY]: DEFAULT_SETTINGS });
    }
  });
});

// popup 请求：把 content script 注入到当前标签页（仅对 host_permissions 内的站点生效）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "INJECT_NOW" && msg.tabId != null) {
    chrome.scripting
      .executeScript({
        target: { tabId: msg.tabId },
        files: ["content/content.js"],
      })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // 异步响应
  }
});
