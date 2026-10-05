import * as containeranalysis from "@distilled.cloud/gcp/containeranalysis_v1";
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

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.ContainerAnalysis.ResourceNotResolved",
)<{
  name: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const rfc1035 = (name: string, fallback = "note"): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `n${next}`;
  next = next.slice(0, MAX_ID_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) return fallback;
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, MAX_ID_LENGTH - 1)}0`;
  return next.slice(0, MAX_ID_LENGTH);
};

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  fallback = "note",
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

export const normalizeLocation = (
  location: string | undefined,
  fallback: string,
) => lastSegment(location ?? fallback).toLowerCase();

export const projectParent = (project: string) => `projects/${project}`;

export const locationParent = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

export const parseName = (name: string, collection: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf(collection);
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]
        : undefined,
    id:
      collectionAt >= 0 && parts[collectionAt + 1]
        ? parts[collectionAt + 1]!
        : lastSegment(name),
    parent:
      collectionAt > 0
        ? parts.slice(0, collectionAt).join("/")
        : parts.slice(0, Math.max(0, parts.length - 1)).join("/"),
  };
};

export const expandNoteName = (
  value: string,
  project: string,
  location?: string,
) => {
  if (value.includes("/")) return value.replace(/\/+$/, "");
  return location !== undefined
    ? `${locationParent(project, location)}/notes/${value}`
    : `${projectParent(project)}/notes/${value}`;
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

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const replaceOnIdentity = (input: {
  previousId?: string;
  nextId?: string;
  previousParent?: string;
  nextParent?: string;
  extra?: boolean;
}) => {
  if (input.extra === true) {
    return { action: "replace" as const, deleteFirst: false };
  }
  const idChanged =
    input.previousId !== undefined &&
    input.nextId !== undefined &&
    input.previousId !== input.nextId;
  const parentChanged =
    (input.previousParent ?? "") !== "" &&
    (input.nextParent ?? "") !== "" &&
    (input.previousParent ?? "") !== (input.nextParent ?? "");
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

export const ignoreGone = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" } =>
        error._tag === "NotFound",
      () => Effect.void,
    ),
  );

export const missingGet =
  <A, E extends { readonly _tag: string }, R>(
    effect: (input: { name: string }) => Effect.Effect<A, E, R>,
  ) =>
  (name: string) =>
    name.length === 0
      ? Effect.succeed(undefined)
      : effect({ name }).pipe(
          Effect.catchIf(
            (error): error is E & { readonly _tag: "NotFound" } =>
              error._tag === "NotFound",
            () => Effect.succeed(undefined),
          ),
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
    Effect.map((chunk) => Array.from(chunk) as Item[]),
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" } =>
        error._tag === "NotFound",
      () => emptyList<Item>(),
    ),
  );

export type NoteNews = {
  shortDescription?: string;
  longDescription?: string;
  expirationTime?: string;
  relatedUrl?: containeranalysis.RelatedUrlList;
  relatedNoteNames?: string[];
  attestation?: containeranalysis.AttestationNote;
  build?: containeranalysis.BuildNote;
  discovery?: containeranalysis.DiscoveryNote;
  image?: containeranalysis.ImageNote;
  package?: containeranalysis.PackageNote;
  vulnerability?: containeranalysis.VulnerabilityNote;
  compliance?: containeranalysis.ComplianceNote;
  deployment?: containeranalysis.DeploymentNote;
  upgrade?: containeranalysis.UpgradeNote;
  vulnerabilityAssessment?: containeranalysis.VulnerabilityAssessmentNote;
  secret?: containeranalysis.SecretNote;
  dsseAttestation?: containeranalysis.DSSEAttestationNote;
  sbomReference?: containeranalysis.SBOMReferenceNote;
  aiSkillAnalysis?: containeranalysis.AISkillAnalysisNote;
};

export type OccurrenceNews = {
  noteName: string;
  resourceUri: string;
  remediation?: string;
  envelope?: containeranalysis.Envelope;
  attestation?: containeranalysis.AttestationOccurrence;
  build?: containeranalysis.BuildOccurrence;
  discovery?: containeranalysis.DiscoveryOccurrence;
  image?: containeranalysis.ImageOccurrence;
  package?: containeranalysis.PackageOccurrence;
  vulnerability?: containeranalysis.VulnerabilityOccurrence;
  compliance?: containeranalysis.ComplianceOccurrence;
  deployment?: containeranalysis.DeploymentOccurrence;
  upgrade?: containeranalysis.UpgradeOccurrence;
  dsseAttestation?: containeranalysis.DSSEAttestationOccurrence;
  sbomReference?: containeranalysis.SBOMReferenceOccurrence;
  secret?: containeranalysis.SecretOccurrence;
  aiSkillAnalysis?: containeranalysis.AISkillAnalysisOccurrence;
};

const DEFAULT_ATTESTATION_PAYLOAD = "YWxjaGVteQ==";

export const noteKind = (news: NoteNews): string | undefined => {
  if (news.attestation !== undefined) return "ATTESTATION";
  if (news.build !== undefined) return "BUILD";
  if (news.discovery !== undefined) return "DISCOVERY";
  if (news.image !== undefined) return "IMAGE";
  if (news.package !== undefined) return "PACKAGE";
  if (news.vulnerability !== undefined) return "VULNERABILITY";
  if (news.compliance !== undefined) return "COMPLIANCE";
  if (news.deployment !== undefined) return "DEPLOYMENT";
  if (news.upgrade !== undefined) return "UPGRADE";
  if (news.vulnerabilityAssessment !== undefined) {
    return "VULNERABILITY_ASSESSMENT";
  }
  if (news.secret !== undefined) return "SECRET";
  if (news.dsseAttestation !== undefined) return "DSSE_ATTESTATION";
  if (news.sbomReference !== undefined) return "SBOM_REFERENCE";
  if (news.aiSkillAnalysis !== undefined) return "AI_SKILL_ANALYSIS";
  return undefined;
};

export const occurrenceKind = (news: OccurrenceNews): string | undefined => {
  if (news.attestation !== undefined) return "ATTESTATION";
  if (news.build !== undefined) return "BUILD";
  if (news.discovery !== undefined) return "DISCOVERY";
  if (news.image !== undefined) return "IMAGE";
  if (news.package !== undefined) return "PACKAGE";
  if (news.vulnerability !== undefined) return "VULNERABILITY";
  if (news.compliance !== undefined) return "COMPLIANCE";
  if (news.deployment !== undefined) return "DEPLOYMENT";
  if (news.upgrade !== undefined) return "UPGRADE";
  if (news.secret !== undefined) return "SECRET";
  if (news.dsseAttestation !== undefined) return "DSSE_ATTESTATION";
  if (news.sbomReference !== undefined) return "SBOM_REFERENCE";
  if (news.aiSkillAnalysis !== undefined) return "AI_SKILL_ANALYSIS";
  return undefined;
};

export const noteKindFields = (news: NoteNews): containeranalysis.Note => {
  const body: containeranalysis.Note = {
    attestation: news.attestation,
    build: news.build,
    discovery: news.discovery,
    image: news.image,
    package: news.package,
    vulnerability: news.vulnerability,
    compliance: news.compliance,
    deployment: news.deployment,
    upgrade: news.upgrade,
    vulnerabilityAssessment: news.vulnerabilityAssessment,
    secret: news.secret,
    dsseAttestation: news.dsseAttestation,
    sbomReference: news.sbomReference,
    aiSkillAnalysis: news.aiSkillAnalysis,
  };
  if (noteKind(news) === undefined) {
    body.attestation = { hint: { humanReadableName: "alchemy" } };
  }
  return body;
};

export const occurrenceKindFields = (
  news: OccurrenceNews,
): containeranalysis.Occurrence => {
  const body: containeranalysis.Occurrence = {
    attestation: news.attestation,
    build: news.build,
    discovery: news.discovery,
    image: news.image,
    package: news.package,
    vulnerability: news.vulnerability,
    compliance: news.compliance,
    deployment: news.deployment,
    upgrade: news.upgrade,
    dsseAttestation: news.dsseAttestation,
    sbomReference: news.sbomReference,
    secret: news.secret,
    aiSkillAnalysis: news.aiSkillAnalysis,
    envelope: news.envelope,
  };
  if (occurrenceKind(news) === undefined) {
    body.attestation = {
      serializedPayload: DEFAULT_ATTESTATION_PAYLOAD,
      signatures: [
        {
          publicKeyId: "https://alchemy.local/keys/test",
          signature: DEFAULT_ATTESTATION_PAYLOAD,
        },
      ],
    };
  }
  return body;
};

export type NoteAttrs = {
  name: string;
  noteId: string;
  project: string;
  location: string | undefined;
  shortDescription: string | undefined;
  longDescription: string | undefined;
  kind: string | undefined;
  expirationTime: string | undefined;
  relatedUrl: containeranalysis.RelatedUrlList;
  relatedNoteNames: string[];
  attestation: containeranalysis.AttestationNote | undefined;
  build: containeranalysis.BuildNote | undefined;
  discovery: containeranalysis.DiscoveryNote | undefined;
  image: containeranalysis.ImageNote | undefined;
  package: containeranalysis.PackageNote | undefined;
  vulnerability: containeranalysis.VulnerabilityNote | undefined;
  compliance: containeranalysis.ComplianceNote | undefined;
  deployment: containeranalysis.DeploymentNote | undefined;
  upgrade: containeranalysis.UpgradeNote | undefined;
  vulnerabilityAssessment:
    | containeranalysis.VulnerabilityAssessmentNote
    | undefined;
  secret: containeranalysis.SecretNote | undefined;
  dsseAttestation: containeranalysis.DSSEAttestationNote | undefined;
  sbomReference: containeranalysis.SBOMReferenceNote | undefined;
  aiSkillAnalysis: containeranalysis.AISkillAnalysisNote | undefined;
  createTime: string | undefined;
  updateTime: string | undefined;
};

export const noteAttrs = (
  note: containeranalysis.Note,
  project: string,
): NoteAttrs => {
  const name = note.name ?? "";
  const parsed = parseName(name, "notes");
  const description = parseDescription(note.longDescription);
  return {
    name,
    noteId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    shortDescription: note.shortDescription,
    longDescription: description.description,
    kind: note.kind,
    expirationTime: note.expirationTime,
    relatedUrl: note.relatedUrl ?? [],
    relatedNoteNames: note.relatedNoteNames ?? [],
    attestation: note.attestation,
    build: note.build,
    discovery: note.discovery,
    image: note.image,
    package: note.package,
    vulnerability: note.vulnerability,
    compliance: note.compliance,
    deployment: note.deployment,
    upgrade: note.upgrade,
    vulnerabilityAssessment: note.vulnerabilityAssessment,
    secret: note.secret,
    dsseAttestation: note.dsseAttestation,
    sbomReference: note.sbomReference,
    aiSkillAnalysis: note.aiSkillAnalysis,
    createTime: note.createTime,
    updateTime: note.updateTime,
  };
};

export type OccurrenceAttrs = {
  name: string;
  occurrenceId: string;
  project: string;
  location: string | undefined;
  noteName: string;
  resourceUri: string;
  remediation: string | undefined;
  kind: string | undefined;
  envelope: containeranalysis.Envelope | undefined;
  attestation: containeranalysis.AttestationOccurrence | undefined;
  build: containeranalysis.BuildOccurrence | undefined;
  discovery: containeranalysis.DiscoveryOccurrence | undefined;
  image: containeranalysis.ImageOccurrence | undefined;
  package: containeranalysis.PackageOccurrence | undefined;
  vulnerability: containeranalysis.VulnerabilityOccurrence | undefined;
  compliance: containeranalysis.ComplianceOccurrence | undefined;
  deployment: containeranalysis.DeploymentOccurrence | undefined;
  upgrade: containeranalysis.UpgradeOccurrence | undefined;
  dsseAttestation: containeranalysis.DSSEAttestationOccurrence | undefined;
  sbomReference: containeranalysis.SBOMReferenceOccurrence | undefined;
  secret: containeranalysis.SecretOccurrence | undefined;
  aiSkillAnalysis: containeranalysis.AISkillAnalysisOccurrence | undefined;
  createTime: string | undefined;
  updateTime: string | undefined;
};

export const occurrenceAttrs = (
  occurrence: containeranalysis.Occurrence,
  project: string,
): OccurrenceAttrs => {
  const name = occurrence.name ?? "";
  const parsed = parseName(name, "occurrences");
  const remediation = parseDescription(occurrence.remediation);
  return {
    name,
    occurrenceId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    noteName: occurrence.noteName ?? "",
    resourceUri: occurrence.resourceUri ?? "",
    remediation: remediation.description,
    kind: occurrence.kind,
    envelope: occurrence.envelope,
    attestation: occurrence.attestation,
    build: occurrence.build,
    discovery: occurrence.discovery,
    image: occurrence.image,
    package: occurrence.package,
    vulnerability: occurrence.vulnerability,
    compliance: occurrence.compliance,
    deployment: occurrence.deployment,
    upgrade: occurrence.upgrade,
    dsseAttestation: occurrence.dsseAttestation,
    sbomReference: occurrence.sbomReference,
    secret: occurrence.secret,
    aiSkillAnalysis: occurrence.aiSkillAnalysis,
    createTime: occurrence.createTime,
    updateTime: occurrence.updateTime,
  };
};

export type NoteOps<E = unknown, R = unknown> = {
  get: (
    name: string,
  ) => Effect.Effect<containeranalysis.Note | undefined, E, R>;
  create: (input: {
    parent: string;
    noteId: string;
    body: containeranalysis.Note;
  }) => Effect.Effect<containeranalysis.Note | undefined, E, R>;
  patch: (input: {
    name: string;
    updateMask: string;
    body: containeranalysis.Note;
  }) => Effect.Effect<containeranalysis.Note, E, R>;
};

export const reconcileNote = Effect.fn(function* (input: {
  id: string;
  name: string;
  parent: string;
  noteId: string;
  news: NoteNews;
  ops: NoteOps;
}) {
  const ownership = yield* createInternalLabels(input.id);
  const desiredLong = encodeDescription(ownership, input.news.longDescription);
  const kinds = noteKindFields({
    ...input.news,
    attestation:
      input.news.attestation ??
      (noteKind(input.news) === undefined
        ? { hint: { humanReadableName: input.noteId } }
        : undefined),
  });

  let current = yield* input.ops.get(input.name);

  if (current === undefined) {
    const created = yield* input.ops.create({
      parent: input.parent,
      noteId: input.noteId,
      body: {
        shortDescription: input.news.shortDescription,
        longDescription: desiredLong,
        expirationTime: input.news.expirationTime,
        relatedUrl: input.news.relatedUrl,
        relatedNoteNames: input.news.relatedNoteNames,
        ...kinds,
      },
    });
    current = created ?? undefined;
  }

  if (current === undefined) {
    return yield* new ResourceNotResolved({ name: input.name });
  }

  const currentName = current.name ?? input.name;
  const shortChanged = !sameText(
    current.shortDescription,
    input.news.shortDescription,
  );
  const longChanged = !sameText(current.longDescription, desiredLong);
  const expirationChanged = !sameText(
    current.expirationTime,
    input.news.expirationTime,
  );
  const relatedUrlChanged = !sameJson(
    current.relatedUrl ?? [],
    input.news.relatedUrl ?? [],
  );
  const relatedNotesChanged = !sameJson(
    [...(current.relatedNoteNames ?? [])].slice().sort(),
    [...(input.news.relatedNoteNames ?? [])].slice().sort(),
  );
  const attestationChanged = !sameJson(current.attestation, kinds.attestation);
  const buildChanged = !sameJson(current.build, kinds.build);
  const discoveryChanged = !sameJson(current.discovery, kinds.discovery);
  const imageChanged = !sameJson(current.image, kinds.image);
  const packageChanged = !sameJson(current.package, kinds.package);
  const vulnerabilityChanged = !sameJson(
    current.vulnerability,
    kinds.vulnerability,
  );
  const complianceChanged = !sameJson(current.compliance, kinds.compliance);
  const deploymentChanged = !sameJson(current.deployment, kinds.deployment);
  const upgradeChanged = !sameJson(current.upgrade, kinds.upgrade);
  const assessmentChanged = !sameJson(
    current.vulnerabilityAssessment,
    kinds.vulnerabilityAssessment,
  );
  const secretChanged = !sameJson(current.secret, kinds.secret);
  const dsseChanged = !sameJson(current.dsseAttestation, kinds.dsseAttestation);
  const sbomChanged = !sameJson(current.sbomReference, kinds.sbomReference);
  const skillChanged = !sameJson(
    current.aiSkillAnalysis,
    kinds.aiSkillAnalysis,
  );

  const updateMask = updateMaskOf(
    shortChanged ? "shortDescription" : undefined,
    longChanged ? "longDescription" : undefined,
    expirationChanged ? "expirationTime" : undefined,
    relatedUrlChanged ? "relatedUrl" : undefined,
    relatedNotesChanged ? "relatedNoteNames" : undefined,
    attestationChanged && kinds.attestation !== undefined
      ? "attestation"
      : undefined,
    buildChanged && kinds.build !== undefined ? "build" : undefined,
    discoveryChanged && kinds.discovery !== undefined ? "discovery" : undefined,
    imageChanged && kinds.image !== undefined ? "image" : undefined,
    packageChanged && kinds.package !== undefined ? "package" : undefined,
    vulnerabilityChanged && kinds.vulnerability !== undefined
      ? "vulnerability"
      : undefined,
    complianceChanged && kinds.compliance !== undefined
      ? "compliance"
      : undefined,
    deploymentChanged && kinds.deployment !== undefined
      ? "deployment"
      : undefined,
    upgradeChanged && kinds.upgrade !== undefined ? "upgrade" : undefined,
    assessmentChanged && kinds.vulnerabilityAssessment !== undefined
      ? "vulnerabilityAssessment"
      : undefined,
    secretChanged && kinds.secret !== undefined ? "secret" : undefined,
    dsseChanged && kinds.dsseAttestation !== undefined
      ? "dsseAttestation"
      : undefined,
    sbomChanged && kinds.sbomReference !== undefined
      ? "sbomReference"
      : undefined,
    skillChanged && kinds.aiSkillAnalysis !== undefined
      ? "aiSkillAnalysis"
      : undefined,
  );

  if (updateMask.length > 0) {
    current = yield* input.ops.patch({
      name: currentName,
      updateMask,
      body: {
        shortDescription: input.news.shortDescription,
        longDescription: desiredLong,
        expirationTime: input.news.expirationTime,
        relatedUrl: input.news.relatedUrl,
        relatedNoteNames: input.news.relatedNoteNames,
        ...kinds,
      },
    });
  }

  return current;
});

export type OccurrenceOps<E = unknown, R = unknown> = {
  get: (
    name: string,
  ) => Effect.Effect<containeranalysis.Occurrence | undefined, E, R>;
  create: (input: {
    parent: string;
    body: containeranalysis.Occurrence;
  }) => Effect.Effect<containeranalysis.Occurrence | undefined, E, R>;
  patch: (input: {
    name: string;
    updateMask: string;
    body: containeranalysis.Occurrence;
  }) => Effect.Effect<containeranalysis.Occurrence, E, R>;
};

export const reconcileOccurrence = Effect.fn(function* (input: {
  id: string;
  name: string | undefined;
  parent: string;
  project: string;
  location: string | undefined;
  news: OccurrenceNews;
  ops: OccurrenceOps;
}) {
  const ownership = yield* createInternalLabels(input.id);
  const desiredRemediation = encodeDescription(
    ownership,
    input.news.remediation,
  );
  const noteName = expandNoteName(
    input.news.noteName,
    input.project,
    input.location,
  );
  const kinds = occurrenceKindFields(input.news);

  let current =
    input.name !== undefined && input.name.length > 0
      ? yield* input.ops.get(input.name)
      : undefined;

  if (current === undefined) {
    const created = yield* input.ops.create({
      parent: input.parent,
      body: {
        noteName,
        resourceUri: input.news.resourceUri,
        remediation: desiredRemediation,
        ...kinds,
      },
    });
    current = created ?? undefined;
  }

  if (current === undefined) {
    return yield* new ResourceNotResolved({
      name: input.name ?? `${input.parent}/occurrences`,
    });
  }

  const currentName = current.name ?? input.name ?? "";
  const remediationChanged = !sameText(current.remediation, desiredRemediation);
  const envelopeChanged = !sameJson(current.envelope, kinds.envelope);
  const attestationChanged = !sameJson(current.attestation, kinds.attestation);
  const buildChanged = !sameJson(current.build, kinds.build);
  const discoveryChanged = !sameJson(current.discovery, kinds.discovery);
  const imageChanged = !sameJson(current.image, kinds.image);
  const packageChanged = !sameJson(current.package, kinds.package);
  const vulnerabilityChanged = !sameJson(
    current.vulnerability,
    kinds.vulnerability,
  );
  const complianceChanged = !sameJson(current.compliance, kinds.compliance);
  const deploymentChanged = !sameJson(current.deployment, kinds.deployment);
  const upgradeChanged = !sameJson(current.upgrade, kinds.upgrade);
  const dsseChanged = !sameJson(current.dsseAttestation, kinds.dsseAttestation);
  const sbomChanged = !sameJson(current.sbomReference, kinds.sbomReference);
  const secretChanged = !sameJson(current.secret, kinds.secret);
  const skillChanged = !sameJson(
    current.aiSkillAnalysis,
    kinds.aiSkillAnalysis,
  );

  const updateMask = updateMaskOf(
    remediationChanged ? "remediation" : undefined,
    envelopeChanged && kinds.envelope !== undefined ? "envelope" : undefined,
    attestationChanged && kinds.attestation !== undefined
      ? "attestation"
      : undefined,
    buildChanged && kinds.build !== undefined ? "build" : undefined,
    discoveryChanged && kinds.discovery !== undefined ? "discovery" : undefined,
    imageChanged && kinds.image !== undefined ? "image" : undefined,
    packageChanged && kinds.package !== undefined ? "package" : undefined,
    vulnerabilityChanged && kinds.vulnerability !== undefined
      ? "vulnerability"
      : undefined,
    complianceChanged && kinds.compliance !== undefined
      ? "compliance"
      : undefined,
    deploymentChanged && kinds.deployment !== undefined
      ? "deployment"
      : undefined,
    upgradeChanged && kinds.upgrade !== undefined ? "upgrade" : undefined,
    dsseChanged && kinds.dsseAttestation !== undefined
      ? "dsseAttestation"
      : undefined,
    sbomChanged && kinds.sbomReference !== undefined
      ? "sbomReference"
      : undefined,
    secretChanged && kinds.secret !== undefined ? "secret" : undefined,
    skillChanged && kinds.aiSkillAnalysis !== undefined
      ? "aiSkillAnalysis"
      : undefined,
  );

  if (updateMask.length > 0) {
    current = yield* input.ops.patch({
      name: currentName,
      updateMask,
      body: {
        noteName,
        resourceUri: input.news.resourceUri,
        remediation: desiredRemediation,
        ...kinds,
      },
    });
  }

  return current;
});

export const ownedNote = (
  id: string,
  note: containeranalysis.Note,
  project: string,
) =>
  Effect.gen(function* () {
    const attrs = noteAttrs(note, project);
    const { labels } = parseDescription(note.longDescription);
    return (yield* hasAlchemyLabels(id, labels)) ? attrs : undefined;
  });

export const ownedOccurrence = (
  id: string,
  occurrence: containeranalysis.Occurrence,
  project: string,
) =>
  Effect.gen(function* () {
    const attrs = occurrenceAttrs(occurrence, project);
    const { labels } = parseDescription(occurrence.remediation);
    return (yield* hasAlchemyLabels(id, labels)) ? attrs : undefined;
  });

export const listProjectNotes = (project: string) =>
  collectPages(
    containeranalysis.listProjectsNotes.pages({
      parent: projectParent(project),
      pageSize: 1000,
    }),
    (page) => page.notes,
  );

export const listLocationNotes = (project: string, location: string) =>
  collectPages(
    containeranalysis.listProjectsLocationsNotes.pages({
      parent: locationParent(project, location),
      pageSize: 1000,
      returnPartialSuccess: location === "-",
    }),
    (page) => page.notes,
  );

export const listProjectOccurrences = (project: string) =>
  collectPages(
    containeranalysis.listProjectsOccurrences.pages({
      parent: projectParent(project),
      pageSize: 1000,
    }),
    (page) => page.occurrences,
  );

export const listLocationOccurrences = (project: string, location: string) =>
  collectPages(
    containeranalysis.listProjectsLocationsOccurrences.pages({
      parent: locationParent(project, location),
      pageSize: 1000,
      returnPartialSuccess: location === "-",
    }),
    (page) => page.occurrences,
  );

export const findOwnedNote = (
  id: string,
  notes: readonly containeranalysis.Note[],
  project: string,
) =>
  Effect.gen(function* () {
    for (const note of notes) {
      const owned = yield* ownedNote(id, note, project);
      if (owned !== undefined) return owned;
    }
    return undefined;
  });

export const findOwnedOccurrence = (
  id: string,
  occurrences: readonly containeranalysis.Occurrence[],
  project: string,
) =>
  Effect.gen(function* () {
    for (const occurrence of occurrences) {
      const owned = yield* ownedOccurrence(id, occurrence, project);
      if (owned !== undefined) return owned;
    }
    return undefined;
  });
