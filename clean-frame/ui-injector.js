/**
 * CleanFrame — Material dark-theme UI injector for Google Flow video cards.
 * Pure DOM helpers; content.js owns the MutationObserver lifecycle.
 *
 * Injection rule: one button per leaf media cell. Never mark a shared
 * grid/list ancestor — that would suppress sibling cards.
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

  /**
   * Broad per-cell selectors. Prefer leaf media wrappers over grid roots.
   * (Also mirrored in config.cardSelectors for shared config consumers.)
   */
  const CARD_SELECTORS = [
    '[data-test-id*="media"]',
    '[data-testid*="card"]',
    '[data-testid*="media"]',
    '[data-testid*="tile"]',
    '[class*="card"]',
    '[class*="tile"]',
    '[class*="grid-item"]',
    '.relative.group',
    'div:has(> video)',
    'div:has(> img[src*="googleusercontent"])',
    '[role="listitem"]:has(video)',
    '[role="gridcell"]:has(video)',
    'article:has(video)',
  ];

  function ensureStyles() {
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    // Google Material 3 dark tonal button — matches Flow chrome, no glassmorphism
    style.textContent = `
      .cleanframe-host {
        position: absolute;
        inset: 0;
        z-index: ${zIndex};
        pointer-events: none;
      }

      .cleanframe-btn {
        pointer-events: auto;
        position: absolute;
        top: 10px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 99;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 5px 12px;
        font-family: 'Google Sans', Roboto, -apple-system, sans-serif;
        font-size: 11px;
        font-weight: 500;
        color: #e3e3e3;
        background-color: rgba(30, 31, 32, 0.85);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 100px;
        backdrop-filter: blur(4px);
        cursor: pointer;
        transition: all 0.15s ease;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
      }

      .cleanframe-btn:hover:not(:disabled) {
        background: #3c4043;
        border-color: #c4c7c5;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
      }

      .cleanframe-btn:active:not(:disabled) {
        transform: translateX(-50%) scale(0.96);
        background: #444746;
      }

      .cleanframe-btn:focus-visible {
        outline: 2px solid #a8c7fa;
        outline-offset: 2px;
      }

      .cleanframe-btn:disabled {
        cursor: progress;
        opacity: 0.72;
      }

      .cleanframe-btn[data-cleanframe-processing="1"] {
        color: transparent;
      }

      .cleanframe-btn .cleanframe-label {
        position: relative;
        z-index: 1;
        white-space: nowrap;
      }

      .cleanframe-btn .cleanframe-progress {
        position: absolute;
        inset: 0;
        display: none;
        align-items: center;
        justify-content: center;
        z-index: 2;
        color: #e3e3e3;
        font: 500 12px/1 "Google Sans", "Roboto", system-ui, sans-serif;
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
        background: #a8c7fa;
        transition: width 180ms linear;
        z-index: 3;
      }

      .cleanframe-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #a8c7fa;
        flex-shrink: 0;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

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
      progress.textContent = statusText || `${Math.round(clamped * 100)}%`;
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
   * Count direct-ish media pieces. Multi-video containers are grid roots, not cards.
   */
  function mediaCount(el) {
    if (!el?.querySelectorAll) return 0;
    return el.querySelectorAll('video, img[src*="googleusercontent"]').length;
  }

  /**
   * True if this looks like a shared grid / page shell rather than one tile.
   */
  function isSharedContainer(el) {
    if (!el || el === document.body || el === document.documentElement) return true;
    const count = mediaCount(el);
    if (count > 1) return true;

    const rect = el.getBoundingClientRect?.();
    if (rect) {
      // Near full-viewport width with lots of children → grid/shell
      if (rect.width > window.innerWidth * 0.85 && el.children.length > 4) {
        return true;
      }
      if (rect.height > window.innerHeight * 0.9 && count >= 1 && el.children.length > 6) {
        return true;
      }
    }
    return false;
  }

  /**
   * From a <video> or thumbnail <img>, walk up to the nearest *leaf* card cell.
   * Stops before multi-media grid ancestors.
   */
  function resolveLeafCard(mediaEl) {
    if (!mediaEl) return null;

    let best = null;
    let el = mediaEl.parentElement;

    while (el && el !== document.body) {
      if (isSharedContainer(el)) break;

      const cls = typeof el.className === 'string' ? el.className : '';
      const cardLike =
        el.matches?.(
          '[data-test-id*="media"], [data-testid*="card"], [data-testid*="media"], [data-testid*="tile"], [class*="card"], [class*="tile"], [class*="grid-item"], .relative.group, [role="listitem"], [role="gridcell"], article'
        ) ||
        /\b(relative|group)\b/.test(cls) ||
        el.querySelector(':scope > video, :scope > img') === mediaEl ||
        (el.contains(mediaEl) && mediaCount(el) === 1);

      if (cardLike && mediaCount(el) === 1) {
        best = el;
      }

      // Direct parent of video/img is always a candidate
      if (
        !best &&
        (el.querySelector(':scope > video') === mediaEl ||
          el.querySelector(':scope > img') === mediaEl)
      ) {
        best = el;
      }

      el = el.parentElement;
    }

    return best || mediaEl.parentElement;
  }

  /**
   * Keep only innermost candidates (true per-tile cells).
   * Drop any node that contains another candidate — fixes the old
   * outermostOnly bug that kept the shared grid and skipped siblings.
   */
  function innermostOnly(nodes) {
    const list = [...new Set(nodes)].filter(Boolean);
    return list.filter((el) => {
      if (isSharedContainer(el)) return false;
      return !list.some((other) => other !== el && el.contains(other));
    });
  }

  /**
   * Inject one CleanFrame button into a single leaf card.
   * Idempotent on THIS element only — never consults ancestors.
   */
  function injectIntoCard(card, onClick) {
    if (!card || card.nodeType !== 1) return null;

    // Self-only guards (do NOT check ancestors — that killed sibling tiles)
    if (card.querySelector(':scope > .cleanframe-host .cleanframe-btn, :scope > .cleanframe-btn')) {
      card.dataset.cleanframeInjected = 'true';
      return card.querySelector('.cleanframe-btn');
    }
    if (card.dataset.cleanframeInjected === 'true') {
      return card.querySelector('.cleanframe-btn');
    }
    if (card.querySelector('.cleanframe-btn')) {
      // Button already somewhere under this leaf — mark and stop
      card.dataset.cleanframeInjected = 'true';
      card.setAttribute(boundAttr, 'true');
      return card.querySelector('.cleanframe-btn');
    }

    if (isSharedContainer(card)) return null;

    const rect = card.getBoundingClientRect?.();
    if (rect && (rect.width < 80 || rect.height < 60)) return null;

    const hasMedia =
      card.querySelector('video') ||
      card.querySelector('img[src*="googleusercontent"]') ||
      card.querySelector('img[src]') ||
      card.querySelector('a[href*=".mp4"]');
    if (!hasMedia) return null;

    // Mark this leaf only
    card.dataset.cleanframeInjected = 'true';
    card.setAttribute(boundAttr, 'true');

    ensureStyles();
    ensurePositioned(card);

    const { host, btn } = createButton(card, onClick);
    card.appendChild(host);
    return btn;
  }

  /**
   * Discover every media tile and inject exactly one button each.
   */
  function scanAndInject(rootNode, onClick) {
    ensureStyles();
    const root = rootNode && rootNode.querySelectorAll ? rootNode : document;
    /** @type {Element[]} */
    const raw = [];

    const selectors = CFG.cardSelectors?.length ? CFG.cardSelectors : CARD_SELECTORS;
    for (const selector of [...CARD_SELECTORS, ...selectors]) {
      let nodes;
      try {
        nodes = root.querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const node of nodes) {
        if (mediaCount(node) === 1 && !isSharedContainer(node)) {
          raw.push(node);
        }
      }
    }

    // Primary discovery: every video / Flow thumbnail → leaf card
    const mediaNodes = root.querySelectorAll?.(
      'video, img[src*="googleusercontent"]'
    ) || [];
    for (const media of mediaNodes) {
      const leaf = resolveLeafCard(media);
      if (leaf) raw.push(leaf);
    }

    const cards = innermostOnly(raw);
    let injected = 0;

    for (const card of cards) {
      if (injectIntoCard(card, onClick)) injected += 1;
    }

    // Dedup hosts on a single leaf (keep first only)
    for (const card of cards) {
      const hosts = [...card.querySelectorAll(':scope > .cleanframe-host')];
      for (let i = 1; i < hosts.length; i += 1) hosts[i].remove();
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
