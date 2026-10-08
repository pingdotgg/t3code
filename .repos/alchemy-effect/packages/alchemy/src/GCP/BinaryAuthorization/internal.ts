import * as binaryauthorization from "@distilled.cloud/gcp/binaryauthorization_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import { isTransientGcpError } from "../Errors.ts";

export const MAX_ID_LENGTH = 63;
export const DEFAULT_PLATFORM = "gke";
export const LIST_PLATFORMS = ["gke", "cloudRun"] as const;

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.BinaryAuthorization.ResourceNotResolved",
)<{
  name: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const rfc1035 = (name: string, fallback = "binauthz"): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `a${next}`;
  next = next.slice(0, MAX_ID_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) return fallback;
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, MAX_ID_LENGTH - 1)}0`;
  return next.slice(0, MAX_ID_LENGTH);
};

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  fallback = "binauthz",
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return rfc1035(explicit, fallback);
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_ID_LENGTH,
        lowercase: true,
      }),
      fallback,
    );
  });

export const projectParent = (project: string) => `projects/${project}`;

export const attestorName = (project: string, attestorId: string) =>
  `${projectParent(project)}/attestors/${attestorId}`;

export const platformParent = (project: string, platform: string) =>
  `${projectParent(project)}/platforms/${platform}`;

export const policyName = (
  project: string,
  platform: string,
  policyId: string,
) => `${platformParent(project, platform)}/policies/${policyId}`;

export const parseAttestorName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const attestorsAt = parts.lastIndexOf("attestors");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    attestorId:
      attestorsAt >= 0 && parts[attestorsAt + 1]
        ? parts[attestorsAt + 1]!
        : lastSegment(name),
  };
};

export const parsePolicyName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const policiesAt = parts.lastIndexOf("policies");
  const platformsAt = parts.lastIndexOf("platforms");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    platform:
      platformsAt >= 0 && parts[platformsAt + 1]
        ? parts[platformsAt + 1]!
        : DEFAULT_PLATFORM,
    policyId:
      policiesAt >= 0 && parts[policiesAt + 1]
        ? parts[policiesAt + 1]!
        : lastSegment(name),
  };
};

export const expandNoteReference = (value: string, project: string) => {
  const trimmed = value.replace(/\/+$/, "");
  if (trimmed.includes("/")) return trimmed;
  return `${projectParent(project)}/notes/${trimmed}`;
};

export const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  return description ? `${marker}\n${description}` : marker;
};

export const parseDescription = (
  description: string | undefined,
): {
  labels: Record<string, string>;
  description: string | undefined;
} => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

export const ownedBy = (id: string, labels: Record<string, string>) =>
  hasAlchemyLabels(id, labels);

export const createOwnership = (id: string) => createInternalLabels(id);

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const replaceOnIdentity = (input: {
  previousId?: string;
  nextId?: string;
  previousParent?: string;
  nextParent?: string;
  extra?: boolean;
  deleteFirst?: boolean;
}) => {
  if (input.extra === true) {
    return {
      action: "replace" as const,
      deleteFirst: input.deleteFirst === true,
    };
  }
  const idChanged =
    input.previousId !== undefined &&
    input.nextId !== undefined &&
    input.previousId !== input.nextId;
  const parentChanged =
    (input.previousParent ?? "") !== "" &&
    (input.nextParent ?? "") !== "" &&
    (input.previousParent ?? "") !== input.nextParent;
  if (!idChanged && !parentChanged) return undefined;
  return { action: "replace" as const, deleteFirst: false };
};

export const retryTransient = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: isTransientGcpError,
      times: 8,
      schedule: Schedule.exponential("250 millis"),
    }),
  );

const isNotFound = <E extends { readonly _tag: string }>(
  error: E,
): error is E & { readonly _tag: "NotFound" } => error._tag === "NotFound";

export const ignoreGone = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) => effect.pipe(Effect.catchIf(isNotFound, () => Effect.void));

export const missingGet =
  <A, E extends { readonly _tag: string }, R>(
    effect: (input: { name: string }) => Effect.Effect<A, E, R>,
  ) =>
  (name: string) =>
    name.length === 0
      ? Effect.succeed(undefined)
      : effect({ name }).pipe(
          Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
        );

const emptyList = <A>() => Effect.succeed<A[]>([]);

export const collectPages = <
  Page,
  Item,
  E extends { readonly _tag: string },
  R,
>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly Item[] | null | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk): Item[] => Array.from(chunk)),
    Effect.catchIf(isNotFound, () => emptyList<Item>()),
  );

export const listAttestors = (project: string) =>
  collectPages(
    binaryauthorization.listProjectsAttestors.pages({
      parent: projectParent(project),
      pageSize: 1000,
    }),
    (page) => page.attestors,
  );

export const listPlatformPolicies = (project: string) =>
  Effect.gen(function* () {
    const pages = yield* Effect.forEach(
      LIST_PLATFORMS,
      (platform) =>
        collectPages(
          binaryauthorization.listProjectsPlatformsPolicies.pages({
            parent: platformParent(project, platform),
            pageSize: 1000,
          }),
          (page) => page.platformPolicies,
        ),
      { concurrency: "unbounded" },
    );
    return pages.flat();
  });

const normalizePem = (value: string | undefined) =>
  (value ?? "")
    .replace(/-----BEGIN PUBLIC KEY-----/g, "")
    .replace(/-----END PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");

const normalizeAlgorithm = (value: string | undefined) => {
  const next = (value ?? "").toUpperCase();
  if (next === "ECDSA_P256_SHA256") return "EC_SIGN_P256_SHA256";
  if (next === "ECDSA_P384_SHA384") return "EC_SIGN_P384_SHA384";
  if (next === "ECDSA_P521_SHA512") return "EC_SIGN_P521_SHA512";
  return next;
};

export const publicKeysOf = (
  keys: readonly binaryauthorization.AttestorPublicKey[] | undefined,
): binaryauthorization.AttestorPublicKey[] => [...(keys ?? [])];

export const samePublicKeys = (
  observed: readonly binaryauthorization.AttestorPublicKey[] | undefined,
  desired: readonly binaryauthorization.AttestorPublicKey[] | undefined,
) => {
  const left = observed ?? [];
  const right = desired ?? [];
  if (left.length !== right.length) return false;
  return left.every((obs, index) => {
    const want = right[index];
    if (want === undefined) return false;
    if ((obs.comment ?? "") !== (want.comment ?? "")) return false;
    if (
      normalizePem(obs.asciiArmoredPgpPublicKey) !==
      normalizePem(want.asciiArmoredPgpPublicKey)
    ) {
      return false;
    }
    if (
      normalizePem(obs.pkixPublicKey?.publicKeyPem) !==
      normalizePem(want.pkixPublicKey?.publicKeyPem)
    ) {
      return false;
    }
    if (
      normalizeAlgorithm(obs.pkixPublicKey?.signatureAlgorithm) !==
      normalizeAlgorithm(want.pkixPublicKey?.signatureAlgorithm)
    ) {
      return false;
    }
    if (want.id !== undefined && obs.id !== want.id) return false;
    if (
      want.pkixPublicKey?.keyId !== undefined &&
      obs.pkixPublicKey?.keyId !== want.pkixPublicKey.keyId
    ) {
      return false;
    }
    return true;
  });
};

export const gkePolicyOf = (
  policy: binaryauthorization.GkePolicy | undefined,
): binaryauthorization.GkePolicy => policy ?? {};
