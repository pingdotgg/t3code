import { assert, it } from "@effect/vitest";

import {
  findForbiddenAuthorityDirectives,
  validateAuldricFeatureDocs,
} from "./complete-feature-docs.ts";

it("accepts the registered Marketing-domain documentation spine", () => {
  assert.deepStrictEqual(validateAuldricFeatureDocs(), []);
});

it("detects directives that restore legacy runtime authority", () => {
  assert.deepStrictEqual(
    findForbiddenAuthorityDirectives(
      "Auldric will launch as a controlled hard fork. Auldric owns the launch runtime.",
    ),
    ["Auldric runtime ownership", "hard-fork launch directive"],
  );
});

it("allows the current T3-authoritative contract", () => {
  assert.deepStrictEqual(
    findForbiddenAuthorityDirectives(
      "T3 owns Dev. Auldric Marketing loads only after explicit domain selection.",
    ),
    [],
  );
});
