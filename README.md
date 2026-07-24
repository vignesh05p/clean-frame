**Chrome Extension Technical Architecture for Watermark Removal via Reverse Alpha Blending**

Here is a production-grade, client-side architecture focused on performance, using only browser APIs (no server, no heavy ML inpainting).

### 1. Manifest & Permissions (manifest.json v3)

```json
{
  "manifest_version": 3,
  "name": "AI Video Watermark Remover",
  "version": "1.0",
  "background": {
    "service_worker": "background.js"
  },
  "content_scripts": [
    {
      "matches": ["https://*.gemini.google.com/*", "https://*.flow.google.com/*", "<all_urls>"],
      "js": ["content.js"],
      "run_at": "document_end"
    }
  ],
  "permissions": [
    "downloads",
    "activeTab",
    "storage"
  ],
  "host_permissions": [
    "<all_urls>"
  ],
  "web_accessible_resources": [
    {
      "resources": ["processor.js"],
      "matches": ["<all_urls>"]
    }
  ]
}
```

### 2. High-Level Pipeline (Background Service Worker)

**background.js** (orchestrator):

- Listen for `chrome.downloads.onCreated` / `onDeterminingFilename` to intercept AI-generated MP4 downloads.
- Pause the download (`chrome.downloads.pause`).
- Fetch the raw bytes via `fetch` (using the original URL from the download item).
- Send the `ArrayBuffer` to an offscreen document or a dedicated Web Worker for heavy processing.
- After processing, trigger a new `Blob` download of the cleaned MP4.

**Why Service Worker?** It survives page navigation and can handle long-running downloads.

### 3. Core Processing Module (processor.js in Web Worker / Offscreen Document)

Use an **Offscreen Document** (Chrome 109+) or a Web Worker + transferable objects for best performance.

**Steps inside the processor:**

1. **Demuxing**  
   Use `mp4box.js` (or `mux.js` / `webm-muxer` if targeting WebM).  
   ```js
   import MP4Box from 'mp4box';
   const mp4 = MP4Box.createFile();
   mp4.onReady = () => { /* extract video + audio tracks */ };
   mp4.appendBuffer(arrayBuffer);
   ```
   - Extract video track (H.264/AVC or HEVC).
   - Extract/copy audio track(s) untouched (critical for quality).

2. **Decoding Frames** – WebCodecs
   ```js
   const decoder = new VideoDecoder({
     output: frame => processFrame(frame),
     error: e => console.error(e)
   });

   decoder.configure({ codec: 'avc1.42E01E' }); // match the track codec
   // Feed encoded chunks from the demuxer
   ```

3. **Reverse Alpha Blending** (per-frame)

   For each `VideoFrame`:
   - Copy to `OffscreenCanvas` (or use `VideoFrame.copyTo()` + ImageData).
   - If you know the watermark bounding box + color + alpha (pre-configured per generator), apply the reverse formula:

   ```js
   // In a tight loop or WebGL shader
   const outR = (outR - (wmR * alpha)) / (1 - alpha);
   // same for G, B
   ```

   **Performance Critical Path**:  
   - Pure JS loops are too slow for 1080p/4K.  
   - **Recommended**: Use WebGL2 fragment shader on the GPU.

   Example WebGL shader skeleton:
   ```glsl
   uniform sampler2D u_frame;
   uniform vec4 u_wmColor;
   uniform float u_alpha;
   uniform vec4 u_box; // watermark bounding box

   void main() {
     vec4 color = texture2D(u_frame, v_texCoord);
     if (insideBox(v_texCoord, u_box)) {
       color.rgb = (color.rgb - u_wmColor.rgb * u_alpha) / (1.0 - u_alpha);
     }
     gl_FragColor = color;
   }
   ```

   Use `OffscreenCanvas` in WebGL context and `transferToImageBitmap()` or re-encode directly.

4. **Encoding Clean Frames**
   ```js
   const encoder = new VideoEncoder({
     output: chunk => muxer.addChunk(chunk),
     error: e => {}
   });

   encoder.configure({
     codec: 'avc1.42E01E',
     width: frame.width,
     height: frame.height,
     bitrate: 8_000_000 // tune per resolution
   });

   encoder.encode(cleanFrame, { keyFrame: everyN });
   ```

5. **Remuxing**
   - Use `mp4box.js` or `MP4Muxer` (by videojs) to combine the new video track with the original audio track.
   - Final output: `new Blob([muxedBuffer], { type: 'video/mp4' })`
   - Trigger download: `chrome.downloads.download({ url: URL.createObjectURL(blob), filename: 'clean.mp4' })`

### 4. Watermark Configuration (Per-Generator)

Store in `chrome.storage` or hardcode a small JSON:
```js
const configs = {
  "gemini": {
    box: { x: 0.85, y: 0.9, w: 0.15, h: 0.08 }, // normalized coords
    color: [r, g, b],      // known watermark tint
    alpha: 0.85,
    type: "logo"           // or "sparkle", "text"
  }
};
```

You can improve detection by running a quick pass with Canvas to locate high-contrast static regions across frames (watermarks are usually static).

### 5. Optimizations & Edge Cases

- **Memory**: Use `VideoFrame.close()` immediately after use. Process in chunks (e.g., 30-frame batches) for long videos.
- **Speed**: WebGL + WebCodecs can approach real-time on modern hardware for 1080p.
- **Audio Sync**: Keep original audio track timestamps intact.
- **UI**: Content script injects a floating "Remove Watermark" button near the download button on supported sites.
- **Fallback**: If WebCodecs not supported, degrade to MediaRecorder + Canvas capture (much slower).
- **Permissions Handling**: Request `downloads` permission on first use.

### 6. Project Structure

```
/extension
├── manifest.json
├── background.js
├── content.js          // UI injection & button
├── processor.js        // main heavy logic (worker/offscreen)
├── webgl-shader.js     // reverse blend shader
├── mp4box.js           // or imported via importmap
├── utils.js
└── icons/
```

**Development Tips**:
- Use Chrome's "Offscreen Document" API for clean separation.
- Test with small clips first (10-second 720p).
- Monitor `chrome.storage` for user-defined watermark profiles.
- For maximum speed, explore `WebGPU` compute shaders in the future (even better pixel processing).

This architecture runs 100% client-side, preserves audio quality, and avoids blurry AI inpainting. The math (reverse alpha) gives near-perfect results when you have accurate watermark parameters.

Would you like code skeletons for specific parts (WebGL shader, demux → decode → encode loop, or manifest + download interceptor)?