import {
  IssueTrackerConnectionError,
  type StandaloneIssueTrackerDescriptor,
} from "@t3tools/contracts";
import { Schema } from "effect";

export type CredentialFields = StandaloneIssueTrackerDescriptor["credential"]["fields"];

const isConnectionError = Schema.is(IssueTrackerConnectionError);

export function packCredential(
  fields: CredentialFields,
  values: Readonly<Record<string, string>>,
): string | null {
  if (fields === undefined) return values[""]?.trim() || null;
  const entries = fields.map((field) => [field.key, values[field.key]?.trim() ?? ""] as const);
  if (entries.some(([, value]) => value.length === 0)) return null;
  return JSON.stringify(Object.fromEntries(entries));
}

export function connectionFailureDetail(error: unknown): string {
  if (isConnectionError(error)) return error.detail;
  return error instanceof Error ? error.message : "The request failed.";
}

export function connectFailureMessage(error: unknown): string {
  const detail = connectionFailureDetail(error);
  return isConnectionError(error) && error.reason === "rejected"
    ? `Credential rejected. ${detail}`
    : detail;
}
