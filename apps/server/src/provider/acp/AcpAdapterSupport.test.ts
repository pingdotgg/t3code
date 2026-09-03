import { describe, expect, it } from "vite-plus/test";
import * as EffectAcpErrors from "effect-acp/errors";
import { ProviderDriverKind } from "@t3tools/contracts";

import { mapAcpToAdapterError } from "./AcpAdapterSupport.ts";

describe("AcpAdapterSupport", () => {
  it("maps ACP request errors to provider adapter request errors", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("cursor"),
      "thread-1" as never,
      "session/prompt",
      new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: "Invalid params",
      }),
    );

    expect(error._tag).toBe("ProviderAdapterRequestError");
    expect(error.message).toContain("Invalid params");
  });

  it("directs generic ACP authentication back to the configured CLI", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("acp"),
      "thread-auth" as never,
      "session/new",
      EffectAcpErrors.AcpRequestError.authRequired(),
    );
    expect(error.message).toContain("outside T3 Code");
  });
});
