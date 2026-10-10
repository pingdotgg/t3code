import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import { createHash } from "node:crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { unzipFiles, zipFiles } from "../../Util/zip.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createInternalLabels,
  encodeOwnership,
  hasAlchemyLabels,
  hasOwnershipMarker,
  lastSegment,
  orgIdOf,
  orgParent,
  parseOwnership,
  xmlEscape,
  xmlUnescape,
} from "./ownership.ts";

const MAX_ID_LENGTH = 255;

export type SharedflowProps = {
  /**
   * Shared flow id (the `{sharedflow}` segment of
   * `organizations/{org}/sharedflows/{sharedflow}`). If omitted, a unique
   * name is generated from the stack, stage, and logical id. Restrict
   * characters to `A-Za-z0-9._-`. Immutable — changing it replaces the
   * shared flow.
   */
  sharedflowId?: string;
  /**
   * Apigee organization id. Defaults to the stack GCP project. Immutable —
   * changing it replaces the shared flow.
   */
  organization?: string;
  /**
   * Space id to associate with this shared flow. Only applied on create;
   * subsequent space changes call `move`.
   */
  space?: string;
  /**
   * Base64-encoded ZIP shared-flow bundle. If omitted, Alchemy uploads a
   * minimal empty shared flow. Shared flows have no labels field, so
   * Alchemy ownership is stored in the bundle `Description` for `list` /
   * nuke. Uploading a new bundle (or changing `description`) creates a
   * new revision.
   */
  bundle?: string;
  /**
   * Human-readable description stored in the shared-flow bundle. Alchemy
   * ownership (`alchemy-stack` / `alchemy-stage` / `alchemy-id`) is
   * prefixed and stripped from attributes.
   */
  description?: string;
};

