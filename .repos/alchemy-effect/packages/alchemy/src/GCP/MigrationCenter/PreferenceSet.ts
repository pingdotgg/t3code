import * as mc from "@distilled.cloud/gcp/migrationcenter_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnership,
  fieldMask,
  fingerprint,
  hasOwnershipMarker,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  parseName,
  parseOwnership,
  replaceOnIdentity,
  ResourceNotResolved,
  toPhysicalId,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type VirtualMachinePreferences = mc.VirtualMachinePreferences;

export type PreferenceSetProps = {
  /**
   * Preference set id (the `{preferenceSet}` segment of
   * `projects/{project}/locations/{location}/preferenceSets/{preferenceSet}`).
   * If omitted, a unique RFC1035 name is generated. Immutable — changing
   * it replaces the preference set.
   */
  preferenceSetId?: string;
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the
   * preference set. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * User-friendly display name. Maximum length is 63 characters.
   */
  displayName?: string;
  /**
   * Free-text description. Preference sets have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
  /**
   * Preferences that apply to virtual machines in this set.
   */
  virtualMachinePreferences?: VirtualMachinePreferences;
};

export type PreferenceSet = Resource<
  "GCP.MigrationCenter.PreferenceSet",
  PreferenceSetProps,
  {
    /** Full resource name. */
    name: string;
    /** Preference set id (last path segment). */
    preferenceSetId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User-friendly display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Virtual machine preferences. */
    virtualMachinePreferences: VirtualMachinePreferences | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

// Report input rather than the preference set's own location; kept fixed so a
// stack-region change doesn't rewrite existing preference sets.
const DEFAULT_VM: VirtualMachinePreferences = {
  targetProduct: "COMPUTE_MIGRATION_TARGET_PRODUCT_COMPUTE_ENGINE",
  regionPreferences: { preferredRegions: ["us-central1"] },
  sizingOptimizationStrategy: "SIZING_OPTIMIZATION_STRATEGY_MODERATE",
  commitmentPlan: "COMMITMENT_PLAN_THREE_YEARS",
};

/**
 * A Migration Center preference set capturing target-product, region, and
 * sizing assumptions used when generating reports.
 *
 * Preference sets have no labels field — Alchemy stamps ownership into
 * the description so `list` / nuke can find them. Id and location are
 * immutable. Display name, description, and VM preferences update in
 * place.
 *
 * ### Creating a Preference Set
 * **Example:** Compute Engine defaults
 * ```typescript
 * const prefs = yield* GCP.MigrationCenter.PreferenceSet("Prod", {
 *   displayName: "prod-gce",
 * });
 * ```
 *
 * **Example:** Explicit VM preferences
 * ```typescript
 * const prefs = yield* GCP.MigrationCenter.PreferenceSet("Prod", {
 *   virtualMachinePreferences: {
 *     targetProduct: "COMPUTE_MIGRATION_TARGET_PRODUCT_COMPUTE_ENGINE",
 *     regionPreferences: { preferredRegions: ["us-central1"] },
 *     sizingOptimizationStrategy: "SIZING_OPTIMIZATION_STRATEGY_MODERATE",
 *     commitmentPlan: "COMMITMENT_PLAN_THREE_YEARS",
 *   },
 * });
 * ```
 *
 * @resource
 * @category MigrationCenter
 */
export const PreferenceSet = Resource<PreferenceSet>(
  "GCP.MigrationCenter.PreferenceSet",
);

const resourceName = (
  project: string,
  location: string,
  preferenceSetId: string,
) => `${locationParent(project, location)}/preferenceSets/${preferenceSetId}`;

const toAttrs = (item: mc.PreferenceSet, project: string, region: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "preferenceSets", region);
  const ownership = parseOwnership(item.description);
  return {
    name,
    preferenceSetId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: item.displayName,
    description: ownership.text,
    virtualMachinePreferences: item.virtualMachinePreferences,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : mc
        .getProjectsLocationsPreferenceSets({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  mc.listProjectsLocationsPreferenceSets
    .pages({
      parent: `projects/${project}/locations/-`,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.preferenceSets ?? [])),
      Stream.filter((item) => hasOwnershipMarker(item.description)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () =>
        mc.listProjectsLocationsPreferenceSets
          .pages({
            parent: locationParent(project, region),
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.preferenceSets ?? []),
            ),
            Stream.filter((item) => hasOwnershipMarker(item.description)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as mc.PreferenceSet[]),
            ),
          ),
      ),
    );

export const PreferenceSetProvider = () =>
  Provider.succeed(PreferenceSet, {
    stables: ["name", "preferenceSetId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.preferenceSetId ?? output?.preferenceSetId,
        nextId:
          news.preferenceSetId ??
          olds?.preferenceSetId ??
          output?.preferenceSetId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const preferenceSetId = yield* toPhysicalId(
        id,
        olds?.preferenceSetId,
        output?.preferenceSetId,
        "prefset",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, preferenceSetId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const preferenceSetId = yield* toPhysicalId(
        id,
        news.preferenceSetId,
        output?.preferenceSetId,
        "prefset",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, preferenceSetId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const displayName = news.displayName ?? preferenceSetId;
      const virtualMachinePreferences =
        news.virtualMachinePreferences ?? DEFAULT_VM;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* mc
          .createProjectsLocationsPreferenceSets({
            parent: locationParent(env.project, location),
            preferenceSetId,
            body: {
              displayName,
              description,
              virtualMachinePreferences,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const descriptionChanged = (current.description ?? "") !== description;
      const displayNameChanged = (current.displayName ?? "") !== displayName;
      const prefsChanged =
        fingerprint(current.virtualMachinePreferences) !==
        fingerprint(virtualMachinePreferences);
      const mask = fieldMask([
        descriptionChanged && "description",
        displayNameChanged && "displayName",
        prefsChanged && "virtualMachinePreferences",
      ]);

      if (mask.length > 0) {
        const operation = yield* mc.patchProjectsLocationsPreferenceSets({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            name: current.name ?? name,
            displayName,
            description,
            virtualMachinePreferences,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* mc
        .deleteProjectsLocationsPreferenceSets({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
