chrome.runtime.onInstalled.addListener(() => {
  console.log("[songsterr-highway] installed");
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url?.includes("songsterr.com")) return;
  // Soft nudge: reload so inject hooks catch track JSON early.
  await chrome.tabs.reload(tab.id);
});
