import * as containeranalysis from "@distilled.cloud/gcp/containeranalysis_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  expandNoteName,
  hasOwnershipMarker,
  ignoreGone,
  listProjectNotes,
  missingGet,
  noteAttrs,
  noteKind,
  parseDescription,
  projectParent,
  reconcileNote,
  replaceOnIdentity,
  retryTransient,
  toPhysicalId,
} from "./internal.ts";

export type NoteProps = {
  /**
   * Note id (the `{note}` segment of
   * `projects/{project}/notes/{note}`). If omitted, a unique RFC1035 id is
   * generated. Immutable — changing it replaces the note.
   */
  noteId?: string;
  /**
   * One-sentence summary of the analysis this note describes.
   */
  shortDescription?: string;
  /**
   * Detailed description. Alchemy stamps ownership into this field for
   * `list` / nuke because notes have no labels API.
   */
  longDescription?: string;
  /**
   * RFC3339 expiration. Empty means the note does not expire.
   */
  expirationTime?: string;
  /**
   * URLs associated with this note.
   */
  relatedUrl?: containeranalysis.RelatedUrlList;
  /**
   * Other note resource names related to this note.
   */
  relatedNoteNames?: string[];
  /**
   * Attestation authority note. Used when no other kind is set.
   */
  attestation?: containeranalysis.AttestationNote;
  /**
   * Build provenance note.
   */
  build?: containeranalysis.BuildNote;
  /**
   * Discovery note.
   */
  discovery?: containeranalysis.DiscoveryNote;
  /**
   * Base image note.
   */
  image?: containeranalysis.ImageNote;
  /**
   * Package note.
   */
  package?: containeranalysis.PackageNote;
  /**
   * Vulnerability note.
   */
  vulnerability?: containeranalysis.VulnerabilityNote;
  /**
   * Compliance note.
   */
  compliance?: containeranalysis.ComplianceNote;
  /**
   * Deployment note.
   */
  deployment?: containeranalysis.DeploymentNote;
  /**
   * Upgrade note.
   */
  upgrade?: containeranalysis.UpgradeNote;
  /**
   * Vulnerability assessment note.
   */
  vulnerabilityAssessment?: containeranalysis.VulnerabilityAssessmentNote;
  /**
   * Secret note.
   */
  secret?: containeranalysis.SecretNote;
  /**
   * DSSE attestation note.
   */
  dsseAttestation?: containeranalysis.DSSEAttestationNote;
  /**
   * SBOM reference note.
   */
  sbomReference?: containeranalysis.SBOMReferenceNote;
  /**
   * AI skill analysis note.
   */
  aiSkillAnalysis?: containeranalysis.AISkillAnalysisNote;
};

