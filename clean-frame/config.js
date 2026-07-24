/**
 * CleanFrame — shared configuration
 * Loaded by content scripts and the offscreen pipeline.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CLEANFRAME_CONFIG = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  return Object.freeze({
    name: 'CleanFrame',
    version: '0.1.0',

    /** Google Flow origins we operate on */
    hosts: Object.freeze([
      'labs.google.com',
      'labs.google',
    ]),

    /**
     * Heuristic selectors for video cards / thumbnails on Flow.
     * Ordered from most specific → most general. The injector tries each
     * and only injects once per card (data-cleanframe-injected).
     */
    cardSelectors: Object.freeze([
      '[data-testid*="video"]',
      '[data-testid*="media"]',
      '[data-testid*="asset"]',
      '[data-testid*="generation"]',
      'article:has(video)',
      '[role="listitem"]:has(video)',
      '[role="gridcell"]:has(video)',
      'div:has(> video)',
      'div:has(video[src]), div:has(video source)',
    ]),

    /** Elements that usually expose a downloadable / playable video URL */
    videoSelectors: Object.freeze([
      'video[src]',
      'video source[src]',
      'a[href*=".mp4"]',
      'a[download]',
    ]),

    ui: Object.freeze({
      buttonLabel: 'CleanFrame',
      buttonAttr: 'data-cleanframe-btn',
      boundAttr: 'data-cleanframe-injected',
      processingAttr: 'data-cleanframe-processing',
      styleId: 'cleanframe-styles',
      overlayId: 'cleanframe-overlay-container',
      zIndex: 2147483000,
    }),

    /**
     * Default Veo / Flow visible-watermark profile.
     * Position is dynamic — webgl-processor runs a detection pass first.
     * These values are fallbacks / search priors, not hard locks.
     */
    watermark: Object.freeze({
      // Semi-transparent light gray / white "veo" / "Made with Veo" tint
      color: Object.freeze([0.92, 0.92, 0.94]),
      alpha: 0.55,
      // Normalized search prior (bottom-right region)
      searchRegion: Object.freeze({ x: 0.65, y: 0.78, w: 0.35, h: 0.22 }),
      // Detection scan stride in pixels (lighter = faster)
      detectStride: 4,
      // Minimum alpha-pattern confidence to accept a bbox
      detectConfidence: 0.62,
      // If detected alpha ≈ 1.0, fall back to spatial blur
      opaqueAlphaThreshold: 0.98,
      blurRadiusPx: 6,
    }),

    pipeline: Object.freeze({
      // Never hold more than this many decoded frames in flight
      maxInFlightFrames: 3,
      // Keyframe interval for the re-encode pass
      keyFrameEvery: 60,
      // Default target bitrate (bps) — tuned per resolution later
      bitrate: 8_000_000,
      // Chunk size when reading the fetch ReadableStream
      fetchChunkBytes: 256 * 1024,
    }),

    messages: Object.freeze({
      ENSURE_OFFSCREEN: 'CLEANFRAME_ENSURE_OFFSCREEN',
      PROCESS_VIDEO: 'CLEANFRAME_PROCESS_VIDEO',
      PROCESS_PROGRESS: 'CLEANFRAME_PROCESS_PROGRESS',
      PROCESS_DONE: 'CLEANFRAME_PROCESS_DONE',
      PROCESS_ERROR: 'CLEANFRAME_PROCESS_ERROR',
      PING: 'CLEANFRAME_PING',
      /** Content → SW: ask for recently sniffed HD media URLs */
      LOOKUP_MEDIA: 'CLEANFRAME_LOOKUP_MEDIA',
      /** SW → content: a high-res media URL was observed on the network */
      MEDIA_SEEN: 'CLEANFRAME_MEDIA_SEEN',
    }),

    /**
     * URL patterns treated as high-value download / media hosts when sniffing.
     */
    mediaUrlPatterns: Object.freeze([
      '.mp4',
      'alt=media',
      'googleusercontent.com',
      'storage.googleapis.com',
    ]),
  });
});
