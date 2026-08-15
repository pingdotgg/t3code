import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { chromium } from "playwright-core";

const marketingRoot = NodePath.resolve(NodeURL.fileURLToPath(new URL("..", import.meta.url)));
const publicRoot = NodePath.join(marketingRoot, "public");
const outputRoot = NodePath.join(publicRoot, "demo-states");
const ogOutputPath = NodePath.join(publicRoot, "og-image.png");
const ogSourceOutputPath = NodePath.join(publicRoot, "og-source.png");
const showcaseSpec = JSON.parse(
  await NodeFSP.readFile(NodePath.join(marketingRoot, "src", "lib", "showcase-spec.json"), "utf8"),
);
const ogStudioSetup = JSON.parse(
  await NodeFSP.readFile(
    NodePath.join(marketingRoot, "src", "lib", "og-studio-setup.json"),
    "utf8",
  ),
);
const captureSize = showcaseSpec.render;
const viewport = { width: captureSize.width, height: captureSize.height };
const ogCaptureSize = { width: 1200, height: 630 };
const ogSourceViewport = { width: 1440, height: 810 };
const featureClip = (x, y, width) => ({
  x,
  y,
  width,
  height: Math.round((width * captureSize.height) / captureSize.width),
});

const frozenMotionCss = `
  *, *::before, *::after {
    animation-delay: 0s !important;
    animation-duration: 0s !important;
    caret-color: transparent !important;
    transition-duration: 0s !important;
  }
`;

const toDataUrl = (mimeType, bytes) => `data:${mimeType};base64,${bytes.toString("base64")}`;

const ogVertexShaderSource = `
  attribute vec3 aPosition;
  attribute vec2 aUv;
  uniform float uPitch;
  uniform float uYaw;
  uniform float uRoll;
  uniform float uFov;
  uniform float uScale;
  uniform float uDistance;
  uniform vec2 uOffset;
  uniform float uViewportAspect;
  varying vec2 vUv;
  varying float vDepth;

  vec3 rotateX(vec3 point, float angle) {
    float sine = sin(angle);
    float cosine = cos(angle);
    return vec3(point.x, cosine * point.y - sine * point.z, sine * point.y + cosine * point.z);
  }

  vec3 rotateY(vec3 point, float angle) {
    float sine = sin(angle);
    float cosine = cos(angle);
    return vec3(cosine * point.x + sine * point.z, point.y, -sine * point.x + cosine * point.z);
  }

  vec3 rotateZ(vec3 point, float angle) {
    float sine = sin(angle);
    float cosine = cos(angle);
    return vec3(cosine * point.x - sine * point.y, sine * point.x + cosine * point.y, point.z);
  }

  void main() {
    vec3 point = aPosition * uScale;
    point = rotateX(point, uPitch);
    point = rotateY(point, uYaw);
    point = rotateZ(point, uRoll);
    point += vec3(uOffset, -uDistance);
    float focal = 1.0 / tan(uFov * 0.5);
    gl_Position = vec4(
      point.x * focal / uViewportAspect,
      point.y * focal,
      0.0,
      -point.z
    );
    vUv = aUv;
    vDepth = -point.z;
  }
`;

