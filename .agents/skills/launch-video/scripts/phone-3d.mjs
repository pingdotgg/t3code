// Renders <dir>/phone-frames/f%04d.jpg (416×904, 30 fps) onto iphone-18-pro.glb with a 2 s
// spin-in and 0.3 s exit, to <dir>/phone-3d.mov (1920×1080 with alpha).
// Usage: node phone-3d.mjs <dir> [--probe]   (--probe writes a few frames to <dir>/probe-3d)
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import { findChrome } from "./chrome.mjs";

const REPO = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../..",
);
const require = NodeModule.createRequire(NodePath.join(REPO, "apps/server/package.json"));
const { chromium } = require("playwright-core");
const THREE_DIR = NodePath.join(REPO, "packages/client-runtime/node_modules/three");
const GLB_PATH = NodePath.join(REPO, "apps/web/src/components/device/models/iphone-18-pro.glb");
if (!process.argv[2]) throw new Error("usage: phone-3d.mjs <dir> [--probe]");
const DIR = NodePath.resolve(process.argv[2]);
const FRAMES_DIR = NodePath.join(DIR, "phone-frames");
const PROBE = process.argv.includes("--probe");

const frameFiles = NodeFS.readdirSync(FRAMES_DIR)
  .filter((f) => f.endsWith(".jpg"))
  .sort();
const LIVE_FRAMES = frameFiles.length;
const INTRO_FRAMES = 60; // 2.0s spin-in
const OUTRO_FRAMES = 9; // 0.3s exit
const TOTAL_FRAMES = INTRO_FRAMES + LIVE_FRAMES + OUTRO_FRAMES;

const HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    html, body { margin: 0; padding: 0; width: 1920px; height: 1080px; overflow: hidden; background: transparent; }
    canvas { display: block; width: 1920px; height: 1080px; }
  </style>
  <script type="importmap">
  {
    "imports": {
      "three": "/three/build/three.module.js",
      "three/addons/": "/three/examples/jsm/"
    }
  }
  </script>
</head>
<body>
  <canvas id="c" width="1920" height="1080"></canvas>
  <script type="module">
    import * as THREE from "three";
    import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

    const canvas = document.getElementById("c");
    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    renderer.setSize(1920, 1080, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1920 / 1080, 0.1, 30);
    camera.position.set(0, 0, 5.2);

    // Exact 4-light studio rig from packages/client-runtime/src/device/phoneViewer.ts
    const ambient = new THREE.AmbientLight(0xffffff, 2.4);
    const key = new THREE.DirectionalLight(0xe4edff, 5);
    key.position.set(-3, 4, 5);
    const rim = new THREE.DirectionalLight(0xffffff, 4);
    rim.position.set(3, 1, -3);
    const fill = new THREE.DirectionalLight(0x9facd4, 2);
    fill.position.set(-2, -2, -4);
    scene.add(ambient, key, rim, fill);

    const gltf = await new GLTFLoader().loadAsync("/model/iphone-18-pro.glb");
    const asset = gltf.scene;
    let display = null;
    asset.traverse((obj) => {
      if (obj.isMesh && obj.name === "device-screen") display = obj;
    });
    if (!display) throw new Error("device-screen mesh not found");

    asset.updateMatrixWorld(true);
    const screenBounds = new THREE.Box3().setFromObject(display);
    const sw = screenBounds.max.x - screenBounds.min.x;
    const sh = screenBounds.max.y - screenBounds.min.y;
    const pos = display.geometry.attributes.position;
    let uv = display.geometry.attributes.uv;
    if (!uv) {
      uv = new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2);
      display.geometry.setAttribute("uv", uv);
    }
    for (let i = 0; i < pos.count; i++) {
      const u = (pos.getX(i) + sw / 2) / sw;
      const v = (pos.getY(i) + sh / 2) / sh;
      uv.setXY(i, u, v);
    }
    uv.needsUpdate = true;

    const screenCanvas = document.createElement("canvas");
    screenCanvas.width = 416;
    screenCanvas.height = 904;
    const ctx = screenCanvas.getContext("2d");
    const texture = new THREE.CanvasTexture(screenCanvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;

    display.material = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false });

    const pivot = new THREE.Group();
    pivot.add(asset);
    scene.add(pivot);

    const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3);
    const easeInOutCubic = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

    const imgCache = new Map();
    const loadImg = (url) =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = url;
      });

    window.renderFrame = async (frameIdx, totalIntro, totalLive, frameUrl) => {
      const img = await loadImg(frameUrl);
      ctx.drawImage(img, 0, 0, screenCanvas.width, screenCanvas.height);
      texture.needsUpdate = true;

      const t = frameIdx / 30;
      const restX = -1.38;
      const restY = 0.0;
      const restScale = 1.03;

      if (frameIdx < totalIntro) {
        const p = frameIdx / totalIntro;
        const eRot = easeOutCubic(p);
        const eSlide = easeInOutCubic(Math.max(0, (p - 0.35) / 0.65));
        // Spins from the back (-205°) to the hero pose (+7°).
        pivot.rotation.y = -3.65 + (3.65 + 0.13) * eRot;
        pivot.rotation.x = 0.24 * (1 - eRot) + 0.02 * eRot;
        pivot.rotation.z = -0.10 * (1 - eRot);
        pivot.position.x = restX * eSlide;
        pivot.position.y = restY + 0.12 * (1 - eRot);
        const s = 0.88 + (restScale - 0.88) * eRot;
        pivot.scale.set(s, s, s);
      } else if (frameIdx < totalIntro + totalLive) {
        const lt = (frameIdx - totalIntro) / 30;
        // A slow float keeps the edge and camera depth visible.
        pivot.rotation.y = 0.13 + 0.035 * Math.sin(lt * 0.85);
        pivot.rotation.x = 0.02 + 0.015 * Math.cos(lt * 0.65);
        pivot.rotation.z = 0.005 * Math.sin(lt * 0.5);
        pivot.position.set(restX, restY + 0.02 * Math.sin(lt * 1.1), 0);
        pivot.scale.set(restScale, restScale, restScale);
      } else {
        const ep = (frameIdx - totalIntro - totalLive) / 9;
        const e = easeInOutCubic(ep);
        pivot.rotation.y = 0.13 - 0.65 * e;
        pivot.position.set(restX - 1.4 * e, restY, 0);
        const s = restScale * (1 - 0.15 * e);
        pivot.scale.set(s, s, s);
      }

      renderer.render(scene, camera);
      return canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
    };

    window.__READY = true;
  </script>
