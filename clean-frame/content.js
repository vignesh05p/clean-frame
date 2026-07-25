/**
 * CleanFrame — content script entry.
 * Owns MutationObserver lifecycle, HD source resolution, and relays
 * process requests to the background → offscreen pipeline.
 *
 * Messaging is fire-and-forget: PROCESS_VIDEO only waits for { status:'started' }.
 * Progress / done / error arrive as separate chrome.runtime.onMessage events.
 */
(function () {
  'use strict';

  const CFG = self.CLEANFRAME_CONFIG;
  const UI = self.CleanFrameUI;
  const Source = self.CleanFrameSource;

  if (!CFG || !UI) {
    console.error('[CleanFrame:content] Missing config or UI module');
    return;
  }

  const MSG = CFG.messages;
  /** @type {Map<string, HTMLButtonElement>} */
  const activeJobs = new Map();
  let observer = null;
  let scanScheduled = false;

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      UI.scanAndInject(document, onCleanFrameClick);
    });
  }

  /**
   * Hunt down the highest-resolution MP4 for this card, then kick off
   * the offscreen pipeline without holding the message port open.
   */
  async function onCleanFrameClick(btn, card) {
    if (btn.getAttribute(CFG.ui.processingAttr) === '1') return;

    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    activeJobs.set(jobId, btn);
    UI.setButtonState(btn, 'processing');
    UI.setButtonProgress(btn, 0.02, 'Finding HD…');

    let resolved;
    try {
      resolved = await UI.getHighResVideoUrl(card);
    } catch (err) {
      console.error('[CleanFrame:content] HD source resolution failed', err);

      const errorMessage = String(err.message || err);

      // 1. Handle Zombie Tabs (Extension Context Invalidated)
      if (errorMessage.includes('Extension context invalidated')) {
        UI.setButtonState(btn, 'error');
        UI.setButtonProgress(btn, 1.0, 'Extension updated. Please refresh page!');
      }
      // 2. Handle Phantom Click Failure / Hidden Videos
      else if (errorMessage.includes('No video URL found')) {
        UI.setButtonState(btn, 'error');
        UI.setButtonProgress(btn, 1.0, 'Click Flow Download First!');

        setTimeout(() => {
          UI.setButtonState(btn, 'ready');
          UI.setButtonProgress(btn, 0, 'CleanFrame');
        }, 4000);
      }
      // 3. Generic Errors
      else {
        UI.setButtonState(btn, 'error');
      }

      activeJobs.delete(jobId);
      return;
    }

    const videoUrl = resolved.url;
    console.info('[CleanFrame:content] Using media source', {
      strategy: resolved.strategy,
      score: resolved.score,
      bytes: resolved.bytes,
      url: videoUrl.slice(0, 160),
    });

    if (resolved.strategy === 'preview') {
      console.warn(
        '[CleanFrame:content] Fell back to in-page preview URL — HD download link not found yet. ' +
          'Tip: click Flow’s Download once so the sniffer can capture the full-res URL.'
      );
    }

    UI.setButtonProgress(btn, 0.05, 'Starting…');

    try {
      // Fire-and-forget: only wait for immediate ack — NOT the full pipeline.
      const response = await chrome.runtime.sendMessage({
        type: MSG.PROCESS_VIDEO,
        jobId,
        videoUrl,
        pageUrl: location.href,
        platform: CFG.platform || 'flow',
        watermark: CFG.watermark,
        sourceMeta: {
          strategy: resolved.strategy,
          score: resolved.score,
          bytes: resolved.bytes,
        },
      });

      if (response?.ok === false) {
        const errText = response.error || 'Failed to start processing';
        if (/cors|Failed to fetch|HTTP 403|HTTP 401/i.test(errText)) {
          throw new Error(
            `${errText} — the HD URL may need a fresh download link. ` +
              'Try Flow’s Download once, then click CleanFrame again.'
          );
        }
        throw new Error(errText);
      }

      // Job accepted — UI updates continue via PROCESS_PROGRESS / DONE / ERROR
      UI.setButtonProgress(btn, 0.08, 'Demuxing…');
      console.info('[CleanFrame:content] job started', jobId, response?.status);
    } catch (err) {
      console.error('[CleanFrame:content] Process request failed', err);

      const errorMessage = String(err.message || err);

      // 1. Handle Zombie Tabs (Extension Context Invalidated)
      if (errorMessage.includes('Extension context invalidated')) {
        UI.setButtonState(btn, 'error');
        UI.setButtonProgress(btn, 1.0, 'Extension updated. Please refresh page!');
      }
      // 2. Handle Phantom Click Failure / Hidden Videos
      else if (errorMessage.includes('No video URL found')) {
        UI.setButtonState(btn, 'error');
        UI.setButtonProgress(btn, 1.0, 'Click Flow Download First!');

        setTimeout(() => {
          UI.setButtonState(btn, 'ready');
          UI.setButtonProgress(btn, 0, 'CleanFrame');
        }, 4000);
      }
      // 3. Generic Errors
      else {
        UI.setButtonState(btn, 'error');
      }

      activeJobs.delete(jobId);
    }
  }

  function onRuntimeMessage(message) {
    if (!message || !message.type) return;

    if (message.type === MSG.MEDIA_SEEN && message.url) {
      Source?.rememberNetworkUrl?.(message.url, message.bytes);
      return;
    }

    if (message.type === MSG.PROCESS_PROGRESS) {
      const btn = activeJobs.get(message.jobId);
      if (!btn) return;
      UI.setButtonProgress(btn, message.ratio, message.statusText);
      return;
    }

    if (message.type === MSG.PROCESS_DONE) {
      const btn = activeJobs.get(message.jobId);
      if (!btn) return;
      UI.setButtonState(btn, 'done');
      activeJobs.delete(message.jobId);
      return;
    }

    if (message.type === MSG.PROCESS_ERROR) {
      const btn = activeJobs.get(message.jobId);
      if (!btn) return;
      console.error('[CleanFrame:content]', message.error);
      UI.setButtonState(btn, 'error');
      activeJobs.delete(message.jobId);
    }
  }

  function startObserver() {
    if (observer) return;

    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const t = mutation.target;
        if (
          t?.closest?.('.cleanframe-host, .cleanframe-btn') ||
          (t?.nodeType === 1 && t.classList?.contains('cleanframe-host'))
        ) {
          continue;
        }

        if (mutation.type === 'childList' && mutation.addedNodes.length) {
          let relevant = false;
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== 1) continue;
            if (node.classList?.contains('cleanframe-host')) continue;
            if (
              node.querySelector?.('.cleanframe-host') &&
              !node.querySelector?.('video, img')
            ) {
              continue;
            }
            relevant = true;
            break;
          }
          if (relevant) {
            scheduleScan();
            return;
          }
        }
        if (
          mutation.type === 'attributes' &&
          (mutation.attributeName === 'src' ||
            mutation.attributeName === 'href')
        ) {
          scheduleScan();
          return;
        }
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'href', 'data-src', 'data-video-url', 'data-download-url'],
    });
  }

  function init() {
    UI.ensureStyles();
    Source?.startPerformanceSniffer?.();
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    startObserver();
    scheduleScan();

    const _push = history.pushState;
    const _replace = history.replaceState;
    history.pushState = function (...args) {
      const ret = _push.apply(this, args);
      scheduleScan();
      return ret;
    };
    history.replaceState = function (...args) {
      const ret = _replace.apply(this, args);
      scheduleScan();
      return ret;
    };
    window.addEventListener('popstate', scheduleScan);

    console.info(
      `[CleanFrame:content] v${CFG.version} ready (fire-and-forget messaging)`
    );
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
