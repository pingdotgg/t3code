import { ignoredCodes } from "./internal.ts";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitGlobalOperation } from "./operations.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const MAX_NAME_LENGTH = 63;

export type LicenseDuration = compute.Duration;
export type LicenseResourceRequirements = compute.LicenseResourceRequirements;

export type LicenseProps = {
  /**
   * License name (RFC1035, 1-63 characters). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Immutable — changing
   * it replaces the license.
   */
  licenseName?: string;
  /**
   * Optional description. Compute licenses have no labels field, so
   * Alchemy ownership (`alchemy-stack` / `alchemy-stage` / `alchemy-id`)
   * is stored in a `[alchemy …]` prefix for `list` / nuke. Immutable —
   * `licenses.update` rejects it, so changing it replaces the license.
   */
  description?: string;
  /**
   * When `true`, this is an OS license. Only one OS license can be
   * attached to a disk or image. Immutable — changing it replaces the
   * license.
   * @default false
   */
  osLicense?: boolean;
  /**
   * When `false`, licenses are not copied from the source when creating
   * an image from a disk (or disk from snapshot, snapshot from disk).
   * Immutable — changing it replaces the license.
   * @default true
   */
  transferable?: boolean;
  /**
   * When `true`, this license can be appended to an existing disk.
   */
  appendableToDisk?: boolean;
  /**
   * When `true`, this license can be removed from a disk with no
   * replacement license.
   */
  removableFromDisk?: boolean;
  /**
   * When `true`, this license can only be used on multi-tenant nodes.
   * Immutable — changing it replaces the license.
   */
  multiTenantOnly?: boolean;
  /**
   * When `true`, this license can only be used on sole-tenant nodes.
   * Immutable — changing it replaces the license.
   */
  soleTenantOnly?: boolean;
  /**
   * Minimum time this license must stay attached once applied.
   */
  minimumRetention?: LicenseDuration;
  /**
   * License codes that are incompatible with this license. Immutable —
   * changing it replaces the license.
   */
  incompatibleLicenses?: string[];
  /**
   * License codes that can replace this license.
   */
  allowedReplacementLicenses?: string[];
  /**
   * License codes that must be co-attached with this license.
   */
  requiredCoattachedLicenses?: string[];
  /**
   * Deprecated resource-requirement hints (cores, ram).
   */
  resourceRequirements?: LicenseResourceRequirements;
};

export type License = Resource<
  "GCP.Compute.License",
  LicenseProps,
  {
    /** License name. */
    licenseName: string;
    /** Project id. */
    project: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Unique code used to attach this license to images and disks. */
    licenseCode: string | undefined;
    /** Whether this is an OS license. */
    osLicense: boolean;
    /** Whether the license is copied from source resources. */
    transferable: boolean;
    /** Whether the license can be appended to an existing disk. */
    appendableToDisk: boolean;
    /** Whether the license can be removed from a disk. */
    removableFromDisk: boolean;
    /** Whether the license is multi-tenant only. */
    multiTenantOnly: boolean;
    /** Whether the license is sole-tenant only. */
    soleTenantOnly: boolean;
    /** Minimum retention period. */
    minimumRetention: LicenseDuration | undefined;
    /** Incompatible license codes. */
    incompatibleLicenses: ReadonlyArray<string>;
    /** Replacement license codes. */
    allowedReplacementLicenses: ReadonlyArray<string>;
    /** Required co-attached license codes. */
    requiredCoattachedLicenses: ReadonlyArray<string>;
    /** Deprecated resource requirements. */
    resourceRequirements: LicenseResourceRequirements | undefined;
    /** Server-assigned numeric id. */
    licenseId: string | undefined;
    /** Resource self-link. */
    selfLink: string | undefined;
    /** Self-link including the numeric id. */
    selfLinkWithId: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTimestamp: string | undefined;
    /** Resource kind. */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A global Compute Engine License.
 *
 * Licenses are intended for third-party partners who publish Cloud
 * Marketplace images. Name and `osLicense` are immutable. Description and
 * the attachability flags update in place via `licenses.update`. Compute
 * License has no labels field — Alchemy stamps ownership into the
 * description so nuke can find leaked licenses.
 *
 * ### Creating a License
 * **Example:** Generated name
 * ```typescript
 * const license = yield* GCP.Compute.License("ImageLicense", {
 *   description: "marketplace os",
 *   transferable: true,
 * });
 * ```
 *
 * **Example:** Named OS license
 * ```typescript
 * const license = yield* GCP.Compute.License("ImageLicense", {
 *   licenseName: "app-os",
 *   osLicense: true,
 *   transferable: false,
 *   removableFromDisk: false,
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const License = Resource<License>("GCP.Compute.License");

export class LicenseNotResolved extends Data.TaggedError(
  "GCP.Compute.LicenseNotResolved",
)<{
  licenseName: string;
}> {}

export class LicenseStillExists extends Data.TaggedError(
  "GCP.Compute.LicenseStillExists",
)<{
  licenseName: string;
}> {}

const lastSegment = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) next = `l${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/, "");
  return next.length > 0 ? next : "license";
};

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
    );
  });