</body>
</html>`;

const server = NodeHttp.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  if (url === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(HTML);
    return;
  }
  if (url === "/model/iphone-18-pro.glb") {
    res.writeHead(200, { "content-type": "model/gltf-binary" });
    NodeFS.createReadStream(GLB_PATH).pipe(res);
    return;
  }
  if (url.startsWith("/three/")) {
    const file = NodePath.join(THREE_DIR, url.slice("/three/".length));
    if (NodeFS.existsSync(file)) {
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
      NodeFS.createReadStream(file).pipe(res);
      return;
    }
  }
  if (url.startsWith("/frames/")) {
    const file = NodePath.join(FRAMES_DIR, url.slice("/frames/".length));
    if (NodeFS.existsSync(file)) {
      res.writeHead(200, { "content-type": "image/jpeg" });
      NodeFS.createReadStream(file).pipe(res);
      return;
    }
  }
  res.writeHead(404);
  res.end("not found");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: findChrome(chromium),
  headless: true,
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
  ],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on("pageerror", (e) => console.error("PAGEERROR:", e));
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.__READY === true, { timeout: 30000 });

if (PROBE) {
  const probeIndices = [2, 14, 28, 45, 75, 220];
  const probeDir = NodePath.join(DIR, "probe-3d");
  NodeFS.mkdirSync(probeDir, { recursive: true });
  for (let i = 0; i < probeIndices.length; i++) {
    const idx = probeIndices[i];
    const liveIdx = Math.max(0, Math.min(LIVE_FRAMES - 1, idx - INTRO_FRAMES));
    const b64 = await page.evaluate(
      ([fi, ti, tl, u]) => window.renderFrame(fi, ti, tl, u),
      [idx, INTRO_FRAMES, LIVE_FRAMES, `/frames/${frameFiles[liveIdx]}`],
    );
    NodeFS.writeFileSync(NodePath.join(probeDir, `p${i}.png`), Buffer.from(b64, "base64"));
  }
  console.log("PROBE_3D_DONE");
} else {
  const outPath = NodePath.join(DIR, "phone-3d.mov");
  const ff = NodeChildProcess.spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "image2pipe",
      "-vcodec",
      "png",
      "-framerate",
      "30",
      "-i",
      "-",
      "-c:v",
      "qtrle",
      "-pix_fmt",
      "argb",
      outPath,
    ],
    { stdio: ["pipe", "inherit", "inherit"] },
  );

  for (let idx = 0; idx < TOTAL_FRAMES; idx++) {
    const liveIdx = Math.max(0, Math.min(LIVE_FRAMES - 1, idx - INTRO_FRAMES));
    const b64 = await page.evaluate(
      ([fi, ti, tl, u]) => window.renderFrame(fi, ti, tl, u),
      [idx, INTRO_FRAMES, LIVE_FRAMES, `/frames/${frameFiles[liveIdx]}`],
    );
    const buf = Buffer.from(b64, "base64");
    if (!ff.stdin.write(buf)) {
      await new Promise((r) => ff.stdin.once("drain", r));
    }
    if (idx % 120 === 0) console.log(`3D frame ${idx}/${TOTAL_FRAMES}`);
  }
  ff.stdin.end();
  await new Promise((resolve, reject) =>
    ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`)))),
  );
  console.log("RENDER_3D_DONE", outPath);
}

await browser.close();
server.close();
