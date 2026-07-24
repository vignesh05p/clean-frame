/**
 * CleanFrame — content script entry.
 * Owns MutationObserver lifecycle, HD source resolution, and relays
 * process requests to the background → offscreen pipeline.
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
   * Hunt down the highest-resolution MP4 for this card, then hand it to
   * the offscreen streaming pipeline (extension host_permissions bypass page CORS).
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
      UI.setButtonState(btn, 'error');
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
      const response = await chrome.runtime.sendMessage({
        type: MSG.PROCESS_VIDEO,
        jobId,
        videoUrl,
        pageUrl: location.href,
        watermark: CFG.watermark,
        sourceMeta: {
          strategy: resolved.strategy,
          score: resolved.score,
          bytes: resolved.bytes,
        },
      });

      if (response?.ok === false) {
        // CORS / fetch failures surface here from the offscreen pipeline
        const errText = response.error || 'Processing failed';
        if (/cors|Failed to fetch|HTTP 403|HTTP 401/i.test(errText)) {
          throw new Error(
            `${errText} — the HD URL may need cookies or a fresh download link. ` +
              'Try opening the clip and using Flow’s Download once, then click CleanFrame again.'
          );
        }
        throw new Error(errText);
      }

      if (response?.ok === true && response.done) {
        UI.setButtonState(btn, 'done');
        activeJobs.delete(jobId);
      }
    } catch (err) {
      console.error('[CleanFrame:content] Process request failed', err);
      UI.setButtonState(btn, 'error');
      activeJobs.delete(jobId);
    }
  }

  function onRuntimeMessage(message) {
    if (!message || !message.type) return;

    // Background / MAIN-world may push newly seen media URLs
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
        if (mutation.type === 'childList' && mutation.addedNodes.length) {
          scheduleScan();
          return;
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

    // Flow is a SPA — re-scan on history changes
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

    console.info(`[CleanFrame:content] v${CFG.version} ready on Flow (HD source resolver active)`);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
