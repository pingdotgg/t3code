import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { expect } from "@alchemy.run/test";
import * as organizations from "@distilled.cloud/aws/organizations";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as OrganizationLease from "./OrganizationLease.ts";

// Exclusive: the local lifecycle creates and deletes the account's single
// organization, so no other organization suite may hold it meanwhile.
const { test } = OrganizationLease.make({ providers: AWS.providers() }, "exclusive");

// Account singleton: an AWS Organization has no list API. `list()` calls
// `describeOrganization` and returns the single org as a one-element array, or
// `[]` when the account isn't a management account (the typed
// `AWSOrganizationsNotInUseException` is caught to `[]`). This runs read-only —
// it neither creates nor deletes an organization.
test.provider(
  "list returns the organization singleton",
  (stack) =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(AWS.Organizations.Organization);
      const all = yield* provider.list();

      // 0 (account is not a management account) or 1 (it is) — never more.
      expect(all.length).toBeLessThanOrEqual(1);

      // When the account is an organization management account, the single
      // entry carries a well-typed Attributes shape.
      if (all.length === 1) {
        const org = all[0];
        expect(typeof org.organizationId).toBe("string");
        expect(org.organizationId.length).toBeGreaterThan(0);
        expect(typeof org.organizationArn).toBe("string");
        expect(org.organizationArn.startsWith("arn:aws:organizations::")).toBe(true);
        expect(Array.isArray(org.availablePolicyTypes)).toBe(true);
        if (org.managementAccountEmail != null) {
          expect(typeof org.managementAccountEmail).toBe("string");
          expect(org.managementAccountEmail.length).toBeGreaterThan(0);
        }
      }

      yield* stack.destroy();
    }),
  { tags: ["provider:aws", "provider:aws:organizations", "live"] },
);

// Creating and deleting an organization is safe only in the local emulator.
test.provider.skipIf(process.env.ALCHEMY_TEST_DEV !== "1")(
  "local organization resources create, update, and clean up",
  (stack) =>
    Effect.gen(function* () {
      const environment = yield* AWSEnvironment.current;
      expect(environment.endpoint).toBe("http://localhost:4566");
      expect(environment.accountId).toBe("000000000000");
      yield* stack.destroy();

      const organization = () =>
        AWS.Organizations.Organization("Organization", { featureSet: "ALL" });
      const created = yield* stack.deploy(organization());
      expect(created.managementAccountId).toBe("000000000000");

      const member = yield* organizations.createAccount({
        AccountName: "floci-local-member",
        Email: "floci-local-member@example.com",
      });
      const accountId = member.CreateAccountStatus?.AccountId;
      expect(accountId).toBeDefined();

      const resources = (phase: string) =>
        Effect.gen(function* () {
          yield* organization();
          const root = yield* AWS.Organizations.Root("Root", { tags: { phase } });
          const unit = yield* AWS.Organizations.OrganizationalUnit("Unit", {
            parentId: root.rootId,
            tags: { phase },
          });
          const enabled = yield* AWS.Organizations.RootPolicyType("PolicyType", {
            rootId: root.rootId,
            policyType: "TAG_POLICY",
          });
          const policy = yield* AWS.Organizations.Policy("Policy", {
            type: enabled.policyType,
            description: phase,
            document: JSON.stringify({ tags: {} }),
            tags: { phase },
          });
          yield* AWS.Organizations.PolicyAttachment("Attachment", {
            policyId: policy.policyId,
            targetId: unit.ouId,
          });
          const trusted = yield* AWS.Organizations.TrustedServiceAccess("Trusted", {
            servicePrincipal: "cloudtrail.amazonaws.com",
          });
          yield* AWS.Organizations.DelegatedAdministrator("Administrator", {
            accountId: accountId!,
            servicePrincipal: trusted.servicePrincipal,
          });
          const resourcePolicy = yield* AWS.Organizations.OrganizationResourcePolicy(
            "ResourcePolicy",
            {
              document: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Principal: { AWS: accountId! },
                    Action: [
                      phase === "created"
                        ? "organizations:DescribeOrganization"
                        : "organizations:ListAccounts",
                    ],
                    Resource: "*",
                  },
                ],
              },
            },
          );
          return { root, unit, policy, resourcePolicy };
        });

      yield* Effect.gen(function* () {
        const first = yield* stack.deploy(resources("created"));
        const updated = yield* stack.deploy(resources("updated"));
        expect(updated.unit.ouId).toBe(first.unit.ouId);
        expect(updated.policy.policyId).toBe(first.policy.policyId);
        const tags = yield* organizations.listTagsForResource({ ResourceId: updated.unit.ouId });
        expect(tags.Tags).toContainEqual({ Key: "phase", Value: "updated" });
        const policy = yield* organizations.describePolicy({ PolicyId: updated.policy.policyId });
        expect(policy.Policy?.PolicySummary?.Description).toBe("updated");
        const attachment = yield* organizations.listTargetsForPolicy({
          PolicyId: updated.policy.policyId,
        });
        expect(attachment.Targets?.map((target) => target.TargetId)).toContain(updated.unit.ouId);
        const administrators = yield* organizations.listDelegatedAdministrators({
          ServicePrincipal: "cloudtrail.amazonaws.com",
        });
        expect(administrators.DelegatedAdministrators?.map((admin) => admin.Id)).toContain(
          accountId,
        );
        const observed = yield* organizations.describeResourcePolicy({});
        expect(JSON.parse(observed.ResourcePolicy!.Content!)).toEqual(
          updated.resourcePolicy.document,
        );
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            // Remove dependent resources before the member and organization.
            yield* stack.deploy(organization());
            yield* organizations.removeAccountFromOrganization({ AccountId: accountId! });
            yield* stack.destroy();
          }).pipe(Effect.orDie),
        ),
      );
      const removed = yield* organizations.describeOrganization({}).pipe(
        Effect.map(() => false),
        Effect.catchTag("AWSOrganizationsNotInUseException", () => Effect.succeed(true)),
      );
      expect(removed).toBe(true);
    }),
  { timeout: 120_000, tags: ["provider:aws", "provider:aws:organizations", "local"] },
);
