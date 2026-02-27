import path from "path";
import fs from "fs";

const FAVICON_CANDIDATES = [
  "favicon.svg", "favicon.ico", "favicon.png",
  "public/favicon.svg", "public/favicon.ico", "public/favicon.png",
  "app/favicon.ico", "app/favicon.png", "app/icon.svg", "app/icon.png", "app/icon.ico",
  "src/favicon.ico", "src/favicon.svg", "src/app/favicon.ico", "src/app/icon.svg", "src/app/icon.png",
];

const ICON_SOURCE_FILES = [
  "index.html", "public/index.html",
  "app/routes/__root.tsx", "src/routes/__root.tsx",
  "app/root.tsx", "src/root.tsx", "src/index.html",
];

const LINK_ICON_HTML_RE = /<link[^>]*rel=["'](?:icon|shortcut icon)["'][^>]*href=["']([^"'?]+)/i;
const LINK_ICON_OBJ_RE = /rel:\s*["'](?:icon|shortcut icon)["'][^}]*href:\s*["']([^"'?]+)/i;

function test(projectCwd) {
  console.log("--- Testing:", projectCwd, "---");

  for (const c of FAVICON_CANDIDATES) {
    const full = path.join(projectCwd, c);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      console.log("  Phase 1 FOUND:", c);
      return;
    }
  }
  console.log("  Phase 1: no match");

  for (const sf of ICON_SOURCE_FILES) {
    const full = path.join(projectCwd, sf);
    if (!fs.existsSync(full)) continue;
    const content = fs.readFileSync(full, "utf8");
    const href = content.match(LINK_ICON_HTML_RE)?.[1] || content.match(LINK_ICON_OBJ_RE)?.[1];
    if (href) {
      const clean = href.replace(/^\//, "");
      const tryPaths = [path.join(projectCwd, "public", clean), path.join(projectCwd, clean)];
      for (const p of tryPaths) {
        if (fs.existsSync(p)) {
          console.log("  Phase 2 FOUND:", sf, "->", href, "->", p);
          return;
        }
      }
      console.log("  Phase 2 href found but file missing:", href);
    }
  }
  console.log("  Phase 2: no match");
}

function getTestPaths() {
  const cliPaths = process.argv.slice(2).map((p) => p.trim()).filter(Boolean);
  if (cliPaths.length > 0) return cliPaths;

  const envPaths = process.env.TEST_PATHS?.split(path.delimiter).map((p) => p.trim()).filter(Boolean);
  if (envPaths?.length) return envPaths;

  return [process.cwd()];
}

for (const p of getTestPaths()) {
  test(path.resolve(p));
}
