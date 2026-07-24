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

  function isProbablyVideoUrl(url) {
    if (!url) return false;
    if (url.startsWith('blob:') || url.startsWith('data:')) return false;
    if (MP4_LIKE.test(url)) return true;
    if (MEDIA_HOST.test(url) && /video|mp4|media|download|export/i.test(url)) return true;
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
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 2500);
          const res = await fetch(c.url, {
            method: 'HEAD',
            mode: 'cors',
            credentials: 'include',
            signal: ctrl.signal,
          });
          clearTimeout(timer);
          if (!res.ok) {
            // CORS opaque / blocked — don't discard; offscreen has host_permissions
            c.hint = `${c.hint || ''}|head:${res.status}`;
            return;
          }
          const len = Number(res.headers.get('content-length')) || 0;
          const type = res.headers.get('content-type') || '';
          if (len) {
            c.bytes = len;
            c.score += Math.min(25, Math.log10(len + 1) * 3);
          }
          if (/video\//i.test(type)) c.score += 15;
          if (/text\/html|application\/json/i.test(type)) c.score -= 40;
          c.hint = `${c.hint || ''}|${type}|${len}`;
        } catch (e) {
          // Expected for many CDNs from the page world — offscreen fetch still works.
          c.hint = `${c.hint || ''}|head-cors-blocked`;
          log('HEAD probe blocked (ok if host_permissions cover it)', c.url, e?.name);
        }
      })
    );
    return candidates;
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
      throw new Error(
        'No video URL found. Open the clip, wait for it to load, or use Flow’s Download once so CleanFrame can sniff the HD URL.'
      );
    }

    await refineByHead(merged);

    merged.sort((a, b) => b.score - a.score);
    const best = merged[0];

    // Prefer non-preview if scores are close
    const nonPreview = merged.find((c) => c.strategy !== 'preview');
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

  function startPerformanceSniffer() {
    try {
      const po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          rememberNetworkUrl(entry.name, entry.transferSize || entry.encodedBodySize);
        }
      });
      po.observe({ type: 'resource', buffered: true });
    } catch {
      /* PerformanceObserver resource type may be unavailable */
    }

    // MAIN-world sniffer: capture fetch/XHR media URLs Flow loads for previews & downloads
    try {
      if (document.documentElement.dataset.cleanframeSniffer === '1') return;
      document.documentElement.dataset.cleanframeSniffer = '1';

      const script = document.createElement('script');
      script.textContent = `
        (function () {
          if (window.__cleanframeSniffer) return;
          window.__cleanframeSniffer = true;
          function looksMedia(url) {
            if (!url) return false;
            var s = String(url);
            return /\\.mp4(?:\\?|#|$)/i.test(s) ||
              /googleusercontent\\.com/i.test(s) ||
              /storage\\.googleapis\\.com/i.test(s) ||
              /alt=media/i.test(s) ||
              /video%2Fmp4/i.test(s);
          }
          function emit(url) {
            if (!looksMedia(url)) return;
            try {
              window.postMessage({ source: 'cleanframe-sniffer', url: String(url) }, '*');
            } catch (e) {}
          }
          var ofetch = window.fetch;
          if (ofetch) {
            window.fetch = function () {
              try {
                var a = arguments[0];
                emit(a && typeof a === 'object' && a.url ? a.url : a);
              } catch (e) {}
              return ofetch.apply(this, arguments).then(function (res) {
                try { emit(res && res.url); } catch (e) {}
                return res;
              });
            };
          }
          var open = XMLHttpRequest.prototype.open;
          XMLHttpRequest.prototype.open = function (method, url) {
            try { emit(url); } catch (e) {}
            return open.apply(this, arguments);
          };
        })();
      `;
      (document.documentElement || document.head).appendChild(script);
      script.remove();

      window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        if (event.data?.source !== 'cleanframe-sniffer') return;
        rememberNetworkUrl(event.data.url);
      });
    } catch (e) {
      log('MAIN-world sniffer inject failed', e);
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