export type Note = Resource<
  "GCP.ContainerAnalysis.Note",
  NoteProps,
  {
    /** Full resource name `projects/{project}/notes/{note}`. */
    name: string;
    /** Note id (last path segment). */
    noteId: string;
    /** Project id. */
    project: string;
    /** One-sentence summary. */
    shortDescription: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    longDescription: string | undefined;
    /** Server-reported analysis kind. */
    kind: string | undefined;
    /** RFC3339 expiration, if any. */
    expirationTime: string | undefined;
    /** URLs associated with this note. */
    relatedUrl: containeranalysis.RelatedUrlList;
    /** Related note resource names. */
    relatedNoteNames: string[];
    /** Attestation authority metadata. */
    attestation: containeranalysis.AttestationNote | undefined;
    /** Build provenance metadata. */
    build: containeranalysis.BuildNote | undefined;
    /** Discovery metadata. */
    discovery: containeranalysis.DiscoveryNote | undefined;
    /** Base image metadata. */
    image: containeranalysis.ImageNote | undefined;
    /** Package metadata. */
    package: containeranalysis.PackageNote | undefined;
    /** Vulnerability metadata. */
    vulnerability: containeranalysis.VulnerabilityNote | undefined;
    /** Compliance metadata. */
    compliance: containeranalysis.ComplianceNote | undefined;
    /** Deployment metadata. */
    deployment: containeranalysis.DeploymentNote | undefined;
    /** Upgrade metadata. */
    upgrade: containeranalysis.UpgradeNote | undefined;
    /** Vulnerability assessment metadata. */
    vulnerabilityAssessment:
      | containeranalysis.VulnerabilityAssessmentNote
      | undefined;
    /** Secret metadata. */
    secret: containeranalysis.SecretNote | undefined;
    /** DSSE attestation metadata. */
    dsseAttestation: containeranalysis.DSSEAttestationNote | undefined;
    /** SBOM reference metadata. */
    sbomReference: containeranalysis.SBOMReferenceNote | undefined;
    /** AI skill analysis metadata. */
    aiSkillAnalysis: containeranalysis.AISkillAnalysisNote | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A project-scoped Container Analysis (Grafeas) note. Notes describe a
 * type of analysis; occurrences attach a note to a resource such as a
 * container image.
 *
 * Notes have no labels field, so Alchemy stamps ownership into
 * `longDescription` for `list` / nuke. `noteId` is identity — changing it
 * replaces the note. Descriptions, related URLs, and kind payloads update
 * in place. Switching the analysis kind replaces the note.
 *
 * ### Creating a Note
 * **Example:** Attestation authority
 * ```typescript
 * const note = yield* GCP.ContainerAnalysis.Note("Authority", {
 *   shortDescription: "qa attestor",
 *   attestation: { hint: { humanReadableName: "QA" } },
 * });
 * ```
 *
 * **Example:** Explicit id and related URL
 * ```typescript
 * const note = yield* GCP.ContainerAnalysis.Note("Authority", {
 *   noteId: "qa-attestor",
 *   shortDescription: "qa attestor",
 *   longDescription: "signs production images",
 *   relatedUrl: [{ url: "https://example.com/policy", label: "policy" }],
 *   attestation: { hint: { humanReadableName: "QA" } },
 * });
 * ```
 *
 * ### Updating a Note
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical resource and updates it in place.
 *
 * **Example:** Change the summary
 * ```typescript
 * const note = yield* GCP.ContainerAnalysis.Note("Authority", {
 *   shortDescription: "qa and staging attestor",
 *   attestation: { hint: { humanReadableName: "QA" } },
 * });
 * ```
 *
 * @resource
 * @category ContainerAnalysis
 */
export const Note = Resource<Note>("GCP.ContainerAnalysis.Note");

const resourceName = (project: string, noteId: string) =>
  expandNoteName(noteId, project);

const getByName = missingGet(containeranalysis.getProjectsNotes);

const toPublicAttrs = (
  note: containeranalysis.Note,
  project: string,
): Note["Attributes"] => {
  const attrs = noteAttrs(note, project);
  return {
    name: attrs.name,
    noteId: attrs.noteId,
    project: attrs.project,
    shortDescription: attrs.shortDescription,
    longDescription: attrs.longDescription,
    kind: attrs.kind,
    expirationTime: attrs.expirationTime,
    relatedUrl: attrs.relatedUrl,
    relatedNoteNames: attrs.relatedNoteNames,
    attestation: attrs.attestation,
    build: attrs.build,
    discovery: attrs.discovery,
    image: attrs.image,
    package: attrs.package,
    vulnerability: attrs.vulnerability,
    compliance: attrs.compliance,
    deployment: attrs.deployment,
    upgrade: attrs.upgrade,
    vulnerabilityAssessment: attrs.vulnerabilityAssessment,
    secret: attrs.secret,
    dsseAttestation: attrs.dsseAttestation,
    sbomReference: attrs.sbomReference,
    aiSkillAnalysis: attrs.aiSkillAnalysis,
    createTime: attrs.createTime,
    updateTime: attrs.updateTime,
  };
};

export const NoteProvider = () =>
  Provider.succeed(Note, {
    stables: ["name", "noteId", "project", "kind", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousKind = noteKind(olds ?? {}) ?? output?.kind;
      const nextKind = noteKind(news) ?? previousKind;
      return replaceOnIdentity({
        previousId: olds?.noteId ?? output?.noteId,
        nextId: news.noteId,
        extra:
          previousKind !== undefined &&
          nextKind !== undefined &&
          previousKind !== nextKind,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const noteId = yield* toPhysicalId(id, olds?.noteId, output?.noteId);
      const name = output?.name ?? resourceName(env.project, noteId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toPublicAttrs(existing, env.project);
      const { labels } = parseDescription(existing.longDescription);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listProjectNotes(env.project);
        return items
          .filter((item) => hasOwnershipMarker(item.longDescription))
          .map((item) => toPublicAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const noteId = yield* toPhysicalId(id, news.noteId, output?.noteId);
      const parent = projectParent(env.project);
      const name = resourceName(env.project, noteId);
      const current = yield* reconcileNote({
        id,
        name: output?.name ?? name,
        parent,
        noteId,
        news,
        ops: {
          get: getByName,
          create: (request) =>
            retryTransient(
              containeranalysis.createProjectsNotes({
                parent: request.parent,
                noteId: request.noteId,
                body: request.body,
              }),
            ).pipe(
              Effect.catchTag("Conflict", () =>
                getByName(`${request.parent}/notes/${request.noteId}`),
              ),
            ),
          patch: (request) =>
            retryTransient(
              containeranalysis.patchProjectsNotes({
                name: request.name,
                updateMask: request.updateMask,
                body: request.body,
              }),
            ),
        },
      });
      return toPublicAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreGone(
        containeranalysis.deleteProjectsNotes({ name: output.name }),
      );
    }),
  });
