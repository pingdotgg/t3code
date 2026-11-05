import { MANAGED_POLICY_SCHEMA_URL } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { buildManagedPolicyJsonSchema } from "./managedPolicySchema.ts";

it("describes the policy file as strictly as T3 Code reads it", () => {
  const schema = buildManagedPolicyJsonSchema();

  expect(schema.$id).toBe(MANAGED_POLICY_SCHEMA_URL);
  expect(schema.required).toEqual(["schemaVersion", "organization"]);
  expect(schema.additionalProperties).toBe(false);
  expect(schema.properties).toHaveProperty("$schema");
});
