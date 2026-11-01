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
  findOwnedOccurrence,
  hasOwnershipMarker,
  ignoreGone,
  listProjectOccurrences,
  missingGet,
  occurrenceAttrs,
  occurrenceKind,
  parseDescription,
  projectParent,
  reconcileOccurrence,
  replaceOnIdentity,
  retryTransient,
} from "./internal.ts";

export type OccurrenceProps = {
  /**
   * Analysis note this occurrence attaches to, as
   * `projects/{project}/notes/{note}` or a bare note id. Immutable —
   * changing it replaces the occurrence.
   */
  noteName: string;
  /**
   * URI of the analyzed resource, for example
   * `https://gcr.io/project/image@sha256:abc`. Immutable — changing it
   * replaces the occurrence.
   */
  resourceUri: string;
  /**
   * Remediation notes. Alchemy stamps ownership into this field for
   * `list` / nuke because occurrences have no labels API.
   */
  remediation?: string;
  /**
   * DSSE envelope stored on the occurrence.
   */
  envelope?: containeranalysis.Envelope;
  /**
   * Attestation details. Used when no other kind is set.
   */
  attestation?: containeranalysis.AttestationOccurrence;
  /**
   * Build provenance details.
   */
  build?: containeranalysis.BuildOccurrence;
  /**
   * Discovery details.
   */
  discovery?: containeranalysis.DiscoveryOccurrence;
  /**
   * Image basis details.
   */
  image?: containeranalysis.ImageOccurrence;
  /**
   * Package installation details.
   */
  package?: containeranalysis.PackageOccurrence;
  /**
   * Vulnerability details.
   */
  vulnerability?: containeranalysis.VulnerabilityOccurrence;
  /**
   * Compliance details.
   */
  compliance?: containeranalysis.ComplianceOccurrence;
  /**
   * Deployment details.
   */
  deployment?: containeranalysis.DeploymentOccurrence;
  /**
   * Upgrade details.
   */
  upgrade?: containeranalysis.UpgradeOccurrence;
  /**
   * DSSE attestation details.
   */
  dsseAttestation?: containeranalysis.DSSEAttestationOccurrence;
  /**
   * SBOM reference details.
   */
  sbomReference?: containeranalysis.SBOMReferenceOccurrence;
  /**
   * Secret details.
   */
  secret?: containeranalysis.SecretOccurrence;
  /**
   * AI skill analysis details.
   */
  aiSkillAnalysis?: containeranalysis.AISkillAnalysisOccurrence;
};

