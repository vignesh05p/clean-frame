/**
 * CleanFrame — MV3 service worker.
 * Ensures offscreen document, relays process jobs, and sniffs HD media URLs.
 */
/* global CLEANFRAME_CONFIG */
importScripts('config.js');

const CFG = self.CLEANFRAME_CONFIG;
const MSG = CFG.messages;
const OFFSCREEN_URL = 'offscreen.html';

let creatingOffscreen = null;

/** @type {Map<number, { url: string, bytes?: number, ts: number }[]>} */
const mediaByTab = new Map();
const MEDIA_CACHE_LIMIT = 40;
const MEDIA_TTL_MS = 15 * 60 * 1000;

function isMediaUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const patterns = CFG.mediaUrlPatterns || ['.mp4', 'googleusercontent.com'];
  const lower = url.toLowerCase();
  if (/(?:preview|thumb|thumbnail|sprite|waveform)/i.test(lower) && !/\.mp4/i.test(lower)) {
    return false;
  }
  return patterns.some((p) => lower.includes(p.toLowerCase()));
}

function rememberTabMedia(tabId, url, bytes) {
  if (tabId == null || tabId < 0 || !isMediaUrl(url)) return;
  const list = mediaByTab.get(tabId) || [];
  const existing = list.find((x) => x.url === url);
  if (existing) {
    existing.ts = Date.now();
    if (bytes) existing.bytes = bytes;
  } else {
    list.unshift({ url, bytes, ts: Date.now() });
  }
  while (list.length > MEDIA_CACHE_LIMIT) list.pop();
  mediaByTab.set(tabId, list);

  // Notify the content script so Strategy C stays warm
  chrome.tabs.sendMessage(tabId, {
    type: MSG.MEDIA_SEEN,
    url,
    bytes,
  }).catch(() => {});
}

function lookupMedia(tabId, hints = []) {
  const now = Date.now();
  const list = (mediaByTab.get(tabId) || []).filter((x) => now - x.ts < MEDIA_TTL_MS);
  mediaByTab.set(tabId, list);

  if (!hints.length) return list;

  const scored = list.map((item) => {
    let score = item.bytes ? Math.log10(item.bytes + 1) : 0;
    for (const h of hints) {
      if (h && item.url.includes(h)) score += 50;
    }
    if (/download|export|1080|2160|4k|original/i.test(item.url)) score += 20;
    if (/preview|proxy|thumb/i.test(item.url)) score -= 30;
    return { ...item, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

async function hasOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
    });
    return contexts.length > 0;
  }
  return false;
}

async function ensureOffscreen() {
  if (await hasOffscreenDocument()) return;

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['BLOBS', 'WORKERS', 'DOM_SCRAPING'],
    justification:
      'Run WebCodecs + WebGL2 watermark removal off the extension service worker.',
  });

  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

async function relayToTab(tabId, message) {
  if (tabId == null) return;
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    console.warn('[CleanFrame:background] tab relay failed', err);
  }
}

// ---------- Strategy C: chrome.webRequest HD sniffer ----------
if (chrome.webRequest?.onCompleted) {
  const filter = {
    urls: [
      '*://*.googleusercontent.com/*',
      '*://storage.googleapis.com/*',
      '*://*.googleapis.com/*',
      '*://labs.google.com/*',
      '*://labs.google/*',
      '*://*.ggpht.com/*',
    ],
    types: ['media', 'xmlhttprequest', 'other', 'object'],
  };

  chrome.webRequest.onCompleted.addListener(
    (details) => {
      if (details.tabId < 0) return;
      if (!isMediaUrl(details.url)) return;
      // Prefer larger responses — previews are often tiny
      const bytes = details.responseHeaders
        ? Number(
            details.responseHeaders.find(
              (h) => h.name.toLowerCase() === 'content-length'
            )?.value
          ) || undefined
        : undefined;
      console.log('[CleanFrame:background] webRequest media', details.url.slice(0, 120), bytes);
      rememberTabMedia(details.tabId, details.url, bytes);
    },
    filter,
    ['responseHeaders']
  );

  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.tabId < 0) return;
      if (!isMediaUrl(details.url)) return;
      rememberTabMedia(details.tabId, details.url);
    },
    filter
  );
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) return;

  if (message.type === MSG.PING) {
    sendResponse({ ok: true, version: CFG.version });
    return;
  }

  if (message.type === MSG.LOOKUP_MEDIA) {
    const tabId = sender.tab?.id;
    const urls = lookupMedia(tabId, message.hints || []);
    sendResponse({ ok: true, urls });
    return;
  }

  if (message.type === MSG.ENSURE_OFFSCREEN) {
    ensureOffscreen()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (
    message.type === MSG.PROCESS_PROGRESS ||
    message.type === MSG.PROCESS_DONE ||
    message.type === MSG.PROCESS_ERROR
  ) {
    if (message.via === 'offscreen') {
      relayToTab(message.tabId, {
        type: message.type,
        jobId: message.jobId,
        ratio: message.ratio,
        statusText: message.statusText,
        error: message.error,
      });

      if (
        message.type === MSG.PROCESS_DONE &&
        message.blobUrl &&
        message.filename
      ) {
        chrome.downloads.download({
          url: message.blobUrl,
          filename: message.filename,
          saveAs: true,
        });
      }
      sendResponse({ ok: true });
      return;
    }
  }

  if (message.type === MSG.PROCESS_VIDEO && message.target !== 'offscreen') {
    const tabId = sender.tab?.id;
    (async () => {
      // Keep the chosen URL in the media cache for retries
      if (message.videoUrl && tabId != null) {
        rememberTabMedia(tabId, message.videoUrl, message.sourceMeta?.bytes);
      }

      await ensureOffscreen();

      const result = await chrome.runtime.sendMessage({
        type: MSG.PROCESS_VIDEO,
        target: 'offscreen',
        jobId: message.jobId,
        videoUrl: message.videoUrl,
        pageUrl: message.pageUrl,
        watermark: message.watermark,
        sourceMeta: message.sourceMeta,
        tabId,
      });

      sendResponse(result ?? { ok: true });
    })().catch((e) => {
      const error = String(e?.message || e);
      sendResponse({ ok: false, error });
      relayToTab(tabId, {
        type: MSG.PROCESS_ERROR,
        jobId: message.jobId,
        error,
      });
    });
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  console.info(`[CleanFrame:background] v${CFG.version} service worker ready (media sniffer on)`);
});
