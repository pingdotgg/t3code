import * as AWS from "@alchemy.run/aws";
import { OrganizationResourcePolicy } from "@alchemy.run/aws/Organizations";
import { expect } from "@alchemy.run/test";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as OrganizationLease from "./OrganizationLease.ts";

const { test } = OrganizationLease.make({ providers: AWS.providers() }, "shared");

// The org resource policy is a singleton with no list API. `list()` describes
// the single resource policy and returns a one-element array if present, else
// []. This runs read-only: a missing policy or a non-org account both yield []
// via the typed ResourcePolicyNotFoundException / AWSOrganizationsNotInUseException
// catches, so the assertion holds without deploying anything.
test.provider(
  "list enumerates the organization resource policy",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(OrganizationResourcePolicy);
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      expect(all.length).toBeLessThanOrEqual(1);

      for (const policy of all) {
        expect(typeof policy.resourcePolicyId).toBe("string");
        expect(typeof policy.resourcePolicyArn).toBe("string");
        expect(policy.document).toBeDefined();
      }
    }),
  { tags: ["provider:aws", "provider:aws:organizations", "live"] },
);
