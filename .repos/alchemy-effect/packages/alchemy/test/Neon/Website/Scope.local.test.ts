import { providers } from "@/Neon/Providers.ts";
import * as Website from "@/Neon/Website/index.ts";
import * as Test from "@/Test/Alchemy.ts";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { bodyContaining, exampleRoot } from "./Fixture.ts";

const { test } = Test.make({ providers: providers(), dev: true });
const constructors = [
  Website.Vite,
  Website.Astro,
  Website.Nextjs,
  Website.Nuxt,
  Website.SvelteKit,
  Website.ReactRouter,
  Website.SolidStart,
  Website.TanStackStart,
  Website.Waku,
  Website.Octane,
  Website.Foldkit,
  Website.Vocs,
];

describe.sequential(
  "Neon Website explicit local scope",
  { tags: ["provider:neon", "provider:neon:website", "local"] },
  () => {
    for (const [index, website] of constructors.entries()) {
      test.provider(
        `constructor ${index} preserves explicit branch and project without an implicit backend`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const dev = {
              mode: "external" as const,
              url: "http://localhost:5173",
            };
            const branch = {
              projectId: "explicit-project",
              branchId: "explicit-branch",
            };
            const project = { projectId: "explicit-project" };
            const first = yield* stack.deploy(website("Web", { branch, dev }));
            expect(first.branch).toEqual(branch);
            expect(first.project).toBeUndefined();
            expect(first.function).toBeUndefined();
            expect(first.url).toBe(dev.url);
            const second = yield* stack.deploy(
              website("Web", { project, dev }),
            );
            expect(second.project).toEqual(project);
            expect(second.branch).toBeUndefined();
            expect(second.function).toBeUndefined();
            yield* stack.destroy();
          }),
        { timeout: 120_000 },
      );
    }

    test.provider(
      "StaticSite preserves explicit branch and project without an implicit backend",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const rootDir = yield* exampleRoot("static");
          const branch = {
            projectId: "explicit-project",
            branchId: "explicit-branch",
          };
          const project = { projectId: "explicit-project" };
          const props = {
            rootDir,
            command: "bun run build",
            outdir: "dist",
            dev: { command: "bun run dev:site" },
          };
          const first = yield* stack.deploy(
            Website.StaticSite("Web", { ...props, branch }),
          );
          expect(first.branch).toEqual(branch);
          expect(first.project).toBeUndefined();
          expect(first.function).toBeUndefined();
          yield* bodyContaining(String(first.url), "Static site on Neon");
          const second = yield* stack.deploy(
            Website.StaticSite("Web", { ...props, project }),
          );
          expect(second.project).toEqual(project);
          expect(second.branch).toBeUndefined();
          expect(second.function).toBeUndefined();
          yield* stack.destroy();
        }),
      { timeout: 120_000 },
    );
  },
);