const ogFragmentShaderSource = `
  precision highp float;
  uniform sampler2D uTexture0;
  uniform sampler2D uTexture1;
  uniform sampler2D uTexture2;
  uniform sampler2D uTexture3;
  uniform sampler2D uTexture4;
  uniform float uFocusDistance;
  uniform float uFarBlur;
  uniform float uNearBlur;
  uniform float uMaxBlur;
  uniform float uFarFade;
  uniform float uNearFade;
  uniform float uBrightness;
  uniform float uSaturation;
  uniform float uVignette;
  uniform float uEdgeFade;
  uniform float uCornerRadius;
  varying vec2 vUv;
  varying float vDepth;

  vec4 sampleLens(vec2 uv, float radius) {
    if (radius < 6.0) {
      return mix(
        texture2D(uTexture0, uv),
        texture2D(uTexture1, uv),
        smoothstep(0.0, 6.0, radius)
      );
    }
    if (radius < 14.0) {
      return mix(
        texture2D(uTexture1, uv),
        texture2D(uTexture2, uv),
        smoothstep(6.0, 14.0, radius)
      );
    }
    if (radius < 28.0) {
      return mix(
        texture2D(uTexture2, uv),
        texture2D(uTexture3, uv),
        smoothstep(14.0, 28.0, radius)
      );
    }
    return mix(
      texture2D(uTexture3, uv),
      texture2D(uTexture4, uv),
      smoothstep(28.0, 56.0, radius)
    );
  }

  float roundedRectangleMask(vec2 uv, float radius) {
    vec2 point = abs(uv - 0.5) - vec2(0.5 - radius);
    float distance = length(max(point, 0.0)) + min(max(point.x, point.y), 0.0) - radius;
    return 1.0 - smoothstep(0.0, 0.004, distance);
  }

  void main() {
    float depthDelta = vDepth - uFocusDistance;
    float rawBlur = depthDelta >= 0.0
      ? depthDelta * uFarBlur
      : -depthDelta * uNearBlur;
    float focusFalloff = smoothstep(0.02, 0.22, abs(depthDelta));
    float blurRadius = uMaxBlur > 0.0
      ? uMaxBlur * (1.0 - exp(-max(rawBlur, 0.0) / max(uMaxBlur, 0.001)))
      : 0.0;
    blurRadius *= focusFalloff;

    vec4 color = sampleLens(vUv, blurRadius);
    float luminance = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
    color.rgb = mix(vec3(luminance), color.rgb, uSaturation);

    float farAmount = smoothstep(0.0, 1.35, max(depthDelta, 0.0));
    float nearAmount = smoothstep(0.0, 1.35, max(-depthDelta, 0.0));
    float depthLight = (1.0 - farAmount * uFarFade) * (1.0 - nearAmount * uNearFade);

    vec2 vignettePoint = (vUv - 0.5) * vec2(0.82, 1.0);
    float vignetteMask = 1.0 - smoothstep(0.24, 0.72, length(vignettePoint));
    float vignetteLight = mix(1.0, vignetteMask, uVignette);

    float edge = max(uEdgeFade, 0.0001);
    float edgeMask =
      smoothstep(0.0, edge, vUv.x) *
      smoothstep(0.0, edge, vUv.y) *
      smoothstep(0.0, edge, 1.0 - vUv.x) *
      smoothstep(0.0, edge, 1.0 - vUv.y);
    float shapeMask = roundedRectangleMask(vUv, uCornerRadius);

    color.rgb *= uBrightness * depthLight * vignetteLight;
    color.a *= edgeMask * shapeMask;
    gl_FragColor = color;
  }
`;

async function freezeMotion(page) {
  await page.addStyleTag({ content: frozenMotionCss });
}

async function waitForDemoReady(page) {
  await page.getByText("All projects", { exact: true }).first().waitFor({
    state: "visible",
    timeout: 30_000,
  });
}

