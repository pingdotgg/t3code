import type { AstroIntegration } from "astro";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rewriteForPagefind } from "./pagefind-ignore-noise.ts";

/** Populated before the sitemap integration runs. */
export const noindexPaths = new Set();
const noindexRegex =
  /<meta\b(?=[^>]*\bname="robots")(?=[^>]*\bcontent="[^"]*noindex)/i;

/**
 * Build-output checks — one pass over every rendered HTML page:
 *
 * 1. Case-sensitive internal-link check: validates every internal
 *    `<a href>` / `<img src>` against a case-sensitive Set of output
 *    paths. Case-sensitivity matters: `fs.existsSync`-based checkers
 *    (e.g. astro-broken-links-checker, which this replaced) resolve
 *    `/foo/Bar` to `/foo/bar` on macOS but 404 on Linux CI.
 *
 * 2. Diff-block indent check: in every rendered ```diff code block,
 *    each line's indentation must be even (the docs use 2-space
 *    indents everywhere). An odd indent means a `+`/`-` marker line
 *    was authored in the wrong convention — expressive-code strips
 *    only the marker character, so markers must be written as an
 *    EXTRA column followed by the line's full indentation, with
 *    context lines flush. See git history: three different authoring
 *    conventions had accumulated and all rendered misaligned.
 *
 * 3. `og:image` check: every page's og:image URL must not contain
 *    "undefined"/"null" (a broken slug lookup — Starlight 0.39 renamed
 *    routeData `slug` to `id` and the old field silently reads as
 *    undefined), and when OG images were emitted (full builds; the
 *    DOCS_FAST target skips them) the URL's path must exist in the
 *    build output.
 */
