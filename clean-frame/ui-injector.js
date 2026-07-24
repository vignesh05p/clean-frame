/**
 * CleanFrame — glassmorphic UI injector for Google Flow video cards.
 * Pure DOM helpers; content.js owns the MutationObserver lifecycle.
 */
(function (root) {
  'use strict';

  const CFG = root.CLEANFRAME_CONFIG;
  if (!CFG) {
    console.error('[CleanFrame:content] config.js must load before ui-injector.js');
    return;
  }

  const { buttonLabel, buttonAttr, boundAttr, processingAttr, styleId, zIndex } =
    CFG.ui;

  function ensureStyles() {
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      .cleanframe-host {
        position: absolute;
        top: 10px;
        right: 10px;
        z-index: ${zIndex};
        pointer-events: none;
      }

      .cleanframe-btn {
        pointer-events: auto;
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        min-width: 92px;
        height: 34px;
        padding: 0 14px;
        border: 1px solid rgba(255, 255, 255, 0.28);
        border-radius: 999px;
        background:
          linear-gradient(135deg, rgba(255,255,255,0.22), rgba(255,255,255,0.06)),
          rgba(12, 28, 34, 0.42);
        backdrop-filter: blur(14px) saturate(1.35);
        -webkit-backdrop-filter: blur(14px) saturate(1.35);
        box-shadow:
          0 1px 0 rgba(255,255,255,0.22) inset,
          0 8px 24px rgba(0, 0, 0, 0.28);
        color: #f4fbfd;
        font: 600 12px/1 "Segoe UI", "SF Pro Text", system-ui, sans-serif;
        letter-spacing: 0.04em;
        text-transform: none;
        cursor: pointer;
        overflow: hidden;
        transition:
          transform 160ms ease,
          box-shadow 160ms ease,
          background 160ms ease,
          opacity 160ms ease;
        user-select: none;
        -webkit-user-select: none;
      }

      .cleanframe-btn::before {
        content: "";
        position: absolute;
        inset: 0;
        background: linear-gradient(
          120deg,
          transparent 0%,
          rgba(255,255,255,0.18) 42%,
          transparent 68%
        );
        transform: translateX(-120%);
        transition: transform 520ms ease;
        pointer-events: none;
      }

      .cleanframe-btn:hover:not(:disabled) {
        transform: translateY(-1px) scale(1.02);
        box-shadow:
          0 1px 0 rgba(255,255,255,0.28) inset,
          0 12px 28px rgba(0, 0, 0, 0.34);
        background:
          linear-gradient(135deg, rgba(255,255,255,0.28), rgba(255,255,255,0.08)),
          rgba(10, 36, 42, 0.55);
      }

      .cleanframe-btn:hover:not(:disabled)::before {
        transform: translateX(120%);
      }

      .cleanframe-btn:active:not(:disabled) {
        transform: translateY(0) scale(0.98);
      }

      .cleanframe-btn:disabled {
        cursor: progress;
        opacity: 0.92;
      }

      .cleanframe-btn[data-cleanframe-processing="1"] {
        color: transparent;
      }

      .cleanframe-btn .cleanframe-label {
        position: relative;
        z-index: 1;
      }

      .cleanframe-btn .cleanframe-progress {
        position: absolute;
        inset: 0;
        display: none;
        align-items: center;
        justify-content: center;
        z-index: 2;
        color: #f4fbfd;
        font: 600 11px/1 "Segoe UI", "SF Pro Text", system-ui, sans-serif;
        letter-spacing: 0.03em;
      }

      .cleanframe-btn[data-cleanframe-processing="1"] .cleanframe-progress {
        display: inline-flex;
      }

      .cleanframe-btn .cleanframe-bar {
        position: absolute;
        left: 0;
        bottom: 0;
        height: 2px;
        width: 0%;
        background: linear-gradient(90deg, #7de2d1, #e8fffb);
        box-shadow: 0 0 10px rgba(125, 226, 209, 0.65);
        transition: width 180ms linear;
        z-index: 3;
      }

      .cleanframe-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #7de2d1;
        box-shadow: 0 0 8px rgba(125, 226, 209, 0.8);
        flex-shrink: 0;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  /**
   * Resolve a playable / downloadable video URL from a card subtree.
   * Prefer CleanFrameSource.getHighResVideoUrl() for HD; this is the sync fallback.
   */
  function resolveVideoUrl(card) {
    if (root.CleanFrameSource?.resolveVideoUrl) {
      return root.CleanFrameSource.resolveVideoUrl(card);
    }
    if (!card) return null;

    const video = card.querySelector('video[src]');
    if (video?.src && !video.src.startsWith('blob:')) {
      return video.currentSrc || video.src;
    }
    if (video?.currentSrc) return video.currentSrc;

    const source = card.querySelector('video source[src]');
    if (source?.src) return source.src;

    const mp4Link = card.querySelector('a[href*=".mp4"], a[download]');
    if (mp4Link?.href) return mp4Link.href;

    const dataUrl =
      card.getAttribute('data-video-url') ||
      card.getAttribute('data-src') ||
      card.querySelector('[data-video-url]')?.getAttribute('data-video-url');
    if (dataUrl) return dataUrl;

    return null;
  }

  /**
   * @param {Element} card
   * @returns {Promise<{ url: string, strategy: string, score: number }>}
   */
  async function getHighResVideoUrl(card) {
    if (!root.CleanFrameSource?.getHighResVideoUrl) {
      const fallback = resolveVideoUrl(card);
      if (!fallback) throw new Error('No video URL found on card');
      return { url: fallback, strategy: 'preview', score: 0 };
    }
    return root.CleanFrameSource.getHighResVideoUrl(card);
  }

  function setButtonProgress(btn, ratio, statusText) {
    const clamped = Math.max(0, Math.min(1, Number(ratio) || 0));
    const bar = btn.querySelector('.cleanframe-bar');
    const progress = btn.querySelector('.cleanframe-progress');
    if (bar) bar.style.width = `${Math.round(clamped * 100)}%`;
    if (progress) {
      progress.textContent =
        statusText || `${Math.round(clamped * 100)}%`;
    }
  }

  function setButtonState(btn, state) {
    if (state === 'processing') {
      btn.disabled = true;
      btn.setAttribute(processingAttr, '1');
      setButtonProgress(btn, 0, '0%');
      return;
    }
    if (state === 'idle') {
      btn.disabled = false;
      btn.removeAttribute(processingAttr);
      setButtonProgress(btn, 0, '');
      const bar = btn.querySelector('.cleanframe-bar');
      if (bar) bar.style.width = '0%';
      return;
    }
    if (state === 'done') {
      btn.disabled = false;
      btn.removeAttribute(processingAttr);
      const label = btn.querySelector('.cleanframe-label');
      if (label) label.textContent = 'Done';
      setTimeout(() => {
        if (label) label.textContent = buttonLabel;
        setButtonProgress(btn, 0, '');
        const bar = btn.querySelector('.cleanframe-bar');
        if (bar) bar.style.width = '0%';
      }, 1600);
    }
    if (state === 'error') {
      btn.disabled = false;
      btn.removeAttribute(processingAttr);
      const label = btn.querySelector('.cleanframe-label');
      if (label) label.textContent = 'Retry';
      setTimeout(() => {
        if (label) label.textContent = buttonLabel;
      }, 2200);
    }
  }

  function createButton(card, onClick) {
    const host = document.createElement('div');
    host.className = 'cleanframe-host';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cleanframe-btn';
    btn.setAttribute(buttonAttr, '1');
    btn.setAttribute('aria-label', 'Remove watermark with CleanFrame');
    btn.title = 'Remove visible watermark (client-side)';

    btn.innerHTML = `
      <span class="cleanframe-dot" aria-hidden="true"></span>
      <span class="cleanframe-label">${buttonLabel}</span>
      <span class="cleanframe-progress" aria-live="polite"></span>
      <span class="cleanframe-bar" aria-hidden="true"></span>
    `;

    btn.addEventListener(
      'click',
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick?.(btn, card);
      },
      true
    );

    host.appendChild(btn);
    return { host, btn };
  }

  function ensurePositioned(card) {
    const style = getComputedStyle(card);
    if (style.position === 'static') {
      card.style.position = 'relative';
    }
  }

  /**
   * Inject an CleanFrame button into a single card if not already bound.
   * @returns {HTMLButtonElement|null}
   */
  function injectIntoCard(card, onClick) {
    if (!card || card.nodeType !== 1) return null;
    if (card.hasAttribute(boundAttr)) {
      return card.querySelector(`[${buttonAttr}]`);
    }
    // Skip tiny containers that are unlikely to be media cards
    const rect = card.getBoundingClientRect?.();
    if (rect && (rect.width < 96 || rect.height < 72)) return null;

    // Prefer cards that actually contain media
    const hasMedia =
      card.querySelector('video') ||
      card.querySelector('img[src]') ||
      card.querySelector('a[href*=".mp4"]');
    if (!hasMedia) return null;

    ensureStyles();
    ensurePositioned(card);

    const { host, btn } = createButton(card, onClick);
    card.setAttribute(boundAttr, 'true');
    card.appendChild(host);
    return btn;
  }

  /**
   * Scan the document (or a subtree) and inject buttons onto matching cards.
   */
  function scanAndInject(rootNode, onClick) {
    ensureStyles();
    const root = rootNode && rootNode.querySelectorAll ? rootNode : document;
    const seen = new Set();
    let injected = 0;

    for (const selector of CFG.cardSelectors) {
      let nodes;
      try {
        nodes = root.querySelectorAll(selector);
      } catch {
        // :has() unsupported in very old engines — skip
        continue;
      }
      for (const card of nodes) {
        if (seen.has(card)) continue;
        seen.add(card);
        if (injectIntoCard(card, onClick)) injected += 1;
      }
    }

    // Fallback: any video element's nearest reasonably-sized ancestor
    const videos = root.querySelectorAll?.('video') || [];
    for (const video of videos) {
      const card =
        video.closest('[data-testid]') ||
        video.closest('article') ||
        video.closest('[role="listitem"]') ||
        video.parentElement;
      if (!card || seen.has(card)) continue;
      seen.add(card);
      if (injectIntoCard(card, onClick)) injected += 1;
    }

    return injected;
  }

  root.CleanFrameUI = {
    ensureStyles,
    resolveVideoUrl,
    getHighResVideoUrl,
    injectIntoCard,
    scanAndInject,
    setButtonProgress,
    setButtonState,
  };
})(typeof self !== 'undefined' ? self : window);
