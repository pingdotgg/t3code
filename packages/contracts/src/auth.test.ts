import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { AuthEnvironmentScopes, AuthGrantScopes, AuthStandardClientScopes } from "./auth.ts";

describe("authorization grants", () => {
  it("decodes legacy review credentials without offering them in new grants", () => {
    expect(Schema.decodeUnknownSync(AuthEnvironmentScopes)(["review:write"])).toEqual([
      "review:write",
    ]);
    expect(() => Schema.decodeUnknownSync(AuthGrantScopes)(["review:write"])).toThrow();
    expect(AuthStandardClientScopes).not.toContain("review:write");
  });
});
