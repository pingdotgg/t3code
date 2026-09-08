import * as AWS from "@/AWS";
import * as Test from "./VpcTest.ts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import TestUbuntuInstance from "./fixtures/ubuntu-instance.ts";
import { assertInstanceTerminated } from "./Gone.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Ubuntu 24.04 end-to-end for the hosted bootstrap (issues #1027 + #1028):
// Ubuntu AMIs ship without `unzip`, `dnf`, or `yum`, so a served HTTP response
// proves the bootstrap's `apt-get` branch installed `unzip`, the AWS CLI
// install and S3 bundle sync succeeded, and the systemd unit's
// `bun --no-install` start ran the self-contained bundle.
//
// Heavy (instance boot + apt-get + AWS CLI install + bun install + S3 sync),
// so skipped under `FAST=1`.
test.provider.skipIf(!!process.env.FAST)(
  "deploys a hosted Ubuntu 24.04 instance that serves HTTP",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { instanceId, publicIpAddress } = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* TestUbuntuInstance;
          return {
            instanceId: instance.instanceId,
            publicIpAddress: instance.publicIpAddress,
          };
        }),
      );

      expect(publicIpAddress).toBeTruthy();
      const base = `http://${publicIpAddress}:3000`;

      // Poll until the instance boots, apt-get installs unzip, the AWS CLI
      // installs, bun installs, the bundle syncs from S3, and the systemd
      // unit serves 200 on :3000. Connection errors before the server binds
      // are normalised to "not ready" so the poll keeps going.
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
          Effect.retry({ schedule: Schedule.spaced("1 second"), times: 10 }),
        );

      const body = yield* getJson("/health");
      expect(body).toEqual({ ok: true });

      // Prove the ServerHost.run background loop is executing on the instance.
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
