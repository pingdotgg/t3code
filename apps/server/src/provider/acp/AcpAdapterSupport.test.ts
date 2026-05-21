import { describe, expect, it } from "vitest";
import * as EffectAcpErrors from "effect-acp/errors";
import { ProviderDriverKind } from "@t3tools/contracts";

import { acpPermissionOutcome, mapAcpToAdapterError } from "./AcpAdapterSupport.ts";

describe("AcpAdapterSupport", () => {
  it("maps ACP approval decisions to permission outcomes", () => {
    expect(acpPermissionOutcome("accept")).toBe("allow-once");
    expect(acpPermissionOutcome("acceptForSession")).toBe("allow-always");
    expect(acpPermissionOutcome("decline")).toBe("reject-once");
  });

  it("uses provider-supplied ACP permission option ids when available", () => {
    const options = [
      { optionId: "allow_once", name: "Yes", kind: "allow_once" },
      { optionId: "allow_always", name: "Always", kind: "allow_always" },
      { optionId: "reject_once", name: "No", kind: "reject_once" },
    ] as const;

    expect(acpPermissionOutcome("accept", options)).toBe("allow_once");
    expect(acpPermissionOutcome("acceptForSession", options)).toBe("allow_always");
    expect(acpPermissionOutcome("decline", options)).toBe("reject_once");
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

  it("surfaces ACP request error data when the provider reports a generic internal error", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("kiro"),
      "thread-1" as never,
      "session/prompt",
      new EffectAcpErrors.AcpRequestError({
        code: -32603,
        errorMessage: "Internal error",
        data: "Prompt already in progress",
      }),
    );

    expect(error._tag).toBe("ProviderAdapterRequestError");
    expect(error.message).toContain("Prompt already in progress");
    expect(error.message).not.toContain("Internal error");
  });
});
