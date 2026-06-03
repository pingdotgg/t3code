/**
 * Static Open Graph image endpoint. During `astro build` Astro invokes this
 * for every entry returned by `getStaticPaths`, writing a PNG into
 * `dist/og/<slug>.png`. Pages reference these via `<meta property="og:image">`
 * in their layout/head.
 *
 * - Marketing pages (top-level `src/pages/*.{astro,mdx}`) → /og/<page>.png
 *   (the homepage is keyed as `index`).
 * - Starlight docs (`getCollection("docs")`) → /og/<entry.slug>.png.
 *
 * The card itself lives in `src/brand/OgCard.tsx` and is rendered via
 * satori → resvg. Fonts are the same families used on the website
 * (`tokens.css`), loaded as full unsubsetted variable TTFs from
 * `website/assets/fonts/` so satori has complete Unicode coverage —
 * arrows, em-dashes, fancy quotes, etc. all render verbatim.
 */

import { Resvg } from "@resvg/resvg-js";
import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection } from "astro:content";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import satori from "satori";
import { OgCard, type OgCardKind, type TitlePart } from "../../brand/OgCard";

interface Entry {
  slug: string;
  title: string | TitlePart[];
  description?: string;
  kind: OgCardKind;
  eyebrow?: string;
  /** ISO date string — rendered in the footer for blog cards. */
  date?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Font loading. The website's font stack for the hero is
//   "Source Serif 4", "Source Serif Pro", Georgia, "Times New Roman", serif
// We mirror that here with Source Serif 4 as the primary face (regular,
// italic, semibold, semibold-italic), plus JetBrains Mono for the eyebrow
// label and Caveat for the hand-drawn URL stamp. All loaded as static TTFs
// from `website/assets/fonts/` (populated by `scripts/download-fonts.ts`),
// which carry the full Unicode glyph table — arrows, em-dashes, etc. — so
// the source content renders verbatim with no glyph workarounds.
// ────────────────────────────────────────────────────────────────────────────

const buildFontsDir = fileURLToPath(
  new URL("../../../assets/fonts/", import.meta.url),
);
const publicFontsDir = fileURLToPath(
  new URL("../../../public/fonts/", import.meta.url),
);

async function readFont(
  filename: string,
  publicScope = false,
): Promise<Buffer> {
  return fs.readFile(
    path.join(publicScope ? publicFontsDir : buildFontsDir, filename),
  );
}

const fontsPromise = (async () => {
  const [
    serif,
    serifIt,
    displayLight,
    displayLightIt,
    displayReg,
    displayRegIt,
    displaySemi,
    displaySemiIt,
    tinos,
    mono,
    caveat,
  ] = await Promise.all([
    readFont("SourceSerif4-Regular.ttf"),
    readFont("SourceSerif4-It.ttf"),
    readFont("SourceSerif4Display-Light.ttf"),
    readFont("SourceSerif4Display-LightIt.ttf"),
    readFont("SourceSerif4Display-Regular.ttf"),
    readFont("SourceSerif4Display-It.ttf"),
    readFont("SourceSerif4Display-Semibold.ttf"),
    readFont("SourceSerif4Display-SemiboldIt.ttf"),
    readFont("Tinos-Regular.ttf", true),
    readFont("JetBrainsMono-Regular.ttf"),
    readFont("Caveat-Regular.ttf"),
  ]);

  return [
    // Text optical-size variant (description, wordmark, etc.).
    { name: "Source Serif 4", data: serif, weight: 400, style: "normal" },
    { name: "Source Serif 4", data: serifIt, weight: 400, style: "italic" },

    // Display optical-size variant for the headline. Carries chunkier
    // serifs and more stroke contrast at large sizes — matches the
    // website hero, which uses the variable font's display optical axis
    // automatically. Light (300) is what the hero renders at ~72px;
    // Regular (400) is the default fallback.
    {
      name: "Source Serif 4 Display",
      data: displayLight,
      weight: 300,
      style: "normal",
    },
    {
      name: "Source Serif 4 Display",
      data: displayLightIt,
      weight: 300,
      style: "italic",
    },
    {
      name: "Source Serif 4 Display",
      data: displayReg,
      weight: 400,
      style: "normal",
    },
    {
      name: "Source Serif 4 Display",
      data: displayRegIt,
      weight: 400,
      style: "italic",
    },

    // Semibold (600) approximates the website hero's runtime "Medium"
    // (500) — Adobe doesn't ship a static Medium Display cut, so we
    // snap up. Used by the title.
    {
      name: "Source Serif 4 Display",
      data: displaySemi,
      weight: 600,
      style: "normal",
    },
    {
      name: "Source Serif 4 Display",
      data: displaySemiIt,
      weight: 600,
      style: "italic",
    },

    // Tinos — TNR-equivalent. Used only for the marketing arrow glyph
    // so the OG matches the website's font stack (which lands on Times
    // New Roman for U+2192). See OgCard.tsx — this family is opted into
    // explicitly via fontFamily on individual title spans.
    { name: "Tinos", data: tinos, weight: 400, style: "normal" },

    { name: "JetBrains Mono", data: mono, weight: 400, style: "normal" },
    { name: "Caveat", data: caveat, weight: 400, style: "normal" },
  ] as const;
})();

// ────────────────────────────────────────────────────────────────────────────
// Page enumeration
// ────────────────────────────────────────────────────────────────────────────

/**
 * Fallbacks for the marketing pages — these aren't in a content collection
 * so we hand-curate their OG metadata. Keys are URL-style slugs (e.g.
 * `index` for `/`).
 */
const MARKETING_PAGES: Record<string, Omit<Entry, "slug" | "kind">> = {
  // Title parts mirror the homepage hero markup, which explicitly
  // italicizes "Zero" in the deep-moss accent — see index.mdx:
  //   <span style="color:var(--alc-accent-deep);font-style:italic;">Zero</span>
  //   {" "}&rarr; production.
  index: {
    title: [
      { text: "Zero", italic: true, accent: true },
      // Arrow rendered from Tinos (TNR-equivalent) so the OG mirrors
      // the website, where this glyph falls through the font stack to
      // Times New Roman. Non-breaking spaces flank it so the line
      // doesn't break around the arrow.
      { text: "\u00A0\u2192\u00A0", font: "tinos" },
      { text: "production." },
    ],
    description:
      "TypeScript IaC on Effect. Stand up your whole cloud in one program, type-check the IAM, hot-reload it locally, run tests against the real cloud, preview every PR.",
    eyebrow: "typescript · effect · infrastructure as code",
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

export const getStaticPaths: GetStaticPaths = async () => {
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

  return [...marketingPaths, ...docPaths];
};

export const GET: APIRoute = async ({ props }) => {
  const { title, description, kind, eyebrow, date } = props as Entry;
  const fonts = await fontsPromise;

  const element = OgCard({ title, description, eyebrow, kind, date });

  const svg = await satori(element, {
    width: 1200,
    height: 630,
    fonts: fonts as any,
  });

  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: 1200 },
  })
    .render()
    .asPng();

  return new Response(png as any, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
};
