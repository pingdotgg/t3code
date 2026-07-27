import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment";
import * as Test from "@/Test/Alchemy";
import * as opensearch from "@distilled.cloud/aws/opensearch";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: proves the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "describeDomain on a nonexistent domain fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        opensearch.describeDomain({
          DomainName: "alchemy-nonexistent-probe",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

// Deletion is verified as INITIATED (Deleted=true / Processing, irreversible)
// or fully gone. Full disappearance takes ~10-15 more minutes server-side;
// waiting for it would push the test into its timeout.
const assertDomainDeleting = (name: string) =>
  Effect.gen(function* () {
    const status = yield* opensearch.describeDomain({ DomainName: name }).pipe(
      Effect.map((response) =>
        response.DomainStatus.Deleted === true ||
        response.DomainStatus.Processing === true
          ? ("deleting" as const)
          : ("active" as const),
      ),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed("gone" as const),
      ),
    );
    if (status === "active") {
      return yield* Effect.fail(
        new Error(`domain '${name}' still exists and is not deleting`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("10 seconds"),
        Schedule.recurs(18),
      ]),
    }),
  );

// OpenSearch domains take ~15-25 minutes to provision and are billed per
// instance-hour while they exist. The full lifecycle is gated behind
// AWS_TEST_SLOW=1 and always destroys what it created.
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "create encrypted single-node domain, verify, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { accountId, region } = yield* AWSEnvironment.current;

      // A structured (typed) PolicyDocument — deliberately NOT a raw JSON
      // string — to prove PolicyDocument-valued access policies round-trip.
      const accessPolicies: AWS.IAM.PolicyDocument = {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { AWS: `arn:aws:iam::${accountId}:root` },
            Action: ["es:*"],
            Resource: `arn:aws:es:${region}:${accountId}:domain/*`,
          },
        ],
      };

      const program = Effect.gen(function* () {
        const domain = yield* AWS.OpenSearch.Domain("Search", {
          engineVersion: "OpenSearch_2.19",
          clusterConfig: {
            instanceType: "t3.small.search",
            instanceCount: 1,
          },
          ebsOptions: { volumeType: "gp3", volumeSize: 10 },
          encryptionAtRest: { enabled: true },
          nodeToNodeEncryption: true,
          domainEndpointOptions: {
            enforceHTTPS: true,
            tlsSecurityPolicy: "Policy-Min-TLS-1-2-2019-07",
          },
          accessPolicies,
          tags: { fixture: "opensearch-domain" },
        });
        return { domain };
      });

      const { domain } = yield* stack.deploy(program);

      expect(domain.domainName).toBeDefined();
      expect(domain.domainArn).toContain(":domain/");
      expect(domain.created).toBe(true);
      expect(domain.processing).toBe(false);
      expect(domain.endpoint).toBeDefined();
      expect(domain.engineVersion).toBe("OpenSearch_2.19");

      // Out-of-band verification via distilled.
      const described = yield* opensearch.describeDomain({
        DomainName: domain.domainName,
      });
      expect(described.DomainStatus.EncryptionAtRestOptions?.Enabled).toBe(
        true,
      );
      expect(described.DomainStatus.NodeToNodeEncryptionOptions?.Enabled).toBe(
        true,
      );
      expect(described.DomainStatus.ClusterConfig.InstanceType).toBe(
        "t3.small.search",
      );
      expect(described.DomainStatus.DomainEndpointOptions?.EnforceHTTPS).toBe(
        true,
      );
      expect(described.DomainStatus.AccessPolicies).toContain(accountId);
      // The PolicyDocument round-trips: what OpenSearch echoes back is
      // canonically equal to the structured document we deployed.
      expect(
        AWS.IAM.normalizePolicyDocument(
          described.DomainStatus.AccessPolicies ?? "",
        ),
      ).toBe(AWS.IAM.normalizePolicyDocument(accessPolicies));

      // Re-deploy the identical program — the normalized policy comparison
      // must see no drift, so no updateDomainConfig (blue/green change) may
      // fire. A config change would mint a new ChangeProgressDetails.ChangeId
      // and flip Processing.
      const changeIdBefore =
        described.DomainStatus.ChangeProgressDetails?.ChangeId;
      const { domain: redeployed } = yield* stack.deploy(program);
      expect(redeployed.domainArn).toBe(domain.domainArn);
      expect(redeployed.processing).toBe(false);
      const redescribed = yield* opensearch.describeDomain({
        DomainName: domain.domainName,
      });
      expect(redescribed.DomainStatus.Processing).not.toBe(true);
      expect(redescribed.DomainStatus.ChangeProgressDetails?.ChangeId).toBe(
        changeIdBefore,
      );

      // Destroy immediately — domains bill while they exist — and verify
      // deletion was initiated out-of-band.
      yield* stack.destroy();
      yield* assertDomainDeleting(domain.domainName);
    }),
  // create (~15-25 min) + delete initiation, one test.
  { timeout: 3_000_000 },
);
