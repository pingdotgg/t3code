import * as railway from "@distilled.cloud/railway";
import * as Provider from "@/Provider";
import * as Railway from "@/Railway";
import { suitePartition } from "./suiteProject.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";

const { test } = Test.make({ providers: Railway.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const isGoneStatus = (status: string | undefined) => status === "DESTROYED";

const waitUntilGone = (environmentId: string, sandboxId: string) =>
  railway.sandbox({ environmentId, id: sandboxId }, { status: true }).pipe(
    Effect.map((sandbox) =>
      sandbox === null || isGoneStatus(sandbox.status)
        ? ("gone" as const)
        : ("found" as const),
    ),
    railway.catchTags(["RailwayNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const destroyLive = (environmentId: string, sandboxId: string) =>
  railway.sandboxDestroy({ environmentId, id: sandboxId }, { id: true }).pipe(
    railway.catchTags(["RailwayNotFound"], () => Effect.void),
    Effect.flatMap(() => waitUntilGone(environmentId, sandboxId)),
  );

test.provider(
  "sandbox create succeeds or surfaces a typed authorization error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          return { project, environment };
        }),
      );

      const result = yield* Effect.result(
        railway.createSandbox(
          {
            input: {
              environmentId: created.environment.environmentId,
              idleTimeoutMinutes: 5,
            },
          },
          { environmentId: true, id: true },
        ),
      );

      if (Result.isSuccess(result)) {
        yield* Effect.logInfo(
          "sandboxes are entitled on this token; probe is a no-op",
        );
        yield* destroyLive(result.success.environmentId, result.success.id);
        yield* stack.destroy();
        return;
      }

      expect(railway.isErrorTag(result.failure, "RailwayForbidden")).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "create, exec, and destroy a sandbox",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const box = yield* Railway.Sandbox("Box", {
            environment,
            idleTimeoutMinutes: 5,
          });
          return { project, environment, box };
        }),
      );

      expect(created.box.sandboxId).toEqual(expect.any(String));
      expect(created.box.sandboxId.length).toBeGreaterThan(0);
      expect(created.box.environmentId).toEqual(
        created.environment.environmentId,
      );
      expect(created.box.projectId).toEqual(created.project.projectId);
      expect(created.box.status).toEqual("RUNNING");
      expect(created.box.region).toEqual(expect.any(String));
      expect(created.box.region.length).toBeGreaterThan(0);
      expect(created.box.createdAt).toEqual(expect.any(String));
      expect(created.box.idleTimeoutMinutes).toEqual(5);
      expect(created.box.domains).toEqual([]);

      const fetched = yield* railway.sandbox(
        {
          environmentId: created.box.environmentId,
          id: created.box.sandboxId,
        },
        {
          id: true,
          environmentId: true,
          status: true,
          idleTimeoutMinutes: true,
        },
      );
      if (fetched === null) {
        return yield* Effect.fail(
          new Error("Deployed Railway sandbox was not found"),
        );
      }
      expect(fetched.id).toEqual(created.box.sandboxId);
      expect(fetched.environmentId).toEqual(created.box.environmentId);
      expect(fetched.status).toEqual("RUNNING");
      expect(fetched.idleTimeoutMinutes).toEqual(5);

      const executed = yield* Railway.execSandbox({
        sandboxId: created.box.sandboxId,
        environmentId: created.box.environmentId,
        command: "echo hello",
        timeoutSec: 30,
      });
      expect(executed.exitCode).toEqual(0);
      expect(executed.timedOut).toEqual(false);
      expect(executed.stdout).toContain("hello");

      const provider = yield* Provider.findProvider(Railway.Sandbox);
      const listed = yield* provider.list();
      const found = listed.find(
        (sandbox) => sandbox.sandboxId === created.box.sandboxId,
      );
      expect(found).toBeDefined();
      expect(found?.environmentId).toEqual(created.box.environmentId);
      expect(found?.status).toEqual("RUNNING");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.box.environmentId,
        created.box.sandboxId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "publishes a domain with custom resources and replaces removed options",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (configured: boolean) =>
        stack.deploy(
          Effect.gen(function* () {
            const { environment } = yield* suitePartition;
            const box = yield* Railway.Sandbox("Preview", {
              environment,
              idleTimeoutMinutes: 5,
              ...(configured
                ? {
                    networkIsolation: "PRIVATE" as const,
                    publicDomains: [{ port: 8080 }],
                    resources: { cpu: 0.5, memoryGB: 1 },
                    variables: { ALCHEMY_SANDBOX_TEST: "configured" },
                  }
                : {}),
            });
            return { box };
          }),
        );
      const { box } = yield* deploy(true);
      expect(box.status).toBe("RUNNING");
      expect(box.networkIsolation).toBe("PRIVATE");
      expect(box.domains).toHaveLength(1);
      expect(box.domains[0]?.port).toBe(8080);
      const observed = yield* railway.sandbox(
        { environmentId: box.environmentId, id: box.sandboxId },
        {
          domains: { domain: true, port: true, prefix: true },
          networkIsolation: true,
        },
      );
      expect(observed?.domains).toEqual(box.domains);
      const started = yield* Railway.execSandbox({
        ...box,
        command: `python3 -c 'import os, pathlib, subprocess; root = pathlib.Path("/tmp/alchemy-http"); root.mkdir(exist_ok=True); (root / "index.html").write_text(os.environ["ALCHEMY_SANDBOX_TEST"]); subprocess.Popen(["python3", "-m", "http.server", "8080", "--bind", "0.0.0.0", "--directory", str(root)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)'`,
        timeoutSec: 10,
      });
      expect(started.exitCode).toBe(0);
      const client = yield* HttpClient.HttpClient;
      const body = yield* client.get(`https://${box.domains[0]!.domain}`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? response.text
            : Effect.fail(new Error(`HTTP ${response.status}`)),
        ),
        Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 8 }),
      );
      expect(body).toBe("configured");
      const unchanged = yield* deploy(true);
      expect(unchanged.box.sandboxId).toBe(box.sandboxId);
      const cleared = yield* deploy(false);
      expect(cleared.box.sandboxId).not.toBe(box.sandboxId);
      expect(cleared.box.domains).toEqual([]);
      expect(cleared.box.networkIsolation).toBe("ISOLATED");
      const env = yield* Railway.execSandbox({
        ...cleared.box,
        command: "printf '%s' \"${ALCHEMY_SANDBOX_TEST-unset}\"",
        timeoutSec: 10,
      });
      expect(env.stdout).toBe("unset");
      expect(yield* waitUntilGone(box.environmentId, box.sandboxId)).toBe(
        "gone",
      );
      yield* stack.destroy();
      expect(
        yield* waitUntilGone(cleared.box.environmentId, cleared.box.sandboxId),
      ).toBe("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "forks a running sandbox disk without inheriting variables",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (fork: boolean) =>
        Effect.gen(function* () {
          const { environment } = yield* suitePartition;
          const source = yield* Railway.Sandbox("Source", {
            environment,
            idleTimeoutMinutes: 5,
            variables: { SOURCE_ONLY: "source" },
          });
          const copy = fork
            ? yield* Railway.Sandbox("Fork", {
                environment,
                sourceSandboxId: source.sandboxId,
                idleTimeoutMinutes: 5,
                resources: { cpu: 1 },
                variables: { FORK_ONLY: "fork" },
              })
            : undefined;
          return { source, copy };
        });
      const { source } = yield* stack.deploy(program(false));
      expect(
        (yield* Railway.execSandbox({
          ...source,
          command: "printf disk-content > /tmp/alchemy-fork",
          timeoutSec: 10,
        })).exitCode,
      ).toBe(0);
      const { copy } = yield* stack.deploy(program(true));
      expect(copy).toBeDefined();
      expect(copy!.sandboxId).not.toBe(source.sandboxId);
      const read = yield* Railway.execSandbox({
        ...copy!,
        command:
          'cat /tmp/alchemy-fork; printf \'\\n%s:%s\' "${SOURCE_ONLY-unset}" "$FORK_ONLY"',
        timeoutSec: 10,
      });
      expect(read.exitCode).toBe(0);
      expect(read.stdout).toContain("disk-content");
      expect(read.stdout).toContain("unset:fork");
      expect(
        (yield* Railway.execSandbox({
          ...copy!,
          command: "printf fork-content > /tmp/alchemy-fork",
          timeoutSec: 10,
        })).exitCode,
      ).toBe(0);
      expect(
        (yield* Railway.execSandbox({
          ...source,
          command: "cat /tmp/alchemy-fork",
          timeoutSec: 10,
        })).stdout,
      ).toBe("disk-content");
      yield* stack.destroy();
      expect(yield* waitUntilGone(source.environmentId, source.sandboxId)).toBe(
        "gone",
      );
      expect(yield* waitUntilGone(copy!.environmentId, copy!.sandboxId)).toBe(
        "gone",
      );
    }).pipe(logLevel),
  { timeout: 120_000 },
);
