/**
 * Which source control host settings fields hold secrets, read from each built-in host's client
 * definition. `serverSettings` keeps those values in the secret store and redacts them for
 * clients, the same way for every host.
 *
 * A secret field holds a string, or a string per server host such as GitHub's `tokens`.
 *
 * @module sourceControl/sourceControlHostSecrets
 */
import * as AzureDevOps from "@t3tools/source-control-azure-devops/client/definition";
import * as Bitbucket from "@t3tools/source-control-bitbucket/client/definition";
import {
  secretSourceControlHostSettingsFields,
  type SourceControlClientDefinition,
} from "@t3tools/source-control-core/client/definition";
import * as Forgejo from "@t3tools/source-control-forgejo/client/definition";
import * as GitCafe from "@t3tools/source-control-gitcafe/client/definition";
import * as GitHub from "@t3tools/source-control-github/client/definition";
import * as GitLab from "@t3tools/source-control-gitlab/client/definition";

const definitions: ReadonlyArray<SourceControlClientDefinition> = [
  GitHub.definition,
  GitLab.definition,
  AzureDevOps.definition,
  Bitbucket.definition,
  Forgejo.definition,
  GitCafe.definition,
];

/** Secret field names per host kind; a host with none is absent. */
export const SOURCE_CONTROL_HOST_SECRET_FIELDS: ReadonlyMap<
  string,
  ReadonlyArray<string>
> = new Map(
  definitions.flatMap((definition) => {
    const fields = definition.settings
      ? secretSourceControlHostSettingsFields(definition.settings)
      : [];
    return fields.length > 0 ? [[definition.kind, fields] as const] : [];
  }),
);

/** One stored secret: a host's field, and the server host it is for when the field is per host. */
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

/** The string values a secret field holds, keyed by server host, or `null` for a plain string. */
export function readSecretFieldValues(
  value: unknown,
): ReadonlyArray<readonly [serverHost: string | null, value: string]> {
  if (typeof value === "string") return [[null, value]];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([serverHost, entry]) =>
    typeof entry === "string" ? [[serverHost.trim().toLowerCase(), entry] as const] : [],
  );
}

/** A secret field's value rebuilt from per-slot values, in the shape it was read from. */
export function writeSecretFieldValues(
  original: unknown,
  values: ReadonlyArray<readonly [serverHost: string | null, value: string]>,
): unknown {
  if (typeof original === "string") return values[0]?.[1] ?? "";
  return Object.fromEntries(values.map(([serverHost, value]) => [serverHost ?? "", value]));
}