export function buildOutputChecks(): AstroIntegration {
  return {
    name: "build-output-checks",
    hooks: {
      "astro:build:done": async ({ dir, logger }) => {
        const started = performance.now();
        const distPath = fileURLToPath(dir);
        noindexPaths.clear();

        const paths = new Set<string>();
        const dirs = new Set<string>();

        // One directory inventory and one HTML read per page. Keep only paths
        // globally; HTML buffers are limited to the small worker batch below.
        const entries = await fs.readdir(distPath, {
          recursive: true,
          withFileTypes: true,
        });
        for (const entry of entries) {
          const rel =
            "/" +
            path
              .relative(distPath, path.join(entry.parentPath, entry.name))
              .split(path.sep)
              .join("/");
          if (entry.isDirectory()) dirs.add(rel);
          else if (entry.isFile()) paths.add(rel);
        }

        const linkExists = new Map<string, boolean>();
        const broken = new Map<string, Set<string>>();

        const oddIndents: { file: string; line: string }[] = [];
        const badOgImages: { file: string; url: string }[] = [];
        const htmlFiles = [...paths].filter((p) => p.endsWith(".html")).sort();
        const hasOgImages = [...paths].some(
          (p) => p.startsWith("/og/") && p.endsWith(".webp"),
        );

        async function checkFile(htmlFile: string) {
          const before = await fs.readFile(
            path.join(distPath, htmlFile.slice(1)),
            "utf8",
          );
          const html = rewriteForPagefind(before);
          if (noindexRegex.test(html)) {
            noindexPaths.add(
              htmlFile.endsWith("/index.html")
                ? htmlFile.slice(0, -"index.html".length)
                : htmlFile,
            );
          }
          const links = [
            ...html.matchAll(/<a\s+[^>]*href="([^"#?]+)/gi),
            ...html.matchAll(/<img\s+[^>]*src="([^"#?]+)/gi),
          ].map((m) => m[1]);

          for (const link of links) {
            if (!link.startsWith("/")) continue; // skip external, anchors, mailto, etc.
            let exists = linkExists.get(link);
            if (exists === undefined) {
              const clean = link.replace(/\/$/, "");
              exists =
                paths.has(clean) ||
                paths.has(clean + "/index.html") ||
                paths.has(clean + ".html") ||
                dirs.has(clean);
              linkExists.set(link, exists);
            }
            if (!exists) {
              if (!broken.has(link)) broken.set(link, new Set());
              broken.get(link)?.add(htmlFile);
            }
          }

          // og:image check (see integration docstring).
          for (const m of html.matchAll(
            /property="og:image"\s+content="([^"]+)"/g,
          )) {
            const url = m[1];
            let pathname;
            try {
              pathname = new URL(url).pathname;
            } catch {
              badOgImages.push({ file: htmlFile, url });
              continue;
            }
            if (
              /\b(?:undefined|null)\b/.test(pathname) ||
              (hasOgImages && !paths.has(pathname))
            ) {
              badOgImages.push({ file: htmlFile, url });
            }
          }

          // Diff-block indent check (see integration docstring).
          if (
            html.includes("highlight ins") ||
            html.includes("highlight del")
          ) {
            for (const fig of html.matchAll(
              /<figure class="frame[^"]*">.*?<\/figure>/gs,
            )) {
              const block = fig[0];
              if (
                !block.includes("highlight ins") &&
                !block.includes("highlight del")
              )
                continue;
              for (const m of block.matchAll(
                /<div class="ec-line[^"]*"><div class="code">(.*?)<\/div><\/div>/gs,
              )) {
                const text = m[1]
                  .replace(/<[^>]+>/g, "")
                  .replace(/&quot;/g, '"')
                  .replace(/&#39;/g, "'")
                  .replace(/&lt;/g, "<")
                  .replace(/&gt;/g, ">")
                  .replace(/&amp;/g, "&");
                const trimmed = text.trim();
                if (!trimmed) continue;
                // JSDoc continuation lines legitimately indent by one.
                if (trimmed.startsWith("*")) continue;
                const indent = text.length - text.trimStart().length;
                if (indent % 2 === 1) {
                  oddIndents.push({ file: htmlFile, line: text.slice(0, 60) });
                }
              }
            }
          }
          if (html !== before)
            await fs.writeFile(path.join(distPath, htmlFile.slice(1)), html);
        }

        // Read/scan in bounded parallel batches — serial reads dominate
        // the checker's runtime on 4k+ pages.
        const BATCH = 8;
        for (let i = 0; i < htmlFiles.length; i += BATCH) {
          await Promise.all(htmlFiles.slice(i, i + BATCH).map(checkFile));
        }

        if (broken.size > 0) {
          let msg = "Case-sensitive broken links detected:\n";
          for (const [link, docs] of broken.entries()) {
            msg += `\n  ${link}\n    Found in:\n`;
            for (const doc of docs) msg += `      - ${doc}\n`;
          }
          logger.error(msg);
          throw new Error(
            `Case-sensitive broken links detected (${broken.size})`,
          );
        }
        if (badOgImages.length > 0) {
          let msg = "Broken og:image URLs detected:\n";
          for (const { file, url } of badOgImages.slice(0, 20)) {
            msg += `  ${file}: ${url}\n`;
          }
          logger.error(msg);
          throw new Error(
            `Broken og:image URLs detected (${badOgImages.length})`,
          );
        }
        if (oddIndents.length > 0) {
          let msg =
            "Misindented diff-block lines detected (write markers as an " +
            "extra column before the line's full indentation, context " +
            "lines flush):\n";
          for (const { file, line } of oddIndents.slice(0, 20)) {
            msg += `  ${file}: ${JSON.stringify(line)}\n`;
          }
          logger.error(msg);
          throw new Error(
            `Misindented diff-block lines detected (${oddIndents.length})`,
          );
        }
        logger.info(
          `Build-output checks passed (${htmlFiles.length} pages: links + diff indents + search exclusions; ${noindexPaths.size} noindex) in ${((performance.now() - started) / 1000).toFixed(2)}s`,
        );
      },
    },
  };
}
