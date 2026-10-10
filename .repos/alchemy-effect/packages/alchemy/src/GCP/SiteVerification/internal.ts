import * as siteVerification from "@distilled.cloud/gcp/siteVerification_v1";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";

export const DEFAULT_SITE_TYPE = "SITE";
export const OWNERSHIP_HOST = "alchemy-site-verification.test";
export const MAX_LABEL_LENGTH = 63;

export type SiteType = "SITE" | "INET_DOMAIN" | (string & {});

export type VerificationMethod =
  | "FILE"
  | "META"
  | "ANALYTICS"
  | "TAG_MANAGER"
  | "DNS_TXT"
  | "DNS_CNAME"
  | "DNS"
  | (string & {});

export const defaultVerificationMethod = (
  siteType: string | undefined,
): VerificationMethod =>
  (siteType ?? DEFAULT_SITE_TYPE) === "INET_DOMAIN" ? "DNS_TXT" : "FILE";

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sortedOwners = (owners: readonly string[] | undefined) =>
  [...(owners ?? [])]
    .map((owner) => owner.trim())
    .filter((owner) => owner.length > 0)
    .sort((left, right) => left.localeCompare(right));

export const sameOwners = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) => JSON.stringify(sortedOwners(left)) === JSON.stringify(sortedOwners(right));

/**
 * Distilled fully-encodes `{id}` path labels. Google returns the web
 * resource id already percent-encoded (`http%3A%2F%2F…`), so decode
 * first and let the protocol encode once.
 */
export const toPathId = (id: string | undefined) => {
  if (!id) return "";
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
};

export const normalizeIdentifier = (
  identifier: string,
  siteType: string | undefined,
) => {
  const trimmed = identifier.trim();
  if ((siteType ?? DEFAULT_SITE_TYPE) !== "SITE") return trimmed;
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
};

export const hasOwnershipMarker = (identifier: string | undefined) =>
  (identifier ?? "").toLowerCase().includes(OWNERSHIP_HOST);

export const toGeneratedIdentifier = (
  id: string,
  siteType: string | undefined,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) {
      return normalizeIdentifier(requested, siteType);
    }
    if (existing !== undefined && existing.length > 0) {
      return existing;
    }
    const label = yield* createPhysicalName({
      id,
      maxLength: MAX_LABEL_LENGTH,
      lowercase: true,
    });
    const host = `${label}.${OWNERSHIP_HOST}`;
    return (siteType ?? DEFAULT_SITE_TYPE) === "INET_DOMAIN"
      ? host
      : `https://${host}/`;
  });

const emptyWebResources = () =>
  Effect.succeed([] as siteVerification.SiteVerificationWebResourceResource[]);

export const getWebResource = (id: string | undefined) => {
  const pathId = toPathId(id);
  return pathId.length === 0
    ? Effect.succeed(undefined)
    : siteVerification
        .getWebResource({ id: pathId })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
};

export const listWebResources = () =>
  siteVerification.listWebResource({}).pipe(
    Effect.map((page) => page.items ?? []),
    Effect.catchTag("NotFound", () => emptyWebResources()),
  );

export const findWebResource = (
  identifier: string | undefined,
  siteType: string | undefined,
) =>
  Effect.gen(function* () {
    if (!identifier) return undefined;
    const desiredType = siteType ?? DEFAULT_SITE_TYPE;
    const desiredId = normalizeIdentifier(identifier, desiredType);
    const items = yield* listWebResources();
    return items.find((item) => {
      const type = item.site?.type ?? DEFAULT_SITE_TYPE;
      const observed = item.site?.identifier ?? "";
      return (
        type === desiredType &&
        (sameText(observed, desiredId) ||
          sameText(normalizeIdentifier(observed, type), desiredId) ||
          sameText(toPathId(item.id), desiredId) ||
          sameText(item.id, identifier))
      );
    });
  });

export const deleteWebResource = (id: string | undefined) => {
  const pathId = toPathId(id);
  return pathId.length === 0
    ? Effect.void
    : siteVerification
        .deleteWebResource({ id: pathId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
};

export const getWebResourceToken = (request: {
  identifier: string;
  siteType?: SiteType;
  verificationMethod?: VerificationMethod;
}) => {
  const siteType = request.siteType ?? DEFAULT_SITE_TYPE;
  return siteVerification.getTokenWebResource({
    body: {
      site: {
        identifier: request.identifier,
        type: siteType,
      },
      verificationMethod:
        request.verificationMethod ?? defaultVerificationMethod(siteType),
    },
  });
};
