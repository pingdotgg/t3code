import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as finspace from "@distilled.cloud/aws/finspace";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// FinSpace Managed kdb is closed to non-onboarded accounts, so the runtime
// bindings (all scoped to a live KxEnvironment) cannot be exercised through a
// deployed Lambda fixture here — deploying the fixture requires a real kdb
// environment (tens of minutes, gated onboarding). These ungated typed-error
// probes instead prove, against the live API, that every operation the
// bindings wrap carries the typed not-found tag in its distilled error union
// — the same tags a bound function observes at runtime.
//
// environmentId must match ^[a-zA-Z0-9]{1,26}$ — malformed ids fail earlier
// with ValidationException.
const missingEnvironmentId = "zzzzzzzzzzzzzzzzzzzzzzzzzz";

test.provider(
  "getKxConnectionString on a nonexistent environment fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        finspace.getKxConnectionString({
          environmentId: missingEnvironmentId,
          clusterName: "nocluster",
          userArn: `arn:aws:finspace:us-east-1:123456789012:kxEnvironment/${missingEnvironmentId}/kxUser/nouser`,
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider(
  "createKxChangeset on a nonexistent environment fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        finspace.createKxChangeset({
          environmentId: missingEnvironmentId,
          databaseName: "nodb",
          changeRequests: [
            {
              changeType: "PUT",
              s3Path: "s3://nonexistent-bucket/nonexistent/",
              dbPath: "/2024.01.02/",
            },
          ],
          clientToken: "alchemy-finspace-probe-changeset",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider(
  "listKxChangesets on a nonexistent environment fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        finspace.listKxChangesets({
          environmentId: missingEnvironmentId,
          databaseName: "nodb",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider(
  "listKxClusterNodes on a nonexistent environment fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        finspace.listKxClusterNodes({
          environmentId: missingEnvironmentId,
          clusterName: "nocluster",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider(
  "getKxDataview on a nonexistent environment fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        finspace.getKxDataview({
          environmentId: missingEnvironmentId,
          databaseName: "nodb",
          dataviewName: "noview",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider(
  "getKxUser on a nonexistent environment fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        finspace.getKxUser({
          environmentId: missingEnvironmentId,
          userName: "nouser",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);
