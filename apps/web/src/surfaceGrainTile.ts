// Raster re-runs the grain's SVG noise filter for every repainted tile of every grained surface.
// Drawing the SVG once into a bitmap at the device scale gives the same pixels (identical under
// GPU raster) for the cost of an image draw. Until the bitmap exists the SVG paints.
const GRAIN_REFERENCE = "var(--surface-grain)";

let grainRules: CSSStyleRule[] | null = null;
let tileScale = 0;
let wantedKey = "";
let writtenValue = GRAIN_REFERENCE;
const tileUrls = new Map<string, string>();

async function renderTile(source: string, scale: number): Promise<string | null> {
  const src = /^url\("(.+)"\)$/.exec(source)?.[1];
  const size = src ? Number(/viewBox='0 0 (\d+)/.exec(decodeURIComponent(src))?.[1]) : 0;
  if (!src || !size) return null;
  const image = new Image();
  image.src = src;
  await image.decode();
  const pixels = Math.round(size * scale);
  const canvas = document.createElement("canvas");
  canvas.width = pixels;
  canvas.height = pixels;
  canvas.getContext("2d")?.drawImage(image, 0, 0, pixels, pixels);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve));
  return blob && URL.createObjectURL(blob);
}

function findGrainRules() {
  const found: CSSStyleRule[] = [];
  const walk = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (
        rule instanceof CSSStyleRule &&
        rule.style.getPropertyValue("background-image").trim() === GRAIN_REFERENCE
      ) {
        found.push(rule);
      }
      if (rule instanceof CSSGroupingRule) walk(rule.cssRules);
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      walk(sheet.cssRules);
    } catch {
      // A cross-origin sheet cannot be read and holds no grain rules.
    }
  }
  return found;
}

// The tile goes into the grain rules as a literal url(), not into --surface-grain: Chromium
// repaints the whole background of an element whose background-image comes through var()
// every time that element restyles, and a custom property change on <html> restyles them all.
function writeGrainRules(value: string) {
  if (value === writtenValue) return;
  writtenValue = value;
  grainRules ??= findGrainRules();
  for (const rule of grainRules) {
    const priority = rule.style.getPropertyPriority("background-image");
    rule.style.setProperty("background-image", value, priority);
  }
}

function syncGrainTile() {
  const scale = window.devicePixelRatio;
  if (scale !== tileScale) {
    // A scale change (zoom, another display) needs new tiles; the SVG paints until then.
    for (const url of tileUrls.values()) URL.revokeObjectURL(url);
    tileUrls.clear();
    tileScale = scale;
    window
      .matchMedia(`(resolution: ${scale}dppx)`)
      .addEventListener("change", syncGrainTile, { once: true });
  }
  const source = getComputedStyle(document.documentElement)
    .getPropertyValue("--surface-grain")
    .trim();
  const key = `${scale} ${source}`;
  wantedKey = key;
  const ready = tileUrls.get(key);
  writeGrainRules(ready ? `url("${ready}")` : GRAIN_REFERENCE);
  if (ready) return;
  void renderTile(source, scale)
    .then((url) => {
      if (!url) return;
      if (scale !== tileScale) {
        URL.revokeObjectURL(url);
        return;
      }
      tileUrls.set(key, url);
      if (wantedKey === key) writeGrainRules(`url("${url}")`);
    })
    // A canvas the browser taints or cannot encode keeps the SVG grain.
    .catch(() => {});
}

export function startSurfaceGrainTiles() {
  // The theme decides which grain --surface-grain holds (t3-chat has its own).
  new MutationObserver(() => {
    if (tileScale) syncGrainTile();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme-id"] });
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(syncGrainTile, { timeout: 2000 });
  } else {
    window.setTimeout(syncGrainTile, 0);
  }
}