function ogSceneHtml({ demoFrameDataUrl }) {
  const state = ogStudioSetup.state;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=${ogCaptureSize.width}, initial-scale=1">
    <style>
      * { box-sizing: border-box; }

      html,
      body {
        margin: 0;
        width: ${ogCaptureSize.width}px;
        height: ${ogCaptureSize.height}px;
        overflow: hidden;
        background: ${state.background};
        color: #f5f5f7;
        font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      body {
        position: relative;
      }

      canvas {
        position: absolute;
        inset: 0;
        display: block;
        width: ${ogCaptureSize.width}px;
        height: ${ogCaptureSize.height}px;
      }

      .brand {
        position: absolute;
        z-index: 2;
        top: ${state.logoY}px;
        left: ${state.logoX}px;
        color: rgba(245, 245, 247, 0.9);
        letter-spacing: -0.035em;
        font-size: ${27 * state.logoScale}px;
        font-weight: 600;
        text-shadow: 0 2px 28px rgba(0, 0, 0, 0.64);
      }

      .brand[hidden] {
        display: none;
      }
    </style>
  </head>
  <body>
    <canvas width="${ogCaptureSize.width}" height="${ogCaptureSize.height}"></canvas>
    <div class="brand" ${state.logoVisible ? "" : "hidden"}>T3 Code</div>
    <script>
      const state = ${JSON.stringify(state)};
      const canvas = document.querySelector("canvas");
      const gl = canvas.getContext("webgl", {
        alpha: false,
        antialias: true,
        preserveDrawingBuffer: true,
        premultipliedAlpha: false,
      });
      if (!gl) throw new Error("WebGL is required to render the OG image.");

      const compileShader = (type, source) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          throw new Error(gl.getShaderInfoLog(shader) || "Could not compile OG shader.");
        }
        return shader;
      };

      const program = gl.createProgram();
      gl.attachShader(program, compileShader(gl.VERTEX_SHADER, ${JSON.stringify(ogVertexShaderSource)}));
      gl.attachShader(program, compileShader(gl.FRAGMENT_SHADER, ${JSON.stringify(ogFragmentShaderSource)}));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program) || "Could not link OG shader.");
      }
      gl.useProgram(program);

      const planeAspect = 16 / 9;
      const vertices = new Float32Array([
        -planeAspect, 1, 0, 0, 1,
        -planeAspect, -1, 0, 0, 0,
        planeAspect, 1, 0, 1, 1,
        planeAspect, 1, 0, 1, 1,
        -planeAspect, -1, 0, 0, 0,
        planeAspect, -1, 0, 1, 0,
      ]);
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

      const positionLocation = gl.getAttribLocation(program, "aPosition");
      const uvLocation = gl.getAttribLocation(program, "aUv");
      gl.enableVertexAttribArray(positionLocation);
      gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, 20, 0);
      gl.enableVertexAttribArray(uvLocation);
      gl.vertexAttribPointer(uvLocation, 2, gl.FLOAT, false, 20, 12);

      const uniform = (name) => gl.getUniformLocation(program, name);
      const blurLevels = [0, 6, 14, 28, 56];
      const textures = blurLevels.map((_, index) => {
        const texture = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0 + index);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.uniform1i(uniform("uTexture" + index), index);
        return texture;
      });

      const source = new Image();
      source.addEventListener("load", () => {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        const blurCanvas = document.createElement("canvas");
        blurCanvas.width = 1200;
        blurCanvas.height = 675;
        const blurContext = blurCanvas.getContext("2d");
        if (!blurContext) throw new Error("Could not initialize the blur renderer.");
        for (const [index, radius] of blurLevels.entries()) {
          blurContext.clearRect(0, 0, blurCanvas.width, blurCanvas.height);
          blurContext.filter = radius === 0 ? "none" : "blur(" + radius + "px)";
          blurContext.drawImage(source, 0, 0, blurCanvas.width, blurCanvas.height);
          blurContext.filter = "none";
          gl.activeTexture(gl.TEXTURE0 + index);
          gl.bindTexture(gl.TEXTURE_2D, textures[index]);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, blurCanvas);
        }

        const radians = (value) => value * Math.PI / 180;
        const background = state.background.replace("#", "");
        const backgroundValue = Number.parseInt(background, 16);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(
          ((backgroundValue >> 16) & 255) / 255,
          ((backgroundValue >> 8) & 255) / 255,
          (backgroundValue & 255) / 255,
          1,
        );
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.uniform1f(uniform("uPitch"), radians(state.pitch));
        gl.uniform1f(uniform("uYaw"), radians(state.yaw));
        gl.uniform1f(uniform("uRoll"), radians(state.roll));
        gl.uniform1f(uniform("uFov"), radians(state.fov));
        gl.uniform1f(uniform("uScale"), state.scale);
        gl.uniform1f(uniform("uDistance"), state.distance);
        gl.uniform2f(uniform("uOffset"), state.offsetX, state.offsetY);
        gl.uniform1f(uniform("uViewportAspect"), canvas.width / canvas.height);
        gl.uniform1f(uniform("uFocusDistance"), state.focusDistance);
        gl.uniform1f(uniform("uFarBlur"), state.farBlur);
        gl.uniform1f(uniform("uNearBlur"), state.nearBlur);
        gl.uniform1f(uniform("uMaxBlur"), state.maxBlur);
        gl.uniform1f(uniform("uFarFade"), state.farFade);
        gl.uniform1f(uniform("uNearFade"), state.nearFade);
        gl.uniform1f(uniform("uBrightness"), state.brightness);
        gl.uniform1f(uniform("uSaturation"), state.saturation);
        gl.uniform1f(uniform("uVignette"), state.vignette);
        gl.uniform1f(uniform("uEdgeFade"), state.edgeFade);
        gl.uniform1f(uniform("uCornerRadius"), state.cornerRadius);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        requestAnimationFrame(() => {
          document.documentElement.dataset.rendered = "true";
        });
      });
      source.src = ${JSON.stringify(demoFrameDataUrl)};
    </script>
  </body>
