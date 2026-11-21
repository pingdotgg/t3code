#!/usr/bin/env node
// Finds elements in a frozen beat to target from a story: prints a selector, the box (in beat
// pixels) and the text of the smallest elements containing `text`, and of their clickable or
// labelled ancestors. Usage: find.mjs <beats/name.html> <text> [--all]
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import { findChrome } from "./chrome.mjs";

const [file, text] = process.argv.slice(2);
if (!file || !text) {
  console.error("usage: find.mjs <beats/name.html> <text>");
  process.exit(2);
}
const REPO = NodePath.resolve(import.meta.dirname, "../../../..");
const { chromium } = NodeModule.createRequire(NodePath.join(REPO, "scripts/package.json"))(
  "playwright-core",
);
const root = NodePath.dirname(NodePath.resolve(file));
const server = NodeHttp.createServer((req, res) => {
  NodeFS.readFile(
    NodePath.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname)),
    (error, body) =>
      error
        ? res.writeHead(404).end()
        : res
            .writeHead(200, req.url.endsWith(".html") ? { "content-type": "text/html" } : {})
            .end(body),
  );
}).listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const browser = await chromium.launch({
  executablePath: findChrome(chromium),
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 720 } });
  await page.goto(`http://127.0.0.1:${server.address().port}/${NodePath.basename(file)}`);
  const found = await page.evaluate((needle) => {
    // Short, stable selectors: data attributes and aria labels over generated classes.
    const describe = (el) => {
      const parts = [];
      for (
        let node = el;
        node && node !== document.body && parts.length < 4;
        node = node.parentElement
      ) {
        const data = [...node.attributes].find(
          (a) => a.name.startsWith("data-") && !/^data-(base-ui|state|kit)/.test(a.name),
        );
        const label = node.getAttribute("aria-label");
        const part =
          node.tagName.toLowerCase() +
          (node.id && !node.id.startsWith("base-ui") ? `#${CSS.escape(node.id)}` : "") +
          (data ? `[${data.name}${data.value ? `="${data.value.slice(0, 40)}"` : ""}]` : "") +
          (label ? `[aria-label="${label.slice(0, 50)}"]` : "");
        parts.unshift(part);
        if (data || label || node.id) {
          const selector = parts.join(" > ");
          try {
            if (document.querySelectorAll(selector).length === 1) return selector;
          } catch {}
        }
      }
      return parts.join(" > ");
    };
    const matches = [...document.querySelectorAll("body *")].filter(
      (el) =>
        el.textContent.includes(needle) &&
        ![...el.children].some((c) => c.textContent.includes(needle)),
    );
    return matches.slice(0, 6).map((el) => {
      const chain = [];
      for (let node = el; node && node !== document.body; node = node.parentElement) {
        if (
          node === el ||
          node.matches("button, a, [role], [aria-label], li, section, aside, form, [data-slot]")
        ) {
          const r = node.getBoundingClientRect();
          chain.push(
            `${describe(node)}  @ ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}  "${node.textContent.trim().slice(0, 50)}"`,
          );
        }
        if (chain.length >= 5) break;
      }
      return chain.join("\n    ↑ ");
    });
  }, text);
  console.log(found.length ? found.join("\n\n") : `no element contains "${text}"`);
} finally {
  await browser.close();
  server.close();
}
