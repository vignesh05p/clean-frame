/**
 * CleanFrame — offscreen document controller.
 * Receives PROCESS_VIDEO jobs and runs the streaming pipeline.
 */
(function () {
  'use strict';

  const CFG = self.CLEANFRAME_CONFIG;
  const MSG = CFG.messages;
  /** @type {Set<string>} */
  const running = new Set();

  function emit(message) {
    return chrome.runtime.sendMessage({ ...message, via: 'offscreen' });
  }

  async function handleProcess(message) {
    const { jobId, videoUrl, watermark, tabId } = message;
    if (!jobId || !videoUrl) {
      return { ok: false, error: 'jobId and videoUrl are required' };
    }
    if (running.has(jobId)) {
      return { ok: false, error: 'Job already running' };
    }
    if (!self.CleanFramePipeline?.processVideo) {
      return { ok: false, error: 'Pipeline not loaded' };
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
      // Prefer File System Access when available (flat memory write path).
      // Offscreen documents may not show a picker — fall back to Blob + downloads.
      let writable = null;
      let filename = `cleanframe-${jobId}.mp4`;

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
          // User cancel or unsupported — continue with downloads fallback
          if (pickerErr?.name === 'AbortError') {
            throw new Error('Save cancelled');
          }
          writable = null;
        }
      }

      const result = await self.CleanFramePipeline.processVideo({
        jobId,
        videoUrl,
        watermark,
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

      return { ok: true, done: true, ...result };
    } catch (err) {
      const error = String(err?.message || err);
      console.error('[CleanFrame:offscreen]', error);
      await emit({
        type: MSG.PROCESS_ERROR,
        jobId,
        tabId,
        error,
      });
      return { ok: false, error };
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
      handleProcess(message).then(sendResponse);
      return true;
    }
  });

  console.info(`[CleanFrame:offscreen] document ready (v${CFG.version})`);
})();