</html>`;
}

function browserDemoHtml(mode) {
  const annotating = mode === "annotate";
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#090909;color:#f5f5f5;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
body{display:grid;grid-template-columns:270px 1fr}.thread{border-right:1px solid #272727;background:#101010;padding:22px 18px;display:flex;flex-direction:column;gap:18px}
.brand{font-size:16px;font-weight:650;letter-spacing:-.02em}.bubble{border:1px solid #292929;border-radius:12px;background:#151515;padding:14px;font-size:13px;line-height:1.5;color:#d1d1d1}.bubble.agent{margin-top:auto}.tool{display:flex;gap:9px;align-items:center;color:#929292;font:11px ui-monospace,SFMono-Regular,monospace}.tool i{width:7px;height:7px;border-radius:50%;background:#3b82f6;box-shadow:0 0 0 4px #14233a}
.preview{position:relative;display:flex;flex-direction:column;min-width:0}.tabs{height:42px;border-bottom:1px solid #292929;display:flex;align-items:center;gap:2px;padding:0 12px}.tab{padding:7px 11px;border-radius:7px;font-size:12px;color:#777}.tab.active{background:#202020;color:#f5f5f5}
.chrome{height:44px;border-bottom:1px solid #292929;display:flex;align-items:center;gap:9px;padding:7px 11px;background:#111}.nav{font-size:16px;color:#858585}.address{height:29px;flex:1;border-radius:7px;background:#1d1d1d;color:#bdbdbd;padding:7px 12px;font-size:11px}.chrome button{height:29px;border:1px solid #333;border-radius:7px;background:#191919;color:#d8d8d8;padding:0 10px;font-size:11px}.chrome button.active{border-color:#315ad9;background:#1c2b5c;color:#dce6ff}
.page{position:relative;flex:1;background:#f6f7fb;color:#131724;padding:36px 42px;overflow:hidden}.page nav{display:flex;justify-content:space-between;align-items:center;font-size:12px;font-weight:700}.page nav span:last-child{background:#171b29;color:white;border-radius:20px;padding:8px 14px}.hero{display:grid;grid-template-columns:1.08fr .92fr;gap:28px;margin-top:38px;align-items:center}.hero h1{font-size:38px;line-height:1.02;letter-spacing:-.045em;margin:0 0 15px}.hero p{font-size:14px;color:#5d6474;line-height:1.55;margin:0 0 20px}.cta{display:inline-flex;background:#3163f4;color:#fff;border-radius:9px;padding:10px 15px;font-size:12px;font-weight:650}.art{height:230px;border-radius:20px;background:linear-gradient(145deg,#d9e4ff,#7e9cf2);padding:18px;box-shadow:0 22px 40px -22px #4b62a8}.window{height:100%;border-radius:13px;background:#fff;box-shadow:0 8px 28px #5e72aa55;padding:14px}.window div{height:10px;border-radius:9px;background:#e7eaf3;margin-bottom:9px}.window div:nth-child(2){width:70%}.window div:nth-child(3){height:92px;margin-top:20px;background:#f3f5fa}
.result{position:absolute;right:22px;bottom:20px;width:230px;border:1px solid #333;border-radius:12px;background:#111;color:#eee;padding:13px;box-shadow:0 18px 45px #0008}.result-head{display:flex;justify-content:space-between;font-size:12px;font-weight:650}.passed{color:#53d89b}.checks{display:grid;gap:7px;margin-top:11px;font:10px ui-monospace,SFMono-Regular,monospace;color:#9d9d9d}.checks span:before{content:"✓";color:#53d89b;margin-right:7px}
.selection{position:absolute;left:40px;top:124px;width:325px;height:140px;border:2px solid #3478ff;border-radius:8px;background:#3478ff12}.selection-label{position:absolute;top:-26px;left:-2px;background:#3478ff;color:white;border-radius:5px;padding:5px 8px;font:10px ui-monospace,SFMono-Regular,monospace}.cursor{position:absolute;left:345px;top:245px;color:#3478ff;font-size:25px;filter:drop-shadow(0 2px 2px #fff)}
</style></head><body>
<aside class="thread"><div class="brand">T3 Code <span style="color:#666;font-weight:500">/ Browser test</span></div><div class="bubble">Check the landing page at <b>localhost:4321</b>. Test the mobile menu and make sure the download CTA stays visible.</div><div class="bubble agent">${annotating ? "I opened the page and selected the hero region. The CTA loses contrast over the illustration at the tablet breakpoint." : "The page is open in the in-app browser. I checked navigation, responsive layout, and the download flow."}</div><div class="tool"><i></i>${annotating ? "Element selected · screenshot attached" : "Browser test complete · 7 assertions"}</div></aside>
<main class="preview"><div class="tabs"><span class="tab">Thread</span><span class="tab">Diff</span><span class="tab active">Browser</span></div><div class="chrome"><span class="nav">‹</span><span class="nav">›</span><span class="nav">↻</span><div class="address">localhost:4321</div><button class="${annotating ? "active" : ""}">◎ Annotate</button><button>● Record</button></div><section class="page"><nav><span>ACME STUDIO</span><span>Get started</span></nav><div class="hero"><div><h1>Build the next thing, faster.</h1><p>A focused workspace for teams shipping ambitious products without the usual noise.</p><span class="cta">Start building →</span></div><div class="art"><div class="window"><div></div><div></div><div></div></div></div></div>${annotating ? '<div class="selection"><span class="selection-label">section.hero</span></div><div class="cursor">⌁</div>' : '<div class="result"><div class="result-head"><span>Browser test</span><span class="passed">7 passed</span></div><div class="checks"><span>Navigation links</span><span>CTA remains visible</span><span>Mobile menu opens</span><span>No console errors</span></div></div>'}</section></main>
</body></html>`;
}

