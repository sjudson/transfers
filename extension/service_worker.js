// Minimal service worker: its only job is to open/focus the dashboard tab.
// All fetching, parsing, caching and UI live in the dashboard page, because:
//  - DOMParser is unavailable in service workers, and
//  - page fetches with host_permissions bypass CORS *and* carry the user's
//    pcmdaily.com login cookies (with credentials:'include').

const DASH = 'dashboard.html';

async function openDashboard() {
  const url = chrome.runtime.getURL(DASH);
  const tabs = await chrome.tabs.query({ url });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    if (tabs[0].windowId != null) await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

chrome.action.onClicked.addListener(openDashboard);
chrome.runtime.onInstalled.addListener((d) => {
  if (d.reason === 'install') openDashboard();
});
