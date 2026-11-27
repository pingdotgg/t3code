import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export function trimOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

// Filenames may start or end with whitespace, so a path is only checked for being present.
export function nonEmptyOptionalString(value: string | null | undefined): string | null {
  return value === null || value === undefined || value.length === 0 ? null : value;
}

export function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(value);
}

/** Normalize host timestamps to UTC for cross-host string sorting. */
export function toIsoUtc(value: string): string {
  return Option.match(DateTime.make(value), { onNone: () => value, onSome: DateTime.formatIso });
}

export function normalizeRefName(refName: string): string {
  return refName.trim().replace(/^refs\/heads\//, "");
}

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}
