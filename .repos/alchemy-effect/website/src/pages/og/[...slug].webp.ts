/**
 * Static Open Graph image endpoint. During `astro build` Astro invokes this
 * for every entry returned by `getStaticPaths`, writing a WebP into
 * `dist/og/<slug>.webp`. Pages reference these via `<meta property="og:image">`
 * in their layout/head.
 *
 * - Marketing pages (top-level `src/pages/*.{astro,mdx}`) → /og/<page>.webp
 *   (the homepage is keyed as `index`).
 * - Starlight docs (`getCollection("docs")`) → /og/<entry.slug>.webp.
 *
 * The card itself lives in `src/brand/OgCard.tsx` and is rendered via
 * Takumi. Fonts are the same families used on the website
 * (`tokens.css`), loaded from npm bundles with full Source Serif glyph coverage —
 * arrows, em-dashes, fancy quotes, etc. all render verbatim.
 */

import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection } from "astro:content";
import { createHash } from "node:crypto";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { jsx } from "react/jsx-runtime";
import { render } from "takumi-js";
import { brandFonts } from "../../brand/fonts.ts";
import {
  OgCard,
  type OgCardKind,
  type OgCardProps,
} from "../../brand/OgCard.tsx";

interface Entry extends OgCardProps {
  slug: string;
}

const RENDER_CONCURRENCY = 4;

const renderOptions = {
  width: 1200 * 2,
  height: 630 * 2,
  devicePixelRatio: 2,
  format: "webp" as const,
  emoji: "from-font" as const,
};

async function renderCard(entry: Entry): Promise<Uint8Array<ArrayBuffer>> {
  return render(OgCard(entry), { ...renderOptions, fonts: brandFonts });
}

/**
 * Astro's incremental builder generates routes serially, so a cold build would
 * otherwise leave all but one native renderer idle. Keep a bounded window of
 * upcoming cards in flight: cache hits do no rendering at all, while cold builds
 * still use concurrent native rendering. Entries outside the window are never speculatively
 * rendered.
 */
let renderEntries: Entry[] = [];
const renderEntryIndexes = new Map<string, number>();
const pendingRenders = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();

function setRenderEntries(entries: Entry[]) {
  renderEntries = entries;
  renderEntryIndexes.clear();
  for (const [index, entry] of entries.entries()) {
    renderEntryIndexes.set(entry.slug, index);
  }
}

function renderWithLookahead(entry: Entry) {
  const start = renderEntryIndexes.get(entry.slug);
  if (start === undefined) return renderCard(entry);

  const size = import.meta.env.DEV ? 1 : RENDER_CONCURRENCY;
  for (const candidate of renderEntries.slice(start, start + size)) {
    if (pendingRenders.has(candidate.slug)) continue;
    const render = renderCard(candidate);
    render.catch(() => {});
    pendingRenders.set(candidate.slug, render);
  }

  return pendingRenders.get(entry.slug)!;
}

// ────────────────────────────────────────────────────────────────────────────
// Page enumeration
// ────────────────────────────────────────────────────────────────────────────

/**
 * Fallbacks for the marketing pages — these aren't in a content collection
 * so we hand-curate their OG metadata. Keys are URL-style slugs (e.g.
 * `index` for `/`).
 */
const MARKETING_PAGES: Record<string, Omit<Entry, "slug" | "kind">> = {
  index: {
    title: jsx("span", {
      style: { fontWeight: 600 },
      children: [
        jsx("span", {
          style: { fontStyle: "italic", color: "#3f5a2a" },
          children: "Zero",
        }),
        jsx("span", {
          style: {
            fontFamily: "'JetBrains Mono'",
            fontSize: 64,
            fontWeight: 400,
            fontFeatureSettings: "'calt' 1",
            letterSpacing: 0,
          },
          children: " -> ",
        }),
        "production.",
      ],
    }),
    description:
      "TypeScript IaC on Effect. Stand up your whole cloud in one program, type-check the IAM, hot-reload it locally, run tests against the real cloud, preview every PR.",
    eyebrow: "typescript · effect · infrastructure as code",
  },
  privacy: {
    title: "Privacy & Telemetry",
    description:
      "What data the Alchemy CLI and Cloudflare State Store collect, where it goes, and how to opt out.",
    eyebrow: "alchemy.run",
  },
};