const states = [
  {
    name: "inbox-overview-crop",
    hash: "#/demo-mac-studio/thread-flaky",
    clip: featureClip(0, 0, 720),
    deviceScaleFactor: 3,
  },
  {
    name: "ship-commit-editor-crop",
    hash: "#/demo-mac-studio/thread-flaky",
    clip: featureClip(0, 0, captureSize.width),
    deviceScaleFactor: 3,
    prepare: async (page) => {
      await page.locator('button[aria-label="Git action options"]').click();
      await page.getByText("Commit", { exact: true }).last().click();
      await page.getByText("Commit changes", { exact: true }).waitFor({ state: "visible" });
      await page
        .getByPlaceholder("Leave empty to auto-generate")
        .fill("Deflake GitManager cross-repo metadata test");
    },
  },
  {
    name: "review-diff-crop",
    hash: "#/demo-mac-studio/thread-composer",
    clip: featureClip(510, 50, 570),
    deviceScaleFactor: 4,
  },
  {
    name: "browser-test-crop",
    standalone: "test",
    clip: featureClip(270, 42, 810),
    deviceScaleFactor: 3,
  },
];

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

async function exists(path) {
  try {
    await NodeFSP.access(path);
    return true;
  } catch {
    return false;
  }
}

async function findChromium() {
  const candidates = [
    process.env.CHROME_BIN,
    chromium.executablePath(),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);

  const playwrightCache = NodePath.join(NodeOS.homedir(), "Library", "Caches", "ms-playwright");
  if (await exists(playwrightCache)) {
    const macChromeDirectories = ["chrome-mac-arm64", "chrome-mac-x64"];
    const revisions = (await NodeFSP.readdir(playwrightCache, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("chromium-"))
      .map((entry) => entry.name)
      .sort()
      .toReversed();
    for (const revision of revisions) {
      for (const macChromeDirectory of macChromeDirectories) {
        candidates.push(
          NodePath.join(
            playwrightCache,
            revision,
            macChromeDirectory,
            "Google Chrome for Testing.app",
            "Contents",
            "MacOS",
            "Google Chrome for Testing",
          ),
        );
      }
    }
  }

  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

function startStaticServer() {
  const server = NodeHttp.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const relativePath = NodePath.normalize(decodeURIComponent(requestUrl.pathname)).replace(
        /^[/\\]+/,
        "",
      );
      let filePath = NodePath.resolve(publicRoot, relativePath);
      const pathFromPublicRoot = NodePath.relative(publicRoot, filePath);
      if (
        pathFromPublicRoot === ".." ||
        pathFromPublicRoot.startsWith(`..${NodePath.sep}`) ||
        NodePath.isAbsolute(pathFromPublicRoot)
      ) {
        response.writeHead(403).end();
        return;
      }
      if ((await NodeFSP.stat(filePath)).isDirectory()) {
        filePath = NodePath.join(filePath, "index.html");
      }
      const body = await NodeFSP.readFile(filePath);
      response.setHeader(
        "Content-Type",
        mimeTypes.get(NodePath.extname(filePath)) ?? "application/octet-stream",
      );
      response.setHeader("Cache-Control", "no-store");
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });

  return new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not resolve the demo capture server port."));
        return;
      }
      resolveServer({
        origin: `http://localhost:${address.port}`,
        close: () => new Promise((resolveClose) => server.close(resolveClose)),
      });
    });
  });
}

