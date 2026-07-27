import * as AWS from "@/AWS";
import * as Test from "./VpcTest.ts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import TestInstance, { keyPair } from "./fixtures/instance.ts";
import { assertInstanceTerminated } from "./Gone.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Full end-to-end: bundle the hosted program, launch a real EC2 instance into a
// public subnet, and prove over HTTP (directly against the instance's public
// IP) that (a) the `{ fetch }` handler is served by the instance's Bun HTTP
// server and (b) the `ServerHost.run` background loop is executing on the
// instance (`/ticks` keeps climbing).
//
// Heavy (instance boot + bun install + S3 sync + systemd), so skipped under
// `FAST=1`.
test.provider.skipIf(!!process.env.FAST)(
  "deploys a real EC2 instance that serves HTTP and runs a background loop",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { instanceId, publicIpAddress, privateKey } = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* TestInstance;
          // Resolve the same key-pair resource the instance uses and return its
          // private key from the stack (resolved to a `Redacted` value).
          const key = yield* keyPair;
          return {
            instanceId: instance.instanceId,
            publicIpAddress: instance.publicIpAddress,
            privateKey: key.privateKey,
          };
        }),
      );

      expect(publicIpAddress).toBeTruthy();
      // Unredact only to prove the returned value is usable key material. Do
      // not log the ephemeral private key into the test artifact.
      const pem = privateKey ? Redacted.value(privateKey) : undefined;
      expect(pem).toContain("PRIVATE KEY");
      const base = `http://${publicIpAddress}:3000`;

      // Poll until the instance boots, installs bun, syncs the bundle from S3,
      // and the systemd unit serves 200 on :3000. Connection errors before the
      // server binds are normalised to "not ready" so the poll keeps going
      // (a bare `Effect.retry` does not retry the transport-level failure).
      const served = yield* HttpClient.get(`${base}/health`).pipe(
        Effect.map((res) => res.status === 200),
        Effect.catch(() => Effect.succeed(false)),
        Effect.repeat({
          schedule: Schedule.spaced("8 seconds"),
          until: (ok) => ok,
          times: 75,
        }),
      );
      expect(served).toBe(true);

      const getJson = (path: string) =>
        HttpClient.get(`${base}${path}`).pipe(
          Effect.flatMap((res) =>
            res.status === 200
              ? res.json
              : Effect.fail(
                  new Error(`${path} temporarily returned ${res.status}`),
                ),
          ),
          // cloud-init/systemd can briefly restart the hosted process just
          // after the first successful health probe, especially while a full
          // network lane is saturating EC2. Bound the post-readiness probes as
          // well as the initial health poll.
          Effect.retry({ schedule: Schedule.spaced("1 second"), times: 10 }),
        );

      const body = yield* getJson("/health");
      expect(body).toEqual({ ok: true });

      // Prove the ServerHost.run background loop is executing on the instance:
      // the tick counter climbs between two reads.
      const readTicks = getJson("/ticks").pipe(
        Effect.map((value) => (value as { ticks: number }).ticks),
      );
      const first = yield* readTicks;
      yield* Effect.sleep("3 seconds");
      const second = yield* readTicks;
      expect(second).toBeGreaterThan(first);

      yield* stack.destroy();

      // Zero-orphan proof: the (billed) instance reached a terminal state.
      yield* assertInstanceTerminated(instanceId);
    }),
  { timeout: 1_200_000 },
);
