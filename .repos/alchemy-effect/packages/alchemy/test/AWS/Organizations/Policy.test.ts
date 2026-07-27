import * as AWS from "@/AWS";
import {
  normalizePolicyDocument,
  type ServiceControlPolicyDocument,
} from "@/AWS/IAM/Policy.ts";
import { Policy } from "@/AWS/Organizations";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as organizations from "@distilled.cloud/aws/organizations";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// `listPolicies` requires a `Filter` (policy type), so `list()` fans out across
// every policy-type filter and hydrates each policy via `describePolicy` into the
// exact `read` shape. This runs read-only: when the account is an org management
// account, AWS-managed SCPs like `FullAWSAccess` appear; otherwise `list()`
// degrades to `[]` via the typed `AWSOrganizationsNotInUseException` /
// `AccessDeniedException` catches, so the assertions hold without deploying.
test.provider("list enumerates organization policies", (stack) =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(Policy);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);

    for (const policy of all) {
      expect(typeof policy.policyId).toBe("string");
      expect(policy.policyId.length).toBeGreaterThan(0);
      expect(typeof policy.policyArn).toBe("string");
      expect(policy.policyArn.startsWith("arn:aws")).toBe(true);
      expect(typeof policy.name).toBe("string");
      expect(policy.document).toBeDefined();
      expect(policy.tags).toBeDefined();
    }

    yield* stack.destroy();
  }),
);

// PolicyDocument adoption: a typed `ServiceControlPolicyDocument` deploys, the
// stored SCP content round-trips (normalized comparison), and re-deploying the
// identical document is clean — reconcile diffs
// `normalizePolicyDocument(observed)` against
// `normalizePolicyDocument(desired)` and skips `updatePolicy` on equivalence.
//
// `createPolicy`/`deletePolicy` require an org MANAGEMENT account, so gate
// behind the same env var the other Organizations lifecycle tests use.
test.provider.skipIf(!process.env.AWS_ORG_MANAGEMENT_ACCOUNT)(
  "typed SCP document deploys and re-deploys clean",
  (stack) =>
    Effect.gen(function* () {
      const policyName = "alchemy-test-org-policy-typed-scp";

      // A prior interrupted run may have left an (untagged, hence unowned)
      // SCP with our deterministic name behind — the adoption probe would
      // then fail the create with `OwnedBySomeoneElse`. Clean it up
      // out-of-band before deploying.
      const leftovers = yield* organizations
        .listPolicies({ Filter: "SERVICE_CONTROL_POLICY" })
        .pipe(Effect.map((page) => page.Policies ?? []));
      for (const leftover of leftovers) {
        if (leftover.Name !== policyName || leftover.Id == null) continue;
        yield* organizations
          .deletePolicy({ PolicyId: leftover.Id })
          .pipe(Effect.catchTag("PolicyNotFoundException", () => Effect.void));
      }

      // Key order is deliberately non-alphabetical so the no-op re-deploy
      // exercises the canonicalizing comparison, not string equality.
      const document: ServiceControlPolicyDocument = {
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "AllowAll",
            Effect: "Allow",
            Resource: "*",
            Action: ["*"],
          },
        ],
      };

      const deployPolicy = stack.deploy(
        Effect.gen(function* () {
          return yield* Policy("TypedScp", {
            name: policyName,
            type: "SERVICE_CONTROL_POLICY",
            document,
          });
        }),
      );

      const created = yield* deployPolicy;
      expect(created.policyId).toBeTruthy();
      expect(created.type).toBe("SERVICE_CONTROL_POLICY");
      // The typed attribute round-trips the typed document.
      expect(normalizePolicyDocument(created.document)).toBe(
        normalizePolicyDocument(document),
      );

      // Out-of-band verification via distilled: the stored content is
      // equivalent to the typed document.
      const described = yield* organizations.describePolicy({
        PolicyId: created.policyId,
      });
      expect(described.Policy?.Content).toBeTruthy();
      expect(normalizePolicyDocument(described.Policy?.Content ?? "")).toBe(
        normalizePolicyDocument(document),
      );

      // Re-deploy the identical typed document — must be a clean no-op:
      // same physical policy, equivalent content.
      const redeployed = yield* deployPolicy;
      expect(redeployed.policyId).toBe(created.policyId);
      expect(redeployed.policyArn).toBe(created.policyArn);
      expect(normalizePolicyDocument(redeployed.document)).toBe(
        normalizePolicyDocument(document),
      );

      yield* stack.destroy();

      // Typed wait-until-gone: the policy is deleted after destroy.
      const gone = yield* organizations
        .describePolicy({ PolicyId: created.policyId })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag("PolicyNotFoundException", () =>
            Effect.succeed(true),
          ),
        );
      expect(gone).toBe(true);
    }),
  { timeout: 240_000 },
);
