import * as containeranalysis from "@distilled.cloud/gcp/containeranalysis_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import type { OccurrenceProps } from "./Occurrence.ts";
import {
  findOwnedOccurrence,
  hasOwnershipMarker,
  ignoreGone,
  listLocationOccurrences,
  locationParent,
  missingGet,
  normalizeLocation,
  occurrenceAttrs,
  occurrenceKind,
  parseDescription,
  reconcileOccurrence,
  replaceOnIdentity,
  retryTransient,
} from "./internal.ts";

export type LocationsOccurrenceProps = OccurrenceProps & {
  /**
   * Location (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the occurrence. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
};

export type LocationsOccurrence = Resource<
  "GCP.ContainerAnalysis.LocationsOccurrence",
  LocationsOccurrenceProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/occurrences/{occurrence}`. */
    name: string;
    /** Occurrence id (last path segment, server-assigned). */
    occurrenceId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
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
 * A location-scoped Container Analysis (Grafeas) occurrence. Same shape as
 * {@link Occurrence}, stored at
 * `projects/{project}/locations/{location}/occurrences/{occurrence}`.
 *
 * Location, `noteName`, and `resourceUri` are identity. Alchemy stamps
 * ownership into `remediation` for `list` / nuke.
 *
 * ### Creating a Locations Occurrence
 * **Example:** Regional attestation
 * ```typescript
 * const note = yield* GCP.ContainerAnalysis.LocationsNote("Authority", {
 *   location: "us-central1",
 *   attestation: { hint: { humanReadableName: "QA" } },
 * });
 * const occurrence = yield* GCP.ContainerAnalysis.LocationsOccurrence(
 *   "Signed",
 *   {
 *     location: "us-central1",
 *     noteName: note.name,
 *     resourceUri: "https://example.com/image@sha256:abc",
 *     attestation: {
 *       serializedPayload: btoa("payload"),
 *       signatures: [
 *         {
 *           publicKeyId: "https://example.com/keys/qa",
 *           signature: btoa("sig"),
 *         },
 *       ],
 *     },
 *   },
 * );
 * ```
 *
 * @resource
 * @category ContainerAnalysis
 */
export const LocationsOccurrence = Resource<LocationsOccurrence>(
  "GCP.ContainerAnalysis.LocationsOccurrence",
);

const getByName = missingGet(containeranalysis.getProjectsLocationsOccurrences);

const toPublicAttrs = (
  occurrence: containeranalysis.Occurrence,
  project: string,
  region: string,
): LocationsOccurrence["Attributes"] => {
  const attrs = occurrenceAttrs(occurrence, project);
  return {
    name: attrs.name,
    occurrenceId: attrs.occurrenceId,
    project: attrs.project,
    location: attrs.location ?? region,
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

export const LocationsOccurrenceProvider = () =>
  Provider.succeed(LocationsOccurrence, {
    stables: [
      "name",
      "occurrenceId",
      "project",
      "location",
      "noteName",
      "resourceUri",
      "kind",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousKind =
        occurrenceKind(olds ?? { noteName: "", resourceUri: "" }) ??
        output?.kind;
      const nextKind = occurrenceKind(news) ?? previousKind;
      return replaceOnIdentity({
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
          ((olds?.noteName ?? output?.noteName) !== undefined &&
            news.noteName !== (olds?.noteName ?? output?.noteName)) ||
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
        const attrs = toPublicAttrs(existing, env.project, env.region);
        const { labels } = parseDescription(existing.remediation);
        return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
      }
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const items = yield* listLocationOccurrences(env.project, location);
      const owned = yield* findOwnedOccurrence(id, items, env.project);
      if (owned === undefined) return undefined;
      return {
        name: owned.name,
        occurrenceId: owned.occurrenceId,
        project: owned.project,
        location: owned.location ?? location,
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
        const items = yield* listLocationOccurrences(env.project, env.region);
        return items
          .filter((item) => hasOwnershipMarker(item.remediation))
          .map((item) => toPublicAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const parent = locationParent(env.project, location);
      const current = yield* reconcileOccurrence({
        id,
        name: output?.name,
        parent,
        project: env.project,
        location,
        news,
        ops: {
          get: getByName,
          create: (request) =>
            retryTransient(
              containeranalysis.createProjectsLocationsOccurrences({
                parent: request.parent,
                body: request.body,
              }),
            ),
          patch: (request) =>
            retryTransient(
              containeranalysis.patchProjectsLocationsOccurrences({
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
        containeranalysis.deleteProjectsLocationsOccurrences({
          name: output.name,
        }),
      );
    }),
  });
