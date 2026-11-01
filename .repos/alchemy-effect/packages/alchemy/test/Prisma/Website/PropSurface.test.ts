import * as Prisma from "@/Prisma/index.ts";
import { expect, it } from "alchemy-test";

const constructors = [
  "Astro",
  "Foldkit",
  "Nextjs",
  "Nuxt",
  "Octane",
  "ReactRouter",
  "SolidStart",
  "StaticSite",
  "SvelteKit",
  "TanStackStart",
  "Vinext",
  "Vite",
  "Vocs",
  "Waku",
] as const;

const contracts = [
  () =>
    Prisma.Website.Vite("Web", {
      vite: { outDir: "build", base: "/docs/" },
      assets: { notFoundHandling: "single-page-application" },
    }),
  () =>
    Prisma.Website.Astro("Blog", {
      astro: { output: "server", site: "https://example.com" },
    }),
  () =>
    Prisma.Website.Astro("Docs", {
      astro: { output: "static" },
      assets: { notFoundHandling: "404-page" },
    }),
  () => Prisma.Website.Nextjs("Web", { rootDir: "./app" }),
  () =>
    Prisma.Website.Vinext("Web", {
      rootDir: "./app",
      env: { GREETING: "hello" },
      domain: "app.example.com",
      memo: false,
      dev: { port: 5173 },
      compute: { destroyOldDeployment: true },
    }),
  () => Prisma.Website.Nuxt("Web", { nuxt: { app: { baseURL: "/docs/" } } }),
  () => Prisma.Website.SvelteKit("Web", { kit: { paths: { base: "/docs" } } }),
  () => Prisma.Website.Waku("Web", { waku: { srcDir: "src" } }),
  () => Prisma.Website.Foldkit("Web"),
  () => Prisma.Website.Octane("Web"),
  () => Prisma.Website.ReactRouter("Web"),
  () => Prisma.Website.SolidStart("Web"),
  () => Prisma.Website.TanStackStart("Web"),
  () => Prisma.Website.Vocs("Docs"),
  () =>
    Prisma.Website.StaticSite("Docs", {
      command: "bun run build",
      outdir: "public",
    }),
  () =>
    Prisma.Website.Vite("Web", {
      project: Prisma.Project("Parent", { createDatabase: false }),
      dev: { mode: "external", url: "http://localhost:5173" },
    }),
  () =>
    Prisma.Website.Vite("Web", {
      // @ts-expect-error SPA routing belongs in assets.notFoundHandling.
      spa: true,
    }),
  () =>
    Prisma.Website.Astro("Web", {
      // @ts-expect-error Framework output belongs in the astro option bag.
      output: "static",
    }),
];

it(
  "exports every framework with the established Website prop vocabulary",
  () => {
    for (const name of constructors)
      expect(typeof Prisma.Website[name]).toBe("function");
    expect(contracts.length).toBeGreaterThan(constructors.length);
  },
  {
    tags: [
      "unit",
      "provider:prisma",
      "provider:prisma:project",
      "provider:prisma:website",
      "local",
    ],
  },
);
