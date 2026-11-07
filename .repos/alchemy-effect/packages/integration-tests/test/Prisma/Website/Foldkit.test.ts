import * as Prisma from "@alchemy.run/prisma";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getProject, getService } from "@distilled.cloud/prisma/management";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  foldkitFixture,
  foldkitMemo,
  verifyFoldkitBrowser,
  verifyFoldkitRendering,
} from "../../Website/Foldkit.ts";

const { test } = Test.make({ providers: Prisma.providers() });

describe.sequential(
  "Prisma Foldkit rendering modes",
  { tags: ["provider:prisma", "provider:prisma:website", "live"] },
  () => {
    for (const mode of ["spa", "ssg", "ssr", "hybrid"] as const) {
      test.provider.skipIf(
        !!process.env.FAST || process.env.ALCHEMY_RUN_LIVE_PRISMA_TESTS !== "true",
      )(
        `${mode}: renders every route and cleans up`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const rootDir = yield* foldkitFixture(mode);

            const site = yield* stack.deploy(
              Prisma.Website.Foldkit("Web", {
                rootDir,
                memo: foldkitMemo,
              }),
            );
            expect(site.url).toBeDefined();
            expect(site.compute).toBeDefined();
            const compute = site.compute!;
            yield* getService({ serviceId: compute.appId });
            yield* verifyFoldkitRendering(site.url!, mode);
            yield* verifyFoldkitBrowser(site.url!, mode);
            yield* stack.destroy();
            const gone = yield* getService({ serviceId: compute.appId })
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
            expect(
              yield* getProject({ id: compute.projectId }).pipe(
                Effect.as(false),
                Effect.catchTag("NotFound", () => Effect.succeed(true)),
              ),
            ).toBe(true);
          }),
        {
          timeout: 120_000,
        },
      );
    }
  },
);
