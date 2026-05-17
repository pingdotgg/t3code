import { describe, expect, it } from "vite-plus/test";
import * as EffectAcpErrors from "effect-acp/errors";
import { ProviderDriverKind } from "@t3tools/contracts";

import {
  acpPermissionOutcome,
  mapAcpToAdapterError,
  resolveAcpPermissionOutcome,
} from "./AcpAdapterSupport.ts";

describe("AcpAdapterSupport", () => {
  it("maps ACP approval decisions to permission outcomes", () => {
    expect(acpPermissionOutcome("accept")).toBe("allow-once");
    expect(acpPermissionOutcome("acceptForSession")).toBe("allow-always");
    expect(acpPermissionOutcome("decline")).toBe("reject-once");
  });

  it("resolves approval decisions to the agent's advertised option ids", () => {
    // Agents define their own optionId strings — the client must echo one
    // back, matched by the standard `kind`, not a hardcoded value.
    const options = [
      { optionId: "proceed_always", name: "Allow for this session", kind: "allow_always" },
      { optionId: "proceed_once", name: "Allow", kind: "allow_once" },
      { optionId: "cancel", name: "Reject", kind: "reject_once" },
    ] as const;

    expect(resolveAcpPermissionOutcome("accept", options)).toEqual({
      outcome: "selected",
      optionId: "proceed_once",
    });
    expect(resolveAcpPermissionOutcome("acceptForSession", options)).toEqual({
      outcome: "selected",
      optionId: "proceed_always",
    });
    expect(resolveAcpPermissionOutcome("decline", options)).toEqual({
      outcome: "selected",
      optionId: "cancel",
    });
  });

  it("falls back to cancelled when the agent advertises no matching option", () => {
    expect(resolveAcpPermissionOutcome("accept", [])).toEqual({ outcome: "cancelled" });
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

  it("does not expose transport cause text in the adapter message", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("cursor"),
      "thread-1" as never,
      "session/prompt",
      new EffectAcpErrors.AcpTransportError({
        operation: "call-rpc",
        method: "session/prompt",
        cause: new Error("authorization=secret-token"),
      }),
    );

    expect(error.message).toBe(
      "Provider adapter request failed (cursor) for session/prompt: ACP transport operation 'call-rpc' failed.",
    );
    expect(error.message).not.toContain("secret-token");
  });
});
