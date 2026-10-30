import { isSecretReference, secretSettingsFields, type SecretReference } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { sourceControlDefinitions } from "./sourceControlDefinitions.ts";

export const SOURCE_CONTROL_HOST_SECRET_FIELDS: ReadonlyMap<
  string,
  ReadonlyArray<string>
> = new Map(
  sourceControlDefinitions.definitions.flatMap((definition) => {
    const fields = definition.settings ? secretSettingsFields(definition.settings) : [];
    return fields.length > 0 ? [[definition.kind, fields] as const] : [];
  }),
);

export interface SourceControlHostSecretSlot {
  readonly kind: string;
  readonly field: string;
  readonly serverHost: string | null;
}

/** The secret store entry for one slot; names stay stable across releases. */
export function sourceControlHostSecretName(slot: SourceControlHostSecretSlot): string {
  const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url");
  return slot.serverHost === null
    ? `source-control-${encode(slot.kind)}-${encode(slot.field)}`
    : `source-control-${encode(slot.kind)}-${encode(slot.field)}-${encode(slot.serverHost.trim().toLowerCase())}`;
}

export function readSecretFieldValues(
  value: unknown,
): ReadonlyArray<readonly [serverHost: string | null, value: string]> {
  if (typeof value === "string") return [[null, value]];
  if (isSecretReference(value)) return [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([serverHost, entry]) =>
    typeof entry === "string" ? [[serverHost.trim().toLowerCase(), entry] as const] : [],
  );
}

export function writeSecretFieldValues(
  original: unknown,
  values: ReadonlyArray<readonly [serverHost: string | null, value: string]>,
): unknown {
  if (typeof original === "string") return values[0]?.[1] ?? "";
  if (isSecretReference(original)) return original;
  return Object.fromEntries(values.map(([serverHost, value]) => [serverHost ?? "", value]));
}

type SourceControlHostsSettings = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/** Replaces each secret provider reference in a credential field with the secret it names. */
export function resolveSourceControlHostSecrets<R>(
  hosts: SourceControlHostsSettings,
  resolve: (source: SecretReference) => Effect.Effect<string, never, R>,
): Effect.Effect<SourceControlHostsSettings, never, R> {
  const pending = Object.entries(hosts).flatMap(([kind, fields]) =>
    (SOURCE_CONTROL_HOST_SECRET_FIELDS.get(kind) ?? []).flatMap((field) => {
      const value = fields[field];
      return isSecretReference(value) ? [{ kind, field, source: value }] : [];
    }),
  );
  if (pending.length === 0) return Effect.succeed(hosts);
  return Effect.forEach(pending, ({ kind, field, source }) =>
    resolve(source).pipe(Effect.map((value) => ({ kind, field, value }))),
  ).pipe(
    Effect.map((fields) => {
      const next: Record<string, Readonly<Record<string, unknown>>> = { ...hosts };
      for (const { kind, field, value } of fields) next[kind] = { ...next[kind], [field]: value };
      return next;
    }),
  );
}
