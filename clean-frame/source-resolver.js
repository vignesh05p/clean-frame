/**
 * CleanFrame — high-resolution media source discovery for Google Flow cards.
 *
 * Strategies (highest priority first):
 *   A) DOM: Download / Export anchors & data-* attributes (not the <video> proxy)
 *   B) Embedded app state: __NEXT_DATA__, JSON blobs, React fiber props
 *   C) Network: Performance entries + background webRequest cache
 *   D) Preview <video> src — last resort only
 */
(function (root) {
  'use strict';

  const CFG = root.CLEANFRAME_CONFIG;
  const LOG = '[CleanFrame:source]';
  /** Gate verbose phantom-click stage logs (console.debug). */
  const DEBUG = false;

  /** @typedef {{ url: string, strategy: string, score: number, hint?: string, bytes?: number }} MediaCandidate */

  const HD_HINTS =
    /(?:download|export|original|full[_-]?res|1080|2160|4k|1920|1440|high|hq|master|source|raw|media)/i;
  const PROXY_HINTS =
    /(?:preview|proxy|thumb|thumbnail|poster|low|sd|360p|480p|720p[_-]?preview|gif|sprite|waveform|tiny)/i;
  const MP4_LIKE = /\.mp4(?:$|\?|#)|\/videoplayback|alt=media|mime=video|video%2Fmp4|content-type=video/i;
  const MEDIA_HOST =
    /(?:googleusercontent\.com|storage\.googleapis\.com|ggpht\.com|googleapis\.com|gstatic\.com|labs\.google)/i;

  const ATTR_KEYS = [
    'href',
    'src',
    'data-href',
    'data-src',
    'data-url',
    'data-video-url',
    'data-video',
    'data-download-url',
    'data-export-url',
    'data-media-url',
    'data-original',
    'data-full-url',
    'data-asset-url',
  ];

  /** In-page registry fed by PerformanceObserver + optional MAIN-world sniffer */
  /** @type {Map<string, { url: string, bytes?: number, ts: number }>} */
  const seenNetwork = new Map();

  function log(...args) {
    console.log(LOG, ...args);
  }

  function dbg(...args) {
    if (DEBUG) console.debug(LOG, ...args);
  }

  function absUrl(raw, base) {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('javascript:') || trimmed === '#') return null;
    try {
      return new URL(trimmed, base || location.href).href;
    } catch {
      return null;
    }
  }

  function looksLikeHtmlPayload(value) {
    if (!value || typeof value !== 'string') return false;
    const raw = value.trim();
    if (!raw) return false;
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      // fall back to raw value
    }
    const haystack = `${raw}\n${decoded}`.toLowerCase();
    return /<!doctype|<html|<body|<head|<script|<style|<div|<h1|<h2|<h3|<p|<span|<a\s|<img|<video|%3c|%3e|&lt;|&gt;/.test(haystack);
  }

  function looksLikeImageUrl(url) {
    if (!url) return false;
    const lower = url.toLowerCase();
    return (
      /\.(jpe?g|png|gif|webp|bmp|avif|tiff?)(?:$|\?|#)/i.test(lower) ||
      /\/image\//i.test(lower) ||
      /(mime|content-type|format)=(image|jpeg|png|gif|webp|bmp|avif)/i.test(lower) ||
      /\b(img|image|photo|thumbnail)\b/i.test(lower)
    );
  }

  function isProbablyVideoUrl(url) {
    if (!url) return false;
    const normalized = String(url).trim();
    if (!normalized) return false;
    if (normalized.startsWith('blob:') || normalized.startsWith('data:')) return false;
    if (looksLikeHtmlPayload(normalized)) return false;
    if (
      normalized.includes('/project/') ||
      normalized.includes('/faq') ||
      normalized.includes('/tools/flow/project/') ||
      /labs\.google\/fx\/tools\/flow\/project\//i.test(normalized)
    ) {
      return false;
    }
    if (/\.(?:webmanifest|jpe?g|png|webp|gif|svg)(?:$|\?|#)/i.test(normalized)) return false;
    if (/\/(?:icons|favicon|logo|manifest|browserconfig|apple-touch-icon|tile)\b/i.test(normalized)) return false;
    if (/\/image\//i.test(normalized) || /\/images\//i.test(normalized) || /avatar|thumbnail|poster|jfif/i.test(normalized)) return false;
    if (/\/trpc\//i.test(normalized) || /\/api\//i.test(normalized) || /\/rpc\//i.test(normalized) || /\/graphql\//i.test(normalized)) return false;
    if (looksLikeImageUrl(normalized)) return false;
    if (/\u0000/.test(normalized)) return false;
    // Strict blacklist: non-media file extensions and path segments
    if (/\.(?:webmanifest|json|js|css|xml|txt)(?:$|\?|#)/i.test(normalized)) return false;
    if (/\/icons?\|\/favicon\/|manifest\.webmanifest/i.test(normalized)) return false;
    if (MP4_LIKE.test(normalized)) return true;
    if (MEDIA_HOST.test(normalized)) {
      return /getMediaUrlRedirect|alt=media|video%2Fmp4|\.mp4|\.mov|\.webm|\.m4v|mime=video|content-type=video|videoplayback/i.test(normalized);
    }
    return false;
  }

  function scoreUrl(url, strategy, hint) {
    let score = 0;
    const u = url.toLowerCase();
    const h = (hint || '').toLowerCase();

    if (strategy === 'dom-download') score += 80;
    if (strategy === 'dom-export') score += 75;
    if (strategy === 'state') score += 70;
    if (strategy === 'network') score += 65;
    if (strategy === 'dom-data') score += 55;
    if (strategy === 'preview') score += 10;

    if (HD_HINTS.test(u) || HD_HINTS.test(h)) score += 40;
    if (PROXY_HINTS.test(u) || PROXY_HINTS.test(h)) score -= 50;
    if (/image|thumb|poster|jfif/i.test(u) || /image|thumb|poster/i.test(h)) score -= 200;
    if (/\/trpc\/|\/api\/|\/rpc\/|\/graphql\//i.test(u)) score -= 300;
    if (u.includes('/project/') || /labs\.google\/fx\/tools\/flow\/project\//i.test(u)) score -= 500;
    // Heavily penalise manifest / favicon / icon / json URLs that slip through
    if (/manifest|favicon|icon|json/i.test(u) || /manifest|favicon|icon|json/i.test(h)) score -= 1000;
    if (/\.mp4(?:$|\?)/i.test(u)) score += 25;
    if (/m3u8|application\/vnd\.apple\.mpegurl|hls/i.test(u)) score -= 30; // pipeline needs progressive MP4
    if (MEDIA_HOST.test(u)) score += 10;
    if (/2160|4k|3840/.test(u)) score += 30;
    if (/1080|1920/.test(u)) score += 20;
    if (/720|1280/.test(u)) score += 5;
    if (/480|360|240/.test(u)) score -= 20;

    return score;
  }

  function pushCandidate(list, url, strategy, hint, bytes) {
    const absolute = absUrl(url);
    if (!absolute || !isProbablyVideoUrl(absolute)) return;
    // Dedupe by URL
    if (list.some((c) => c.url === absolute)) {
      const existing = list.find((c) => c.url === absolute);
      const next = scoreUrl(absolute, strategy, hint) + (bytes ? Math.min(20, Math.log10(bytes)) : 0);
      if (next > existing.score) {
        existing.score = next;
        existing.strategy = strategy;
        existing.hint = hint;
        if (bytes) existing.bytes = bytes;
      }
      return;
    }
    const score =
      scoreUrl(absolute, strategy, hint) +
      (bytes ? Math.min(20, Math.log10(bytes + 1)) : 0);
    list.push({ url: absolute, strategy, score, hint, bytes });
  }

  function rememberNetworkUrl(url, bytes) {
    const absolute = absUrl(url);
    if (!absolute || !isProbablyVideoUrl(absolute)) return;
    const prev = seenNetwork.get(absolute);
    seenNetwork.set(absolute, {
      url: absolute,
      bytes: bytes || prev?.bytes,
      ts: Date.now(),
    });
  }

  // ---------- Strategy A: DOM ----------

  function collectDomCandidates(card) {
    /** @type {MediaCandidate[]} */
    const out = [];
    if (!card) return out;

    const roots = [card];
    // Include a bit of parent context (menus often render outside the card)
    let p = card.parentElement;
    for (let i = 0; i < 3 && p; i += 1, p = p.parentElement) roots.push(p);

    const downloadLike = [];
    for (const root of roots) {
      const nodes = root.querySelectorAll(
        'a[download], a[href*=".mp4"], a[href*="download"], a[href*="export"],' +
        'button, [role="button"], [data-testid*="download"], [data-testid*="export"],' +
        '[aria-label*="download"], [aria-label*="Download"], [aria-label*="export"],' +
        '[aria-label*="Export"], [aria-label*="save"], [aria-label*="Save"],' +
        '[title*="download"], [title*="Download"], [title*="export"], [title*="Export"]'
      );
      downloadLike.push(...nodes);
    }

    for (const el of downloadLike) {
      const label = [
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.getAttribute('data-testid'),
        el.textContent,
      ]
        .filter(Boolean)
        .join(' ');

      const isDownload = /download|export|save|hd|4k|1080/i.test(label);
      const strategy = /export/i.test(label) ? 'dom-export' : 'dom-download';

      for (const key of ATTR_KEYS) {
        const val = el.getAttribute?.(key);
        if (val) pushCandidate(out, val, isDownload ? strategy : 'dom-data', label);
      }

      // Some buttons wrap an <a>
      const nested = el.querySelector?.('a[href]');
      if (nested?.href) {
        pushCandidate(out, nested.href, isDownload ? strategy : 'dom-data', label);
      }
    }

    // Generic data-* sweep on the card
    const walker = card.querySelectorAll?.('*') || [];
    for (const el of [card, ...walker]) {
      if (!el.getAttributeNames) continue;
      const tag = el.tagName?.toLowerCase?.();
      if (tag === 'img' || tag === 'picture' || tag === 'svg') continue;
      for (const name of el.getAttributeNames()) {
        if (!/^data-/i.test(name) && name !== 'href' && name !== 'src') continue;
        const val = el.getAttribute(name);
        if (val && /https?:|\.mp4|googleusercontent|googleapis/i.test(val)) {
          pushCandidate(out, val, 'dom-data', name);
        }
      }
    }

    return out;
  }

  // ---------- Strategy B: Embedded state ----------

  function walkJsonForVideos(node, acc, depth, cardHints) {
    if (depth > 12 || node == null) return;
    if (typeof node === 'string') {
      if (isProbablyVideoUrl(node) || /\.mp4/i.test(node)) {
        const hint = cardHints.find((h) => h && node.includes(h));
        // Prefer strings related to this card's id / filename hints
        acc.push({ url: node, related: Boolean(hint), hint: hint || 'json' });
      }
      return;
    }
    if (typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walkJsonForVideos(item, acc, depth + 1, cardHints);
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      // Key names that usually hold media
      if (
        typeof v === 'string' &&
        /(?:video|media|download|export|uri|url|src|mp4)/i.test(k)
      ) {
        walkJsonForVideos(v, acc, depth + 1, cardHints);
      } else {
        walkJsonForVideos(v, acc, depth + 1, cardHints);
      }
    }
  }

  function extractCardHints(card) {
    const hints = [];
    const attrs = [
      card.getAttribute?.('data-id'),
      card.getAttribute?.('data-asset-id'),
      card.getAttribute?.('data-generation-id'),
      card.getAttribute?.('id'),
      card.querySelector?.('[data-id]')?.getAttribute('data-id'),
    ];
    for (const a of attrs) if (a) hints.push(a);

    // Filename-ish text near the card
    const text = (card.textContent || '').slice(0, 400);
    const m = text.match(/[a-z0-9_-]{8,}\.mp4/i);
    if (m) hints.push(m[0].replace(/\.mp4$/i, ''));
    return hints.filter(Boolean);
  }

  function collectStateCandidates(card) {
    /** @type {MediaCandidate[]} */
    const out = [];
    const hints = extractCardHints(card);
    /** @type {{ url: string, related: boolean, hint: string }[]} */
    const found = [];

    // Next.js / RSC payloads
    const nextData = document.getElementById('__NEXT_DATA__');
    if (nextData?.textContent) {
      try {
        walkJsonForVideos(JSON.parse(nextData.textContent), found, 0, hints);
      } catch (e) {
        log('__NEXT_DATA__ parse failed', e);
      }
    }

    // Inline JSON script tags
    for (const script of document.querySelectorAll(
      'script[type="application/json"], script[type="application/ld+json"]'
    )) {
      if (!script.textContent || script.textContent.length > 2_000_000) continue;
      try {
        walkJsonForVideos(JSON.parse(script.textContent), found, 0, hints);
      } catch {
        /* ignore */
      }
    }

    // Lightweight regex sweep of large script contents for mp4 URLs
    for (const script of document.querySelectorAll('script:not([src])')) {
      const text = script.textContent || '';
      if (text.length < 40 || text.length > 3_000_000) continue;
      const re =
        /https?:\/\/[^"'\\\s]+?(?:\.mp4|googleusercontent\.com[^"'\\\s]*|storage\.googleapis\.com[^"'\\\s]*)/gi;
      let m;
      while ((m = re.exec(text))) {
        found.push({
          url: m[0].replace(/\\u002F/g, '/').replace(/\\+/g, ''),
          related: hints.some((h) => m[0].includes(h)),
          hint: 'script-regex',
        });
      }
    }

    // React fiber props on the card (best-effort)
    try {
      const fiberKey = Object.keys(card).find(
        (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
      );
      if (fiberKey) {
        let fiber = card[fiberKey];
        for (let i = 0; i < 25 && fiber; i += 1) {
          const props = fiber.memoizedProps || fiber.pendingProps;
          if (props) walkJsonForVideos(props, found, 0, hints);
          fiber = fiber.return;
        }
      }
    } catch (e) {
      log('react fiber walk failed', e);
    }

    for (const item of found) {
      // Boost URLs that share an id with this card
      const strategy = 'state';
      pushCandidate(out, item.url, strategy, item.hint);
      if (item.related) {
        const c = out.find((x) => x.url === absUrl(item.url));
        if (c) c.score += 35;
      }
    }

    return out;
  }

  // ---------- Strategy C: Network ----------

  function collectPerformanceCandidates() {
    /** @type {MediaCandidate[]} */
    const out = [];
    try {
      const entries = performance.getEntriesByType('resource');
      for (const entry of entries) {
        const url = entry.name;
        if (!isProbablyVideoUrl(url)) continue;
        const bytes = entry.transferSize || entry.encodedBodySize || 0;
        rememberNetworkUrl(url, bytes);
        pushCandidate(out, url, 'network', 'performance', bytes);
      }
    } catch (e) {
      log('performance entries failed', e);
    }

    for (const { url, bytes } of seenNetwork.values()) {
      pushCandidate(out, url, 'network', 'sniffer', bytes);
    }
    return out;
  }

  async function collectBackgroundCandidates(cardHints) {
    /** @type {MediaCandidate[]} */
    const out = [];
    const MSG = CFG?.messages;
    if (!MSG?.LOOKUP_MEDIA || !chrome?.runtime?.sendMessage) return out;

    try {
      const response = await chrome.runtime.sendMessage({
        type: MSG.LOOKUP_MEDIA,
        hints: cardHints,
        pageUrl: location.href,
      });
      if (!response?.ok || !Array.isArray(response.urls)) return out;
      for (const item of response.urls) {
        const url = typeof item === 'string' ? item : item.url;
        const bytes = typeof item === 'object' ? item.bytes : undefined;
        pushCandidate(out, url, 'network', 'webRequest', bytes);
        if (bytes) rememberNetworkUrl(url, bytes);
      }
    } catch (e) {
      log('background LOOKUP_MEDIA failed', e);
    }
    return out;
  }

  // ---------- Strategy D: Preview video (last resort) ----------

  function collectPreviewCandidates(card) {
    /** @type {MediaCandidate[]} */
    const out = [];
    if (!card) return out;

    const video = card.querySelector('video');
    if (video) {
      const src = video.currentSrc || video.src;
      if (src && !src.startsWith('blob:')) {
        pushCandidate(out, src, 'preview', 'video.currentSrc');
      }
      for (const source of video.querySelectorAll('source[src]')) {
        pushCandidate(out, source.src, 'preview', 'video>source');
      }
    }
    return out;
  }

  // Gemini-specific DOM extractor: chat overlay images and generated media
  function collectGeminiCandidates(card) {
    /** @type {MediaCandidate[]} */
    const out = [];
    if (!card) return out;

    // Search nearby overlays / message nodes for image/video elements
    const roots = [card];
    let p = card.parentElement;
    for (let i = 0; i < 4 && p; i += 1, p = p.parentElement) roots.push(p);

    for (const root of roots) {
      if (!root) continue;
      for (const video of root.querySelectorAll('video[src]')) {
        pushCandidate(out, video.currentSrc || video.src, 'preview', 'gemini-video');
      }

      for (const a of root.querySelectorAll('a[href*=".mp4"], a[download]')) {
        pushCandidate(out, a.href, 'dom-download', 'gemini-link');
      }
    }

    return out;
  }

  /**
   * Probe candidates with HEAD (extension may still fail from page context —
   * soft ranking only). Prefer larger payloads and video/mp4.
   */
  async function refineByHead(candidates, limit = 5) {
    const top = [...candidates].sort((a, b) => b.score - a.score).slice(0, limit);
    await Promise.all(
      top.map(async (c) => {
        if (c.bytes && c.bytes > 0) return;
        try {
          // Delegate HEAD probes to the extension background/service worker so
          // probes run with host_permissions and avoid page CORS/CSP issues.
          const msg = { type: CFG.messages.HEAD_PROBE, url: c.url };
          const sendMsg = () =>
            new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
          const timeout = (ms) =>
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
          const probe = await Promise.race([sendMsg(), timeout(2500)]).catch((e) => ({ ok: false, error: String(e?.message || e) }));

          if (!probe || probe.ok === false) {
            c.hint = `${c.hint || ''}|head-probe-failed`;
            return;
          }

          if (!probe.responseOk) {
            // Offscreen/background may still succeed or the URL is restricted
            c.hint = `${c.hint || ''}|head:${probe.status}`;
            return;
          }

          const type = (probe.headers?.['content-type'] || '').toLowerCase();
          if (type.startsWith('image/')) {
            c.score = -999;
            c.hint = 'rejected-image';
            return;
          }
          // Strictly reject JSON, manifest, and plain-text responses
          if (
            type &&
            (/application\/json/i.test(type) ||
              /application\/manifest\+json/i.test(type) ||
              /text\//i.test(type))
          ) {
            c.score = -999;
            c.hint = `${c.hint || ''}|rejected-non-media`;
            return;
          }

          const len = Number(probe.headers?.['content-length']) || 0;
          const contentType = probe.headers?.['content-type'] || '';
          if (len) {
            c.bytes = len;
            c.score += Math.min(25, Math.log10(len + 1) * 3);
          }
          if (/video\//i.test(contentType)) c.score += 15;
          if (/text\/html|application\/json/i.test(contentType)) c.score -= 40;
          c.hint = `${c.hint || ''}|${contentType}|${len}`;
        } catch (e) {
          c.hint = `${c.hint || ''}|head-probe-error`;
          log('HEAD probe failed', c.url, e?.name || e);
        }
      })
    );
    return candidates;
  }

  /**
   * Phantom-click Google Flow's native Radix UI download trigger, wait for the
   * dropdown menu to open, click the 1080p (or 720p fallback) export item, and
   * await the background service-worker capturing the 307 redirect URL from
   * media.getMediaUrlRedirect (..._upsampled).
   *
   * @param {Element} card  - the video card element (UUID extracted from <video src>)
   * @param {number}  [timeoutMs=8000]
   * @returns {Promise<MediaCandidate>}
   */
  async function forceNetworkIntercept(card, timeoutMs = 15000) {
    const TRIGGER_WAIT_MS = 2000;
    const UPSAMPLED_SUFFIX = '_upsampled';
    const MENU_SELECTOR =
      '[data-radix-menu-content], [role="menu"], [role="dialog"], .radix-themes-DropdownMenuContent';

    function isVisibleEl(el) {
      if (!el) return false;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      if (el.offsetParent === null && style.position !== 'fixed') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }

    function isVisuallyHiddenClip(el) {
      try {
        const clip = getComputedStyle(el).clip || '';
        return /^rect\(\s*0(?:px)?\s*,\s*0(?:px)?\s*,\s*0(?:px)?\s*,\s*0(?:px)?\s*\)$/i.test(
          clip.trim()
        );
      } catch {
        return false;
      }
    }

    /** Fact #1: <button> with google-symbols "download" icon + hidden "Download" span. */
    function isDownloadTrigger(btn) {
      if (!btn || btn.tagName !== 'BUTTON') return false;
      const hasIcon = Array.from(btn.querySelectorAll('i')).some((icon) => {
        const cls = typeof icon.className === 'string' ? icon.className : String(icon.className || '');
        return (
          /google-symbols/i.test(cls) &&
          (icon.textContent || '').trim().toLowerCase() === 'download'
        );
      });
      if (!hasIcon) return false;
      return Array.from(btn.querySelectorAll('span')).some(
        (span) =>
          (span.textContent || '').trim() === 'Download' && isVisuallyHiddenClip(span)
      );
    }

    function findTriggerNow() {
      return (
        Array.from(document.querySelectorAll('button')).find(
          (el) => isVisibleEl(el) && isDownloadTrigger(el)
        ) || null
      );
    }

    function waitForElement(findFn, timeoutMsInner, rejectMessage) {
      return new Promise((resolve, reject) => {
        const existing = findFn();
        if (existing) {
          resolve(existing);
          return;
        }
        let settled = false;
        let pollId = null;
        let timerId = null;
        const observer = new MutationObserver(() => {
          const el = findFn();
          if (el) finish(() => resolve(el));
        });

        function finish(fn) {
          if (settled) return;
          settled = true;
          observer.disconnect();
          if (pollId != null) clearInterval(pollId);
          if (timerId != null) clearTimeout(timerId);
          fn();
        }

        observer.observe(document.documentElement, { childList: true, subtree: true });
        pollId = setInterval(() => {
          const el = findFn();
          if (el) finish(() => resolve(el));
        }, 100);
        timerId = setTimeout(() => {
          finish(() => reject(new Error(rejectMessage)));
        }, timeoutMsInner);
      });
    }

    function extractCardUuid(cardEl) {
      const video = cardEl?.querySelector?.('video[src*="getMediaUrlRedirect"]');
      if (!video) {
        console.warn(
          LOG,
          'card UUID: no video[src*=getMediaUrlRedirect] — correlation will fall back to tabId'
        );
        return null;
      }
      try {
        const src = video.getAttribute('src') || '';
        const u = new URL(src, location.origin);
        const name = u.searchParams.get('name');
        if (!name) {
          console.warn(
            LOG,
            'card UUID: video src missing name param — correlation will fall back to tabId'
          );
          return null;
        }
        // Preview src is the bare UUID (no _upsampled suffix).
        return name.endsWith(UPSAMPLED_SUFFIX)
          ? name.slice(0, -UPSAMPLED_SUFFIX.length)
          : name;
      } catch (e) {
        console.warn(LOG, 'card UUID: failed to parse video src — tabId fallback', e?.message || e);
        return null;
      }
    }

    // ── Step 1: UUID Extraction ──────────────────────────────────────────────
    const cardUuid = extractCardUuid(card);
    console.log(LOG, 'Step 1: UUID Extraction — cardUuid =', cardUuid);

    // ── Step 2: ID Generation ────────────────────────────────────────────────
    const requestId = crypto.randomUUID();
    console.log(LOG, 'Step 2: ID Generation — requestId =', requestId);

    // ── Step 3: Arm Background ──────────────────────────────────────────────
    console.log(LOG, 'Step 3: Arm Background — sending EXPECT_CAPTURE', { requestId, cardUuid, timeoutMs });
    try {
      await new Promise((res) =>
        chrome.runtime.sendMessage(
          {
            type: CFG.messages.EXPECT_CAPTURE,
            requestId,
            cardUuid,
            timeoutMs,
          },
          res
        )
      );
    } catch (e) {
      log('phantom-click: EXPECT_CAPTURE failed (non-fatal)', e?.message || e);
    }

    // ── Step 4: Find Trigger Button (MutationObserver ~2s max) ──────────────
    console.log(LOG, 'Step 4: Find Trigger Button — waiting (max', TRIGGER_WAIT_MS, 'ms)');
    const trigger = await waitForElement(
      findTriggerNow,
      TRIGGER_WAIT_MS,
      'Trigger button not found'
    );
    console.log(LOG, 'Step 4: Trigger found', {
      tag: trigger.tagName,
      text: (trigger.textContent || '').trim().slice(0, 60),
    });

    // ── Steps 5–10. Click → optional menu → await sniffed URL (cleanup on exit) ─
    return new Promise((resolve, reject) => {
      let settled = false;
      let captureTimer = null;
      let onSniffed = null;

      function cleanup() {
        console.log(LOG, 'Step 10: Cleanup — removing all observers and listeners');
        if (captureTimer != null) {
          clearTimeout(captureTimer);
          captureTimer = null;
        }
        if (onSniffed) {
          chrome.runtime.onMessage.removeListener(onSniffed);
          onSniffed = null;
        }
      }

      function settle(fn) {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      }

      // Register sniff listener before clicks so we cannot miss the redirect.
      // ── Step 9: Await Network (Message Listener) ────────────────────────
      console.log(LOG, 'Step 9: Await Network — listening for URL_SNIFFED with requestId', requestId);
      onSniffed = (message) => {
        if (message?.type !== CFG.messages.URL_SNIFFED) return;
        if (message.requestId !== requestId) {
          console.log(LOG, 'Step 9: URL_SNIFFED requestId mismatch — ignoring', message.requestId);
          return;
        }
        if (!message.url) return;
        console.log(LOG, 'Step 9: URL_SNIFFED received ✓', {
          url: String(message.url).slice(0, 120),
          expiresAt: message.expiresAt,
        });
        settle(() =>
          resolve({
            url: message.url,
            strategy: 'phantom-click',
            score: 100,
            bytes: 0,
            expiresAt: message.expiresAt,
            capturedAt: message.expiresAt || Date.now(),
          })
        );
      };
      chrome.runtime.onMessage.addListener(onSniffed);

      // Ultimate timeout — menu absence is non-fatal; only network silence fails.
      captureTimer = setTimeout(() => {
        settle(() =>
          reject(
            new Error(
              'Auto-intercept timed out. The server took too long to generate the HD link.'
            )
          )
        );
      }, timeoutMs);

      // ── Step 5: Click the trigger button ─────────────────────────────────
      const nativeBtn = trigger;
      try {
        nativeBtn.dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true, cancelable: true, view: window })
        );
        nativeBtn.dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window })
        );
        nativeBtn.dispatchEvent(
          new PointerEvent('pointerup', { bubbles: true, cancelable: true, view: window })
        );
        nativeBtn.dispatchEvent(
          new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window })
        );
        nativeBtn.click();
        console.log('[CleanFrame:source] Trigger button clicked.');
      } catch (clickErr) {
        nativeBtn.click();
      }

      // ── Steps 6 & 7: OPTIONAL menu handling (non-blocking) ───────────────
      // Fire-and-forget: if Flow skips the menu and downloads directly,
      // onSniffed still resolves the main promise.
      const lookForMenu = async () => {
        for (let i = 0; i < 15; i++) {
          if (settled) return;
          await new Promise((r) => setTimeout(r, 100)); // poll every 100ms
          if (settled) return;

          const menu = document.querySelector(MENU_SELECTOR);
          if (!menu) continue;

          console.log('[CleanFrame:source] Menu found, searching for export option...');
          const menuItems = Array.from(
            menu.querySelectorAll('[role="menuitem"], button')
          );

          let exportBtn = menuItems.find((item) => {
            const text = (item.textContent || '').toLowerCase();
            const isDisabled =
              item.getAttribute('aria-disabled') === 'true' || item.disabled;
            return text.includes('1080p') && !isDisabled;
          });

          if (!exportBtn) {
            exportBtn = menuItems.find((item) => {
              const text = (item.textContent || '').toLowerCase();
              const isDisabled =
                item.getAttribute('aria-disabled') === 'true' || item.disabled;
              return (
                (text.includes('720p') ||
                  text.includes('original') ||
                  text.includes('download')) &&
                !isDisabled
              );
            });
          }

          if (exportBtn) {
            console.log('[CleanFrame:source] Export option found, clicking...');
            exportBtn.click();
          }
          return; // Menu handled (or empty), exit the poll
        }
        console.log(
          '[CleanFrame:source] No menu appeared. Assuming direct download triggered.'
        );
      };

      lookForMenu();
    });
  }

  /**
   * Resolve the best HD / download URL for a Flow video card.
   * @param {Element} videoCardElement
   * @returns {Promise<{ url: string, strategy: string, score: number, candidates: MediaCandidate[] }>}
   */
  async function getHighResVideoUrl(videoCardElement) {
    const card = videoCardElement;
    if (!card) throw new Error('getHighResVideoUrl: card element required');

    const hints = extractCardHints(card);
    log('resolving HD source', { hints });

    /** @type {MediaCandidate[]} */
    let candidates = [];

    // A
    // For Gemini, run Gemini-specific DOM sweep first
    if (CFG && CFG.platform === 'gemini') {
      const gem = collectGeminiCandidates(card);
      candidates = candidates.concat(gem);
      log(`strategy A (gemini-dom): ${gem.length} candidates`);
    }
    candidates = candidates.concat(collectDomCandidates(card));
    log(`strategy A (DOM): ${candidates.length} candidates`);

    // B
    const state = collectStateCandidates(card);
    candidates = candidates.concat(state);
    log(`strategy B (state): +${state.length}`);

    // C
    const perf = collectPerformanceCandidates();
    const bg = await collectBackgroundCandidates(hints);
    candidates = candidates.concat(perf, bg);
    log(`strategy C (network): +${perf.length} perf, +${bg.length} bg`);

    // D — only if we have nothing stronger
    const preview = collectPreviewCandidates(card);
    candidates = candidates.concat(preview);

    // Merge dupes already handled in pushCandidate path for new lists —
    // re-merge here for concatenated arrays
    const merged = [];
    for (const c of candidates) {
      pushCandidate(merged, c.url, c.strategy, c.hint, c.bytes);
      const last = merged.find((x) => x.url === absUrl(c.url));
      if (last && c.score > last.score) last.score = c.score;
    }

    if (!merged.length) {
      log('no candidates found — attempting phantom-click intercept');
      try {
        const phantom = await forceNetworkIntercept(card);
        pushCandidate(merged, phantom.url, phantom.strategy, 'phantom-click', phantom.bytes);
        log('phantom-click resolved:', phantom.url.slice(0, 120));
      } catch (e) {
        throw new Error(
          `No video URL found and auto-intercept failed (${e.message}). ` +
          'Open the clip, wait for it to load, or click Flow’s Download button once so CleanFrame can sniff the HD URL.'
        );
      }
    }

    await refineByHead(merged);

    // Drop any candidate flagged as an image, non-media, or with a negative score
    const viable = merged.filter((c) => {
      const h = (c.hint || '').toLowerCase();
      if (h.includes('image/')) return false;
      if (h.includes('rejected-')) return false;
      if (c.score < 0) return false;
      return true;
    });

    if (!viable.length) {
      log('all candidates filtered out — attempting phantom-click intercept');
      try {
        const phantom = await forceNetworkIntercept(card);
        viable.push({ url: phantom.url, strategy: phantom.strategy, score: phantom.score, hint: 'phantom-click', bytes: phantom.bytes });
        log('phantom-click resolved after filter:', phantom.url.slice(0, 120));
      } catch (e) {
        throw new Error(
          `No valid video candidates remain and auto-intercept failed (${e.message}). ` +
          'Use Flow’s Download button so CleanFrame can capture the HD URL.'
        );
      }
    }

    viable.sort((a, b) => b.score - a.score);
    const best = viable[0];

    // Prefer non-preview if scores are close
    const nonPreview = viable.find((c) => c.strategy !== 'preview');
    const chosen =
      nonPreview && best.strategy === 'preview' && best.score - nonPreview.score < 15
        ? nonPreview
        : best;

    log('chosen source', {
      url: chosen.url.slice(0, 120),
      strategy: chosen.strategy,
      score: chosen.score,
      bytes: chosen.bytes,
      totalCandidates: merged.length,
    });

    return {
      url: chosen.url,
      strategy: chosen.strategy,
      score: chosen.score,
      bytes: chosen.bytes,
      candidates: merged.slice(0, 12),
    };
  }

  /** Legacy helper — preview-only; prefer getHighResVideoUrl */
  function resolveVideoUrl(card) {
    const preview = collectPreviewCandidates(card);
    const dom = collectDomCandidates(card);
    const all = [...dom, ...preview].sort((a, b) => b.score - a.score);
    return all[0]?.url || null;
  }

  /**
   * Observe resource timing for media URLs.
   * CSP on Google Flow forbids inline <script> injection — do NOT patch page fetch/XHR.
   * HD URLs also come from chrome.webRequest in the service worker.
   */
  function startPerformanceSniffer() {
    if (document.documentElement.dataset.cleanframeSniffer === '1') return;
    document.documentElement.dataset.cleanframeSniffer = '1';

    try {
      const po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          rememberNetworkUrl(entry.name, entry.transferSize || entry.encodedBodySize);
        }
      });
      po.observe({ type: 'resource', buffered: true });
      log('PerformanceObserver media sniffer active (no inline scripts)');
    } catch (e) {
      log('PerformanceObserver unavailable', e);
    }
  }

  root.CleanFrameSource = {
    getHighResVideoUrl,
    resolveVideoUrl,
    rememberNetworkUrl,
    startPerformanceSniffer,
    scoreUrl,
  };
})(typeof self !== 'undefined' ? self : window);
