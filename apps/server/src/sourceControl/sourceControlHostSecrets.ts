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
  const sources =
    original !== null && typeof original === "object" && !Array.isArray(original)
      ? Object.entries(original).flatMap(([serverHost, entry]) =>
          isSecretReference(entry) ? [[serverHost.trim().toLowerCase(), entry] as const] : [],
        )
      : [];
  return Object.fromEntries([
    ...sources,
    ...values.map(([serverHost, value]) => [serverHost ?? "", value] as const),
  ]);
}

type SourceControlHostsSettings = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

const referencesIn = (value: unknown): ReadonlyArray<SecretReference> => {
  if (isSecretReference(value)) return [value];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.values(value).filter(isSecretReference);
};

/** Every secret provider reference held in any host kind's credential fields. */
export function collectSourceControlHostSecretReferences(
  hosts: SourceControlHostsSettings,
): ReadonlyArray<SecretReference> {
  return [...SOURCE_CONTROL_HOST_SECRET_FIELDS].flatMap(([kind, fields]) =>
    fields.flatMap((field) => referencesIn(hosts[kind]?.[field])),
  );
}

/** Replaces each secret provider reference in one host kind's credential fields with the secret it names. */
export const resolveSourceControlHostSecrets = Effect.fn("SourceControlHost.resolveSecrets")(
  function* <R>(
    hosts: SourceControlHostsSettings,
    kind: string,
    resolve: (source: SecretReference) => Effect.Effect<string, never, R>,
  ) {
    const fields = hosts[kind] ?? {};
    const resolveField = (value: unknown): Effect.Effect<unknown, never, R> | null => {
      if (isSecretReference(value)) return resolve(value);
      if (referencesIn(value).length === 0) return null;
      return Effect.forEach(
        Object.entries(value as Record<string, unknown>),
        ([serverHost, entry]) =>
          isSecretReference(entry)
            ? resolve(entry).pipe(Effect.map((secret) => [serverHost, secret] as const))
            : Effect.succeed([serverHost, entry] as const),
      ).pipe(Effect.map((resolved) => Object.fromEntries(resolved)));
    };
    const pending = (SOURCE_CONTROL_HOST_SECRET_FIELDS.get(kind) ?? []).flatMap((field) => {
      const resolved = resolveField(fields[field]);
      return resolved === null ? [] : [{ field, resolved }];
    });
    if (pending.length === 0) return hosts;
    const resolved = yield* Effect.forEach(pending, ({ field, resolved }) =>
      resolved.pipe(Effect.map((value) => [field, value] as const)),
    );
    return { ...hosts, [kind]: { ...fields, ...Object.fromEntries(resolved) } };
  },
);
