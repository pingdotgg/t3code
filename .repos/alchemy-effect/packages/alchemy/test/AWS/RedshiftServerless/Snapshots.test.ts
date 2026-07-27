import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as serverless from "@distilled.cloud/aws/redshift-serverless";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import SnapshotFunctionLive, {
  SnapshotFunction,
} from "./fixtures/snapshot-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "RedshiftSnapshotBindings");

// Ungated typed-error probes: prove the distilled error union carries the
// not-found tag the snapshot bindings can surface. Runs in every CI pass at
// near-zero cost.
test.provider(
  "getSnapshot on a nonexistent snapshot fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        serverless.getSnapshot({
          snapshotName: "alchemy-nonexistent-rssnap-probe",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider(
  "deleteSnapshot on a nonexistent snapshot fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        serverless.deleteSnapshot({
          snapshotName: "alchemy-nonexistent-rssnap-probe",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

const SNAPSHOT_NAME = "alchemy-test-rssnap-snapshot";

let baseUrl: string;

// The full lifecycle deploys a Redshift Serverless namespace (no workgroup,
// so no RPU billing floor — but namespace + snapshot provisioning still takes
// minutes), so it is gated behind AWS_TEST_REDSHIFT=1 and destroys everything
// in afterAll.
describe.skipIf(!process.env.AWS_TEST_REDSHIFT)(
  "RedshiftServerless Snapshot Bindings",
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* Effect.logInfo(
          "Snapshot bindings setup: destroying previous run",
        );
        yield* sharedStack.destroy();

        yield* Effect.logInfo("Snapshot bindings setup: deploying fixture");
        const { functionUrl } = yield* sharedStack.deploy(
          Effect.gen(function* () {
            return yield* SnapshotFunction;
          }).pipe(Effect.provide(SnapshotFunctionLive)),
        );

        expect(functionUrl).toBeTruthy();
        baseUrl = functionUrl!.replace(/\/+$/, "");
        yield* Effect.logInfo(
          `Snapshot bindings setup: function URL ready (${functionUrl})`,
        );
      }),
      // namespace (~1 min) + Lambda deploy.
      { timeout: 600_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    const json = (
      request: HttpClientRequest.HttpClientRequest,
    ): Effect.Effect<unknown, unknown, HttpClient.HttpClient> =>
      HttpClient.execute(request).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? res.json
            : Effect.flatMap(res.text, (body) =>
                Effect.fail(
                  new Error(`${request.url} -> ${res.status}: ${body}`),
                ),
              ),
        ),
      );

    test.provider(
      "create, poll, list, update, and delete a snapshot through the deployed bindings",
      (_stack) =>
        Effect.gen(function* () {
          // Create — retried while the fresh function URL warms up.
          const created = (yield* json(
            HttpClientRequest.post(`${baseUrl}/snapshot?name=${SNAPSHOT_NAME}`),
          ).pipe(
            Effect.retry({
              schedule: Schedule.max([
                Schedule.exponential("1 second"),
                Schedule.recurs(8),
              ]),
            }),
          )) as { snapshotName?: string; status?: string };
          expect(created.snapshotName).toBe(SNAPSHOT_NAME);

          // Poll via GetSnapshot until the snapshot settles to AVAILABLE.
          const settled = (yield* json(
            HttpClientRequest.get(`${baseUrl}/snapshot?name=${SNAPSHOT_NAME}`),
          ).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (body): boolean =>
                (body as { status?: string }).status?.toUpperCase() ===
                "AVAILABLE",
              times: 36,
            }),
          )) as {
            snapshotName?: string;
            namespaceName?: string;
            retentionPeriod?: number;
            status?: string;
          };
          expect(settled.status?.toUpperCase()).toBe("AVAILABLE");
          expect(settled.namespaceName).toBe("alchemy-test-rssnap-ns");
          expect(settled.retentionPeriod).toBe(1);

          // ListSnapshots filtered by the bound namespace sees it.
          const listed = (yield* json(
            HttpClientRequest.get(`${baseUrl}/snapshots`),
          )) as { names: (string | undefined)[] };
          expect(listed.names).toContain(SNAPSHOT_NAME);

          // UpdateSnapshot extends the retention period.
          const updated = (yield* json(
            HttpClientRequest.post(
              `${baseUrl}/snapshot/retention?name=${SNAPSHOT_NAME}`,
            ),
          )) as { retentionPeriod?: number };
          expect(updated.retentionPeriod).toBe(2);

          // Recovery-point + table-restore listings respond (may be empty
          // for a fresh, never-computed namespace).
          const recovery = (yield* json(
            HttpClientRequest.get(`${baseUrl}/recovery-points`),
          )) as { count: number };
          expect(recovery.count).toBeGreaterThanOrEqual(0);
          const restores = (yield* json(
            HttpClientRequest.get(`${baseUrl}/table-restores`),
          )) as { count: number };
          expect(restores.count).toBeGreaterThanOrEqual(0);

          // DeleteSnapshot removes it; out-of-band read confirms it is gone.
          yield* json(
            HttpClientRequest.delete(
              `${baseUrl}/snapshot?name=${SNAPSHOT_NAME}`,
            ),
          );
          const gone = yield* serverless
            .getSnapshot({ snapshotName: SNAPSHOT_NAME })
            .pipe(
              Effect.map((r) => r.snapshot?.status ?? "PRESENT"),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed("GONE" as const),
              ),
              Effect.repeat({
                schedule: Schedule.spaced("5 seconds"),
                until: (status): boolean =>
                  status === "GONE" || status === "DELETING",
                times: 12,
              }),
            );
          expect(["GONE", "DELETING"]).toContain(gone);
        }),
      { timeout: 420_000 },
    );
  },
);
