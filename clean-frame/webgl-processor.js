/**
 * CleanFrame — WebGL2 watermark processor (skeleton).
 *
 * Per frame:
 *   1. Lightweight detection pass — scan prior region for watermark alpha/color pattern
 *   2. Reverse alpha blending in a fragment shader (GPU)
 *   3. Fallback spatial blur only when detected alpha ≈ 1.0
 */
(function (root) {
  'use strict';

  const CFG = root.CLEANFRAME_CONFIG;
  const LOG_PREFIX = '[CleanFrame:webgl]';

  const VERT_SRC = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  v_uv.y = 1.0 - v_uv.y;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

  /**
   * Reverse alpha:   C_orig = (C_obs - C_wm * α) / (1 - α)
   * Blur fallback when u_mode == 1.0 (opaque watermark).
   */
  const FRAG_SRC = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_frame;
uniform sampler2D u_mask;
uniform vec4 u_box;       // normalized x,y,w,h
uniform vec3 u_wmColor;
uniform float u_alpha;
uniform float u_mode;     // 0 = reverse-alpha, 1 = blur
uniform vec2 u_texel;     // 1/width, 1/height
uniform float u_blurRadius;
uniform float u_maskEnabled;

bool insideBox(vec2 uv, vec4 box) {
  return uv.x >= box.x && uv.x <= box.x + box.z &&
         uv.y >= box.y && uv.y <= box.y + box.w;
}

vec3 reverseAlpha(vec3 obs, vec3 wm, float a) {
  float denom = max(1.0 - a, 1e-4);
  return clamp((obs - wm * a) / denom, 0.0, 1.0);
}

// Sample mask (assumes mask covers the box region when enabled)
vec4 sampleMask(vec2 uv, vec4 box) {
  if (u_maskEnabled < 0.5) return vec4(0.0);
  vec2 local = (uv - vec2(box.x, box.y)) / vec2(box.z, box.w);
  // clamp to mask space
  local = clamp(local, 0.0, 1.0);
  return texture(u_mask, local);
}

vec3 spatialBlur(sampler2D tex, vec2 uv, vec2 texel, float radius) {
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  int r = int(clamp(radius, 1.0, 12.0));
  for (int y = -12; y <= 12; y++) {
    if (y < -r || y > r) continue;
    for (int x = -12; x <= 12; x++) {
      if (x < -r || x > r) continue;
      float w = 1.0 / (1.0 + float(x*x + y*y));
      acc += texture(tex, uv + vec2(float(x), float(y)) * texel).rgb * w;
      wsum += w;
    }
  }
  return acc / max(wsum, 1e-4);
}

void main() {
  vec4 color = texture(u_frame, v_uv);
  if (insideBox(v_uv, u_box)) {
    if (u_mode > 0.5) {
      color.rgb = spatialBlur(u_frame, v_uv, u_texel, u_blurRadius);
    } else {
      // If mask enabled, use mask color/alpha from texture; otherwise fall back
      vec4 m = sampleMask(v_uv, u_box);
      if (u_maskEnabled > 0.5) {
        vec3 wm = m.rgb;
        float ma = m.a;
        color.rgb = reverseAlpha(color.rgb, wm, ma);
      } else {
        color.rgb = reverseAlpha(color.rgb, u_wmColor, u_alpha);
      }
    }
  }
  outColor = vec4(color.rgb, 1.0);
}`;

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(`Shader compile failed: ${info}`);
    }
    return sh;
  }

  function link(gl, vs, fs) {
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error(`Program link failed: ${info}`);
    }
    return prog;
  }

  /**
   * Create a reusable GPU processor bound to an OffscreenCanvas.
   * @param {object} watermarkProfile
   */
  function createProcessor(watermarkProfile) {
    console.log(LOG_PREFIX, 'createProcessor');
    const profile = {
      ...(CFG?.watermark || {}),
      ...(watermarkProfile || {}),
    };

    const canvas = new OffscreenCanvas(2, 2);
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      antialias: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 unavailable');

    const vs = compile(gl, gl.VERTEX_SHADER, VERT_SRC);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    const program = link(gl, vs, fs);
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const uniforms = {
      frame: gl.getUniformLocation(program, 'u_frame'),
      box: gl.getUniformLocation(program, 'u_box'),
      wmColor: gl.getUniformLocation(program, 'u_wmColor'),
      alpha: gl.getUniformLocation(program, 'u_alpha'),
      mode: gl.getUniformLocation(program, 'u_mode'),
      texel: gl.getUniformLocation(program, 'u_texel'),
      blurRadius: gl.getUniformLocation(program, 'u_blurRadius'),
      maskEnabled: gl.getUniformLocation(program, 'u_maskEnabled'),
      maskSampler: gl.getUniformLocation(program, 'u_mask'),
    };

    let cachedBox = null;
    let detectEveryN = 12;
    let frameIndex = 0;
    let maskTex = null;
    let maskLoaded = false;

    /**
     * Lightweight CPU detection over the search prior region.
     * Looks for pixels close to the known watermark tint with mid-range alpha cues
     * (semi-transparent overlays shift local contrast toward wmColor).
     *
     * @param {VideoFrame} frame
     * @returns {{ box: {x:number,y:number,w:number,h:number}, alpha: number, confidence: number }}
     */
    async function detectWatermark(frame) {
      const region = profile.searchRegion || { x: 0.65, y: 0.78, w: 0.35, h: 0.22 };
      const stride = profile.detectStride || 4;
      const w = frame.displayWidth || frame.codedWidth;
      const h = frame.displayHeight || frame.codedHeight;

      const rx = Math.floor(region.x * w);
      const ry = Math.floor(region.y * h);
      const rw = Math.max(1, Math.floor(region.w * w));
      const rh = Math.max(1, Math.floor(region.h * h));

      // Read only the search prior — keeps detection cheap
      const tmp = new OffscreenCanvas(rw, rh);
      const ctx = tmp.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(frame, rx, ry, rw, rh, 0, 0, rw, rh);
      const { data } = ctx.getImageData(0, 0, rw, rh);

      const [tr, tg, tb] = profile.color || [0.92, 0.92, 0.94];
      const target = [tr * 255, tg * 255, tb * 255];

      let minX = rw, minY = rh, maxX = 0, maxY = 0, hits = 0, sampled = 0;
      const platform = profile.platform || (CFG && CFG.platform) || 'flow';

      for (let y = 0; y < rh; y += stride) {
        // Yield occasionally to avoid blocking
        if (y % 256 === 0) await new Promise((r) => setTimeout(r, 0));
        for (let x = 0; x < rw; x += stride) {
          const i = (y * rw + x) * 4;
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          sampled += 1;

          if (platform === 'gemini') {
            const lum = (r + g + b) / 3;
            const bluish = b - Math.max(r, g);
            if (lum > 220 && bluish > 6) {
              hits += 1;
              if (x < minX) minX = x;
              if (y < minY) minY = y;
              if (x > maxX) maxX = x;
              if (y > maxY) maxY = y;
            }
          } else {
            const dist =
              Math.abs(r - target[0]) +
              Math.abs(g - target[1]) +
              Math.abs(b - target[2]);
            if (dist < 90 && r + g + b > 480) {
              hits += 1;
              if (x < minX) minX = x;
              if (y < minY) minY = y;
              if (x > maxX) maxX = x;
              if (y > maxY) maxY = y;
            }
          }
        }
      }

      const confidence = sampled ? hits / sampled : 0;
      const threshold = profile.detectConfidence ?? 0.62;

      if (confidence < threshold * 0.15 || maxX <= minX || maxY <= minY) {
        // Fall back to prior box (bottom-right Veo mark)
        return {
          box: { x: 0.82, y: 0.9, w: 0.16, h: 0.08 },
          alpha: profile.alpha ?? 0.55,
          confidence: 0,
        };
      }

      // Pad bbox slightly
      const pad = 4;
      minX = Math.max(0, minX - pad);
      minY = Math.max(0, minY - pad);
      maxX = Math.min(rw - 1, maxX + pad);
      maxY = Math.min(rh - 1, maxY + pad);

      return {
        box: {
          x: (rx + minX) / w,
          y: (ry + minY) / h,
          w: (maxX - minX + 1) / w,
          h: (maxY - minY + 1) / h,
        },
        alpha: profile.alpha ?? 0.55,
        confidence,
      };
    }

    // Load platform mask texture if provided
    async function loadMaskIfNeeded() {
      try {
        const platform = profile.platform || (CFG && CFG.platform) || 'flow';
        const maskName = (CFG && CFG.platformMasks && CFG.platformMasks[platform]) || null;
        if (!maskName) return;
        if (maskLoaded) return;
        const url = chrome.runtime.getURL(maskName);
        const img = await fetch(url).then((r) => r.blob()).then((b) => createImageBitmap(b));
        maskTex = gl.createTexture();
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, maskTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        maskLoaded = true;
      } catch (e) {
        console.warn(LOG_PREFIX, 'mask load failed', e);
      }
    }

    /**
     * @param {VideoFrame} frame
     * @returns {Promise<VideoFrame>}
     */
    async function processFrame(frame) {
      const w = frame.displayWidth || frame.codedWidth;
      const h = frame.displayHeight || frame.codedHeight;

      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }

      // Re-detect periodically — Flow watermarks can drift between shots
      if (!cachedBox || frameIndex % detectEveryN === 0) {
        // Ensure mask is loaded for platform if needed
        await loadMaskIfNeeded();
        const detected = await detectWatermark(frame);
        cachedBox = detected;
      }
      frameIndex += 1;

      const box = cachedBox.box;
      const alpha = cachedBox.alpha;
      const opaque = alpha >= (profile.opaqueAlphaThreshold ?? 0.98);
      const mode = opaque ? 1.0 : 0.0;

      gl.useProgram(program);
      gl.bindVertexArray(vao);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      // Upload VideoFrame directly (Chrome supports texImage2D with VideoFrame)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);

      gl.uniform1i(uniforms.frame, 0);
      gl.uniform4f(uniforms.box, box.x, box.y, box.w, box.h);
      const [cr, cg, cb] = profile.color || [0.92, 0.92, 0.94];
      gl.uniform3f(uniforms.wmColor, cr, cg, cb);
      gl.uniform1f(uniforms.alpha, alpha);
      gl.uniform1f(uniforms.mode, mode);
      gl.uniform2f(uniforms.texel, 1 / w, 1 / h);
      gl.uniform1f(uniforms.blurRadius, profile.blurRadiusPx ?? 6);
      gl.uniform1f(uniforms.maskEnabled, maskLoaded ? 1.0 : 0.0);
      if (maskLoaded) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, maskTex);
        gl.uniform1i(uniforms.maskSampler, 1);
      }

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      return new VideoFrame(canvas, {
        timestamp: frame.timestamp,
        duration: frame.duration ?? undefined,
      });
    }

    function destroy() {
      gl.deleteTexture(tex);
      if (maskTex) gl.deleteTexture(maskTex);
      gl.deleteBuffer(buf);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
      cachedBox = null;
    }

    return {
      processFrame,
      detectWatermark,
      destroy,
      /** @private exposed for tests */
      _gl: gl,
    };
  }

  root.CleanFrameWebGL = {
    createProcessor,
    VERT_SRC,
    FRAG_SRC,
  };
})(typeof self !== 'undefined' ? self : globalThis);
