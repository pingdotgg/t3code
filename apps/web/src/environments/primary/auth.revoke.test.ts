import { AuthSessionId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { __setPrimaryHttpRunnerForTests } from "../../lib/runtime";
import { revokeServerClientSession, revokeServerPairingLink } from "./auth";

afterEach(() => {
  __setPrimaryHttpRunnerForTests();
});

describe("revokeServerClientSession", () => {
  it("resolves when the server reports the session was revoked", async () => {
    __setPrimaryHttpRunnerForTests(async () => ({ revoked: true }));
    await expect(
      revokeServerClientSession(AuthSessionId.make("session-1")),
    ).resolves.toBeUndefined();
  });

  it("fails when the server returns a successful no-op", async () => {
    __setPrimaryHttpRunnerForTests(async () => ({ revoked: false }));
    await expect(revokeServerClientSession(AuthSessionId.make("session-1"))).rejects.toThrow(
      "That client session is no longer active.",
    );
  });
});

describe("revokeServerPairingLink", () => {
  it("resolves when the server reports the link was revoked", async () => {
    __setPrimaryHttpRunnerForTests(async () => ({ revoked: true }));
    await expect(revokeServerPairingLink("pairing-1")).resolves.toBeUndefined();
  });

  it("fails when the server returns a successful no-op", async () => {
    __setPrimaryHttpRunnerForTests(async () => ({ revoked: false }));
    await expect(revokeServerPairingLink("pairing-1")).rejects.toThrow(
      "That pairing link is no longer active.",
    );
  });
});