export type Sharedflow = Resource<
  "GCP.Apigee.Sharedflow",
  SharedflowProps,
  {
    /** Full resource name `organizations/{org}/sharedflows/{sharedflow}`. */
    name: string;
    /** Shared flow id (last path segment). */
    sharedflowId: string;
    /** Apigee organization id. */
    organization: string;
    /** Space id, if the shared flow is associated with a space. */
    space: string | undefined;
    /** Latest revision id. */
    latestRevisionId: string | undefined;
    /** Known revision ids. */
    revision: string[];
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Created-at timestamp in milliseconds since epoch. */
    createdAt: string | undefined;
    /** Last-modified timestamp in milliseconds since epoch. */
    lastModifiedAt: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Apigee shared flow — a reusable sequence of policies that API
 * proxies (or other shared flows) invoke with a FlowCallout.
 *
 * Shared flows have no labels field, so Alchemy stamps ownership into
 * the bundle `Description` for `list` / nuke. `sharedflowId` and
 * `organization` are identity — changing either replaces the shared
 * flow. Uploading a bundle or changing `description` creates a new
 * revision. `space` is moved in place.
 *
 * ### Creating a Shared Flow
 * **Example:** Generated empty bundle
 * ```typescript
 * const flow = yield* GCP.Apigee.Sharedflow("Traffic", {
 *   description: "rate limit and spike arrest",
 * });
 * ```
 *
 * **Example:** Explicit id and space
 * ```typescript
 * const flow = yield* GCP.Apigee.Sharedflow("Traffic", {
 *   sharedflowId: "traffic-management",
 *   space: team.spaceId,
 *   description: "rate limit and spike arrest",
 * });
 * ```
 *
 * ### Updating a Shared Flow
 * **Example:** New description (creates a revision)
 * ```typescript
 * const flow = yield* GCP.Apigee.Sharedflow("Traffic", {
 *   description: "rate limit only",
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const Sharedflow = Resource<Sharedflow>("GCP.Apigee.Sharedflow");

export class SharedflowNotResolved extends Data.TaggedError(
  "GCP.Apigee.SharedflowNotResolved",
)<{
  name: string;
}> {}

const sanitizeId = (name: string): string => {
  let next = name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+/, "");
  if (!/^[A-Za-z]/.test(next)) {
    next = `s${next}`;
  }
  next = next.slice(0, MAX_ID_LENGTH).replace(/[^A-Za-z0-9]+$/g, "");
  return next.length > 0 ? next : "sharedflow";
};

const resourceName = (org: string, sharedflowId: string) =>
  `${orgParent(org)}/sharedflows/${sharedflowId}`;

const sharedflowIdOf = (flow: apigee.GoogleCloudApigeeV1SharedFlow) => {
  const raw = flow.name ?? "";
  return raw.includes("/") ? lastSegment(raw) : raw;
};

const toId = (
  id: string,
  sharedflowId: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (sharedflowId !== undefined) return sanitizeId(sharedflowId);
    if (existing !== undefined) return existing;
    return sanitizeId(
      yield* createPhysicalName({
        id,
        maxLength: MAX_ID_LENGTH,
        lowercase: true,
      }),
    );
  });

const sha12 = (value: string) =>
  Effect.sync(() =>
    createHash("sha256").update(value).digest("hex").slice(0, 12),
  );

const bundleXml = (sharedflowId: string, description: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<SharedFlowBundle name="${xmlEscape(sharedflowId)}">
  <ConfigurationVersion majorVersion="4" minorVersion="0"/>
  <Description>${xmlEscape(description)}</Description>
  <DisplayName>${xmlEscape(sharedflowId)}</DisplayName>
  <SharedFlows>
    <SharedFlow>default</SharedFlow>
  </SharedFlows>
</SharedFlowBundle>
`;

const defaultFlowXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<SharedFlow name="default">
</SharedFlow>
`;

const toBase64 = (bytes: Uint8Array) =>
  Effect.sync(() => Buffer.from(bytes).toString("base64"));

const makeEmptyBundle = (sharedflowId: string, description: string) =>
  zipFiles([
    {
      path: `sharedflowbundle/${sharedflowId}.xml`,
      content: bundleXml(sharedflowId, description),
    },
    {
      path: "sharedflowbundle/sharedflows/default.xml",
      content: defaultFlowXml,
    },
  ]).pipe(Effect.flatMap(toBase64));

const bundleXmlPath = (paths: ReadonlyArray<string>) =>
  paths.find((path) => /^sharedflowbundle\/[^/]+\.xml$/i.test(path));

const stampBundle = (base64: string, description: string) =>
  Effect.gen(function* () {
    const bytes = yield* Effect.sync(() => Buffer.from(base64, "base64"));
    const entries = yield* unzipFiles(bytes);
    const xmlPath = bundleXmlPath(Object.keys(entries));
    if (xmlPath !== undefined) {
      const xml = yield* Effect.sync(() =>
        Buffer.from(entries[xmlPath]!).toString("utf8"),
      );
      const escaped = `<Description>${xmlEscape(description)}</Description>`;
      const next = xml.includes("<Description>")
        ? xml.replace(/<Description>[\s\S]*?<\/Description>/, escaped)
        : xml.replace(
            /<\/SharedFlowBundle>/,
            `  ${escaped}\n</SharedFlowBundle>`,
          );
      entries[xmlPath] = yield* Effect.sync(() => Buffer.from(next, "utf8"));
    }
    // zipFiles sorts entries and stamps a fixed timestamp, so restamping the
    // bundle is byte-identical for identical content.
    const archive = yield* zipFiles(
      Object.entries(entries).map(([path, content]) => ({ path, content })),
    );
    return yield* toBase64(archive);
  });

const desiredBundle = (
  sharedflowId: string,
  description: string,
  bundle: string | undefined,
) =>
  bundle !== undefined
    ? stampBundle(bundle, description)
    : makeEmptyBundle(sharedflowId, description);

const toAttrs = (
  flow: apigee.GoogleCloudApigeeV1SharedFlow,
  org: string,
  description: string | undefined,
) => {
  const sharedflowId = sharedflowIdOf(flow);
  const parsed = parseOwnership(description);
  return {
    name: resourceName(org, sharedflowId),
    sharedflowId,
    organization: org,
    space: flow.space,
    latestRevisionId: flow.latestRevisionId,
    revision: [...(flow.revision ?? [])],
    description: parsed.text,
    createdAt: flow.metaData?.createdAt,
    lastModifiedAt: flow.metaData?.lastModifiedAt,
  };
};

const getByName = (name: string) =>
  apigee
    .getOrganizationsSharedflows({ name })
    .pipe(
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

const getRevision = (name: string) =>
  apigee
    .getOrganizationsSharedflowsRevisions({ name, format: "bundle" })
    .pipe(
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

const descriptionFromBundle = (body: apigee.GoogleApiHttpBody | undefined) =>
  Effect.gen(function* () {
    const data = body?.data;
    if (data === undefined || data.length === 0) return undefined;
    const bytes = yield* Effect.sync(() => Buffer.from(data, "base64"));
    const entries = yield* unzipFiles(bytes);
    const xmlPath = bundleXmlPath(Object.keys(entries));
    if (xmlPath === undefined) return undefined;
    const xml = yield* Effect.sync(() =>
      Buffer.from(entries[xmlPath]!).toString("utf8"),
    );
    const match = xml.match(/<Description>([\s\S]*?)<\/Description>/);
    if (match?.[1] === undefined) return undefined;
    return xmlUnescape(match[1]);
  });

const revisionName = (org: string, sharedflowId: string, revisionId: string) =>
  `${resourceName(org, sharedflowId)}/revisions/${revisionId}`;

const observedDescription = (
  org: string,
  flow: apigee.GoogleCloudApigeeV1SharedFlow,
) =>
  Effect.gen(function* () {
    const sharedflowId = sharedflowIdOf(flow);
    const latest = flow.latestRevisionId;
    if (!sharedflowId || !latest) return undefined;
    const revision = yield* getRevision(
      revisionName(org, sharedflowId, latest),
    );
    return yield* descriptionFromBundle(revision);
  });

const importBundle = (input: {
  org: string;
  sharedflowId: string;
  space?: string;
  data: string;
}) =>
  apigee.createOrganizationsSharedflows({
    parent: orgParent(input.org),
    action: "import",
    name: input.sharedflowId,
    space: input.space,
    body: {
      contentType: "application/octet-stream",
      data: input.data,
    },
  });

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((flow) =>
      flow
        ? Effect.succeed(flow)
        : Effect.fail(new SharedflowNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Apigee.SharedflowNotResolved",
      times: 8,
      schedule: Schedule.exponential("250 millis"),
    }),
  );

export const SharedflowProvider = () =>
  Provider.succeed(Sharedflow, {
    stables: ["name", "sharedflowId", "organization", "createdAt"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.sharedflowId ?? output?.sharedflowId;
      const idChanged =
        previousId !== undefined &&
        news.sharedflowId !== undefined &&
        sanitizeId(news.sharedflowId) !== previousId;
      const previousOrg = olds?.organization ?? output?.organization;
      const orgChanged =
        previousOrg !== undefined &&
        news.organization !== undefined &&
        orgIdOf(news.organization, previousOrg) !== previousOrg;
      if (idChanged || orgChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const org = orgIdOf(
        olds?.organization ?? output?.organization,
        env.project,
      );
      const sharedflowId = yield* toId(
        id,
        olds?.sharedflowId,
        output?.sharedflowId,
      );
      const name = output?.name ?? resourceName(org, sharedflowId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const description = yield* observedDescription(org, existing);
      const attrs = toAttrs(existing, org, description);
      const { labels } = parseOwnership(description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const org = env.project;
        const page = yield* apigee
          .listOrganizationsSharedflows({
            parent: orgParent(org),
            includeRevisions: true,
            includeMetaData: true,
          })
          .pipe(
            Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
              Effect.succeed({ sharedFlows: [] }),
            ),
          );
        const owned = yield* Effect.forEach(
          page.sharedFlows ?? [],
          (flow) =>
            Effect.gen(function* () {
              const description = yield* observedDescription(org, flow);
              if (!hasOwnershipMarker(description)) return undefined;
              return toAttrs(flow, org, description);
            }),
          { concurrency: 8 },
        );
        return owned.filter((flow) => flow !== undefined);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const org = orgIdOf(
        news.organization ?? output?.organization,
        env.project,
      );
      const sharedflowId = yield* toId(
        id,
        news.sharedflowId,
        output?.sharedflowId,
      );
      const name = resourceName(org, sharedflowId);
      const ownership = yield* createInternalLabels(id);
      const extra =
        news.bundle !== undefined
          ? { bundle: yield* sha12(news.bundle) }
          : undefined;
      const desiredDescription = encodeOwnership(
        ownership,
        news.description,
        extra,
      );
      const data = yield* desiredBundle(
        sharedflowId,
        desiredDescription,
        news.bundle,
      );

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        yield* importBundle({
          org,
          sharedflowId,
          space: news.space,
          data,
        }).pipe(Effect.catchTag("Conflict", () => Effect.void));
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new SharedflowNotResolved({ name });
      }

      const observed = yield* observedDescription(org, current);
      if ((observed ?? "") !== desiredDescription) {
        yield* importBundle({
          org,
          sharedflowId,
          data,
        });
        current = yield* waitUntilExists(name);
      }

      const desiredSpace = news.space ?? "";
      const observedSpace = current.space ?? "";
      if (desiredSpace !== observedSpace) {
        current = yield* apigee.moveOrganizationsSharedflows({
          name,
          body: { space: news.space },
        });
      }

      const description = yield* observedDescription(org, current);
      return toAttrs(current, org, description);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apigee
        .deleteOrganizationsSharedflows({ name: output.name })
        .pipe(
          Effect.catchTag(
            ["NotFound", "ApigeeResourceNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });
