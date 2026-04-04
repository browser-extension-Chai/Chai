const STORAGE_KEY = "chai_rules";

const DARK_MODE_CSS = `/* Dark mode — invert colors and fix images/videos */
html {
  filter: invert(100%) hue-rotate(180deg);
}

img,
video,
canvas,
picture,
[style*="background-image"] {
  filter: invert(100%) hue-rotate(180deg);
}`;

const DEFAULT_RULES = [
  {
    id: crypto.randomUUID(),
    name: "Dark Mode",
    enabled: true,
    whitelist: [{ matchType: "regex", value: ".*" }],
    blacklist: [],
    css: DARK_MODE_CSS,
  },
];

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== "install") return;

  const result = await chrome.storage.sync.get(STORAGE_KEY);
  if (!result[STORAGE_KEY] || result[STORAGE_KEY].length === 0) {
    await chrome.storage.sync.set({ [STORAGE_KEY]: DEFAULT_RULES });
  }
});
