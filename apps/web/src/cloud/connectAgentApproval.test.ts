import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  approveAgentUrl,
  approvedReturnUrl,
  pendingValue,
  readApproveAgentRequest,
  readConnectApprovalReturn,
} from "./connectAgentApproval";

const SIGN_IN = "https://prod-abc.t3coderelay.com/connect-agent?client_id=c&state=s";
const NONCE = "abcdefghijklmnopqrstuvwx";
const approveAt = (overrides: Record<string, string>) => {
  const url = new URL(
    approveAgentUrl("https://app.t3.codes", {
      environmentId: EnvironmentId.make("env-1"),
      access: "auto",
      nonce: NONCE,
      returnTo: SIGN_IN,
    }),
  );
  for (const [name, value] of Object.entries(overrides)) url.searchParams.set(name, value);
  return url;
};

describe("readApproveAgentRequest", () => {
  it("returns a code only to an https /connect-agent page with a well-formed request", () => {
    const request = readApproveAgentRequest(approveAt({}));
    expect(request).not.toBeNull();
    expect(approvedReturnUrl(request!, "T3-AUTO-CODE")).toBe(
      `${SIGN_IN}#t3-connect-code=T3-AUTO-CODE&t3-connect-nonce=${NONCE}`,
    );

    for (const overrides of [
      { return_to: "http://prod-abc.t3coderelay.com/connect-agent?state=s" },
      { return_to: "https://prod-abc.t3coderelay.com/somewhere-else" },
      { return_to: "https://user:pass@prod-abc.t3coderelay.com/connect-agent" },
      { return_to: "not a url" },
      { access: "everything" },
      { nonce: "short" },
      { environment: "" },
    ]) {
      expect(readApproveAgentRequest(approveAt(overrides)), JSON.stringify(overrides)).toBeNull();
    }
  });
});

describe("readConnectApprovalReturn", () => {
  const code = "AUTO-Q8RZ3NWD5KTC";
  const hash = `#t3-connect-code=${code}&t3-connect-nonce=${NONCE}`;
  const search = "?client_id=c&state=s";

  it("uses a code only in the tab that started this request at its level", () => {
    expect(readConnectApprovalReturn(hash, search, pendingValue(NONCE, "auto", search))).toEqual({
      status: "approved",
      code,
    });
    for (const pending of [
      null,
      pendingValue("another-nonce-value-xyz", "auto", search),
      pendingValue(NONCE, "auto", "?state=other"),
      pendingValue(NONCE, "read-only", search),
    ]) {
      expect(readConnectApprovalReturn(hash, search, pending)).toEqual({ status: "discarded" });
    }
    expect(readConnectApprovalReturn("", search, pendingValue(NONCE, "auto", search))).toEqual({
      status: "none",
    });
  });
});
