import { describe, expect, it } from "vite-plus/test";
import * as EffectAcpErrors from "effect-acp/errors";
import { ProviderDriverKind } from "@t3tools/contracts";

import { acpPermissionOutcome, mapAcpToAdapterError } from "./AcpAdapterSupport.ts";

describe("AcpAdapterSupport", () => {
  it("maps ACP approval decisions to permission outcomes", () => {
    expect(acpPermissionOutcome("accept")).toBe("allow-once");
    expect(acpPermissionOutcome("acceptForSession")).toBe("allow-always");
    expect(acpPermissionOutcome("decline")).toBe("reject-once");
  });

  it("maps ACP request errors to provider adapter request errors", () => {
    const cause = new EffectAcpErrors.AcpRequestError({
      code: -32602,
      errorMessage: "Invalid params",
    });
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("cursor"),
      "thread-1" as never,
      "session/prompt",
      cause,
    );

    expect(error._tag).toBe("ProviderAdapterRequestError");
    expect(error.message).toBe("Provider adapter request failed (cursor) for session/prompt.");
    if (error._tag === "ProviderAdapterRequestError") {
      expect(error.detail).toBe("ACP request failed.");
      expect(error.cause).toBe(cause);
    }
  });
});
