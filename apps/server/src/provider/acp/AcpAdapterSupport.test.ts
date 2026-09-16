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

  it("maps ACP transport errors and preserves detail", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("antigravity"),
      "thread-1" as never,
      "session/cancel",
      new EffectAcpErrors.AcpTransportError({
        operation: "call-rpc",
        method: "session/cancel",
        detail: "The ACP agent did not finish cancellation. Its process was stopped.",
        cause: undefined,
      }),
    );

    expect(error._tag).toBe("ProviderAdapterRequestError");
    if (error._tag === "ProviderAdapterRequestError") {
      expect(error.detail).toBe(
        "ACP transport operation call-rpc failed for method session/cancel. The ACP agent did not finish cancellation. Its process was stopped.",
      );
    }
  });
});