export type Occurrence = Resource<
  "GCP.ContainerAnalysis.Occurrence",
  OccurrenceProps,
  {
    /** Full resource name `projects/{project}/occurrences/{occurrence}`. */
    name: string;
    /** Occurrence id (last path segment, server-assigned). */
    occurrenceId: string;
    /** Project id. */
    project: string;
    /** Note resource name. */
    noteName: string;
    /** Analyzed resource URI. */
    resourceUri: string;
    /** User remediation with the Alchemy ownership prefix stripped. */
    remediation: string | undefined;
    /** Server-reported analysis kind. */
    kind: string | undefined;
    /** DSSE envelope, if any. */
    envelope: containeranalysis.Envelope | undefined;
    /** Attestation details. */
    attestation: containeranalysis.AttestationOccurrence | undefined;
    /** Build provenance details. */
    build: containeranalysis.BuildOccurrence | undefined;
    /** Discovery details. */
    discovery: containeranalysis.DiscoveryOccurrence | undefined;
    /** Image basis details. */
    image: containeranalysis.ImageOccurrence | undefined;
    /** Package installation details. */
    package: containeranalysis.PackageOccurrence | undefined;
    /** Vulnerability details. */
    vulnerability: containeranalysis.VulnerabilityOccurrence | undefined;
    /** Compliance details. */
    compliance: containeranalysis.ComplianceOccurrence | undefined;
    /** Deployment details. */
    deployment: containeranalysis.DeploymentOccurrence | undefined;
    /** Upgrade details. */
    upgrade: containeranalysis.UpgradeOccurrence | undefined;
    /** DSSE attestation details. */
    dsseAttestation: containeranalysis.DSSEAttestationOccurrence | undefined;
    /** SBOM reference details. */
    sbomReference: containeranalysis.SBOMReferenceOccurrence | undefined;
    /** Secret details. */
    secret: containeranalysis.SecretOccurrence | undefined;
    /** AI skill analysis details. */
    aiSkillAnalysis: containeranalysis.AISkillAnalysisOccurrence | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A project-scoped Container Analysis (Grafeas) occurrence. Occurrences
 * attach a note to a concrete resource URI such as a container image
 * digest.
 *
 * The occurrence id is assigned by the API. `noteName` and `resourceUri`
 * are identity — changing either replaces the occurrence. Occurrences have
 * no labels field, so Alchemy stamps ownership into `remediation` for
 * `list` / nuke.
 *
 * ### Creating an Occurrence
 * **Example:** Attest an image
 * ```typescript
 * const note = yield* GCP.ContainerAnalysis.Note("Authority", {
 *   attestation: { hint: { humanReadableName: "QA" } },
 * });
 * const occurrence = yield* GCP.ContainerAnalysis.Occurrence("Signed", {
 *   noteName: note.name,
 *   resourceUri: "https://example.com/image@sha256:abc",
 *   attestation: {
 *     serializedPayload: btoa("payload"),
 *     signatures: [
 *       { publicKeyId: "https://example.com/keys/qa", signature: btoa("sig") },
 *     ],
 *   },
 * });
 * ```
 *
 * ### Updating an Occurrence
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical resource and updates it in place.
 *
 * **Example:** Change remediation text
 * ```typescript
 * const occurrence = yield* GCP.ContainerAnalysis.Occurrence("Signed", {
 *   noteName: note.name,
 *   resourceUri: "https://example.com/image@sha256:abc",
 *   remediation: "rebuild from a patched base",
 *   attestation: { hint: { humanReadableName: "QA" } },
 * });
 * ```
 *
 * @resource
 * @category ContainerAnalysis
 */
export const Occurrence = Resource<Occurrence>(
  "GCP.ContainerAnalysis.Occurrence",
);

const getByName = missingGet(containeranalysis.getProjectsOccurrences);

const toPublicAttrs = (
  occurrence: containeranalysis.Occurrence,
  project: string,
): Occurrence["Attributes"] => {
  const attrs = occurrenceAttrs(occurrence, project);
  return {
    name: attrs.name,
    occurrenceId: attrs.occurrenceId,
    project: attrs.project,
    noteName: attrs.noteName,
    resourceUri: attrs.resourceUri,
    remediation: attrs.remediation,
    kind: attrs.kind,
    envelope: attrs.envelope,
    attestation: attrs.attestation,
    build: attrs.build,
    discovery: attrs.discovery,
    image: attrs.image,
    package: attrs.package,
    vulnerability: attrs.vulnerability,
    compliance: attrs.compliance,
    deployment: attrs.deployment,
    upgrade: attrs.upgrade,
    dsseAttestation: attrs.dsseAttestation,
    sbomReference: attrs.sbomReference,
    secret: attrs.secret,
    aiSkillAnalysis: attrs.aiSkillAnalysis,
    createTime: attrs.createTime,
    updateTime: attrs.updateTime,
  };
};

export const OccurrenceProvider = () =>
  Provider.succeed(Occurrence, {
    stables: [
      "name",
      "occurrenceId",
      "project",
      "noteName",
      "resourceUri",
      "kind",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousKind =
        occurrenceKind(olds ?? { noteName: "", resourceUri: "" }) ??
        output?.kind;
      const nextKind = occurrenceKind(news) ?? previousKind;
      return replaceOnIdentity({
        previousParent: olds?.noteName ?? output?.noteName,
        nextParent: news.noteName,
        extra:
          ((olds?.resourceUri ?? output?.resourceUri) !== undefined &&
            news.resourceUri !== (olds?.resourceUri ?? output?.resourceUri)) ||
          (previousKind !== undefined &&
            nextKind !== undefined &&
            previousKind !== nextKind),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const name = output?.name;
      if (name !== undefined && name.length > 0) {
        const existing = yield* getByName(name);
        if (existing === undefined) return undefined;
        const attrs = toPublicAttrs(existing, env.project);
        const { labels } = parseDescription(existing.remediation);
        return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
      }
      const items = yield* listProjectOccurrences(env.project);
      const owned = yield* findOwnedOccurrence(id, items, env.project);
      if (owned === undefined) return undefined;
      return {
        name: owned.name,
        occurrenceId: owned.occurrenceId,
        project: owned.project,
        noteName: owned.noteName,
        resourceUri: owned.resourceUri,
        remediation: owned.remediation,
        kind: owned.kind,
        envelope: owned.envelope,
        attestation: owned.attestation,
        build: owned.build,
        discovery: owned.discovery,
        image: owned.image,
        package: owned.package,
        vulnerability: owned.vulnerability,
        compliance: owned.compliance,
        deployment: owned.deployment,
        upgrade: owned.upgrade,
        dsseAttestation: owned.dsseAttestation,
        sbomReference: owned.sbomReference,
        secret: owned.secret,
        aiSkillAnalysis: owned.aiSkillAnalysis,
        createTime: owned.createTime,
        updateTime: owned.updateTime,
      };
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listProjectOccurrences(env.project);
        return items
          .filter((item) => hasOwnershipMarker(item.remediation))
          .map((item) => toPublicAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = projectParent(env.project);
      const current = yield* reconcileOccurrence({
        id,
        name: output?.name,
        parent,
        project: env.project,
        location: undefined,
        news,
        ops: {
          get: getByName,
          create: (request) =>
            retryTransient(
              containeranalysis.createProjectsOccurrences({
                parent: request.parent,
                body: request.body,
              }),
            ),
          patch: (request) =>
            retryTransient(
              containeranalysis.patchProjectsOccurrences({
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
        containeranalysis.deleteProjectsOccurrences({ name: output.name }),
      );
    }),
  });
