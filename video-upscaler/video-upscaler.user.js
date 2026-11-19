// ==UserScript==
// @name         Video Upscaler
// @description  Real-time GPU upscaling and sharpening for videos in Safari.
// @version      1.0.0
// @match        *://*/*
// @run-at       document-idle
// @grant        GM.getValue
// @grant        GM.setValue
// ==/UserScript==

// Video Upscaler — Safari userscript (for the free "Userscripts" app).
// For every <video> on the page, draws a WebGL2 canvas on top of it that
// renders each frame at your screen's real pixel resolution using:
//   pass 1: Catmull-Rom bicubic upscale with anti-ringing clamp
//   pass 2: contrast-adaptive sharpening (CAS)
// Clicks pass straight through the canvas, so the site's player controls keep working.
(() => {
  if (window.__videoUpscalerLoaded) return;
  window.__videoUpscalerLoaded = true;

  const DEFAULTS = { enabled: true, sharpness: 0.5, maxRes: 2160 };
  const MAX_PIXELS = { 1080: 1920 * 1080, 1440: 2560 * 1440, 2160: 3840 * 2160 };
  const MIN_SIZE = 160; // ignore tiny thumbnails / preview videos (CSS px)

  let settings = { ...DEFAULTS };
  const instances = new Map(); // video -> Upscaler

  // ---------- shaders ----------
  const VS = `#version 300 es
  out vec2 vUv;
  void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    vUv = p;
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  }`;

  const FS_UPSCALE = `#version 300 es
  precision highp float;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D uTex;
  uniform vec2 uTexSize;
  uniform vec4 uCrop; // xy = uv offset, zw = uv scale

  void main() {
    vec2 uv = uCrop.xy + vUv * uCrop.zw;
    vec2 samplePos = uv * uTexSize;
    vec2 tp1 = floor(samplePos - 0.5) + 0.5;
    vec2 f = samplePos - tp1;

    // Catmull-Rom weights
    vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
    vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
    vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
    vec2 w3 = f * f * (-0.5 + 0.5 * f);
    vec2 w12 = w1 + w2;
    vec2 off12 = w2 / w12;

    vec2 t0  = (tp1 - 1.0) / uTexSize;
    vec2 t3  = (tp1 + 2.0) / uTexSize;
    vec2 t12 = (tp1 + off12) / uTexSize;

    vec3 c = vec3(0.0);
    c += texture(uTex, vec2(t0.x,  t0.y)).rgb  * w0.x  * w0.y;
    c += texture(uTex, vec2(t12.x, t0.y)).rgb  * w12.x * w0.y;
    c += texture(uTex, vec2(t3.x,  t0.y)).rgb  * w3.x  * w0.y;
    c += texture(uTex, vec2(t0.x,  t12.y)).rgb * w0.x  * w12.y;
    c += texture(uTex, vec2(t12.x, t12.y)).rgb * w12.x * w12.y;
    c += texture(uTex, vec2(t3.x,  t12.y)).rgb * w3.x  * w12.y;
    c += texture(uTex, vec2(t0.x,  t3.y)).rgb  * w0.x  * w3.y;
    c += texture(uTex, vec2(t12.x, t3.y)).rgb  * w12.x * w3.y;
    c += texture(uTex, vec2(t3.x,  t3.y)).rgb  * w3.x  * w3.y;

    // Anti-ringing: keep the result inside the range of the 4 nearest source pixels
    vec2 px = 1.0 / uTexSize;
    vec2 b = tp1 * px;
    vec3 n0 = texture(uTex, b).rgb;
    vec3 n1 = texture(uTex, b + vec2(px.x, 0.0)).rgb;
    vec3 n2 = texture(uTex, b + vec2(0.0, px.y)).rgb;
    vec3 n3 = texture(uTex, b + px).rgb;
    vec3 lo = min(min(n0, n1), min(n2, n3));
    vec3 hi = max(max(n0, n1), max(n2, n3));
    c = mix(c, clamp(c, lo, hi), 0.85);

    outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
  }`;

  const FS_SHARPEN = `#version 300 es
  precision highp float;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D uTex;
  uniform vec2 uTexel;
  uniform float uSharp;

  void main() {
    vec3 b = texture(uTex, vUv + vec2(0.0, -uTexel.y)).rgb;
    vec3 d = texture(uTex, vUv + vec2(-uTexel.x, 0.0)).rgb;
    vec3 e = texture(uTex, vUv).rgb;
    vec3 f = texture(uTex, vUv + vec2(uTexel.x, 0.0)).rgb;
    vec3 h = texture(uTex, vUv + vec2(0.0, uTexel.y)).rgb;

    // AMD FidelityFX CAS (cross variant)
    vec3 mn = min(min(min(d, e), min(f, b)), h);
    vec3 mx = max(max(max(d, e), max(f, b)), h);
    vec3 amp = clamp(min(mn, 2.0 - mx) / max(mx, vec3(1e-5)), 0.0, 1.0);
    amp = sqrt(amp);
    float peak = -1.0 / mix(8.0, 4.5, uSharp);
    vec3 w = amp * peak;
    vec3 c = (e + (b + d + f + h) * w) / (1.0 + 4.0 * w);
    outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
  }`;

  function compile(gl, vsSrc, fsSrc) {
    const mk = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  function makeTex(gl) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  // ---------- per-video upscaler ----------
  class Upscaler {
    constructor(video) {
      this.video = video;
      this.status = 'waiting';
      this.dead = false;
      this.newFrame = true;
      this.lastKey = '';
      this.shown = false;

      const c = document.createElement('canvas');
      c.className = '__video-upscaler-canvas';
      c.setAttribute('aria-hidden', 'true');
      Object.assign(c.style, {
        position: 'absolute', left: '0px', top: '0px', width: '0px', height: '0px',
        pointerEvents: 'none', display: 'none', margin: '0', padding: '0', border: '0',
        maxWidth: 'none', maxHeight: 'none', transform: 'none',
      });
      this.canvas = c;

      const gl = c.getContext('webgl2', {
        alpha: false, antialias: false, depth: false, stencil: false,
        premultipliedAlpha: false, preserveDrawingBuffer: false, desynchronized: true,
        powerPreference: 'high-performance',
      });
      if (!gl) { this.status = 'no-webgl'; this.dead = true; return; }
      this.gl = gl;

      try {
        this.pUp = compile(gl, VS, FS_UPSCALE);
        this.pSharp = compile(gl, VS, FS_SHARPEN);
      } catch (e) {
        console.warn('[Video Upscaler] shader error', e);
        this.status = 'no-webgl'; this.dead = true; return;
      }
      this.uUp = {
        tex: gl.getUniformLocation(this.pUp, 'uTex'),
        size: gl.getUniformLocation(this.pUp, 'uTexSize'),
        crop: gl.getUniformLocation(this.pUp, 'uCrop'),
      };
      this.uSh = {
        tex: gl.getUniformLocation(this.pSharp, 'uTex'),
        texel: gl.getUniformLocation(this.pSharp, 'uTexel'),
        sharp: gl.getUniformLocation(this.pSharp, 'uSharp'),
      };
      this.vao = gl.createVertexArray();
      this.srcTex = makeTex(gl);
      this.midTex = makeTex(gl);
      this.fbo = gl.createFramebuffer();
      this.midW = 0; this.midH = 0;

      c.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.destroy(); });

      if (video.requestVideoFrameCallback) {
        const onFrame = () => {
          if (this.dead) return;
          this.newFrame = true;
          video.requestVideoFrameCallback(onFrame);
        };
        video.requestVideoFrameCallback(onFrame);
      }
    }

    destroy() {
      this.dead = true;
      this.canvas.remove();
      const ext = this.gl && this.gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    }

    hide(status) {
      this.status = status;
      this.lastKey = '';
      if (this.shown) { this.canvas.style.display = 'none'; this.shown = false; }
    }

    // Called every animation frame.
    tick() {
      const v = this.video, c = this.canvas;
      if (this.dead) return;
      if (!v.isConnected) { this.destroy(); return; }
      if (!settings.enabled) return this.hide('off');
      if (v.mediaKeys || v.webkitKeys) return this.hide('drm');
      if (v.readyState < 2 || !v.videoWidth || !v.videoHeight) return this.hide('waiting');

      const w = v.clientWidth, h = v.clientHeight;
      if (w < MIN_SIZE || h < MIN_SIZE * 0.5) return this.hide('too-small');
      const cs = getComputedStyle(v);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) {
        return this.hide('hidden');
      }

      // Work out where the picture is actually drawn inside the <video> box (object-fit).
      const vw = v.videoWidth, vh = v.videoHeight;
      let sx, sy;
      switch (cs.objectFit) {
        case 'fill': sx = w / vw; sy = h / vh; break;
        case 'cover': sx = sy = Math.max(w / vw, h / vh); break;
        case 'none': sx = sy = 1; break;
        case 'scale-down': sx = sy = Math.min(1, w / vw, h / vh); break;
        default: sx = sy = Math.min(w / vw, h / vh);
      }
      const dw = vw * sx, dh = vh * sy, dx = (w - dw) / 2, dy = (h - dh) / 2;
      const ix0 = Math.max(0, dx), iy0 = Math.max(0, dy);
      const ix1 = Math.min(w, dx + dw), iy1 = Math.min(h, dy + dh);
      const cssW = ix1 - ix0, cssH = iy1 - iy0;
      if (cssW < 2 || cssH < 2) return this.hide('hidden');
      const u0 = (ix0 - dx) / dw, u1 = (ix1 - dx) / dw;
      const t0 = (iy0 - dy) / dh, t1 = (iy1 - dy) / dh;

      // Output resolution = real screen pixels, capped for performance.
      const dpr = window.devicePixelRatio || 1;
      let outW = Math.round(cssW * dpr), outH = Math.round(cssH * dpr);
      const cap = MAX_PIXELS[settings.maxRes] || MAX_PIXELS[2160];
      if (outW * outH > cap) {
        const k = Math.sqrt(cap / (outW * outH));
        outW = Math.round(outW * k); outH = Math.round(outH * k);
      }
      const srcW = vw * (u1 - u0), srcH = vh * (t1 - t0);
      if (outW <= srcW * 1.02 && outH <= srcH * 1.02) return this.hide('native');

      // Keep the canvas glued on top of the video.
      if (c.parentNode !== v.parentNode || c.previousSibling !== v) {
        v.after(c);
      }
      if (c.style.zIndex !== cs.zIndex) c.style.zIndex = cs.zIndex === 'auto' ? '' : cs.zIndex;
      c.style.width = cssW + 'px';
      c.style.height = cssH + 'px';
      c.style.borderRadius = cs.borderRadius;
      if (!this.shown) { c.style.display = 'block'; }
      const vr = v.getBoundingClientRect();
      const cr = c.getBoundingClientRect();
      const tx = vr.left + v.clientLeft + ix0, ty = vr.top + v.clientTop + iy0;
      if (Math.abs(cr.left - tx) > 0.25 || Math.abs(cr.top - ty) > 0.25) {
        c.style.left = (parseFloat(c.style.left) + tx - cr.left) + 'px';
        c.style.top = (parseFloat(c.style.top) + ty - cr.top) + 'px';
      }

      const key = [outW, outH, u0, u1, t0, t1, settings.sharpness].join(',');
      const changed = key !== this.lastKey;
      const needsFrame = this.newFrame || changed ||
        (!v.requestVideoFrameCallback && !v.paused);
      if (!needsFrame) return;

      if (c.width !== outW || c.height !== outH) { c.width = outW; c.height = outH; }
      try {
        this.render(outW, outH, [u0, 1 - t1, u1 - u0, t1 - t0]);
      } catch (e) {
        // Cross-origin video without CORS: the browser won't let us read its pixels.
        this.status = 'cross-origin';
        console.info('[Video Upscaler] cannot process this video:', e.message);
        this.destroy();
        return;
      }
      this.newFrame = false;
      this.lastKey = key;
      this.status = 'active';
      this.shown = true;
    }

    render(outW, outH, crop) {
      const gl = this.gl, v = this.video;
      gl.bindVertexArray(this.vao);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
      const err = gl.getError();
      if (err === gl.INVALID_VALUE || err === gl.INVALID_OPERATION) throw new Error('texture upload failed');

      const sharpen = settings.sharpness > 0.001;

      // Pass 1: bicubic upscale (to intermediate texture if sharpening follows)
      if (sharpen) {
        gl.bindTexture(gl.TEXTURE_2D, this.midTex);
        if (this.midW !== outW || this.midH !== outH) {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, outW, outH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
          this.midW = outW; this.midH = outH;
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.midTex, 0);
        gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
      gl.viewport(0, 0, outW, outH);
      gl.useProgram(this.pUp);
      gl.uniform1i(this.uUp.tex, 0);
      gl.uniform2f(this.uUp.size, v.videoWidth, v.videoHeight);
      gl.uniform4f(this.uUp.crop, crop[0], crop[1], crop[2], crop[3]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // Pass 2: contrast-adaptive sharpen to screen
      if (sharpen) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, this.midTex);
        gl.useProgram(this.pSharp);
        gl.uniform1i(this.uSh.tex, 0);
        gl.uniform2f(this.uSh.texel, 1 / outW, 1 / outH);
        gl.uniform1f(this.uSh.sharp, settings.sharpness);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    }
  }

  // ---------- discovery + main loop ----------
  function scan() {
    for (const v of document.getElementsByTagName('video')) {
      if (!instances.has(v)) instances.set(v, new Upscaler(v));
    }
  }

  let looping = false;
  function loop() {
    for (const [v, up] of instances) {
      up.tick();
      if (up.dead && !v.isConnected) instances.delete(v);
    }
    if (instances.size) requestAnimationFrame(loop);
    else looping = false;
  }
  function ensureLoop() {
    if (!looping && instances.size) { looping = true; requestAnimationFrame(loop); }
  }

  function refresh() { scan(); ensureLoop(); }

  let scanQueued = false;
  new MutationObserver(() => {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(() => { scanQueued = false; refresh(); }, 300);
  }).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('loadeddata', refresh, true);
  setInterval(refresh, 2000);

  // ---------- settings (saved via GM storage when available, else per-site) ----------
  const KEY = '__videoUpscalerSettings';
  const hasGM = typeof GM !== 'undefined' && GM && typeof GM.getValue === 'function';
  async function load() {
    try {
      const raw = hasGM ? await GM.getValue(KEY) : localStorage.getItem(KEY);
      if (raw) settings = { ...DEFAULTS, ...(typeof raw === 'string' ? JSON.parse(raw) : raw) };
    } catch (_) {}
    refresh();
  }
  function save() {
    const raw = JSON.stringify(settings);
    try { if (hasGM) GM.setValue(KEY, raw); else localStorage.setItem(KEY, raw); } catch (_) {}
    for (const up of instances.values()) up.lastKey = '';
    refresh();
  }
  load();

  // ---------- on-screen messages ----------
  let toastEl = null, toastTimer = 0;
  function toast(text) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      Object.assign(toastEl.style, {
        position: 'fixed', top: '16px', right: '16px', zIndex: '2147483647',
        background: 'rgba(17,24,39,0.92)', color: '#fff', padding: '10px 14px',
        borderRadius: '10px', font: '13px/1.4 -apple-system, BlinkMacSystemFont, sans-serif',
        pointerEvents: 'none', whiteSpace: 'pre-line', boxShadow: '0 4px 16px rgba(0,0,0,.3)',
      });
    }
    const host = document.fullscreenElement || document.webkitFullscreenElement || document.body;
    if (toastEl.parentNode !== host) host.appendChild(toastEl);
    toastEl.textContent = text;
    toastEl.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, 2200);
  }

  const LABELS = {
    active: 'Upscaling', native: 'Idle: already at screen resolution',
    drm: 'Protected (DRM) video: Safari blocks processing',
    'cross-origin': 'Blocked by site security', 'no-webgl': 'WebGL2 unavailable',
    waiting: 'Waiting for video to play', off: 'Off',
  };
  function statusText() {
    const lines = [];
    for (const [v, up] of instances) {
      if (up.status === 'too-small' || up.status === 'hidden') continue;
      const res = up.status === 'active' ? `  ${v.videoWidth}×${v.videoHeight} → ${up.canvas.width}×${up.canvas.height}` : '';
      lines.push((LABELS[up.status] || up.status) + res);
    }
    return lines.join('\n');
  }
  const sharpText = () => settings.sharpness > 0.001 ? `Sharpness ${Math.round(settings.sharpness * 100)}%` : 'Sharpness off (upscale only)';

  // ---------- keyboard shortcuts (Option + Shift + …) ----------
  window.addEventListener('keydown', (e) => {
    if (!e.altKey || !e.shiftKey || e.metaKey || e.ctrlKey) return;
    let handled = true;
    switch (e.code) {
      case 'KeyU':
        settings.enabled = !settings.enabled; save();
        toast(`Video Upscaler ${settings.enabled ? 'ON' : 'OFF'}`);
        break;
      case 'BracketRight':
        settings.sharpness = Math.min(1, Math.round((settings.sharpness + 0.1) * 10) / 10); save();
        toast(sharpText());
        break;
      case 'BracketLeft':
        settings.sharpness = Math.max(0, Math.round((settings.sharpness - 0.1) * 10) / 10); save();
        toast(sharpText());
        break;
      case 'KeyR': {
        const order = [1080, 1440, 2160];
        settings.maxRes = order[(order.indexOf(Number(settings.maxRes)) + 1) % order.length]; save();
        toast(`Max output: ${settings.maxRes === 2160 ? '4K' : settings.maxRes + 'p'}`);
        break;
      }
      case 'KeyI':
        setTimeout(() => toast(`Video Upscaler ${settings.enabled ? 'ON' : 'OFF'} · ${sharpText()}\n` + (statusText() || 'No video found on this page')), 50);
        break;
      default: handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }, true);
})();
