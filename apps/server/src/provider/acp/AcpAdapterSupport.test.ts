import { describe, expect, it } from "vite-plus/test";
import * as EffectAcpErrors from "effect-acp/errors";
import { ProviderDriverKind } from "@t3tools/contracts";

import {
  ANTIGRAVITY_STREAM_DISCONNECTED_MESSAGE,
  acpPermissionOutcome,
  mapAcpToAdapterError,
} from "./AcpAdapterSupport.ts";

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

  it("maps clean websocket 1000 close in AcpRequestError to provider adapter session closed error", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("antigravity"),
      "thread-1" as never,
      "session/prompt",
      new EffectAcpErrors.AcpRequestError({
        code: -32603,
        errorMessage: "received 1000 (OK); then sent 1000 (OK)",
      }),
    );

    expect(error._tag).toBe("ProviderAdapterSessionClosedError");
  });

  it("maps clean websocket 1000 close in AcpTransportError to provider adapter session closed error", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("antigravity"),
      "thread-1" as never,
      "session/start",
      new EffectAcpErrors.AcpTransportError({
        detail: "Failed to rebuild agent: received 1000 (OK); then sent 1000 (OK)",
        cause: undefined,
      }),
    );

    expect(error._tag).toBe("ProviderAdapterSessionClosedError");
  });

  it("sanitizes antigravity stream drop eof error into user-friendly message", () => {
    const rawDropError = new EffectAcpErrors.AcpRequestError({
      code: -32603,
      errorMessage:
        'model unreachable: doRequest: error sending request: Post "http://127.0.0.1:54321/v1beta1/projects/my-project/locations/us/publishers/google/models/gemini-3.8-flash-high:streamGenerateContent?alt=sse": EOF: doRequest: error sending request: Post "http://127.0.0.1:54321/v1beta1/projects/my-project/locations/us/publishers/google/models/gemini-3.8-flash-high:streamGenerateContent?alt=sse": EOF',
    });

    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("antigravity"),
      "thread-1" as never,
      "session/prompt",
      rawDropError,
    );

    expect(error._tag).toBe("ProviderAdapterRequestError");
    if (error._tag === "ProviderAdapterRequestError") {
      expect(error.detail).toBe(ANTIGRAVITY_STREAM_DISCONNECTED_MESSAGE);
    }
  });
});
