/**
 * Downloads the static (non-variable) TTFs for our brand fonts. Two
 * destinations:
 *
 * - `website/assets/fonts/` — build-time only, read by the OG image
 *   renderer (satori) via `fs.readFile`. Never shipped to clients.
 * - `website/public/fonts/` — served by Astro at `/fonts/<file>` for
 *   the website's own `@font-face` declarations. Use this only for
 *   fonts the runtime page actually needs.
 *
 * Why static, not variable: satori's opentype parser
 * (`@shuding/opentype.js`) can't parse Google Fonts' variable TTFs (the
 * ones with `[opsz,wght]` axes). Static TTFs work fine and the upstream
 * static releases include the full glyph set unlike the `@fontsource/*`
 * woff packages, which are subsetted to `latin` only and miss arrows.
 *
 * Files are cached on disk; subsequent runs are no-ops unless missing.
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const buildOnlyFontsDir = path.resolve(here, "../assets/fonts");
const publicFontsDir = path.resolve(here, "../public/fonts");

interface FontSource {
  file: string;
  url: string;
  /**
   * Where the file lands on disk. `"build"` (default) goes to
   * `assets/fonts/` for OG-only consumption; `"public"` goes to
   * `public/fonts/` so the website's CSS can fetch it at runtime.
   */
  scope?: "build" | "public";
}

const FONTS: FontSource[] = [
  // Source Serif 4 — Adobe's official static TTFs.
  //
  // Two optical-size variants: Display (chunkier serifs, more stroke
  // contrast) for the headline at ~100px, and Text (calmer, more even
  // weight) for the description at ~26px. The website's hero uses the
  // variable font which auto-selects optical size; satori needs us to
  // pick explicitly per element.
  {
    file: "SourceSerif4-Regular.ttf",
    url: "https://cdn.jsdelivr.net/gh/adobe-fonts/source-serif@release/TTF/SourceSerif4-Regular.ttf",
  },
  {
    file: "SourceSerif4-It.ttf",
    url: "https://cdn.jsdelivr.net/gh/adobe-fonts/source-serif@release/TTF/SourceSerif4-It.ttf",
  },
  {
    file: "SourceSerif4Display-Regular.ttf",
    url: "https://cdn.jsdelivr.net/gh/adobe-fonts/source-serif@release/TTF/SourceSerif4Display-Regular.ttf",
  },
  {
    file: "SourceSerif4Display-It.ttf",
    url: "https://cdn.jsdelivr.net/gh/adobe-fonts/source-serif@release/TTF/SourceSerif4Display-It.ttf",
  },
  {
    file: "SourceSerif4Display-Light.ttf",
    url: "https://cdn.jsdelivr.net/gh/adobe-fonts/source-serif@release/TTF/SourceSerif4Display-Light.ttf",
  },
  {
    file: "SourceSerif4Display-LightIt.ttf",
    url: "https://cdn.jsdelivr.net/gh/adobe-fonts/source-serif@release/TTF/SourceSerif4Display-LightIt.ttf",
  },
  // Semibold (600) — closest static cut to the website hero's runtime
  // weight. The hero uses the variable font, which the browser
  // interpolates to "Medium" (500) at the 60pt optical size; Adobe
  // doesn't ship a static Medium Display variant, so we snap up to
  // Semibold. Slightly heavier than the website but visibly closer
  // than Light (300).
  {
    file: "SourceSerif4Display-Semibold.ttf",
    url: "https://cdn.jsdelivr.net/gh/adobe-fonts/source-serif@release/TTF/SourceSerif4Display-Semibold.ttf",
  },
  {
    file: "SourceSerif4Display-SemiboldIt.ttf",
    url: "https://cdn.jsdelivr.net/gh/adobe-fonts/source-serif@release/TTF/SourceSerif4Display-SemiboldIt.ttf",
  },

  // Tinos — Apache-2.0, metrically and visually compatible with Times
  // New Roman. Used exclusively for the arrow glyph in the marketing
  // headline. Pinning U+2192 to a TNR-equivalent font on BOTH the
  // website and the OG card keeps the two visuals consistent
  // regardless of which subset/fallback the runtime picks. This font
  // is served to the browser too (via @font-face in tokens.css), so
  // it lands in `public/fonts/` rather than `assets/fonts/`.
  {
    file: "Tinos-Regular.ttf",
    url: "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/tinos/Tinos-Regular.ttf",
    scope: "public",
  },

  // JetBrains Mono — for the eyebrow label.
  {
    file: "JetBrainsMono-Regular.ttf",
    url: "https://cdn.jsdelivr.net/gh/JetBrains/JetBrainsMono@v2.304/fonts/ttf/JetBrainsMono-Regular.ttf",
  },

  // Caveat — for the hand-drawn alchemy.run URL stamp.
  {
    file: "Caveat-Regular.ttf",
    url: "https://cdn.jsdelivr.net/gh/googlefonts/caveat@main/fonts/ttf/Caveat-Regular.ttf",
  },
];

