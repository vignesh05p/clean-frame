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
    if (!codec) return 'avc1.42001f';
    // Chrome only accepts short vp8 / vp9 labels
    if (codec.startsWith('vp08')) return 'vp8';
    if (codec.startsWith('vp09')) return 'vp9';
    return codec;
  }

  function pickEncoderCodec(width, height) {
    // Always re-encode to AVC for broad remux compatibility.
    if (width * height >= 1920 * 1080) return 'avc1.640028'; // High@4.0
    if (width * height >= 1280 * 720) return 'avc1.4D401F'; // Main@3.1
    return 'avc1.42001E'; // Baseline@3.0
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

    onProgress(0.02, 'Fetching…');
    log(`job=${jobId} fetch ${videoUrl}`);

    const response = await fetch(videoUrl, { credentials: 'include', mode: 'cors' });
    if (!response.ok) throw new Error(`Fetch failed: HTTP ${response.status}`);
    if (!response.body) throw new Error('ReadableStream body unavailable');

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

    const encoderCodec = pickEncoderCodec(demux.width, demux.height);
    const encoderConfig = {
      codec: encoderCodec,
      width: demux.width,
      height: demux.height,
      bitrate: CFG?.pipeline?.bitrate ?? 8_000_000,
      framerate: demux.framerate || 24,
      avc: { format: 'avc' },
      hardwareAcceleration: 'prefer-hardware',
    };

    log('encoder configure', encoderConfig);
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
        error('encoder', e);
      },
    });
    encoder.configure(encoderConfig);

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
      width: demux.width,
      height: demux.height,
      framerate: demux.framerate,
      writable,
      onProgress: (r) => onProgress(0.92 + r * 0.08, 'Saving…'),
    });

    onProgress(1, 'Done');
    return result;
  }

  /**
   * Pipe a ReadableStream into mp4box and expose WebCodecs-ready video samples
   * plus an untouched audio track for remux pass-through.
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
        wakeVideoWaiters();
        reject(demuxError);
      };

      file.onReady = (readyInfo) => {
        info = readyInfo;
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

        resolve(readyInfo);
      };

      file.onSamples = (trackId, _user, samples) => {
        if (!samples?.length) return;

        if (trackId === videoTrackId) {
          for (const sample of samples) {
            // Copy — mp4box may reuse underlying buffers
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
      };
    });

    /**
     * Feed the fetch body into mp4box with correct fileStart offsets.
     *
     * For a single sequential ReadableStream we MUST advance fileStart by
     * byteLength every chunk (same as the W3C WebCodecs demuxer sample).
     * Jumping to appendBuffer's returned nextStart would mis-label later
     * chunks unless we also issued HTTP range seeks — which we do not.
     */
    async function pumpStream() {
      const reader = readable.getReader();
      let fileOffset = 0;
      let chunkIndex = 0;

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value?.byteLength) continue;

          // MP4Box requires a real ArrayBuffer with a fileStart property.
          // Always copy — fetch chunks may be views into a larger pool.
          const buffer = copyToArrayBuffer(value);
          buffer.fileStart = fileOffset;

          const nextStart = file.appendBuffer(buffer);
          bytesAppended += buffer.byteLength;
          chunkIndex += 1;

          if (chunkIndex <= 3 || chunkIndex % 40 === 0) {
            log(
              `appendBuffer #${chunkIndex}`,
              `fileStart=${fileOffset}`,
              `size=${buffer.byteLength}`,
              `mp4boxNextStart=${nextStart}`,
              `totalMB=${(bytesAppended / (1024 * 1024)).toFixed(2)}`
            );
          }

          // Sequential stream: advance by what we actually appended.
          fileOffset += buffer.byteLength;

          if (
            typeof nextStart === 'number' &&
            nextStart >= 0 &&
            nextStart !== fileOffset
          ) {
            // Informative only — would need Range requests to honor seeks.
            log(
              `mp4box requested seek to ${nextStart} but stream is sequential;` +
                ` continuing at ${fileOffset}`
            );
          }

          if (contentLength > 0) {
            onProgress(Math.min(0.99, bytesAppended / contentLength));
          } else {
            onProgress(Math.min(0.9, 1 - 1 / (1 + bytesAppended / (512 * 1024))));
          }
        }
      } finally {
        reader.releaseLock?.();
      }

      log(`stream EOF — appended ${(bytesAppended / (1024 * 1024)).toFixed(2)} MiB, flushing`);
      file.flush();
      streamFinished = true;
      onProgress(1);
      wakeVideoWaiters();
    }

    // Start pumping immediately so moov can arrive; await ready in parallel.
    const pumpPromise = pumpStream().catch((e) => {
      demuxError = e instanceof Error ? e : new Error(String(e));
      error('pumpStream failed', demuxError);
      wakeVideoWaiters();
      throw demuxError;
    });

    await readyPromise;
    if (demuxError) throw demuxError;

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

      /**
       * Async iterator of demuxed video samples as WebCodecs-friendly objects.
       * Starts extraction on first call; continues until stream flush + queue drain.
       */
      async *videoSamples() {
        if (!extractionStarted) {
          extractionStarted = true;

          // nbSamples: emit in batches to keep RAM flat but avoid tiny callbacks
          file.setExtractionOptions(videoTrackId, null, { nbSamples: 60 });
          log(`setExtractionOptions video track=${videoTrackId}`);

          if (audioTrackId != null) {
            file.setExtractionOptions(audioTrackId, null, { nbSamples: 100 });
            log(`setExtractionOptions audio track=${audioTrackId} (pass-through)`);
          }

          file.start();
          log('mp4box extraction started');
        }

        try {
          for (;;) {
            if (demuxError) throw demuxError;

            if (videoQueue.length) {
              yield videoQueue.shift();
              continue;
            }

            // Wait for more samples or stream completion
            if (streamFinished) {
              // Give mp4box a turn to flush remaining samples after EOF
              await sleep(0);
              if (videoQueue.length) continue;

              // Pump may still be settling
              try {
                await pumpPromise;
              } catch {
                /* demuxError already set */
              }
              if (demuxError) throw demuxError;
              await sleep(0);
              if (videoQueue.length) continue;

              log(
                `videoSamples done — yielded path complete,` +
                  ` seen=${videoSamplesSeen} audioSeen=${audioSamplesSeen}`
              );
              return;
            }

            await Promise.race([waitForVideoSample(), pumpPromise.then(() => {})]);
          }
        } finally {
          // Ensure pump failures surface
          await pumpPromise.catch(() => {});
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
