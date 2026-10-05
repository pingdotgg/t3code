import * as Alchemy from "@/index.ts";
import * as Prisma from "@/Prisma/index.ts";
import * as Test from "@/Test/Alchemy.ts";
import { getProject, getService } from "@distilled.cloud/prisma/management";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { bodyContaining, copyViteFixture } from "./Fixture.ts";

const { test } = Test.make({ providers: Prisma.providers(), dev: true });

test.provider(
  "Vite dev serves native modules and updates without cloud resources",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* copyViteFixture;
      const { site } = yield* stack.deploy(
        Prisma.Website.Vite("Web", { rootDir }).pipe(
          Effect.map((site) => ({ site })),
        ),
      );
      expect(site.url).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):\d+/);
      expect(site.compute).toBeUndefined();
      expect(site.project).toBeUndefined();
      yield* bodyContaining(`${site.url}/`, "Prisma Website fixture");
      yield* bodyContaining(`${site.url}/main.ts`, "first revision");
      yield* fs.writeFileString(
        path.join(rootDir, "main.ts"),
        'document.querySelector("#message").textContent = "second revision";',
      );
      yield* bodyContaining(`${site.url}/main.ts`, "second revision");
      yield* stack.destroy();
    }).pipe(Effect.scoped),
  {
    tags: ["provider:prisma", "provider:prisma:website", "local"],
    timeout: 120_000,
  },
);

test.provider.skipIf(process.env.ALCHEMY_RUN_LIVE_PRISMA_TESTS !== "true")(
  "Vite remote opt-out deploys real Compute from dev and removes it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const rootDir = yield* copyViteFixture;
      const { site } = yield* stack.deploy(
        Prisma.Website.Vite("Web", { rootDir }).pipe(
          Alchemy.remote(),
          Effect.map((site) => ({ site })),
        ),
      );
      expect(site.url).toMatch(/^https:\/\//);
      expect(site.compute).toBeDefined();
      expect(site.project).toBeDefined();
      const projectId = site.compute!.projectId;
      const appId = site.compute!.appId;
      expect((yield* getProject({ id: projectId })).data.id).toBe(projectId);
      expect((yield* getService({ serviceId: appId })).data.id).toBe(appId);
      yield* bodyContaining(
        `${site.url}/client/route`,
        "Prisma Website fixture",
      );
      yield* stack.destroy();
      expect(
        yield* getService({ serviceId: appId }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
      expect(
        yield* getProject({ id: projectId }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
    }).pipe(Effect.scoped),
  {
    tags: ["provider:prisma", "provider:prisma:website", "live"],
    timeout: 120_000,
  },
);
