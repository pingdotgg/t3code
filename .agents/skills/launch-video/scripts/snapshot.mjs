// Freezes the live app page into a static HTML file that a story can load and animate.
// saveBeat(page, dir, name): `page` is anything with Playwright's `evaluate`, such as a
// scenario's `browser`. Writes <dir>/beats/<name>.html; fonts and images go to
// <dir>/beats/assets, shared by every beat.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// Runs in the page. Returns the frozen document and the assets it references.
async function freeze(known) {
  const hash = (s) => {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  };
  const assets = {};
  const local = (raw, base) => {
    if (!raw || raw.startsWith("data:") || raw.startsWith("#")) return raw;
    const url = new URL(raw, base).href;
    const ext = (new URL(url).pathname.match(/\.[a-z0-9]{1,5}$/i) ?? [""])[0];
    const name = `assets/${hash(url)}${ext}`;
    assets[name] = url;
    return name;
  };
  const urlPattern = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  const rewrite = (css, base) => css.replace(urlPattern, (_, __, u) => `url("${local(u, base)}")`);

  let css = "";
  for (const sheet of [...document.styleSheets, ...document.adoptedStyleSheets]) {
    let rules;
    try {
      rules = [...sheet.cssRules];
    } catch {
      continue;
    }
    css += rewrite(rules.map((r) => r.cssText).join("\n"), sheet.href ?? location.href) + "\n";
  }

  const source = [...document.documentElement.querySelectorAll("*")];
  const clone = document.documentElement.cloneNode(true);
  const copies = [...clone.querySelectorAll("*")];
  source.forEach((el, i) => {
    const copy = copies[i];
    if (el.scrollTop || el.scrollLeft)
      copy.setAttribute("data-kit-scroll", `${el.scrollLeft},${el.scrollTop}`);
    if (el instanceof HTMLTextAreaElement) copy.textContent = el.value;
    else if (el instanceof HTMLInputElement) {
      // Hidden inputs carry ids and local paths nobody sees; keep them out of the beat.
      if (el.type === "hidden" || el.getAttribute("aria-hidden") === "true") {
        copy.removeAttribute("value");
        return;
      }
      copy.setAttribute("value", el.value);
      if (el.checked) copy.setAttribute("checked", "");
    } else if (el instanceof HTMLImageElement) {
      copy.removeAttribute("srcset");
      copy.setAttribute("src", local(el.currentSrc || el.src, location.href));
    } else if (el instanceof HTMLCanvasElement) {
      const img = document.createElement("img");
      for (const a of el.attributes) img.setAttribute(a.name, a.value);
      try {
        img.src = el.toDataURL();
      } catch {}
      img.style.width = `${el.clientWidth}px`;
      img.style.height = `${el.clientHeight}px`;
      copy.replaceWith(img);
    } else if (el instanceof HTMLIFrameElement) {
      const box = document.createElement("div");
      for (const a of el.attributes)
        if (a.name !== "src" && a.name !== "srcdoc") box.setAttribute(a.name, a.value);
      box.setAttribute("data-kit-iframe", el.src);
      copy.replaceWith(box);
    }
    const style = copy.getAttribute?.("style");
    if (style?.includes("url(")) copy.setAttribute("style", rewrite(style, location.href));
  });
  for (const el of clone.querySelectorAll("script, noscript, style, link, base")) el.remove();

  const head = clone.querySelector("head");
  const styleEl = document.createElement("style");
  styleEl.textContent = css;
  head.append(styleEl);
  const viewport = document.createElement("meta");
  viewport.name = "kit-viewport";
  viewport.content = `${innerWidth}x${innerHeight}`;
  head.append(viewport);
  const restore = document.createElement("script");
  restore.textContent = `for (const el of document.querySelectorAll("[data-kit-scroll]")) { const [x, y] = el.dataset.kitScroll.split(",").map(Number); el.scrollLeft = x; el.scrollTop = y; }`;
  clone.querySelector("body").append(restore);

  const fetched = {};
  for (const [name, url] of Object.entries(assets)) {
    if (known.includes(name)) continue;
    try {
      const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000)
        bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      fetched[name] = btoa(bin);
    } catch {}
  }
  return {
    html: `<!doctype html>\n${clone.outerHTML}`,
    assets: fetched,
    viewport: { width: innerWidth, height: innerHeight },
  };
}

export async function saveBeat(page, dir, name) {
  const beats = NodePath.join(dir, "beats");
  NodeFS.mkdirSync(NodePath.join(beats, "assets"), { recursive: true });
  const known = NodeFS.readdirSync(NodePath.join(beats, "assets")).map((f) => `assets/${f}`);
  const result = await page.evaluate(freeze, known);
  for (const [file, base64] of Object.entries(result.assets)) {
    NodeFS.writeFileSync(NodePath.join(beats, file), Buffer.from(base64, "base64"));
  }
  NodeFS.writeFileSync(NodePath.join(beats, `${name}.html`), result.html);
  return result.viewport;
}
