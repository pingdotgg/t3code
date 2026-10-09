import * as containeranalysis from "@distilled.cloud/gcp/containeranalysis_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import type { NoteProps } from "./Note.ts";
import {
  expandNoteName,
  hasOwnershipMarker,
  ignoreGone,
  listLocationNotes,
  locationParent,
  missingGet,
  noteAttrs,
  noteKind,
  normalizeLocation,
  parseDescription,
  reconcileNote,
  replaceOnIdentity,
  retryTransient,
  toPhysicalId,
} from "./internal.ts";

export type LocationsNoteProps = NoteProps & {
  /**
   * Location (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the note. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
};

export type LocationsNote = Resource<
  "GCP.ContainerAnalysis.LocationsNote",
  LocationsNoteProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/notes/{note}`. */
    name: string;
    /** Note id (last path segment). */
    noteId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
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
 * A location-scoped Container Analysis (Grafeas) note. Same shape as
 * {@link Note}, stored at
 * `projects/{project}/locations/{location}/notes/{note}`.
 *
 * Location and note id are identity. Alchemy stamps ownership into
 * `longDescription` for `list` / nuke.
 *
 * ### Creating a Locations Note
 * **Example:** Regional attestation authority
 * ```typescript
 * const note = yield* GCP.ContainerAnalysis.LocationsNote("Authority", {
 *   location: "us-central1",
 *   shortDescription: "qa attestor",
 *   attestation: { hint: { humanReadableName: "QA" } },
 * });
 * ```
 *
 * @resource
 * @category ContainerAnalysis
 */
export const LocationsNote = Resource<LocationsNote>(
  "GCP.ContainerAnalysis.LocationsNote",
);

const resourceName = (project: string, location: string, noteId: string) =>
  expandNoteName(noteId, project, location);

const getByName = missingGet(containeranalysis.getProjectsLocationsNotes);

const toPublicAttrs = (
  note: containeranalysis.Note,
  project: string,
  region: string,
): LocationsNote["Attributes"] => {
  const attrs = noteAttrs(note, project);
  return {
    name: attrs.name,
    noteId: attrs.noteId,
    project: attrs.project,
    location: attrs.location ?? region,
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

export const LocationsNoteProvider = () =>
  Provider.succeed(LocationsNote, {
    stables: ["name", "noteId", "project", "location", "kind", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousKind = noteKind(olds ?? {}) ?? output?.kind;
      const nextKind = noteKind(news) ?? previousKind;
      return replaceOnIdentity({
        previousId: olds?.noteId ?? output?.noteId,
        nextId: news.noteId,
        previousParent: locationParent(
          "x",
          normalizeLocation(olds?.location ?? output?.location, env.region),
        ),
        nextParent: locationParent(
          "x",
          normalizeLocation(
            news.location ?? olds?.location ?? output?.location,
            env.region,
          ),
        ),
        extra:
          previousKind !== undefined &&
          nextKind !== undefined &&
          previousKind !== nextKind,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const noteId = yield* toPhysicalId(id, olds?.noteId, output?.noteId);
      const name = output?.name ?? resourceName(env.project, location, noteId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toPublicAttrs(existing, env.project, env.region);
      const { labels } = parseDescription(existing.longDescription);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listLocationNotes(env.project, env.region);
        return items
          .filter((item) => hasOwnershipMarker(item.longDescription))
          .map((item) => toPublicAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const noteId = yield* toPhysicalId(id, news.noteId, output?.noteId);
      const parent = locationParent(env.project, location);
      const name = resourceName(env.project, location, noteId);
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
              containeranalysis.createProjectsLocationsNotes({
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
              containeranalysis.patchProjectsLocationsNotes({
                name: request.name,
                updateMask: request.updateMask,
                body: request.body,
              }),
            ),
        },
      });
      return toPublicAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreGone(
        containeranalysis.deleteProjectsLocationsNotes({ name: output.name }),
      );
    }),
  });