async function outputsExist() {
  const demoOutputsExist = (
    await Promise.all(states.map(({ name }) => exists(NodePath.join(outputRoot, `${name}.png`))))
  ).every(Boolean);
  return demoOutputsExist && (await exists(ogOutputPath)) && (await exists(ogSourceOutputPath));
}

const executablePath = await findChromium();
if (!executablePath) {
  if (await outputsExist()) {
    console.warn("[marketing] Chromium unavailable; keeping committed demo screenshots.");
    process.exit(0);
  }
  throw new Error("Chromium is required to create the initial marketing demo screenshots.");
}

const hadCommittedOutputs = await outputsExist();
const temporaryOutputRoot = await NodeFSP.mkdtemp(
  NodePath.join(NodeOS.tmpdir(), "t3-marketing-demo-"),
);
let staticServer;
let browser;

try {
  staticServer = await startStaticServer();
  browser = await chromium.launch({ executablePath, headless: true });

  for (const state of states) {
    const page = await browser.newPage({
      colorScheme: "dark",
      deviceScaleFactor: state.deviceScaleFactor ?? captureSize.deviceScaleFactor,
      viewport,
    });
    try {
      if (state.standalone) {
        await page.setContent(browserDemoHtml(state.standalone), {
          waitUntil: "domcontentloaded",
        });
      } else {
        await page.goto(`${staticServer.origin}/sidebar-demo/demo.html${state.hash}`, {
          waitUntil: "domcontentloaded",
        });
        await waitForDemoReady(page);
      }
      await freezeMotion(page);
      await state.prepare?.(page);
      await page.waitForTimeout(400);
      await page.screenshot({
        path: NodePath.join(temporaryOutputRoot, `${state.name}.png`),
        type: "png",
        clip: state.clip,
      });
    } finally {
      await page.close();
    }
  }

  let demoFrameBytes;
  const sourcePage = await browser.newPage({
    colorScheme: "dark",
    deviceScaleFactor: 2,
    viewport: ogSourceViewport,
  });
  try {
    await sourcePage.goto(
      `${staticServer.origin}/sidebar-demo/demo.html#/demo-mac-studio/thread-flaky`,
      { waitUntil: "domcontentloaded" },
    );
    await waitForDemoReady(sourcePage);
    await freezeMotion(sourcePage);
    const modelPickerTrigger = sourcePage.locator('[data-chat-provider-model-picker="true"]');
    const modelPickerTriggerCount = await modelPickerTrigger.count();
    if (modelPickerTriggerCount !== 1) {
      throw new Error(`Expected one demo model picker trigger, found ${modelPickerTriggerCount}.`);
    }
    await modelPickerTrigger.click();
    await sourcePage.locator('[data-model-picker-content="true"]').waitFor({
      state: "visible",
      timeout: 10_000,
    });
    await sourcePage.waitForTimeout(300);
    demoFrameBytes = await sourcePage.screenshot({ type: "png" });
    await NodeFSP.writeFile(NodePath.join(temporaryOutputRoot, "og-source.png"), demoFrameBytes);
  } finally {
    await sourcePage.close();
  }

  const ogPage = await browser.newPage({
    colorScheme: "dark",
    deviceScaleFactor: 1,
    viewport: ogCaptureSize,
  });
  try {
    await ogPage.setContent(
      ogSceneHtml({
        demoFrameDataUrl: toDataUrl("image/png", demoFrameBytes),
      }),
      { waitUntil: "domcontentloaded" },
    );
    await ogPage.waitForFunction(
      () =>
        document.documentElement.dataset.rendered === "true" &&
        Array.from(document.images).every((image) => image.complete && image.naturalWidth > 0),
    );
    await ogPage.screenshot({
      path: NodePath.join(temporaryOutputRoot, "og-image.png"),
      type: "png",
    });
  } finally {
    await ogPage.close();
  }

  await NodeFSP.mkdir(outputRoot, { recursive: true });
  for (const state of states) {
    await NodeFSP.copyFile(
      NodePath.join(temporaryOutputRoot, `${state.name}.png`),
      NodePath.join(outputRoot, `${state.name}.png`),
    );
    console.log(`[marketing] captured demo-states/${state.name}.png`);
  }
  await NodeFSP.copyFile(NodePath.join(temporaryOutputRoot, "og-image.png"), ogOutputPath);
  console.log("[marketing] captured og-image.png");
  await NodeFSP.copyFile(NodePath.join(temporaryOutputRoot, "og-source.png"), ogSourceOutputPath);
  console.log("[marketing] captured og-source.png");
} catch (error) {
  if (!hadCommittedOutputs) throw error;
  console.warn(
    `[marketing] demo capture failed; keeping committed screenshots (${String(error)}).`,
  );
} finally {
  if (browser) await browser.close();
  if (staticServer) await staticServer.close();
  await NodeFSP.rm(temporaryOutputRoot, { recursive: true, force: true });
}
