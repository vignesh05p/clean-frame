/**
 * CleanFrame — memory-safe streaming pipeline.
 *
 * fetch ReadableStream
 *   → chunked mp4box demux (video + untouched audio)
 *   → WebCodecs VideoDecoder (bounded in-flight)
 *   → WebGL2 reverse-alpha
 *   → WebCodecs VideoEncoder
 *   → mp4box remux + FileSystemWritableFileStream / Blob download
 */
(function (root) {
  'use strict';

  const CFG = root.CLEANFRAME_CONFIG;
  const LOG_PREFIX = '[CleanFrame:pipeline]';

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }
  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }
  function error(...args) {
    console.error(LOG_PREFIX, ...args);
  }

  function getMP4Box() {
    const api = root.MP4Box || (typeof MP4Box !== 'undefined' ? MP4Box : null);
    if (!api?.createFile) {
      throw new Error('mp4box.js is not loaded (MP4Box.createFile missing)');
    }
    return api;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Copy a TypedArray/ArrayBufferView into a detached ArrayBuffer (safe for mp4box). */
  function copyToArrayBuffer(view) {
    const ab = new ArrayBuffer(view.byteLength);
    new Uint8Array(ab).set(
      view instanceof Uint8Array
        ? view
        : new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    );
    return ab;
  }

  /**
   * Extract avcC / hvcC / vpcC / av1C description for VideoDecoderConfig.
   * Strips the ISO BMFF box header (first 8 bytes) — WebCodecs expects the
   * raw decoder configuration record only.
   */
  function getVideoDescription(mp4file, trackId) {
    const trak = mp4file.getTrackById(trackId);
    if (!trak) throw new Error(`Video track ${trackId} not found`);

    const entries = trak.mdia?.minf?.stbl?.stsd?.entries || [];
    for (const entry of entries) {
      const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
      if (!box) continue;

      const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
      box.write(stream);
      // Remove 4-byte size + 4-byte type
      const desc = new Uint8Array(stream.buffer, 8);
      log(
        `video description track=${trackId} box=${box.type || '?'} bytes=${desc.byteLength}`
      );
      return desc;
    }

    // Some codecs (e.g. raw vp8) have no description box
    warn(`No avcC/hvcC/vpcC/av1C on track ${trackId} — decoder may fail`);
    return undefined;
  }

  /**
   * Keep the full sample-entry / esds box so remux can rebuild an AAC track
   * without re-encoding.
   */
  function getAudioDescriptionBox(mp4file, trackId) {
    const trak = mp4file.getTrackById(trackId);
    if (!trak) return null;
    const entry = trak.mdia?.minf?.stbl?.stsd?.entries?.[0];
    if (!entry) return null;

    // Prefer the esds child when present (mp4a)
    if (entry.esds) {
      log(`audio description: esds on track ${trackId}`);
      return entry.esds;
    }
    log(`audio description: full sample entry type=${entry.type} track=${trackId}`);
    return entry;
  }

  function normalizeCodec(codec) {
    if (!codec) return 'avc1.4D4028';
    // Chrome only accepts short vp8 / vp9 labels
    if (codec.startsWith('vp08')) return 'vp8';
    if (codec.startsWith('vp09')) return 'vp9';
    return codec;
  }

  function pickEncoderCodec(_width, _height) {
    // Always Main Profile, Level 4.0 — safely supports 720p and 1080p coded area
    return 'avc1.4D4028';
  }

  /**
   * Process a remote (or blob) video URL through the streaming pipeline.
   * @param {object} options
   * @returns {Promise<{ ok: true, filename?: string, blobUrl?: string }>}
   */
  async function processVideo(options) {
    const {
      jobId,
      videoUrl,
      watermark = CFG?.watermark,
      onProgress = () => {},
      writable = null,
    } = options;

    if (!videoUrl) throw new Error('videoUrl is required');
    if (typeof VideoDecoder === 'undefined' || typeof VideoEncoder === 'undefined') {
      throw new Error('WebCodecs API unavailable in this context');
    }

    const lowerUrl = (videoUrl || '').toLowerCase();
    if (/\.(webm|m3u8)(\?|$)/i.test(lowerUrl)) {
      throw new Error(`Unsupported media format for MP4Box demuxer: ${videoUrl}`);
    }

    onProgress(0.02, 'Fetching…');
    log(`job=${jobId} fetch ${videoUrl}`);

    // Pre-signed CDN URLs (Signature=…) must use credentials:'omit'.
    // credentials:'include' + ACAO:* is a CORS error on flow-content.google*.
    const response = await fetch(videoUrl, { credentials: 'omit', mode: 'cors' });
    log('[CleanFrame:Diagnostic] response.type=', response.type, 'status=', response.status, 'url=', videoUrl.slice(0, 160));

    if (response.type === 'opaque' || response.type === 'opaqueredirect') {
      throw new Error('Opaque response received due to strict CORS. Cannot demux.');
    }

    try {
      const headersDump = [];
      response.headers.forEach((v, k) => headersDump.push(`${k}: ${v}`));
      log('[CleanFrame:Diagnostic] response.headers:', headersDump.join(' | ') || '(none visible)');
    } catch (e) {
      warn('[CleanFrame:Diagnostic] cannot enumerate headers', e);
    }

    if (/\.webm(?:$|\?|#)/i.test(videoUrl) || /\.m3u8(?:$|\?|#)/i.test(videoUrl)) {
      throw new Error('Unsupported media URL (WebM/HLS). CleanFrame requires progressive MP4. URL: ' + videoUrl.slice(0, 160));
    }

    if (!response.ok) throw new Error(`Fetch failed: HTTP ${response.status}`);
    if (!response.body) throw new Error('ReadableStream body unavailable');

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType.startsWith('image/')) {
      throw new Error('Invalid video source. Server returned an image (' + contentType + '). The source resolver targeted a thumbnail instead of the video stream.');
    }
    if (/^image\//i.test(contentType)) {
      throw new Error('Invalid video source (server returned image content): ' + contentType);
    }
    if (/text\/|application\/xml|application\/json/.test(contentType)) {
      // CDN returned an error document — do not feed it to mp4box
      const textContent = (await response.text()).slice(0, 200);
      throw new Error(
        'Invalid video source (Server returned ' + contentType + '): ' + textContent
      );
    }
    log(`content-type=${contentType || '(none)'} — proceeding to demux`);

    const contentLength = Number(response.headers.get('content-length')) || 0;
    onProgress(0.06, 'Demuxing…');

    const demux = await createChunkedDemuxer(response.body, {
      chunkBytes: CFG?.pipeline?.fetchChunkBytes ?? 256 * 1024,
      contentLength,
      onProgress: (r) => onProgress(0.06 + r * 0.14, 'Demuxing…'),
    });

    log(
      `demux ready codec=${demux.videoCodec} ${demux.width}x${demux.height}` +
        ` fps≈${demux.framerate} frames≈${demux.estimatedFrames}` +
        ` audio=${demux.audioTrack ? 'yes' : 'no'}`
    );

    onProgress(0.22, 'Decoding…');

    const processor = root.CleanFrameWebGL?.createProcessor?.(watermark);
    if (!processor) throw new Error('WebGL processor unavailable');

    /** @type {{ chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata }[]} */
    const encodedChunks = [];
    const maxInFlight = CFG?.pipeline?.maxInFlightFrames ?? 3;
    const keyFrameEvery = CFG?.pipeline?.keyFrameEvery ?? 60;

    let framesDecoded = 0;
    let framesEncoded = 0;
    let decodeError = null;
    let encodeError = null;

    // Serialize GPU work — VideoDecoder does not await async output callbacks.
    /** @type {Promise<void>} */
    let frameChain = Promise.resolve();
    let inFlight = 0;

    // Force dimensions to be strictly even integers (Hardware encoders crash on odd numbers)
    const encWidth = Math.max(2, Math.floor(demux.width / 2) * 2);
    const encHeight = Math.max(2, Math.floor(demux.height / 2) * 2);

    const encoderCodec = 'avc1.4D4028'; // Main@4.0 — never use Level 3.x for HD
    let encoderConfig = {
      codec: encoderCodec,
      width: encWidth,
      height: encHeight,
      bitrate: CFG?.pipeline?.bitrate ?? 8_000_000,
      framerate: demux.framerate || 24,
      avc: { format: 'avc' },
      hardwareAcceleration: 'prefer-hardware',
    };

    log('encoder configure (initial)', encoderConfig);

    // Safely check if the browser/GPU supports this config
    try {
      const support = await VideoEncoder.isConfigSupported(encoderConfig);
      if (!support.supported) {
        warn('Primary encoder config rejected by GPU. Falling back to HD compatible profile...');
        encoderConfig.codec = 'avc1.4D4028'; // Main Profile, Level 4.0 (Supports 720p/1080p)
        encoderConfig.hardwareAcceleration = 'no-preference';
      } else if (support.config?.codec) {
        // Prefer browser-adjusted config, but never accept Level 3.x
        const suggested = support.config.codec;
        encoderConfig = { ...encoderConfig, ...support.config };
        if (/1[Ee]$/i.test(suggested) || /42001[EeFf]$/i.test(suggested) || /42E01E/i.test(suggested)) {
          warn('isConfigSupported suggested Level 3.x — forcing avc1.4D4028', suggested);
          encoderConfig.codec = 'avc1.4D4028';
        }
      }
    } catch (supportErr) {
      warn('isConfigSupported check failed, attempting HD fallback anyway', supportErr);
      encoderConfig.codec = 'avc1.4D4028';
      encoderConfig.hardwareAcceleration = 'no-preference';
    }

    // Final hard guarantee — VideoEncoder must never see Level 3.0 / 3.1 Baseline
    encoderConfig.codec = 'avc1.4D4028';
    log('encoder configure (final)', encoderConfig);

    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        encodedChunks.push({ chunk, meta });
        framesEncoded += 1;
        if (framesEncoded === 1) {
          log(
            'first encoded chunk',
            `type=${chunk.type}`,
            `ts=${chunk.timestamp}`,
            `desc=${meta?.decoderConfig?.description ? 'yes' : 'no'}`
          );
        }
      },
      error: (e) => {
        encodeError = e;
        error('VideoEncoder failed during processing:', e);
      },
    });

    try {
      encoder.configure(encoderConfig);
    } catch (configErr) {
      throw new Error(`Encoder creation error: ${configErr.message}`);
    }

    const decoderConfig = {
      codec: demux.videoCodec,
      codedWidth: demux.width,
      codedHeight: demux.height,
    };
    if (demux.description) {
      decoderConfig.description = demux.description;
    }
    log('decoder configure', {
      codec: decoderConfig.codec,
      codedWidth: decoderConfig.codedWidth,
      codedHeight: decoderConfig.codedHeight,
      hasDescription: Boolean(decoderConfig.description),
    });

    const decoder = new VideoDecoder({
      output: (frame) => {
        inFlight += 1;
        frameChain = frameChain.then(async () => {
          try {
            if (decodeError || encodeError) {
              frame.close();
              return;
            }
            const cleaned = await processor.processFrame(frame);
            frame.close();

            if (encoder.state !== 'configured') {
              cleaned.close();
              return;
            }

            encoder.encode(cleaned, {
              keyFrame: framesDecoded % keyFrameEvery === 0,
            });
            cleaned.close();

            framesDecoded += 1;
            const est = demux.estimatedFrames || 0;
            const ratio = est
              ? Math.min(0.9, 0.22 + (framesDecoded / est) * 0.68)
              : Math.min(0.9, 0.22 + framesDecoded * 0.002);
            onProgress(ratio, `${framesDecoded} frames`);
          } catch (e) {
            decodeError = e;
            error('frame process', e);
            try {
              frame.close();
            } catch {
              /* already closed */
            }
          } finally {
            inFlight -= 1;
          }
        });
      },
      error: (e) => {
        decodeError = e;
        error('decoder', e);
      },
    });
    decoder.configure(decoderConfig);

    let samplesFed = 0;
    for await (const sample of demux.videoSamples()) {
      if (decodeError) throw decodeError;
      if (encodeError) throw encodeError;

      while (
        inFlight >= maxInFlight ||
        decoder.decodeQueueSize > maxInFlight ||
        encoder.encodeQueueSize > maxInFlight * 2
      ) {
        await sleep(4);
        if (decodeError) throw decodeError;
        if (encodeError) throw encodeError;
      }

      const chunk = new EncodedVideoChunk({
        type: sample.isKey ? 'key' : 'delta',
        timestamp: sample.timestamp,
        duration: sample.duration,
        data: sample.data,
      });

      decoder.decode(chunk);
      samplesFed += 1;

      if (samplesFed <= 3 || samplesFed % 60 === 0) {
        log(
          `decode feed #${samplesFed}`,
          `type=${chunk.type}`,
          `ts=${chunk.timestamp}µs`,
          `bytes=${sample.data.byteLength}`,
          `queue=${decoder.decodeQueueSize}`
        );
      }
    }

    log(`all ${samplesFed} video samples fed — flushing decoder/encoder`);
    await decoder.flush();
    await frameChain;
    await encoder.flush();
    decoder.close();
    encoder.close();
    processor.destroy?.();

    if (decodeError) throw decodeError;
    if (encodeError) throw encodeError;
    if (!encodedChunks.length) {
      throw new Error('No encoded chunks produced — check demux/decode path');
    }

    log(
      `encode complete framesDecoded=${framesDecoded} chunks=${encodedChunks.length}` +
        ` audioSamples=${demux.audioTrack?.samples?.length ?? 0}`
    );

    onProgress(0.92, 'Remuxing…');

    const result = await remuxAndSave({
      jobId,
      encodedChunks,
      audioTrack: demux.audioTrack,
      width: encWidth,
      height: encHeight,
      framerate: demux.framerate,
      writable,
      onProgress: (r) => onProgress(0.92 + r * 0.08, 'Saving…'),
    });

    onProgress(1, 'Done');
    return result;
  }

  /**
   * Demux an MP4 via true chunked streaming into WebCodecs-ready video samples
   * plus an untouched audio track for remux pass-through.
   *
   * Each chunk is copied to a detached ArrayBuffer with an accurate fileStart
   * offset so mp4box can reconstruct atoms (including moov-at-end files once
   * the stream completes and flush() runs).
   *
   * @param {ReadableStream<Uint8Array>} readable
   * @param {{ chunkBytes?: number, contentLength?: number, onProgress?: Function }} opts
   */
  async function createChunkedDemuxer(readable, opts = {}) {
    const { contentLength = 0, onProgress = () => {} } = opts;
    const MP4 = getMP4Box();
    const file = MP4.createFile();

    /** @type {object|null} */
    let info = null;
    /** @type {Error|null} */
    let demuxError = null;

    /** @type {{ isKey: boolean, timestamp: number, duration: number, data: ArrayBuffer }[]} */
    const videoQueue = [];
    /** @type {(() => void)[]} */
    const videoWaiters = [];

    const audioSamples = [];
    let audioMeta = null;

    let videoTrackId = null;
    let audioTrackId = null;
    let videoTimescale = 1;
    let streamFinished = false;
    let extractionStarted = false;
    let bytesAppended = 0;
    let videoSamplesSeen = 0;
    let audioSamplesSeen = 0;
    let readySettled = false;

    function wakeVideoWaiters() {
      while (videoWaiters.length) {
        const resolve = videoWaiters.shift();
        resolve?.();
      }
    }

    function waitForVideoSample() {
      return new Promise((resolve) => {
        videoWaiters.push(resolve);
      });
    }

    const readyPromise = new Promise((resolve, reject) => {
      file.onError = (e) => {
        demuxError = new Error(String(e));
        error('mp4box onError', e);
        readySettled = true;
        wakeVideoWaiters();
        reject(demuxError);
      };

      file.onReady = (readyInfo) => {
        info = readyInfo;
        readySettled = true;
        log('mp4box onReady', {
          duration: readyInfo.duration,
          timescale: readyInfo.timescale,
          videoTracks: readyInfo.videoTracks?.length ?? 0,
          audioTracks: readyInfo.audioTracks?.length ?? 0,
        });

        const vTrack = readyInfo.videoTracks?.[0];
        if (!vTrack) {
          demuxError = new Error('No video track in MP4');
          reject(demuxError);
          return;
        }

        videoTrackId = vTrack.id;
        videoTimescale = vTrack.timescale || 1;

        try {
          const aTrack = readyInfo.audioTracks?.[0] || null;
          if (aTrack) {
            audioTrackId = aTrack.id;
            audioMeta = {
              id: aTrack.id,
              codec: aTrack.codec,
              timescale: aTrack.timescale,
              duration: aTrack.duration,
              sampleRate: aTrack.audio?.sample_rate || 48000,
              channelCount: aTrack.audio?.channel_count || 2,
              description: getAudioDescriptionBox(file, aTrack.id),
              samples: audioSamples,
            };
            log(
              `audio track id=${aTrack.id} codec=${aTrack.codec}` +
                ` rate=${audioMeta.sampleRate} ch=${audioMeta.channelCount}` +
                ` timescale=${aTrack.timescale}`
            );
          } else {
            log('no audio track — video-only remux');
          }
        } catch (audioErr) {
          warn('audio track metadata failed (continuing video-only)', audioErr);
          audioTrackId = null;
          audioMeta = null;
        }

        resolve(readyInfo);
      };

      file.onSamples = (trackId, _user, samples) => {
        if (!samples?.length) return;

        try {
          if (trackId === videoTrackId) {
            for (const sample of samples) {
              const data = copyToArrayBuffer(sample.data);
              const timestamp = Math.round((1e6 * sample.cts) / sample.timescale);
              const duration = Math.round(
                (1e6 * (sample.duration || 0)) / sample.timescale
              );

              videoQueue.push({
                isKey: Boolean(sample.is_sync),
                timestamp,
                duration: duration || undefined,
                data,
              });
              videoSamplesSeen += 1;
            }

            if (videoSamplesSeen <= 3 || videoSamplesSeen % 120 === 0) {
              log(
                `onSamples video +${samples.length} total=${videoSamplesSeen}` +
                  ` queue=${videoQueue.length}` +
                  ` lastTs=${videoQueue[videoQueue.length - 1]?.timestamp}µs`
              );
            }
            wakeVideoWaiters();
            return;
          }

          if (trackId === audioTrackId) {
            for (const sample of samples) {
              audioSamples.push({
                data: copyToArrayBuffer(sample.data),
                duration: sample.duration || 1,
                cts: sample.cts || 0,
                dts: sample.dts ?? sample.cts ?? 0,
                is_sync: sample.is_sync !== false,
                timescale: sample.timescale,
              });
              audioSamplesSeen += 1;
            }
            if (audioSamplesSeen <= 2 || audioSamplesSeen % 200 === 0) {
              log(
                `onSamples audio +${samples.length} total=${audioSamplesSeen} (pass-through)`
              );
            }
          }
        } catch (sampleErr) {
          warn('onSamples handler error', sampleErr);
        }
      };
    });

    /**
     * True chunked streaming — append each fetch chunk with correct fileStart.
     * Never buffers the whole file in RAM.
     */
    async function pumpStream() {
      const reader = readable.getReader();
      let offset = 0;
      let chunkIndex = 0;

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            log(
              `stream EOF — appended ${(offset / (1024 * 1024)).toFixed(2)} MiB, flushing`
            );
            file.flush();
            streamFinished = true;
            bytesAppended = offset;
            onProgress(1);
            wakeVideoWaiters();
            break;
          }
          if (!value?.byteLength) continue;

          // mp4box requires a detached ArrayBuffer with a fileStart property
          const ab = copyToArrayBuffer(value);
          if (offset === 0) {
            const head = value.subarray(0, Math.min(12, value.byteLength));
            const hex = [...head].map((b) => b.toString(16).padStart(2, '0')).join(' ');
            const ascii = [...head].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
            console.log(`[CleanFrame:Diagnostic] First 12 bytes of file: [${hex}] | [${ascii}]`);

            const brand = String.fromCharCode(head[4] || 0, head[5] || 0, head[6] || 0, head[7] || 0);
            if (!ascii.includes('ftyp') && brand !== 'ftyp') {
              await reader.cancel?.();
              throw new Error("Invalid file format. Expected MP4 'ftyp', but got: " + ascii);
            }

            if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
              await reader.cancel?.();
              throw new Error('Invalid file format: WebM/EBML detected. Pipeline requires MP4.');
            }
          }

          try {
            ab.fileStart = offset;
            file.appendBuffer(ab);
          } catch (e) {
            await reader.cancel?.();
            throw new Error(`mp4box appendBuffer failed at fileStart=${offset}: ${e?.message || e}`);
          }

          offset += ab.byteLength;
          bytesAppended = offset;
          chunkIndex += 1;

          if (chunkIndex <= 3 || chunkIndex % 40 === 0) {
            log(
              `appendBuffer #${chunkIndex}`,
              `fileStart=${ab.fileStart}`,
              `size=${ab.byteLength}`,
              `totalMB=${(offset / (1024 * 1024)).toFixed(2)}`,
              `ready=${readySettled}`
            );
          }

          if (contentLength > 0) {
            onProgress(Math.min(0.99, offset / contentLength));
          } else {
            onProgress(Math.min(0.9, 1 - 1 / (1 + offset / (512 * 1024))));
          }
        }
      } finally {
        reader.releaseLock?.();
      }
    }

    // Pump the entire stream first (moov may be at EOF). onReady may also
    // fire mid-stream for fast-start files.
    await pumpStream();

    if (demuxError) throw demuxError;

    // Fail fast after flush if moov still missing
    const READY_TIMEOUT_MS = 15_000;
    const moovWarnTimer = setTimeout(() => {
      if (!readySettled) {
        warn('Waiting for MP4 moov atom… (file may be non-fast-start or corrupt)');
        try {
          file.flush();
        } catch (e) {
          warn('flush during moov wait failed', e);
        }
      }
    }, 5_000);

    try {
      await Promise.race([
        readyPromise,
        sleep(READY_TIMEOUT_MS).then(() => {
          if (!readySettled) {
            throw new Error(
              'Timed out waiting for MP4 moov atom 15s after stream flush. ' +
                'File may be corrupt, truncated, or not an MP4.'
            );
          }
        }),
      ]);
    } finally {
      clearTimeout(moovWarnTimer);
    }

    if (demuxError) throw demuxError;
    if (!info) throw new Error('mp4box onReady never fired');

    onProgress(1);

    const vTrack = info.videoTracks[0];
    const width = vTrack.video?.width || vTrack.track_width;
    const height = vTrack.video?.height || vTrack.track_height;
    const videoCodec = normalizeCodec(vTrack.codec);
    const description = getVideoDescription(file, vTrack.id);

    const durationSec =
      vTrack.duration && vTrack.timescale
        ? vTrack.duration / vTrack.timescale
        : info.duration && info.timescale
          ? info.duration / info.timescale
          : 0;
    const estimatedFrames =
      vTrack.nb_samples ||
      (durationSec ? Math.max(1, Math.round(durationSec * 24)) : 0);
    const framerate =
      durationSec && vTrack.nb_samples
        ? Math.max(1, Math.round(vTrack.nb_samples / durationSec))
        : 24;

    log(
      `track ready id=${vTrack.id} ${width}x${height} codec=${videoCodec}` +
        ` timescale=${vTrack.timescale} nb_samples=${vTrack.nb_samples}` +
        ` duration=${durationSec.toFixed?.(2) ?? durationSec}s`
    );

    return {
      videoCodec,
      width,
      height,
      framerate,
      description,
      estimatedFrames,
      videoTimescale,
      audioTrack: audioMeta,
      bytesAppended: () => bytesAppended,

      async *videoSamples() {
        if (!extractionStarted) {
          extractionStarted = true;

          try {
            file.setExtractionOptions(videoTrackId, null, { nbSamples: 60 });
            log(`setExtractionOptions video track=${videoTrackId}`);
          } catch (e) {
            throw new Error(`Failed to set video extraction options: ${e}`);
          }

          if (audioTrackId != null) {
            try {
              file.setExtractionOptions(audioTrackId, null, { nbSamples: 100 });
              log(`setExtractionOptions audio track=${audioTrackId} (pass-through)`);
            } catch (audioOptErr) {
              warn('audio extraction options failed — skipping audio', audioOptErr);
              audioTrackId = null;
            }
          }

          file.start();
          log('mp4box extraction started');
        }

        for (;;) {
          if (demuxError) throw demuxError;

          if (videoQueue.length) {
            yield videoQueue.shift();
            continue;
          }

          if (streamFinished) {
            await sleep(0);
            if (videoQueue.length) continue;
            await sleep(16);
            if (videoQueue.length) continue;
            log(
              `videoSamples done — seen=${videoSamplesSeen} audioSeen=${audioSamplesSeen}`
            );
            return;
          }

          await waitForVideoSample();
        }
      },
    };
  }

  /**
   * Mux encoder output + original audio samples into an MP4 and save to disk.
   */
  async function remuxAndSave({
    jobId,
    encodedChunks,
    audioTrack,
    width,
    height,
    framerate = 24,
    writable = null,
    onProgress = () => {},
  }) {
    const MP4 = getMP4Box();

    if (!encodedChunks?.length) {
      throw new Error('remuxAndSave: no encoded video chunks');
    }

    onProgress(0.05);
    log(
      `remux start chunks=${encodedChunks.length} audio=${audioTrack?.samples?.length ?? 0}` +
        ` ${width}x${height}`
    );

    const out = MP4.createFile();
    const videoTimescale = 1_000_000; // WebCodecs timestamps are µs
    const defaultDuration = Math.round(videoTimescale / (framerate || 24));

    // Decoder config / avcC arrives on the first keyframe's metadata
    let decoderConfig = null;
    for (const { meta } of encodedChunks) {
      if (meta?.decoderConfig) {
        decoderConfig = meta.decoderConfig;
        break;
      }
    }
    if (!decoderConfig?.description) {
      throw new Error(
        'remuxAndSave: missing encoder decoderConfig.description (avcC) — cannot mux'
      );
    }

    const videoOpts = {
      timescale: videoTimescale,
      width,
      height,
      nb_samples: encodedChunks.length,
      avcDecoderConfigRecord: decoderConfig.description,
    };
    const videoTrackId = out.addTrack(videoOpts);
    const descBytes = new Uint8Array(decoderConfig.description).byteLength;
    log(
      `mux video track id=${videoTrackId}`,
      `codec=${decoderConfig.codec || 'avc1'}`,
      `descBytes=${descBytes}`
    );

    let audioOutId = null;
    if (audioTrack?.samples?.length) {
      const audioOpts = {
        type: 'mp4a',
        timescale: audioTrack.timescale || 48000,
        samplerate: audioTrack.sampleRate || 48000,
        channel_count: audioTrack.channelCount || 2,
        nb_samples: audioTrack.samples.length,
      };
      if (audioTrack.description) {
        audioOpts.description = audioTrack.description;
      }
      audioOutId = out.addTrack(audioOpts);
      log(
        `mux audio track id=${audioOutId} (pass-through)`,
        `samples=${audioTrack.samples.length}`,
        `timescale=${audioOpts.timescale}`,
        `hasDescription=${Boolean(audioTrack.description)}`
      );
    }

    // --- Video samples from EncodedVideoChunk ---
    let i = 0;
    for (const { chunk } of encodedChunks) {
      const data = new ArrayBuffer(chunk.byteLength);
      chunk.copyTo(data);

      const duration = chunk.duration && chunk.duration > 0 ? chunk.duration : defaultDuration;

      out.addSample(videoTrackId, data, {
        duration,
        dts: chunk.timestamp,
        cts: chunk.timestamp,
        is_sync: chunk.type === 'key',
      });

      i += 1;
      if (i <= 2 || i % 60 === 0) {
        log(
          `mux video sample #${i}/${encodedChunks.length}`,
          `type=${chunk.type}`,
          `ts=${chunk.timestamp}`,
          `dur=${duration}`,
          `bytes=${data.byteLength}`
        );
      }
      if (i % 30 === 0) {
        onProgress(0.05 + (i / encodedChunks.length) * 0.55);
      }
    }

    // --- Untouched audio samples ---
    if (audioOutId != null && audioTrack?.samples?.length) {
      let a = 0;
      for (const sample of audioTrack.samples) {
        out.addSample(audioOutId, sample.data, {
          duration: sample.duration || 1,
          dts: sample.dts,
          cts: sample.cts,
          is_sync: sample.is_sync !== false,
        });
        a += 1;
        if (a <= 2 || a % 200 === 0) {
          log(
            `mux audio sample #${a}/${audioTrack.samples.length}`,
            `cts=${sample.cts}`,
            `bytes=${sample.data.byteLength}`
          );
        }
      }
      onProgress(0.7);
    }

    onProgress(0.8);
    log('writing moov/mdat via getBuffer()…');
    const buffer = out.getBuffer();
    if (!buffer || !buffer.byteLength) {
      throw new Error('remuxAndSave: getBuffer() returned empty result');
    }
    log(`muxed MP4 size=${(buffer.byteLength / (1024 * 1024)).toFixed(2)} MiB`);
    onProgress(0.9);

    const filename = `cleanframe-${jobId || Date.now()}.mp4`;

    if (writable) {
      try {
        await writable.write(buffer);
        await writable.close();
        log(`saved via FileSystemWritableFileStream → ${filename}`);
        onProgress(1);
        return { ok: true, filename };
      } catch (e) {
        warn('writable stream failed, falling back to Blob download', e);
        try {
          await writable.abort?.();
        } catch {
          /* ignore */
        }
      }
    }

    const blob = new Blob([buffer], { type: 'video/mp4' });
    const blobUrl = URL.createObjectURL(blob);
    log(`blob URL ready (${blob.size} bytes) for chrome.downloads`);
    onProgress(1);

    return { ok: true, filename, blobUrl };
  }

  root.CleanFramePipeline = {
    processVideo,
    createChunkedDemuxer,
    remuxAndSave,
  };

  log('streaming-pipeline.js loaded');
})(typeof self !== 'undefined' ? self : globalThis);
