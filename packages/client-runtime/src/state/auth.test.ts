import { AuthSessionId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { applyAuthAccessStreamEvent, EMPTY_AUTH_ACCESS_SNAPSHOT } from "./auth.ts";

describe("applyAuthAccessStreamEvent", () => {
  it("accumulates rapid pairing-link and client updates into one snapshot", () => {
    const pairingLink = {
      id: "pairing-link",
      credential: "credential",
      scopes: ["orchestration:read"],
      subject: "subject",
      label: "Phone",
      createdAt: DateTime.makeUnsafe("2036-04-07T00:00:00.000Z"),
      expiresAt: DateTime.makeUnsafe("2036-04-07T00:05:00.000Z"),
    } as const;
    const clientSession = {
      sessionId: AuthSessionId.make("session-client"),
      subject: "subject",
      scopes: ["orchestration:read"],
      method: "browser-session-cookie",
      client: {
        label: "Phone",
        deviceType: "mobile",
      },
      issuedAt: DateTime.makeUnsafe("2036-04-07T00:00:00.000Z"),
      expiresAt: DateTime.makeUnsafe("2036-05-07T00:00:00.000Z"),
      lastConnectedAt: null,
      connected: true,
      current: false,
    } as const;

    const withPairingLink = applyAuthAccessStreamEvent(EMPTY_AUTH_ACCESS_SNAPSHOT, {
      version: 1,
      revision: 1,
      type: "pairingLinkUpserted",
      payload: pairingLink,
    });
    const withClient = applyAuthAccessStreamEvent(withPairingLink, {
      version: 1,
      revision: 2,
      type: "clientUpserted",
      payload: clientSession,
    });

    expect(withClient).toEqual({
      connectSecurityMode: "account",
      connectClients: [],
      pairingLinks: [pairingLink],
      clientSessions: [clientSession],
    });
  });

  it("applies removals without disturbing unrelated access state", () => {
    const snapshot = applyAuthAccessStreamEvent(
      {
        connectSecurityMode: "client-approval",
        connectClients: [],
        pairingLinks: [
          {
            id: "pairing-link",
            credential: "credential",
            scopes: ["orchestration:read"],
            subject: "subject",
            label: "Phone",
            createdAt: DateTime.makeUnsafe("2036-04-07T00:00:00.000Z"),
            expiresAt: DateTime.makeUnsafe("2036-04-07T00:05:00.000Z"),
          },
        ],
        clientSessions: [],
      },
      {
        version: 1,
        revision: 2,
        type: "pairingLinkRemoved",
        payload: { id: "pairing-link" },
      },
    );

    expect(snapshot).toEqual({
      ...EMPTY_AUTH_ACCESS_SNAPSHOT,
      connectSecurityMode: "client-approval",
    });
  });

  it("applies Connect security mode and client updates", () => {
    const connectClient = {
      clientProofKeyThumbprint: "thumbprint",
      cloudUserId: "user_123",
      status: "pending",
      client: {
        label: "Phone",
        deviceType: "mobile",
      },
      requestedAt: DateTime.makeUnsafe("2036-04-07T00:00:00.000Z"),
      updatedAt: DateTime.makeUnsafe("2036-04-07T00:00:00.000Z"),
      approvedAt: null,
      rejectedAt: null,
      lastSeenAt: null,
    } as const;

    const withMode = applyAuthAccessStreamEvent(EMPTY_AUTH_ACCESS_SNAPSHOT, {
      version: 1,
      revision: 1,
      type: "connectSecurityModeUpdated",
      payload: { mode: "client-approval" },
    });
    const withClient = applyAuthAccessStreamEvent(withMode, {
      version: 1,
      revision: 2,
      type: "connectClientUpserted",
      payload: connectClient,
    });
    const withoutClient = applyAuthAccessStreamEvent(withClient, {
      version: 1,
      revision: 3,
      type: "connectClientRemoved",
      payload: { clientProofKeyThumbprint: "thumbprint" },
    });

    expect(withClient.connectSecurityMode).toBe("client-approval");
    expect(withClient.connectClients).toEqual([connectClient]);
    expect(withoutClient).toEqual({
      ...EMPTY_AUTH_ACCESS_SNAPSHOT,
      connectSecurityMode: "client-approval",
    });
  });
});
