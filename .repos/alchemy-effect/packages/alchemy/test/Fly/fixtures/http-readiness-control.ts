import * as machines from "@distilled.cloud/fly-io/machines";
import * as Retry from "@distilled.cloud/fly-io/Retry";
import * as Fly from "@/Fly";
import { checksPassing, configuredCheckNames } from "@/Fly/replicas";
import type { ScratchStack } from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { FileSystem } from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { randomBytes } from "node:crypto";

const Receipt = Schema.Struct({
  machineId: Schema.String,
  ready: Schema.Boolean,
});

// HTTP failures can retain the authenticated request, including on defects.
const privateFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Effect.failCause(
        Cause.fromReasons(
          cause.reasons.map((reason) =>
            Cause.isFailReason(reason)
              ? Cause.makeFailReason(
                  new Error("Readiness control request failed"),
                )
              : Cause.isDieReason(reason)
                ? Cause.makeDieReason(
                    new Error("Readiness control request defect"),
                  )
                : Cause.makeInterruptReason(reason.fiberId),
          ),
        ),
      ),
    ),
  );

export const makeReadinessControl = () =>
  Effect.gen(function* () {
    const token = yield* Effect.sync(() =>
      Redacted.make(
        Array.from(randomBytes(32), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join(""),
      ),
    );
    const fs = yield* FileSystem;
    const path = yield* Path.Path;
    const script = yield* fs.readFileString(
      yield* path.fromFileUrl(
        new URL("./http-readiness-control.mjs", import.meta.url),
      ),
    );
    const infrastructure = Effect.gen(function* () {
      const app = yield* Fly.App("Site");
      const secret = yield* Fly.Secret("ReadinessControl", {
        app,
        name: "READINESS_CONTROL_TOKEN",
        value: token,
      });
      yield* Fly.IpAssignment("Public", { app, type: "shared_v4" });
      return { app, secret };
    });
    const ready = {
      type: "http" as const,
      port: 3000,
      path: "/ready",
      interval: "2s",
      timeout: "1s",
    };
    const deployApp = (stack: ScratchStack) =>
      stack.deploy(infrastructure.pipe(Effect.map(({ app }) => app)));
    const deployWorker = (stack: ScratchStack, version: string) =>
      stack.deploy(
        Effect.gen(function* () {
          const { app, secret } = yield* infrastructure;
          return yield* Fly.Machine("Worker", {
            app,
            image: "node:22-alpine",
            init: { exec: ["node", "--input-type=module", "-e", script] },
            env: {
              VERSION: version,
              READINESS_CONTROL_SECRET: secret.name,
            },
            checks: { ready },
            services: [
              {
                protocol: "tcp",
                internalPort: 3000,
                ports: [{ port: 443, handlers: ["tls", "http"] }],
                autostop: "off",
                autostart: true,
                checks: [ready],
              },
            ],
            deploy: { strategy: "bluegreen", healthTimeout: "30 seconds" },
            shutdown: { signal: "SIGTERM", timeout: "5 seconds" },
          });
        }),
      );
    const request = (appName: string, machineId: string, off: boolean) =>
      Effect.gen(function* () {
        const url = `https://${appName}.fly.dev`;
        const response = yield* HttpClient.execute(
          (off
            ? HttpClientRequest.post(`${url}/readiness/off`)
            : HttpClientRequest.get(`${url}/ready`)
          ).pipe(
            HttpClientRequest.bearerToken(token),
            HttpClientRequest.setHeader("fly-force-instance-id", machineId),
            HttpClientRequest.setHeader("x-readiness-machine-id", machineId),
          ),
        );
        if (response.status !== 200)
          return yield* Effect.fail(new Error("Unexpected readiness status"));
        return yield* response.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Receipt)),
        );
      }).pipe(
        Effect.timeout("10 seconds"),
        Effect.provide(FetchHttpClient.layer),
        privateFailure,
      );
    const turnOff = (appName: string, machineId: string) =>
      Effect.gen(function* () {
        const observe = machines
          .getMachine({ app_name: appName, machine_id: machineId })
          .pipe(Retry.none, Effect.timeout("10 seconds"));
        const before = yield* observe.pipe(
          Effect.repeat({
            until: (machine) => checksPassing(machine, machine.config),
            times: 8,
            schedule: Schedule.spaced("1 second"),
          }),
          Effect.timeout("10 seconds"),
        );
        expect(before.id).toBe(machineId);
        expect(before.cordoned).toBe(false);
        const checkNames = configuredCheckNames(before.config);
        expect(checkNames).toEqual(["ready", "servicecheck-00-http-3000"]);
        expect(checksPassing(before, before.config)).toBe(true);
        const healthy = yield* request(appName, machineId, false).pipe(
          Effect.retry({ times: 8, schedule: Schedule.spaced("1 second") }),
          Effect.timeout("30 seconds"),
        );
        expect(healthy).toEqual({ machineId, ready: true });
        const receipt = yield* request(appName, machineId, true);
        expect(receipt).toEqual({ machineId, ready: false });
        const failed = (machine: machines.Machine) =>
          checkNames.every((name) =>
            machine.checks?.some(
              (check) => check.name === name && check.status === "critical",
            ),
          );
        // Hold the provider barrier until Fly has observed the real file change.
        const after = yield* observe.pipe(
          Effect.repeat({
            until: failed,
            times: 8,
            schedule: Schedule.spaced("1 second"),
          }),
          Effect.timeout("20 seconds"),
        );
        expect(after.id).toBe(machineId);
        expect(after.cordoned).toBe(false);
        expect(failed(after)).toBe(true);
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.timeout("25 seconds"),
      );
    return { deployApp, deployWorker, turnOff };
  });

export const repairReadiness = (appName: string, machineId: string) =>
  Effect.gen(function* () {
    const unleased = yield* machines
      .getMachineLease({ app_name: appName, machine_id: machineId })
      .pipe(
        Retry.none,
        Effect.timeout("15 seconds"),
        Effect.as(false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
      );
    expect(unleased).toBe(true);
    const repaired = yield* machines
      .execMachine({
        app_name: appName,
        machine_id: machineId,
        command: ["touch", "/tmp/ready"],
        timeout: 5,
      })
      .pipe(Retry.none, Effect.timeout("15 seconds"));
    expect(repaired.exit_code).toBe(0);
  }).pipe(Effect.provide(FetchHttpClient.layer));
