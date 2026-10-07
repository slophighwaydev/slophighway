import { OPEN_DETACHED } from "./shared/detached";

chrome.runtime.onInstalled.addListener(() => {
  console.log("[slophighway] installed");
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url?.includes("songsterr.com")) return;
  // Soft nudge: reload so inject hooks catch track JSON early.
  await chrome.tabs.reload(tab.id);
});

/** Songsterr tab id → detached window id. Kept in session storage because the worker can be suspended. */
const WINDOWS_KEY = "shh-detached-windows";

async function knownWindows(): Promise<Record<string, number>> {
  return ((await chrome.storage.session.get(WINDOWS_KEY))[WINDOWS_KEY] as Record<string, number>) ?? {};
}

async function openDetached(tabId: number): Promise<void> {
  const windows = await knownWindows();
  const existing = windows[tabId];
  if (existing != null) {
    try {
      await chrome.windows.update(existing, { focused: true });
      return;
    } catch {
      // the window was closed; open a new one
    }
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(`detached.html?tab=${tabId}`),
    type: "popup",
    width: 1280,
    height: 720,
  });
  if (win?.id != null) {
    await chrome.storage.session.set({ [WINDOWS_KEY]: { ...windows, [tabId]: win.id } });
  }
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === OPEN_DETACHED && sender.tab?.id != null) void openDetached(sender.tab.id);
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  const windows = await knownWindows();
  const left = Object.fromEntries(Object.entries(windows).filter(([, id]) => id !== windowId));
  await chrome.storage.session.set({ [WINDOWS_KEY]: left });
});
