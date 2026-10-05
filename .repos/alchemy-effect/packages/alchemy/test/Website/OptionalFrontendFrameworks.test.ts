import { exec } from "@/Util/exec.ts";
import { nodeLoaderArgs } from "@/Util/Node.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import { ChildProcess } from "effect/process";
import { fileURLToPath } from "node:url";

describe(
  "optional frontend-frameworks peer",
  { tags: ["unit", "local"] },
  () => {
    it.effect(
      "imports providers without the peer and reports missing website dependencies as defects",
      () =>
        Effect.gen(function* () {
          const fixture = fileURLToPath(
            new URL(
              "./fixtures/optional-frontend-frameworks.fixture.ts",
              import.meta.url,
            ),
          );
          const { exitCode, stdout, stderr } = yield* exec(
            ChildProcess.make("node", [...nodeLoaderArgs(fixture), fixture], {
              stdout: "pipe",
              stderr: "pipe",
              killSignal: "SIGKILL",
            }),
          );
          expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
          expect(JSON.parse(stdout)).toEqual({
            providers: ["Prisma", "Neon", "Fly", "Hetzner", "Railway"],
            providerImportAttempts: 0,
            loaderImportAttempts: 1,
            defect: true,
            error: {
              _tag: "FrameworkServerError",
              framework: "@alchemy.run/frontend-frameworks/core",
              message: expect.stringContaining(
                "Install @alchemy.run/frontend-frameworks",
              ),
              cause:
                "Cannot find package '@alchemy.run/frontend-frameworks/core'",
            },
          });
        }).pipe(
          Effect.timeout("30 seconds"),
          Effect.scoped,
          Effect.provide(NodeServices.layer),
        ),
      { timeout: 40_000 },
    );
  },
);
