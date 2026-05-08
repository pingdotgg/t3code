import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  formatIssuedPairingCredential,
  formatIssuedSession,
  formatPairingCredentialList,
  formatSessionList,
} from "./cliAuthFormat.ts";

it("formats issued pairing credentials with the secret and optional pair URL", () => {
  const output = formatIssuedPairingCredential(
    {
      id: "pairing-1",
      credential: "secret-pairing-token",
      role: "client",
      subject: "one-time-token",
      createdAt: DateTime.makeUnsafe("2026-04-08T09:00:00.000Z"),
      expiresAt: DateTime.makeUnsafe("2026-04-08T10:00:00.000Z"),
    },
    { baseUrl: "https://example.com", json: false },
  );

  expect(output).toContain("secret-pairing-token");
  expect(output).toContain("https://example.com/pair#token=secret-pairing-token");
});

it("formats pairing listings without exposing the secret token", () => {
  const output = formatPairingCredentialList(
    [
      {
        id: "pairing-1",
        credential: "secret-pairing-token",
        subject: "one-time-token",
        label: "Phone",
        role: "client",
        createdAt: DateTime.makeUnsafe("2026-04-08T09:00:00.000Z"),
        expiresAt: DateTime.makeUnsafe("2026-04-08T10:00:00.000Z"),
      },
    ],
    { json: false },
  );

  expect(output).toContain("pairing-1");
  expect(output).not.toContain("secret-pairing-token");
});

it("formats issued sessions with the bearer token but omits tokens from listings", () => {
  const issuedOutput = formatIssuedSession(
    {
      sessionId: "session-1" as never,
      token: "secret-session-token",
      method: "bearer-session-token",
      role: "owner",
      subject: "cli-issued-session",
      client: {
        label: "deploy-bot",
        deviceType: "bot",
      },
      expiresAt: DateTime.makeUnsafe("2026-04-08T10:00:00.000Z"),
    },
    { json: false },
  );

  const listedOutput = formatSessionList(
    [
      {
        sessionId: "session-1" as never,
        method: "bearer-session-token",
        role: "owner",
        subject: "cli-issued-session",
        client: {
          label: "deploy-bot",
          deviceType: "bot",
        },
        connected: false,
        current: false,
        issuedAt: DateTime.makeUnsafe("2026-04-08T09:00:00.000Z"),
        expiresAt: DateTime.makeUnsafe("2026-04-08T10:00:00.000Z"),
        lastConnectedAt: null,
      },
    ],
    { json: false },
  );

  expect(issuedOutput).toContain("secret-session-token");
  expect(listedOutput).not.toContain("secret-session-token");
});
