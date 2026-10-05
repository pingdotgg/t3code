import * as Prisma from "@/Prisma/index.ts";
import * as Test from "@/Test/Alchemy.ts";
import { getProject, getService } from "@distilled.cloud/prisma/management";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import { bodyContaining, copyViteFixture } from "./Fixture.ts";

const { test } = Test.make({ providers: Prisma.providers() });

test.provider.skipIf(process.env.ALCHEMY_RUN_LIVE_PRISMA_TESTS !== "true")(
  "Vite publishes real builds, memoizes unchanged content, updates in place, and cleans up",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* copyViteFixture;
      const deploy = (
        fallback:
          | "single-page-application"
          | "none" = "single-page-application",
      ) =>
        stack.deploy(
          Prisma.Website.Vite("Web", {
            rootDir,
            assets: { notFoundHandling: fallback },
            vite: { outDir: "build" },
            memo: { include: ["index.html", "main.ts", "package.json"] },
          }).pipe(Effect.map((site) => ({ site }))),
        );
      const initial = (yield* deploy()).site;
      expect(initial.url).toMatch(/^https:\/\//);
      const projectId = initial.compute!.projectId;
      const appId = initial.compute!.appId;
      yield* bodyContaining(
        `${initial.url}/client/route`,
        "Prisma Website fixture",
      );
      yield* bodyContaining(`${initial.url}/health`, "ok");
      const unchanged = (yield* deploy()).site;
      expect(unchanged.compute!.deploymentId).toBe(
        initial.compute!.deploymentId,
      );
      const indexPath = path.join(rootDir, "index.html");
      const index = yield* fs.readFileString(indexPath);
      yield* fs.writeFileString(
        indexPath,
        index.replaceAll("Prisma Website fixture", "Prisma Website updated"),
      );
      const updated = (yield* deploy("none")).site;
      expect(updated.compute!.appId).toBe(appId);
      expect(updated.compute!.projectId).toBe(projectId);
      expect(updated.compute!.deploymentId).not.toBe(
        initial.compute!.deploymentId,
      );
      yield* bodyContaining(`${updated.url}/`, "Prisma Website updated");
      const missing = yield* HttpClient.get(
        `${updated.url}/missing-client-route`,
      );
      expect(missing.status).toBe(404);
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
