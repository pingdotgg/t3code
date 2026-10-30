import {
  isSecretReference,
  secretReferencesInSettings,
  secretSettingsFields,
  type SecretReference,
  type ServerSettings,
} from "@t3tools/contracts";
import type * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";

import { resolveSettingsSecrets } from "../secrets/settingsSecretValue.ts";

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

const hostSettingsSchemas = new Map(
  sourceControlDefinitions.definitions.flatMap((definition) =>
    definition.settings ? [[definition.kind as string, definition.settings] as const] : [],
  ),
);

/** Every secret provider reference held in any host kind's credential fields. */
export function collectSourceControlHostSecretReferences(
  hosts: SourceControlHostsSettings,
): ReadonlyArray<SecretReference> {
  return [...hostSettingsSchemas].flatMap(([kind, schema]) => [
    ...secretReferencesInSettings(schema, hosts[kind]).map(({ reference }) => reference),
    ...perHostSecretReferences(kind, hosts[kind]).map(({ reference }) => reference),
  ]);
}

/** References kept per hostname, such as GitHub `tokens`, which the schema walker does not reach. */
function perHostSecretReferences(
  kind: string,
  fields: Readonly<Record<string, unknown>> | undefined,
): ReadonlyArray<{
  readonly field: string;
  readonly serverHost: string;
  readonly reference: SecretReference;
}> {
  if (fields === undefined) return [];
  return (SOURCE_CONTROL_HOST_SECRET_FIELDS.get(kind) ?? []).flatMap((field) => {
    const value = fields[field];
    if (value === null || typeof value !== "object" || isSecretReference(value)) return [];
    return Object.entries(value).flatMap(([serverHost, reference]) =>
      isSecretReference(reference) ? [{ field, serverHost, reference }] : [],
    );
  });
}

/** Replaces each secret provider reference in one host kind's credential fields with the secret it names. */
export const resolveSourceControlHostSecrets = Effect.fn("SourceControlHost.resolveSecrets")(
  function* (
    resolver: SecretResolver.SecretResolver["Service"],
    hosts: SourceControlHostsSettings,
    kind: string,
  ) {
    const schema = hostSettingsSchemas.get(kind);
    const fields = hosts[kind];
    if (schema === undefined || fields === undefined) return hosts;
    const resolved = yield* resolveSettingsSecrets(resolver, schema, fields);
    const pending = perHostSecretReferences(kind, resolved);
    if (pending.length === 0) return resolved === fields ? hosts : { ...hosts, [kind]: resolved };
    const values = yield* resolver.read(pending.map(({ reference }) => reference));
    const next: Record<string, unknown> = { ...resolved };
    pending.forEach(({ field, serverHost }, index) => {
      next[field] = { ...(next[field] as object), [serverHost]: values[index] ?? "" };
    });
    return { ...hosts, [kind]: next };
  },
);

/** Settings that cannot be read clear every cached secret, so a refresh never keeps a stale one. */
export const invalidateSettingsSecrets = Effect.fn("SettingsSecrets.invalidate")(function* <E>(
  resolver: SecretResolver.SecretResolver["Service"],
  settings: Effect.Effect<Pick<ServerSettings, "sourceControlHosts">, E>,
) {
  const references = yield* settings.pipe(
    Effect.map((current) => collectSourceControlHostSecretReferences(current.sourceControlHosts)),
    Effect.orElseSucceed(() => undefined),
  );
  yield* resolver.invalidate(references);
});