const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  return description ? `${marker}\n${description}` : marker;
};

const parseDescription = (
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
    if (eq > 0) labels[part.slice(0, eq)] = part.slice(eq + 1);
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

const hasOwnershipMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const sorted = (values: ReadonlyArray<string> | undefined) =>
  [...(values ?? [])].map((value) => lastSegment(value)).sort();

const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

const immutableChanged = (olds: LicenseProps, news: LicenseProps) =>
  (olds.description ?? "") !== (news.description ?? "") ||
  (olds.transferable ?? true) !== (news.transferable ?? true) ||
  (olds.multiTenantOnly ?? false) !== (news.multiTenantOnly ?? false) ||
  (olds.soleTenantOnly ?? false) !== (news.soleTenantOnly ?? false) ||
  sorted(olds.incompatibleLicenses).join(",") !==
    sorted(news.incompatibleLicenses).join(",") ||
  sorted(olds.requiredCoattachedLicenses).join(",") !==
    sorted(news.requiredCoattachedLicenses).join(",");

const toAttrs = (
  license: compute.License,
  project: string,
): License["Attributes"] => {
  const parsed = parseDescription(license.description);
  return {
    licenseName: license.name ?? "",
    project,
    description: parsed.description,
    licenseCode: license.licenseCode,
    osLicense: license.osLicense === true,
    transferable: license.transferable !== false,
    appendableToDisk: license.appendableToDisk === true,
    removableFromDisk: license.removableFromDisk === true,
    multiTenantOnly: license.multiTenantOnly === true,
    soleTenantOnly: license.soleTenantOnly === true,
    minimumRetention: license.minimumRetention,
    incompatibleLicenses: license.incompatibleLicenses ?? [],
    allowedReplacementLicenses: license.allowedReplacementLicenses ?? [],
    requiredCoattachedLicenses: license.requiredCoattachedLicenses ?? [],
    resourceRequirements: license.resourceRequirements,
    licenseId: license.id,
    selfLink: license.selfLink,
    selfLinkWithId: license.selfLinkWithId,
    creationTimestamp: license.creationTimestamp,
    updateTimestamp: license.updateTimestamp,
    kind: license.kind,
  };
};

const getByName = (project: string, license: string) =>
  compute
    .getLicenses({ project, license })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const awaitResource = (project: string, licenseName: string) =>
  getByName(project, licenseName).pipe(
    Effect.flatMap((license) =>
      license !== undefined
        ? Effect.succeed(license)
        : Effect.fail(new LicenseNotResolved({ licenseName })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.LicenseNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (project: string, licenseName: string) =>
  getByName(project, licenseName).pipe(
    Effect.flatMap((license) =>
      license === undefined
        ? Effect.void
        : Effect.fail(new LicenseStillExists({ licenseName })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.LicenseStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
    Effect.catchTag("GCP.Compute.LicenseStillExists", () => Effect.void),
  );

const runOp = <E extends { readonly _tag: string }, R>(
  project: string,
  licenseName: string,
  start: Effect.Effect<compute.Operation, E, R>,
  options?: { ignoreAlreadyExists?: boolean; ignoreNotFound?: boolean },
) =>
  start.pipe(
    Effect.flatMap((operation) =>
      waitGlobalOperation(project, operation, {
        ignore: ignoredCodes(options),
      }),
    ),
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      times: 5,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const insertBody = (
  licenseName: string,
  news: LicenseProps,
  description: string,
): compute.License => ({
  name: licenseName,
  description,
  osLicense: news.osLicense === true ? true : undefined,
  transferable: news.transferable,
  appendableToDisk: news.appendableToDisk,
  removableFromDisk: news.removableFromDisk,
  multiTenantOnly: news.multiTenantOnly,
  soleTenantOnly: news.soleTenantOnly,
  minimumRetention: news.minimumRetention,
  incompatibleLicenses: news.incompatibleLicenses,
  allowedReplacementLicenses: news.allowedReplacementLicenses,
  requiredCoattachedLicenses: news.requiredCoattachedLicenses,
  resourceRequirements: news.resourceRequirements,
});

export const LicenseProvider = () =>
  Provider.succeed(License, {
    stables: [
      "licenseName",
      "project",
      "licenseId",
      "licenseCode",
      "osLicense",
      "selfLink",
      "selfLinkWithId",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName = olds?.licenseName ?? output?.licenseName;
      const nextName = news.licenseName ?? previousName;
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName;
      const previousOs = olds?.osLicense ?? output?.osLicense ?? false;
      const nextOs = news.osLicense ?? previousOs;
      if (nameChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (previousOs !== nextOs) {
        return { action: "replace" as const, deleteFirst: true };
      }
      // `licenses.update` only accepts appendableToDisk, removableFromDisk,
      // allowedReplacementLicenses, and minimumRetention; every other field
      // is fixed at insert.
      if (olds !== undefined && immutableChanged(olds, news)) {
        return {
          action: "replace" as const,
          deleteFirst: news.licenseName !== undefined,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const licenseName = yield* toName(
        id,
        olds?.licenseName,
        output?.licenseName,
      );
      const existing = yield* getByName(env.project, licenseName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* compute.listLicenses
          .items({
            project: env.project,
            maxResults: 500,
          })
          .pipe(
            Stream.filter((license) => hasOwnershipMarker(license.description)),
            Stream.map((license) => toAttrs(license, env.project)),
            Stream.runCollect,
            Effect.map((items) => Array.from(items)),
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as License["Attributes"][]),
            ),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const licenseName = yield* toName(
        id,
        news.licenseName,
        output?.licenseName,
      );
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);

      let current = yield* getByName(env.project, licenseName);

      if (current === undefined) {
        yield* compute
          .insertLicenses({
            project: env.project,
            body: insertBody(licenseName, news, desiredDescription),
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation, {
                ignore: ["RESOURCE_ALREADY_EXISTS"],
              }),
            ),
            Effect.catchTag("Conflict", () => Effect.void),
          );
        current = yield* awaitResource(env.project, licenseName);
      }

      const appendable =
        news.appendableToDisk ?? current.appendableToDisk === true;
      const removable =
        news.removableFromDisk ?? current.removableFromDisk === true;
      const updateMask = [
        (current.appendableToDisk === true) !== appendable &&
          "appendableToDisk",
        (current.removableFromDisk === true) !== removable &&
          "removableFromDisk",
        news.allowedReplacementLicenses !== undefined &&
          sorted(current.allowedReplacementLicenses).join(",") !==
            sorted(news.allowedReplacementLicenses).join(",") &&
          "allowedReplacementLicenses",
        news.minimumRetention !== undefined &&
          !sameJson(current.minimumRetention, news.minimumRetention) &&
          "minimumRetention",
      ].filter((field): field is string => typeof field === "string");

      if (updateMask.length > 0) {
        yield* runOp(
          env.project,
          licenseName,
          compute.updateLicenses({
            project: env.project,
            license: licenseName,
            updateMask: updateMask.join(","),
            body: {
              appendableToDisk: appendable,
              removableFromDisk: removable,
              allowedReplacementLicenses:
                news.allowedReplacementLicenses ??
                current.allowedReplacementLicenses,
              minimumRetention:
                news.minimumRetention ?? current.minimumRetention,
            },
          }),
        );
        current = (yield* getByName(env.project, licenseName)) ?? current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.licenseName) return;
      const env = yield* GcpEnvironment.current;
      const project = output.project || env.project;
      yield* compute
        .deleteLicenses({
          project,
          license: output.licenseName,
        })
        .pipe(
          Effect.flatMap((operation) =>
            waitGlobalOperation(project, operation, {
              ignore: ["RESOURCE_NOT_FOUND"],
            }),
          ),
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
        );
      yield* waitUntilGone(project, output.licenseName);
    }),
  });
