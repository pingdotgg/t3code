import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { GrokCredentials } from "./usageLimits.ts";

const accountKey = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(GrokCredentials));

describe("GrokCredentials", () => {
  it("accepts a Grok CLI auth file when email is null", () => {
    const credentials = decode(
      JSON.stringify({
        [accountKey]: {
          key: "oidc-token",
          auth_mode: "oidc",
          email: null,
          coding_data_retention_opt_out: true,
          user_id: "user-1",
        },
      }),
    );

    expect(credentials[accountKey]).toEqual({
      key: "oidc-token",
      auth_mode: "oidc",
      email: null,
    });
  });

  it("accepts a string email and a missing email", () => {
    const withEmail = decode(
      JSON.stringify({
        [accountKey]: {
          key: "oidc-token",
          auth_mode: "oidc",
          email: "user@example.com",
        },
      }),
    );
    expect(withEmail[accountKey]?.email).toBe("user@example.com");

    const withoutEmail = decode(
      JSON.stringify({
        [accountKey]: {
          key: "oidc-token",
          auth_mode: "oidc",
        },
      }),
    );
    expect(withoutEmail[accountKey]).toEqual({
      key: "oidc-token",
      auth_mode: "oidc",
    });
  });
});
