import * as Website from "@/Neon/Website/index.ts";
import { expect, it } from "alchemy-test";

const constructors = [
  "Vite",
  "Astro",
  "Nextjs",
  "Nuxt",
  "SvelteKit",
  "ReactRouter",
  "SolidStart",
  "TanStackStart",
  "Waku",
  "Octane",
  "Foldkit",
  "Vocs",
  "StaticSite",
] as const;
const contracts = [
  () =>
    Website.Vite("Web", {
      vite: { outDir: "build", base: "/docs/" },
      assets: { notFoundHandling: "single-page-application" },
    }),
  () => Website.Astro("Web", { astro: { output: "static" } }),
  () =>
    Website.Nextjs("Web", {
      project: { projectId: "project" },
      function: { name: "Web", slug: "website" },
    }),
  () => Website.Nuxt("Web", { nuxt: { app: { baseURL: "/docs/" } } }),
  () => Website.SvelteKit("Web", { kit: { paths: { base: "/docs" } } }),
  () => Website.Waku("Web", { waku: { srcDir: "src" } }),
  () => Website.Foldkit("Web"),
  () => Website.Octane("Web"),
  () => Website.ReactRouter("Web"),
  () => Website.SolidStart("Web"),
  () => Website.TanStackStart("Web"),
  () => Website.Vocs("Docs"),
  () =>
    Website.StaticSite("Web", {
      command: "hugo",
      outdir: "public",
      branch: { projectId: "project", branchId: "branch" },
    }),
  () =>
    Website.Vite("Web", {
      branch: { projectId: "project", branchId: "branch" },
      // @ts-expect-error Branch and project are mutually exclusive scopes.
      project: { projectId: "project" },
    }),
  () =>
    Website.Vite("Web", {
      // @ts-expect-error The composition owns its entrypoint.
      function: { main: "./index.ts" },
    }),
  () =>
    Website.Astro("Web", {
      // @ts-expect-error Memory sizing is not exposed by Neon Functions.
      function: { memory: 512 },
    }),
  () =>
    Website.Nextjs("Web", {
      // @ts-expect-error Functions export Fetch handlers; they do not expose listening ports.
      function: { port: 3000 },
    }),
  () =>
    Website.Vite("Web", {
      // @ts-expect-error SPA behavior belongs in assets.notFoundHandling.
      spa: true,
    }),
];

it(
  "exports all thirteen constructors with restricted Neon deployment controls",
  () => {
    for (const name of constructors)
      expect(typeof Website[name]).toBe("function");
    expect(contracts.length).toBeGreaterThan(constructors.length);
  },
  { tags: ["unit", "provider:neon", "provider:neon:website", "local"] },
);
