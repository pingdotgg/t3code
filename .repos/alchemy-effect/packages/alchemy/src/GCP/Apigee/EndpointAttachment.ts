import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  defaultOrgName,
  lastSegment,
  listOrgNames,
  orgIdOf,
  orgNameOf,
  waitForOperation,
} from "./operations.ts";

const MAX_ID_LENGTH = 32;

export type EndpointAttachmentProps = {
  /**
   * Apigee organization id or `organizations/{org}`. Defaults to the
   * current GCP project id. Immutable — changing it replaces the
   * attachment.
   */
  organization?: string;
  /**
   * Endpoint attachment id (the `{endpoint_attachment}` segment of
   * `organizations/{org}/endpointAttachments/{endpoint_attachment}`).
   * Must start with a lowercase letter, be 2-32 characters of lowercase
   * letters, numbers, or hyphens, and must not end with a hyphen. If
   * omitted, a unique `alc-` prefixed name is generated so `list` / nuke
   * can find it (the API has no labels or description). Immutable —
   * changing it replaces the attachment.
   */
  endpointAttachmentId?: string;
  /**
   * Location of the endpoint attachment. Immutable — changing it replaces
   * the attachment. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Service attachment in
   * `projects/{project}/regions/{region}/serviceAttachments/{attachment}`.
   * Immutable — changing it replaces the attachment.
   */
  serviceAttachment: string;
};

export type EndpointAttachment = Resource<
  "GCP.Apigee.EndpointAttachment",
  EndpointAttachmentProps,
  {
    /** Full resource name `organizations/{org}/endpointAttachments/{id}`. */
    name: string;
    /** Endpoint attachment id (last path segment). */
    endpointAttachmentId: string;
    /** Apigee organization id. */
    organization: string;
    /** Location. */
    location: string;
    /** Service attachment resource name. */
    serviceAttachment: string | undefined;
    /** Host that can be used as an HTTP target. */
    host: string | undefined;
    /** Server-reported state (`CREATING`, `ACTIVE`, …). */
    state: string | undefined;
    /** Connection state to the service attachment. */
    connectionState: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Apigee endpoint attachment for southbound Private Service Connect.
 *
 * The API has no labels or description, so Alchemy prefixes generated ids
 * with `alc-` so `list` / nuke can find them. All properties are identity —
 * changing any of them replaces the attachment.
 *
 * ### Creating an Endpoint Attachment
 * **Example:** Attach a service attachment in us-central1
 * ```typescript
 * const attachment = yield* GCP.Apigee.EndpointAttachment("Backend", {
 *   location: "us-central1",
 *   serviceAttachment:
 *     "projects/my-project/regions/us-central1/serviceAttachments/backend",
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const EndpointAttachment = Resource<EndpointAttachment>(
  "GCP.Apigee.EndpointAttachment",
);

export class EndpointAttachmentNotResolved extends Data.TaggedError(
  "GCP.Apigee.EndpointAttachmentNotResolved",
)<{
  name: string;
}> {}

const normalizeLocation = (
  location: string | undefined,
  defaultLocation: string,
) => (location ?? defaultLocation).toLowerCase();

const toId = (id: string, explicit: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_ID_LENGTH - 4,
      lowercase: true,
    });
    const body = generated.replace(/-+$/g, "");
    const prefixed = body.startsWith("alc") ? body : `alc-${body}`;
    return prefixed.slice(0, MAX_ID_LENGTH).replace(/-+$/g, "") || "alc-a";
  });

const resourceName = (organization: string, endpointAttachmentId: string) =>
  `${orgNameOf(organization)}/endpointAttachments/${endpointAttachmentId}`;

const toAttrs = (
  attachment: apigee.GoogleCloudApigeeV1EndpointAttachment,
  organization: string,
  region: string,
) => {
  const name = attachment.name ?? "";
  return {
    name,
    endpointAttachmentId: lastSegment(name),
    organization: orgIdOf(organization),
    location: attachment.location ?? region,
    serviceAttachment: attachment.serviceAttachment,
    host: attachment.host,
    state: attachment.state,
    connectionState: attachment.connectionState,
  };
};

const getByName = (name: string) =>
  apigee
    .getOrganizationsEndpointAttachments({ name })
    .pipe(
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

const isAlchemyId = (endpointAttachmentId: string) =>
  endpointAttachmentId.startsWith("alc");

export const EndpointAttachmentProvider = () =>
  Provider.succeed(EndpointAttachment, {
    stables: [
      "name",
      "endpointAttachmentId",
      "organization",
      "location",
      "serviceAttachment",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId =
        olds?.endpointAttachmentId ?? output?.endpointAttachmentId;
      const previousOrg = olds?.organization ?? output?.organization;
      const previousLocation = olds?.location ?? output?.location;
      const previousSa = olds?.serviceAttachment ?? output?.serviceAttachment;
      const idChanged =
        previousId !== undefined &&
        news.endpointAttachmentId !== undefined &&
        news.endpointAttachmentId !== previousId;
      const orgChanged =
        previousOrg !== undefined &&
        news.organization !== undefined &&
        orgIdOf(news.organization) !== orgIdOf(previousOrg);
      const locationChanged =
        previousLocation !== undefined &&
        normalizeLocation(news.location ?? previousLocation, env.region) !==
          normalizeLocation(previousLocation, env.region);
      const saChanged =
        previousSa !== undefined && news.serviceAttachment !== previousSa;
      if (idChanged || orgChanged || locationChanged || saChanged) {
        return {
          action: "replace" as const,
          deleteFirst: idChanged && !orgChanged,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = defaultOrgName(
        env.project,
        olds?.organization ?? output?.organization,
      );
      const endpointAttachmentId = yield* toId(
        id,
        olds?.endpointAttachmentId,
        output?.endpointAttachmentId,
      );
      const name =
        output?.name ?? resourceName(organization, endpointAttachmentId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, organization, env.region);
      return isAlchemyId(attrs.endpointAttachmentId) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const orgs = yield* listOrgNames();
        const rows: EndpointAttachment["Attributes"][] = [];
        for (const organization of orgs) {
          const attachments = yield* collectPages(
            apigee.listOrganizationsEndpointAttachments.pages({
              parent: organization,
              pageSize: 1000,
            }),
            (page) => page.endpointAttachments,
          ).pipe(
            Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
              Effect.succeed(
                [] as apigee.GoogleCloudApigeeV1EndpointAttachment[],
              ),
            ),
          );
          for (const attachment of attachments) {
            const attrs = toAttrs(attachment, organization, env.region);
            if (isAlchemyId(attrs.endpointAttachmentId)) {
              rows.push(attrs);
            }
          }
        }
        return rows;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = defaultOrgName(env.project, news.organization);
      const endpointAttachmentId = yield* toId(
        id,
        news.endpointAttachmentId,
        output?.endpointAttachmentId,
      );
      const name = resourceName(organization, endpointAttachmentId);
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const operation = yield* apigee
          .createOrganizationsEndpointAttachments({
            parent: organization,
            endpointAttachmentId,
            body: {
              location,
              serviceAttachment: news.serviceAttachment,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (operation !== undefined) {
          yield* waitForOperation(operation);
        }
        current = yield* getByName(name);
      }

      if (current === undefined) {
        return yield* new EndpointAttachmentNotResolved({ name });
      }

      return toAttrs(current, organization, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* apigee
        .deleteOrganizationsEndpointAttachments({ name: output.name })
        .pipe(
          Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
            Effect.succeed(undefined),
          ),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
    }),
  });
