import * as Prisma from "@/Prisma/index.ts";
import * as Test from "@/Test/Alchemy.ts";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { bodyContaining } from "./Fixture.ts";

const frameworks = [
  ["astro", "Astro", Prisma.Website.Astro],
  ["foldkit", "Foldkit", Prisma.Website.Foldkit],
  ["nextjs", "Next.js", Prisma.Website.Nextjs],
  ["nuxt", "Nuxt", Prisma.Website.Nuxt],
  ["octane", "Octane", Prisma.Website.Octane],
  ["react-router", "React Router", Prisma.Website.ReactRouter],
  ["solidstart", "SolidStart", Prisma.Website.SolidStart],
  ["sveltekit", "SvelteKit", Prisma.Website.SvelteKit],
  ["tanstack-start", "TanStack Start", Prisma.Website.TanStackStart],
  ["vinext", "vinext", Prisma.Website.Vinext],
  ["vite", "Vite", Prisma.Website.Vite],
  ["vocs", "Prisma", Prisma.Website.Vocs],
  ["waku", "Waku", Prisma.Website.Waku],
  [
    "static-built",
    "Static site on Prisma",
    (id: string, props: { rootDir: string }) =>
      Prisma.Website.StaticSite(id, {
        ...props,
        command: "bun run build",
        outdir: "dist",
      }),
  ],
  [
    "static",
    "Static site on Prisma",
    (id: string, props: { rootDir: string }) =>
      Prisma.Website.StaticSite(id, {
        ...props,
        command: "bun run build",
        outdir: "dist",
        dev: { command: "bun run dev:site" },
      }),
  ],
] as const;

describe.sequential(
  "Prisma Website native frameworks",
  { tags: ["provider:prisma", "provider:prisma:website", "local"] },
  () => {
    for (const [slug, title, website] of frameworks) {
      const { test } = Test.make({ providers: Prisma.providers(), dev: true });
      test.provider(
        slug,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const path = yield* Path.Path;
            const rootDir = yield* path.fromFileUrl(
              new URL(
                `../../../../../examples/prisma-website-${slug === "static-built" ? "static" : slug}/`,
                import.meta.url,
              ),
            );
            const { site } = yield* stack.deploy(
              Effect.gen(function* () {
                return { site: yield* website("Web", { rootDir }) };
              }),
            );
            expect(site.url).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):\d+/);
            expect(site.compute).toBeUndefined();
            expect(site.project).toBeUndefined();
            const url = String(site.url).replace(/\/+$/, "");
            yield* bodyContaining(`${url}/`, title);
            yield* bodyContaining(`${url}/example.json`, "framework");
            yield* stack.destroy();
          }),
        { timeout: 120_000 },
      );
    }
  },
);
