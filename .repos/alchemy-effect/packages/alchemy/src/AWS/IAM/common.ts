import type * as iam from "@distilled.cloud/aws/iam";
import * as Redacted from "effect/Redacted";
import type { PolicyDocument } from "./Policy.ts";

export const toTagRecord = (
  tags: Array<{ Key?: string; Value?: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { Key: string; Value: string } =>
          typeof tag.Key === "string" && typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

const decodePolicyString = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const parsePolicyDocument = (
  value: string | undefined,
): PolicyDocument | undefined => {
  if (!value) {
    return undefined;
  }

  const decoded = decodePolicyString(value);
  return JSON.parse(decoded) as PolicyDocument;
};

export const stringifyPolicyDocument = (value: PolicyDocument) =>
  JSON.stringify(value);

export const normalizeIamPath = (value: string | undefined) => {
  const path = value ?? "/";
  const withLeadingSlash = path.startsWith("/") ? path : `/${path}`;
  return withLeadingSlash.endsWith("/")
    ? withLeadingSlash
    : `${withLeadingSlash}/`;
};

export const policyArnFromParts = ({
  accountId,
  path,
  policyName,
}: {
  accountId: string;
  path: string | undefined;
  policyName: string;
}) => `arn:aws:iam::${accountId}:policy${normalizeIamPath(path)}${policyName}`;

export const oldestNondefaultPolicyVersion = (
  versions: iam.PolicyVersion[] | undefined,
) =>
  [...(versions ?? [])]
    .filter((version) => !version.IsDefaultVersion && version.VersionId)
    .sort(
      (a, b) => (a.CreateDate?.getTime() ?? 0) - (b.CreateDate?.getTime() ?? 0),
    )[0];

export const toRedactedString = (
  value: string | Redacted.Redacted<string> | undefined,
): Redacted.Redacted<string> | undefined =>
  value === undefined
    ? undefined
    : typeof value === "string"
      ? Redacted.make(value)
      : value;

export const toRedactedBytes = (
  value:
    | Uint8Array<ArrayBufferLike>
    | Redacted.Redacted<Uint8Array<ArrayBufferLike>>
    | undefined,
): Redacted.Redacted<Uint8Array<ArrayBufferLike>> | undefined =>
  value === undefined
    ? undefined
    : value instanceof Uint8Array
      ? Redacted.make(value)
      : value;

export const unwrapRedactedString = (
  value: string | Redacted.Redacted<string>,
): string => (typeof value === "string" ? value : Redacted.value(value));
