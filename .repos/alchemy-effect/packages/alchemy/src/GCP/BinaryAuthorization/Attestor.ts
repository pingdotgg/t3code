import * as binaryauthorization from "@distilled.cloud/gcp/binaryauthorization_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  attestorName,
  createOwnership,
  encodeDescription,
  expandNoteReference,
  hasOwnershipMarker,
  ignoreGone,
  lastSegment,
  listAttestors,
  missingGet,
  ownedBy,
  parseAttestorName,
  parseDescription,
  publicKeysOf,
  replaceOnIdentity,
  ResourceNotResolved,
  retryTransient,
  samePublicKeys,
  sameText,
  toPhysicalId,
} from "./internal.ts";

export type AttestorPublicKey = binaryauthorization.AttestorPublicKey;

export type AttestorProps = {
  /**
   * Attestor id (the `{attestor}` segment of
   * `projects/{project}/attestors/{attestor}`). If omitted, a unique RFC1035
   * id is generated. Immutable — changing it replaces the attestor.
   */
  attestorId?: string;
  /**
   * Grafeas Attestation Authority note this attestor reads, as
   * `projects/{project}/notes/{note}` or a note id in the same project.
   * Immutable — changing it replaces the attestor.
   */
  noteReference: string;
  /**
   * Human-readable comment. Binary Authorization attestors have no labels
   * field, so Alchemy stamps ownership into this field for `list` / nuke
   * and strips the marker from attributes.
   */
  description?: string;
  /**
   * Public keys that verify attestations signed by this attestor. Empty
   * means the attestor never reports a valid attestation.
   */
  publicKeys?: AttestorPublicKey[];
};

export type Attestor = Resource<
  "GCP.BinaryAuthorization.Attestor",
  AttestorProps,
  {
    /** Full resource name `projects/{project}/attestors/{attestor}`. */
    name: string;
    /** Attestor id (last path segment). */
    attestorId: string;
    /** Project id. */
    project: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Grafeas note this attestor reads. */
    noteReference: string;
    /** Public keys that verify attestations. */
    publicKeys: AttestorPublicKey[];
    /**
     * Service account Binary Authorization uses when querying Container
     * Analysis for this attestor.
     */
    delegationServiceAccountEmail: string | undefined;
    /** Server-assigned checksum for optimistic concurrency. */
    etag: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Binary Authorization attestor that verifies container-image
 * attestations against a Grafeas Attestation Authority note.
 *
 * Attestors have no labels field, so Alchemy stamps ownership into
 * `description` for `list` / nuke. `attestorId` and `noteReference` are
 * identity — changing either replaces the attestor. Description and
 * public keys update in place.
 *
 * ### Creating an Attestor
 * **Example:** Generated name
 * ```typescript
 * const note = yield* GCP.ContainerAnalysis.Note("Authority", {
 *   attestation: { hint: { humanReadableName: "QA" } },
 * });
 * const attestor = yield* GCP.BinaryAuthorization.Attestor("Qa", {
 *   noteReference: note.name,
 * });
 * ```
 *
 * **Example:** Explicit id, description, and PKIX key
 * ```typescript
 * const attestor = yield* GCP.BinaryAuthorization.Attestor("Qa", {
 *   attestorId: "qa-attestor",
 *   noteReference: note.name,
 *   description: "signs production images",
 *   publicKeys: [
 *     {
 *       comment: "ci",
 *       pkixPublicKey: {
 *         publicKeyPem: pem,
 *         signatureAlgorithm: "EC_SIGN_P256_SHA256",
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * ### Updating an Attestor
 * **Example:** Change the description
 * ```typescript
 * const attestor = yield* GCP.BinaryAuthorization.Attestor("Qa", {
 *   description: "signs staging and production images",
 * });
 * ```
 *
 * @resource
 * @category BinaryAuthorization
 */
export const Attestor = Resource<Attestor>("GCP.BinaryAuthorization.Attestor");

export class NoteReferenceRequired extends Data.TaggedError(
  "GCP.BinaryAuthorization.NoteReferenceRequired",
)<{
  attestorId: string;
}> {}

const getByName = missingGet(binaryauthorization.getProjectsAttestors);

const toAttrs = (
  attestor: binaryauthorization.Attestor,
  project: string,
): Attestor["Attributes"] => {
  const name = attestor.name ?? "";
  const parsed = parseAttestorName(name);
  const { description } = parseDescription(attestor.description);
  const note = attestor.userOwnedGrafeasNote;
  return {
    name,
    attestorId: parsed.attestorId,
    project: parsed.project || project,
    description,
    noteReference: note?.noteReference ?? "",
    publicKeys: publicKeysOf(note?.publicKeys),
    delegationServiceAccountEmail: note?.delegationServiceAccountEmail,
    etag: attestor.etag,
    updateTime: attestor.updateTime,
  };
};

const toBody = (
  news: AttestorProps,
  description: string,
  noteReference: string,
): binaryauthorization.Attestor => ({
  description,
  userOwnedGrafeasNote: {
    noteReference,
    publicKeys: news.publicKeys,
  },
});

export const AttestorProvider = () =>
  Provider.succeed(Attestor, {
    stables: ["name", "attestorId", "project", "noteReference"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousNote = lastSegment(
        olds?.noteReference ?? output?.noteReference ?? "",
      );
      const nextNote = lastSegment(news.noteReference);
      return replaceOnIdentity({
        previousId: olds?.attestorId ?? output?.attestorId,
        nextId: news.attestorId,
        extra:
          previousNote.length > 0 &&
          nextNote.length > 0 &&
          previousNote !== nextNote,
        deleteFirst: true,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const attestorId = yield* toPhysicalId(
        id,
        olds?.attestorId,
        output?.attestorId,
        "attestor",
      );
      const name = output?.name ?? attestorName(env.project, attestorId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* ownedBy(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listAttestors(env.project);
        return items
          .filter((item) => hasOwnershipMarker(item.description))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const attestorId = yield* toPhysicalId(
        id,
        news.attestorId,
        output?.attestorId,
        "attestor",
      );
      const name = attestorName(env.project, attestorId);
      if (news.noteReference.trim().length === 0) {
        return yield* new NoteReferenceRequired({ attestorId });
      }
      const desiredNote = expandNoteReference(news.noteReference, env.project);
      const ownership = yield* createOwnership(id);
      const desiredDescription = encodeDescription(ownership, news.description);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* retryTransient(
          binaryauthorization.createProjectsAttestors({
            parent: `projects/${env.project}`,
            attestorId,
            body: toBody(news, desiredDescription, desiredNote),
          }),
        ).pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observedNote = current.userOwnedGrafeasNote?.noteReference ?? "";
      const descriptionChanged = !sameText(
        current.description,
        desiredDescription,
      );
      const keysChanged = !samePublicKeys(
        current.userOwnedGrafeasNote?.publicKeys,
        news.publicKeys,
      );

      if (descriptionChanged || keysChanged) {
        current = yield* retryTransient(
          binaryauthorization.updateProjectsAttestors({
            name: current.name ?? name,
            body: {
              name: current.name ?? name,
              description: desiredDescription,
              etag: current.etag,
              userOwnedGrafeasNote: {
                noteReference: observedNote || desiredNote,
                publicKeys: news.publicKeys,
                delegationServiceAccountEmail:
                  current.userOwnedGrafeasNote?.delegationServiceAccountEmail,
              },
            },
          }),
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreGone(
        binaryauthorization.deleteProjectsAttestors({ name: output.name }),
      );
    }),
  });
