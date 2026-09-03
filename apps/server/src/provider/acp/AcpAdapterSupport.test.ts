import { describe, expect, it } from "vite-plus/test";
import * as EffectAcpErrors from "effect-acp/errors";
import { ProviderDriverKind } from "@t3tools/contracts";

import {
  ACP_AUTH_REQUIRED_DETAIL,
  acpPermissionOutcome,
  isAcpAuthRequiredError,
  mapAcpToAdapterError,
  selectAcpPermissionOptionId,
} from "./AcpAdapterSupport.ts";

describe("AcpAdapterSupport", () => {
  it("maps ACP approval decisions to permission outcomes", () => {
    expect(acpPermissionOutcome("accept")).toBe("allow-once");
    expect(acpPermissionOutcome("acceptForSession")).toBe("allow-always");
    expect(acpPermissionOutcome("decline")).toBe("reject-once");
  });

  it("selects the offered rejection option when an agent only advertises reject_always", () => {
    const optionId = selectAcpPermissionOptionId(
      {
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "never", name: "Never", kind: "reject_always" },
        ],
      },
      "decline",
    );

    expect(optionId).toBe("never");
  });

  it("prefers reject_once over reject_always for a decline", () => {
    const optionId = selectAcpPermissionOptionId(
      {
        options: [
          { optionId: "never", name: "Never", kind: "reject_always" },
          { optionId: "once", name: "Not now", kind: "reject_once" },
        ],
      },
      "decline",
    );

    expect(optionId).toBe("once");
  });

  it("recognizes the ACP auth_required error code", () => {
    expect(isAcpAuthRequiredError(EffectAcpErrors.AcpRequestError.authRequired())).toBe(true);
    expect(isAcpAuthRequiredError(EffectAcpErrors.AcpRequestError.invalidParams())).toBe(false);
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

  it("directs generic ACP authentication back to the configured CLI", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("acp"),
      "thread-auth" as never,
      "session/new",
      EffectAcpErrors.AcpRequestError.authRequired("Run `copilot login` first"),
    );
    expect(error.message).toContain(ACP_AUTH_REQUIRED_DETAIL);
    expect(error.message).not.toContain("copilot login");
    expect(error.cause).toMatchObject({ code: -32000 });
  });

  it("keeps the wire message for auth errors from the Cursor adapter", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("cursor"),
      "thread-cursor-auth" as never,
      "session/new",
      EffectAcpErrors.AcpRequestError.authRequired("Please log in"),
    );
    expect(error.message).toContain("Please log in");
    expect(error.message).not.toContain("outside T3 Code");
  });
});
