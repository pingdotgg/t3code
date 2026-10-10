import * as Website from "@/Neon/Website/index.ts";
import type { FrameworkSiteProps } from "@/Neon/Website/FrameworkSite.ts";

export const frameworks = [
  { slug: "vite", name: "Vite", website: Website.Vite, interactive: true },
  { slug: "astro", name: "Astro", website: Website.Astro, interactive: true },
  {
    slug: "nextjs",
    name: "Next.js",
    website: Website.Nextjs,
    interactive: true,
  },
  { slug: "nuxt", name: "Nuxt", website: Website.Nuxt, interactive: true },
  {
    slug: "sveltekit",
    name: "SvelteKit",
    website: Website.SvelteKit,
    interactive: true,
  },
  {
    slug: "react-router",
    name: "React Router",
    website: Website.ReactRouter,
    interactive: true,
  },
  {
    slug: "solidstart",
    name: "SolidStart",
    website: Website.SolidStart,
    interactive: true,
  },
  {
    slug: "tanstack-start",
    name: "TanStack Start",
    website: Website.TanStackStart,
    interactive: true,
  },
  { slug: "waku", name: "Waku", website: Website.Waku, interactive: true },
  {
    slug: "octane",
    name: "Octane",
    website: Website.Octane,
    interactive: true,
  },
  {
    slug: "foldkit",
    name: "Foldkit",
    website: Website.Foldkit,
    interactive: true,
  },
  { slug: "vocs", name: "Neon", website: Website.Vocs, interactive: true },
  {
    slug: "static",
    name: "Static site on Neon",
    website: (id: string, props: FrameworkSiteProps) =>
      Website.StaticSite(id, {
        ...props,
        dev: { command: "bun run dev:site" },
        command: "bun run build",
        outdir: "dist",
      }),
    interactive: true,
  },
] as const;