function classifyDoc(slug: string): { kind: OgCardKind; eyebrow: string } {
  if (slug.startsWith("blog/"))
    return { kind: "blog", eyebrow: "blog · alchemy.run" };
  if (slug.startsWith("guides/"))
    return { kind: "doc", eyebrow: "guide · alchemy" };
  if (slug.startsWith("concepts/"))
    return { kind: "doc", eyebrow: "concept · alchemy" };
  if (slug.startsWith("tutorial/"))
    return { kind: "doc", eyebrow: "tutorial · alchemy" };
  if (slug.startsWith("providers/"))
    return { kind: "doc", eyebrow: "provider · alchemy" };
  if (slug.startsWith("compare/"))
    return { kind: "doc", eyebrow: "compare · alchemy" };
  return { kind: "doc", eyebrow: "alchemy · documentation" };
}

/** Hash the actual card tree, including styles and embedded SVGs, plus renderer inputs. */
export function createOgCacheKey(
  fonts: Awaited<typeof brandFonts>,
  options: object,
) {
  const shared = createHash("sha256").update(JSON.stringify(options));
  for (const { data, ...metadata } of fonts) {
    shared.update(JSON.stringify(metadata));
    shared.update(new Uint8Array(data));
  }
  return (card: ReactNode) =>
    shared.copy().update(renderToStaticMarkup(card)).digest("hex");
}

export const getStaticPaths: GetStaticPaths = async () => {
  // `DOCS_FAST=1` (the `docs:check` build target) skips OG image generation —
  // rendering PNGs is unnecessary for link checking.
  if (process.env.DOCS_FAST) return [];

  const docs = await getCollection("docs");
  const docPaths = docs.map((entry: any) => {
    const slug = (entry as { slug?: string; id?: string }).slug ?? entry.id;
    const meta = classifyDoc(slug);
    const data = entry.data as {
      title?: string;
      description?: string;
      excerpt?: string;
      date?: string | Date;
    };
    return {
      params: { slug },
      props: {
        slug,
        title: data.title ?? slug,
        // Blog frontmatter uses `excerpt` (starlight-blog schema). Fall
        // back to it so the OG card has body copy to fill the layout.
        description: data.description ?? data.excerpt,
        kind: meta.kind,
        eyebrow: meta.eyebrow,
        date:
          data.date instanceof Date
            ? data.date.toISOString().slice(0, 10)
            : data.date,
      } satisfies Entry,
    };
  });

  const marketingPaths = Object.entries(MARKETING_PAGES).map(
    ([slug, meta]) => ({
      params: { slug },
      props: {
        slug,
        title: meta.title,
        description: meta.description,
        kind: "marketing" as const,
        eyebrow: meta.eyebrow,
      } satisfies Entry,
    }),
  );

  // Virtual routes that emit og:image metas but aren't docs entries or
  // hand-curated marketing pages: Starlight's 404 and starlight-blog's
  // pagination indexes (/blog, /blog/2, …). The page count is estimated
  // generously (starlight-blog paginates at ≥5 posts/page, so dividing
  // by 5 can only overshoot); a surplus card is harmless, and the
  // build-output og:image check fails loudly if a rendered page ever
  // references a card this misses.
  const blogPosts = docs.filter((entry: any) =>
    ((entry as { slug?: string; id?: string }).slug ?? entry.id).startsWith(
      "blog/",
    ),
  );
  const blogDescription = "Release notes and posts from the alchemy team.";
  const virtualPaths = [
    {
      slug: "404",
      title: "Page not found",
      kind: "doc" as const,
      eyebrow: "alchemy · documentation",
    },
    ...Array.from(
      { length: Math.max(1, Math.ceil(blogPosts.length / 5)) },
      (_, i) => ({
        slug: i === 0 ? "blog" : `blog/${i + 1}`,
        title: "Blog",
        description: blogDescription,
        kind: "blog" as const,
        eyebrow: "blog · alchemy.run",
      }),
    ),
  ].map((props) => ({
    params: { slug: props.slug },
    props,
  }));

  const paths = [...marketingPaths, ...docPaths, ...virtualPaths];
  setRenderEntries(paths.map(({ props }) => props));
  const cacheKey = createOgCacheKey(brandFonts, renderOptions);
  return paths.map((path) => ({
    ...path,
    cacheKey: cacheKey(OgCard(path.props)),
  }));
};

export const GET: APIRoute = async ({ props }) => {
  const entry = props as Entry;
  const png = await renderWithLookahead(entry);
  pendingRenders.delete(entry.slug);
  return new Response(png, {
    headers: {
      "Content-Type": "image/webp",
    },
  });
};
