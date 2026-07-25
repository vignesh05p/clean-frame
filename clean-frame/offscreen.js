/**
 * CleanFrame — offscreen document controller.
 * Receives PROCESS_VIDEO jobs and runs the streaming pipeline.
 *
 * Immediately acks job start; progress / done / error are pushed as
 * separate messages so Chrome does not close a long-lived sendMessage port.
 */
(function () {
  'use strict';

  const CFG = self.CLEANFRAME_CONFIG;
  const MSG = CFG.messages;
  /** @type {Set<string>} */
  const running = new Set();

  function emit(message) {
    return chrome.runtime.sendMessage({ ...message, via: 'offscreen' }).catch((e) => {
      console.warn('[CleanFrame:offscreen] emit failed', e);
    });
  }

  async function handleProcess(message) {
    const { jobId, videoUrl, watermark, tabId } = message;
    if (!jobId || !videoUrl) {
      await emit({
        type: MSG.PROCESS_ERROR,
        jobId,
        tabId,
        error: 'jobId and videoUrl are required',
      });
      return;
    }
    if (running.has(jobId)) {
      await emit({
        type: MSG.PROCESS_ERROR,
        jobId,
        tabId,
        error: 'Job already running',
      });
      return;
    }
    if (!self.CleanFramePipeline?.processVideo) {
      await emit({
        type: MSG.PROCESS_ERROR,
        jobId,
        tabId,
        error: 'Pipeline not loaded',
      });
      return;
    }

    running.add(jobId);

    const onProgress = (ratio, statusText) => {
      emit({
        type: MSG.PROCESS_PROGRESS,
        jobId,
        tabId,
        ratio,
        statusText,
      });
    };

    try {
      let writable = null;
      let filename = `cleanframe-${jobId}.mp4`;

      // Offscreen usually cannot show a file picker — prefer downloads fallback.
      if (typeof showSaveFilePicker === 'function') {
        try {
          const handle = await showSaveFilePicker({
            suggestedName: filename,
            types: [
              {
                description: 'MP4 video',
                accept: { 'video/mp4': ['.mp4'] },
              },
            ],
          });
          writable = await handle.createWritable();
          filename = handle.name || filename;
        } catch (pickerErr) {
          if (pickerErr?.name === 'AbortError') {
            throw new Error('Save cancelled');
          }
          writable = null;
        }
      }

      const pipelineWatermark = { ...(watermark || {}) };
      if (message.platform) pipelineWatermark.platform = message.platform;

      onProgress(0.05, 'Fetching…');

      const result = await self.CleanFramePipeline.processVideo({
        jobId,
        videoUrl,
        watermark: pipelineWatermark,
        onProgress,
        writable,
      });

      await emit({
        type: MSG.PROCESS_DONE,
        jobId,
        tabId,
        filename: result.filename || filename,
        blobUrl: result.blobUrl,
      });
    } catch (err) {
      const error = String(err?.message || err);
      console.error('[CleanFrame:offscreen]', error);
      await emit({
        type: MSG.PROCESS_ERROR,
        jobId,
        tabId,
        error,
      });
    } finally {
      running.delete(jobId);
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.target !== 'offscreen') return;

    if (message.type === MSG.PING) {
      sendResponse({
        ok: true,
        context: 'offscreen',
        pipeline: Boolean(self.CleanFramePipeline),
        webgl: Boolean(self.CleanFrameWebGL),
        mp4box: typeof MP4Box !== 'undefined',
      });
      return;
    }

    if (message.type === MSG.PROCESS_VIDEO) {
      // Ack immediately — run the heavy job without holding this channel open.
      sendResponse({ ok: true, status: 'started', jobId: message.jobId });
      handleProcess(message);
      return; // sync response — do not return true
    }
  });

  console.info(`[CleanFrame:offscreen] document ready (v${CFG.version})`);
})();
