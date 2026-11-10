import * as Neon from "@alchemy.run/neon";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getProject, getProjectBranchFunction } from "@distilled.cloud/neon";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  foldkitFixture,
  foldkitMemo,
  verifyFoldkitBrowser,
  verifyFoldkitRendering,
} from "../../Website/Foldkit.ts";

const { test } = Test.make({ providers: Neon.providers() });

describe.sequential(
  "Neon Foldkit rendering modes",
  { tags: ["provider:neon", "provider:neon:website", "live"] },
  () => {
    for (const mode of ["ssg", "ssr", "hybrid"] as const) {
      test.provider.skipIf(!!process.env.FAST)(
        `${mode}: renders every route and cleans up`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const rootDir = yield* foldkitFixture(mode);

            const site = yield* stack.deploy(
              Neon.Website.Foldkit("Web", {
                rootDir,
                memo: foldkitMemo,
              }),
            );
            expect(site.url).toBeDefined();
            expect(site.function).toBeDefined();
            const fn = site.function!;
            const found = yield* getProjectBranchFunction({
              project_id: fn.projectId,
              branch_id: fn.branchId,
              slug: fn.slug,
            });
            expect(found.function.active_deployment?.id).toBe(fn.activeDeploymentId);
            yield* verifyFoldkitRendering(site.url!, mode);
            yield* verifyFoldkitBrowser(site.url!, mode);
            yield* stack.destroy();
            const gone = yield* getProject({ project_id: fn.projectId })
              .pipe(
                Effect.as(false),
                Effect.catchTag("NotFound", () => Effect.succeed(true)),
              )
              .pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("1 second"),
                  times: 8,
                  until: (gone) => gone,
                }),
              );
            expect(gone).toBe(true);
          }),
        {
          timeout: 120_000,
        },
      );
    }
  },
);
