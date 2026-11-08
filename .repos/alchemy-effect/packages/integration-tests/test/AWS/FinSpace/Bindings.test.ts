import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as finspace from "@distilled.cloud/aws/finspace";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Amazon FinSpace reached end of support on 2026-10-07
// (https://docs.aws.amazon.com/finspace/latest/userguide/amazon-finspace-end-of-support.html).
// The control-plane hostname finspace.<region>.amazonaws.com no longer has
// A records in any region, so every control-plane call fails before reaching
// AWS with:
//   HttpClientError: Transport error (GET https://finspace.us-west-2.amazonaws.com/kx/environments)
//   (cause: getaddrinfo ENOTFOUND finspace.us-west-2.amazonaws.com)
// A transport failure can't be patched into a typed tag, so all control-plane
// tests are gated behind AWS_TEST_FINSPACE=1 for accounts that still have access.
const finspaceRetired = !process.env.AWS_TEST_FINSPACE;

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

test.provider.skipIf(finspaceRetired)(
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
  { tags: ["provider:aws", "provider:aws:finspace", "live"] },
);

test.provider.skipIf(finspaceRetired)(
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
  { tags: ["provider:aws", "provider:aws:finspace", "live"] },
);

test.provider.skipIf(finspaceRetired)(
  "listKxChangesets on a nonexistent environment fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        finspace.listKxChangesets({ environmentId: missingEnvironmentId, databaseName: "nodb" }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
  { tags: ["provider:aws", "provider:aws:finspace", "live"] },
);

test.provider.skipIf(finspaceRetired)(
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
  { tags: ["provider:aws", "provider:aws:finspace", "live"] },
);

test.provider.skipIf(finspaceRetired)(
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
  { tags: ["provider:aws", "provider:aws:finspace", "live"] },
);

test.provider.skipIf(finspaceRetired)(
  "getKxUser on a nonexistent environment fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        finspace.getKxUser({ environmentId: missingEnvironmentId, userName: "nouser" }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
  { tags: ["provider:aws", "provider:aws:finspace", "live"] },
);
