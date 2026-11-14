import { MANAGED_POLICY_SCHEMA_URL, ManagedUpdatesPolicy } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import { buildManagedPolicyJsonSchema } from "./managedPolicySchema.ts";

const isUpdatesPolicy = Schema.is(ManagedUpdatesPolicy);

it("describes the policy file as strictly as T3 Code reads it", () => {
  const schema = buildManagedPolicyJsonSchema();

  expect(schema.$id).toBe(MANAGED_POLICY_SCHEMA_URL);
  expect(schema.required).toEqual(["schemaVersion", "organization"]);
  expect(schema.additionalProperties).toBe(false);
  expect(schema.properties).toHaveProperty("$schema");
  expect(schema).toMatchObject({
    properties: {
      limits: {
        properties: {
          updates: {
            additionalProperties: false,
            properties: { feedUrl: { pattern: "^\\s*[Hh][Tt][Tt][Pp][Ss]://[^\\s/]+" } },
          },
        },
      },
    },
  });
});

it("keeps the https check on decoded policies", () => {
  expect(isUpdatesPolicy({ mode: "auto", feedUrl: "http://example.com" })).toBe(false);
});
