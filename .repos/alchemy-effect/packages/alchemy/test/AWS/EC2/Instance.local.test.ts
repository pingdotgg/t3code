/**
 * Hosted `AWS.EC2.Instance` under `alchemy dev`: the dualized EC2 providers
 * deploy the whole fleet (VPC network, security group, instance, and the
 * hosted program's S3 bundle) into the floci emulator, where the instance
 * runs as a REAL docker container that boots the Alchemy userData — syncs
 * the bundle from emulated S3, installs the runtime, and serves the hosted
 * `{ fetch }` program.
 *
 * Proof structure:
 *   - attrs carry the emulator's `.localhost.floci.io` public address — the
 *     live cloud can never mint it;
 *   - e2e over HTTP: floci publishes the security-group app port behind a
 *     host-routing mux, so `http://<host>:3000/marker` serves THIS build's
 *     marker from inside the emulated instance;
 *   - bindings through compute: a floci-hosted Lambda bound to the instance
 *     (`DescribeInstance` / `DescribeInstanceStatus`) answers over its
 *     function URL — emulated Lambda → EC2 control plane → emulated
 *     instance, no real cloud anywhere;
 *   - destroy terminates the instance (verified out-of-band via distilled).
 *
 * Requires Docker (floci runs as a container); skipped when unavailable.
 */
import * as AWS from "@/AWS";
import * as Endpoint from "@/AWS/Endpoint.ts";
import * as Region from "@/AWS/Region.ts";
import * as Test from "@/Test/Alchemy";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import type { RegionName } from "@distilled.cloud/aws/Region";
import * as ec2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { dockerAvailable } from "../Local/fixtures/raw.ts";
import DevInstance, { MARKER } from "./fixtures/dev-instance.ts";
import DevProbeFunctionLive, {
  Ec2DevProbeFunction,
} from "./fixtures/dev-instance-fn.ts";

const { test } = Test.make({ providers: AWS.providers(), dev: true });

/** Floci-scoped context for the raw distilled calls the test makes itself. */
const flociContext = Layer.mergeAll(
  Endpoint.of("http://localhost:4566"),
  Region.of("us-east-1"),
  Layer.succeed(
    Credentials,
    Effect.succeed({
      accessKeyId: Redacted.make("test"),
      secretAccessKey: Redacted.make("test"),
      sessionToken: undefined,
      region: "us-east-1" as RegionName,
    }),
  ),
);

test.provider.skipIf(!dockerAvailable)(
  "dev runs a hosted EC2 instance as a container serving HTTP, with Lambda EC2 bindings against it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const outputs = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* DevInstance;
          const fn = yield* Ec2DevProbeFunction;
          return {
            instanceId: instance.instanceId,
            publicDnsName: instance.publicDnsName,
            functionUrl: fn.functionUrl,
          };
        }).pipe(Effect.provide(DevProbeFunctionLive)),
      );

      expect(outputs.instanceId).toMatch(/^i-/);
      expect(outputs.functionUrl).toBeDefined();
      // Emulator identity: floci addresses instances under its own
      // host-routed localhost domain.
      const host =
        outputs.publicDnsName?.endsWith(".localhost.floci.io") === true
          ? outputs.publicDnsName
          : `${outputs.instanceId}.localhost.floci.io`;
      const base = `http://${host}:3000`;

      // The instance container boots the Alchemy userData: bundle sync from
      // emulated S3, runtime install, then the Bun HTTP server on :3000.
      const served = yield* HttpClient.get(`${base}/health`).pipe(
        Effect.map((res) => res.status === 200),
        Effect.catch(() => Effect.succeed(false)),
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (ok): boolean => ok,
          times: 60,
        }),
      );
      expect(served).toBe(true);

      // The program served is THIS build.
      const marker = yield* HttpClient.get(`${base}/marker`).pipe(
        Effect.flatMap((res) => res.text),
        Effect.retry({ schedule: Schedule.spaced("1 second"), times: 10 }),
      );
      expect(marker).toBe(MARKER);

      // Bindings through compute: the floci-hosted Lambda observes the
      // emulated instance via its DescribeInstance binding.
      const describeUrl = `${outputs.functionUrl}describe`;
      const described = yield* HttpClient.get(describeUrl).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? res.json
            : Effect.fail(new Error(`/describe returned ${res.status}`)),
        ),
        Effect.map(
          (json) =>
            json as {
              ok: boolean;
              state?: string;
              instanceId?: string;
            },
        ),
        Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 20 }),
      );
      expect(described.ok).toBe(true);
      expect(described.instanceId).toBe(outputs.instanceId);
      expect(described.state).toBe("running");

      // Reboot resilience: the provider's in-place update path ends in
      // RebootInstances, and floci's guest services must come back after
      // the container restart (the systemd shim's processes die with the
      // container; the emulator re-runs the boot sequence). Without this
      // the box goes dark after every hosted-program update.
      yield* ec2
        .rebootInstances({ InstanceIds: [outputs.instanceId] })
        .pipe(Effect.provide(flociContext));
      const backAfterReboot = yield* HttpClient.get(`${base}/marker`).pipe(
        Effect.flatMap((res) => res.text),
        Effect.map((text) => text.includes(MARKER)),
        Effect.catch(() => Effect.succeed(false)),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (ok): boolean => ok,
          times: 60,
        }),
      );
      expect(backAfterReboot).toBe(true);

      const status = yield* HttpClient.get(`${outputs.functionUrl}status`).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? res.json
            : Effect.fail(new Error(`/status returned ${res.status}`)),
        ),
        Effect.map((json) => json as { ok: boolean; count?: number }),
        Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 10 }),
      );
      expect(status.ok).toBe(true);
      expect(status.count).toBeGreaterThan(0);

      // Destroy: the emulated instance reaches a terminal state (or is
      // fully forgotten by the emulator).
      yield* stack.destroy();
      const gone = yield* ec2
        .describeInstances({ InstanceIds: [outputs.instanceId] })
        .pipe(
          Effect.map((res) => {
            const state = res.Reservations?.[0]?.Instances?.[0]?.State?.Name;
            return state === undefined || state === "terminated";
          }),
          Effect.catchTag("InvalidInstanceID.NotFound", () =>
            Effect.succeed(true),
          ),
          Effect.provide(flociContext),
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (isGone): boolean => isGone,
            times: 30,
          }),
        );
      expect(gone).toBe(true);
    }),
  { timeout: 600_000 },
);
