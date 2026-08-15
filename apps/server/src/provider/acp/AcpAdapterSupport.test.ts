import { describe, expect, it } from "vite-plus/test";
import * as EffectAcpErrors from "effect-acp/errors";
import { ProviderDriverKind } from "@t3tools/contracts";

import { acpPermissionOutcome, mapAcpToAdapterError } from "./AcpAdapterSupport.ts";

describe("AcpAdapterSupport", () => {
  it("maps ACP approval decisions to permission outcomes", () => {
    const options = [
      { optionId: "once", name: "Allow once", kind: "allow_once" as const },
      { optionId: "always", name: "Always allow", kind: "allow_always" as const },
      { optionId: "no", name: "Reject", kind: "reject_once" as const },
    ];
    expect(acpPermissionOutcome("accept", options)).toBe("once");
    expect(acpPermissionOutcome("acceptForSession", options)).toBe("always");
    expect(acpPermissionOutcome("decline", options)).toBe("no");
  });

  it("falls back to reject_always when reject_once is unavailable", () => {
    const options = [
      { optionId: "always-reject", name: "Always reject", kind: "reject_always" as const },
    ];
    expect(acpPermissionOutcome("decline", options)).toBe("always-reject");
  });

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
});
