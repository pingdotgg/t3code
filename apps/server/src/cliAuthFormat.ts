import type { AuthClientMetadata, AuthClientSession, AuthPairingLink } from "@t3tools/contracts";
import { DateTime } from "effect";

import type { IssuedBearerSession, IssuedPairingLink } from "./auth/Services/AuthControlPlane.ts";

const newline = "\n";

function serializeOptionalFields(values: ReadonlyArray<string | null | undefined>) {
  return values.filter((value): value is string => typeof value === "string" && value.length > 0);
}

function formatClientMetadata(metadata: AuthClientMetadata): string {
  const details = serializeOptionalFields([
    metadata.label,
    metadata.deviceType !== "unknown" ? metadata.deviceType : undefined,
    metadata.os,
    metadata.browser,
    metadata.ipAddress,
  ]);
  return details.length > 0 ? details.join(" | ") : "unlabeled client";
}

function toIsoString(value: DateTime.DateTime | DateTime.Utc): string {
  return DateTime.formatIso(DateTime.toUtc(value));
}

export function formatIssuedPairingCredential(
  credential: IssuedPairingLink,
  options?: {
    readonly json?: boolean;
    readonly baseUrl?: string;
  },
): string {
  const pairUrl =
    options?.baseUrl != null && options.baseUrl.length > 0
      ? (() => {
          const url = new URL("/pair", options.baseUrl);
          url.searchParams.delete("token");
          url.hash = new URLSearchParams([["token", credential.credential]]).toString();
          return url.toString();
        })()
      : undefined;

  if (options?.json) {
    return `${JSON.stringify(
      {
        id: credential.id,
        credential: credential.credential,
        ...(credential.label ? { label: credential.label } : {}),
        role: credential.role,
        expiresAt: toIsoString(credential.expiresAt),
        ...(pairUrl ? { pairUrl } : {}),
      },
      null,
      2,
    )}${newline}`;
  }

  return (
    [
      `Issued client pairing token ${credential.id}.`,
      `Token: ${credential.credential}`,
      ...(pairUrl ? [`Pair URL: ${pairUrl}`] : []),
      `Expires at: ${credential.expiresAt}`,
    ].join(newline) + newline
  );
}

export function formatPairingCredentialList(
  credentials: ReadonlyArray<AuthPairingLink>,
  options?: {
    readonly json?: boolean;
  },
): string {
  if (options?.json) {
    return `${JSON.stringify(
      credentials.map((credential) => ({
        id: credential.id,
        ...(credential.label ? { label: credential.label } : {}),
        role: credential.role,
        createdAt: toIsoString(credential.createdAt),
        expiresAt: toIsoString(credential.expiresAt),
      })),
      null,
      2,
    )}${newline}`;
  }

  if (credentials.length === 0) {
    return `No active pairing credentials.${newline}`;
  }

  return (
    credentials
      .map((credential) =>
        [
          `${credential.id}${credential.label ? ` (${credential.label})` : ""}`,
          `  role: ${credential.role}`,
          `  created: ${toIsoString(credential.createdAt)}`,
          `  expires: ${toIsoString(credential.expiresAt)}`,
        ].join(newline),
      )
      .join(`${newline}${newline}`) + newline
  );
}

export function formatIssuedSession(
  session: IssuedBearerSession,
  options?: {
    readonly json?: boolean;
    readonly tokenOnly?: boolean;
  },
): string {
  if (options?.tokenOnly) {
    return `${session.token}${newline}`;
  }

  if (options?.json) {
    return `${JSON.stringify(
      {
        sessionId: session.sessionId,
        token: session.token,
        method: session.method,
        role: session.role,
        subject: session.subject,
        client: session.client,
        expiresAt: toIsoString(session.expiresAt),
      },
      null,
      2,
    )}${newline}`;
  }

  return (
    [
      `Issued ${session.role} bearer session ${session.sessionId}.`,
      `Token: ${session.token}`,
      `Subject: ${session.subject}`,
      `Client: ${formatClientMetadata(session.client)}`,
      `Expires at: ${toIsoString(session.expiresAt)}`,
    ].join(newline) + newline
  );
}

export function formatSessionList(
  sessions: ReadonlyArray<AuthClientSession>,
  options?: {
    readonly json?: boolean;
  },
): string {
  if (options?.json) {
    return `${JSON.stringify(
      sessions.map((session) => ({
        sessionId: session.sessionId,
        method: session.method,
        role: session.role,
        subject: session.subject,
        client: session.client,
        connected: session.connected,
        issuedAt: toIsoString(session.issuedAt),
        expiresAt: toIsoString(session.expiresAt),
        lastConnectedAt: session.lastConnectedAt ? toIsoString(session.lastConnectedAt) : null,
      })),
      null,
      2,
    )}${newline}`;
  }

  if (sessions.length === 0) {
    return `No active sessions.${newline}`;
  }

  return (
    sessions
      .map((session) =>
        [
          `${session.sessionId} [${session.role}]${session.connected ? " connected" : ""}`,
          `  method: ${session.method}`,
          `  subject: ${session.subject}`,
          `  client: ${formatClientMetadata(session.client)}`,
          `  issued: ${toIsoString(session.issuedAt)}`,
          `  last connected: ${
            session.lastConnectedAt ? toIsoString(session.lastConnectedAt) : "never"
          }`,
          `  expires: ${toIsoString(session.expiresAt)}`,
        ].join(newline),
      )
      .join(`${newline}${newline}`) + newline
  );
}