async function exists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.size > 1024;
  } catch {
    return false;
  }
}

/**
 * Derive a list of mirror URLs to try in order. jsdelivr's `cdn.jsdelivr.net/gh/`
 * surface intermittently 403s under burst load; raw.githubusercontent.com serves
 * the same blob directly from GitHub and is a reliable fallback. Any other URL
 * is used as-is with no fallback.
 */
function mirrorsFor(url: string): string[] {
  const m = url.match(
    /^https:\/\/cdn\.jsdelivr\.net\/gh\/([^/]+)\/([^@]+)@([^/]+)\/(.+)$/,
  );
  if (!m) return [url];
  const [, owner, repo, ref, rest] = m;
  return [
    url,
    `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${rest}`,
  ];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(
  url: string,
  attempts = 3,
): Promise<Uint8Array | { error: string }> {
  let lastErr = "";
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.byteLength < 1024) {
          lastErr = `${buf.byteLength} bytes (suspiciously small)`;
        } else {
          return buf;
        }
      } else if (res.status === 404) {
        // No point retrying a hard 404 — the URL itself is wrong.
        return { error: `404 Not Found` };
      } else {
        lastErr = `${res.status} ${res.statusText}`;
      }
    } catch (e) {
      lastErr = (e as Error).message;
    }
    if (i < attempts - 1) await sleep(500 * 2 ** i); // 500ms, 1s
  }
  return { error: lastErr };
}

function dirFor(font: FontSource): string {
  return font.scope === "public" ? publicFontsDir : buildOnlyFontsDir;
}

async function downloadOne(font: FontSource): Promise<"cached" | "fetched"> {
  const dest = path.join(dirFor(font), font.file);
  if (await exists(dest)) return "cached";

  const mirrors = mirrorsFor(font.url);
  const errors: string[] = [];
  for (const url of mirrors) {
    const result = await fetchWithRetry(url);
    if (result instanceof Uint8Array) {
      await writeFile(dest, result);
      return "fetched";
    }
    errors.push(`${url} → ${result.error}`);
  }
  throw new Error(
    `Failed to download ${font.file} from ${mirrors.length} mirror(s):\n  ${errors.join("\n  ")}`,
  );
}

async function main() {
  await mkdir(buildOnlyFontsDir, { recursive: true });
  await mkdir(publicFontsDir, { recursive: true });
  // Sequential, not parallel: jsdelivr rate-limits bursts of >5 concurrent
  // requests from the same IP and starts returning 403s. Fonts are small
  // and only fetched once per dev environment, so the speed difference
  // is negligible.
  let fetched = 0;
  let cached = 0;
  for (const font of FONTS) {
    const r = await downloadOne(font);
    if (r === "fetched") fetched++;
    else cached++;
  }
  console.log(
    `[fonts] ${fetched} downloaded, ${cached} cached → assets/fonts (build) + public/fonts (runtime)`,
  );
}

await main();
