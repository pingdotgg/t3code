import * as scc from "@distilled.cloud/gcp/securitycenter_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  encodeOwnership,
  hasOwnershipMarker,
  lastSegment,
  ownedByAlchemy,
  parseOwnership,
  projectOf,
  replaceOn,
  sameText,
  toResourceId,
  updateMaskOf,
} from "./internal.ts";

export type MuteConfigType =
  | "MUTE_CONFIG_TYPE_UNSPECIFIED"
  | "STATIC"
  | "DYNAMIC";

export type MuteConfigProps = {
  /**
   * Mute config id (the `{muteConfig}` segment of
   * `projects/{project}/muteConfigs/{muteConfig}`). If omitted, a unique
   * id is generated. Lowercase letters, digits, and hyphens; must start
   * with a letter; max 63 characters. Immutable — changing it replaces
   * the config.
   */
  muteConfigId?: string;
  /**
   * Finding filter that selects which findings are muted.
   */
  filter: string;
  /**
   * Human-readable description (max 1024 characters). Mute configs have
   * no labels field, so Alchemy ownership is stored in a `[alchemy …]`
   * prefix and stripped from attributes.
   */
  description?: string;
  /**
   * Mute config type. `STATIC` mutes matching findings immediately.
   * `DYNAMIC` re-evaluates until `expiryTime`. Immutable — changing it
   * replaces the config.
   * @default "STATIC"
   */
  type?: MuteConfigType;
  /**
   * RFC3339 expiry for `DYNAMIC` mute configs.
   */
  expiryTime?: string;
};

export type MuteConfig = Resource<
  "GCP.SecurityCenter.MuteConfig",
  MuteConfigProps,
  {
    /** Full resource name `projects/{project}/muteConfigs/{muteConfig}`. */
    name: string;
    /** Mute config id (last path segment). */
    muteConfigId: string;
    /** Project id. */
    project: string;
    /** Finding filter. */
    filter: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Mute config type. */
    type: string | undefined;
    /** RFC3339 expiry, if set. */
    expiryTime: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Last editor email. */
    mostRecentEditor: string | undefined;
  },
  never,
  Providers
>;

/**
 * A project-scoped Security Command Center mute config that hides matching
 * findings from the default view.
 *
 * Mute configs have no labels field — Alchemy stamps ownership into the
 * description so `list` / nuke can find them. Id and type are identity.
 * Filter, description, and expiry update in place.
 *
 * ### Creating a Mute Config
 * **Example:** Mute low-severity findings
 * ```typescript
 * const mute = yield* GCP.SecurityCenter.MuteConfig("Low", {
 *   filter: 'severity="LOW"',
 *   description: "mute low severity",
 * });
 * ```
 *
 * ### Updating a Mute Config
 * **Example:** Mute medium severity as well
 * ```typescript
 * const mute = yield* GCP.SecurityCenter.MuteConfig("Low", {
 *   filter: 'severity="LOW" OR severity="MEDIUM"',
 *   description: "mute low and medium",
 * });
 * ```
 *
 * @resource
 * @category SecurityCenter
 */
export const MuteConfig = Resource<MuteConfig>("GCP.SecurityCenter.MuteConfig");

export class MuteConfigNotResolved extends Data.TaggedError(
  "GCP.SecurityCenter.MuteConfigNotResolved",
)<{
  name: string;
}> {}

const resourceName = (project: string, muteConfigId: string) =>
  `projects/${project}/muteConfigs/${muteConfigId}`;

const toAttrs = (
  config: scc.GoogleCloudSecuritycenterV1MuteConfig,
  project: string,
) => {
  const name = config.name ?? "";
  const parsed = parseOwnership(config.description);
  return {
    name,
    muteConfigId: lastSegment(name),
    project: projectOf(name) || project,
    filter: config.filter,
    description: parsed.text,
    type: config.type,
    expiryTime: config.expiryTime,
    createTime: config.createTime,
    updateTime: config.updateTime,
    mostRecentEditor: config.mostRecentEditor,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : scc
        .getProjectsMuteConfigs({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const MuteConfigProvider = () =>
  Provider.succeed(MuteConfig, {
    stables: ["name", "muteConfigId", "project", "type", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return (
        replaceOn(
          olds?.muteConfigId ?? output?.muteConfigId,
          news.muteConfigId,
        ) ??
        replaceOn(olds?.type ?? output?.type ?? "STATIC", news.type ?? "STATIC")
      );
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const muteConfigId = yield* toResourceId(
        id,
        olds?.muteConfigId,
        output?.muteConfigId,
        "m",
      );
      const name = output?.name ?? resourceName(env.project, muteConfigId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* collectPages(
          scc.listProjectsMuteConfigs.pages({
            parent: `projects/${env.project}`,
            pageSize: 100,
          }),
          (page) => page.muteConfigs,
        ).pipe(
          Effect.catchTag("NotFound", () =>
            Effect.succeed([] as scc.GoogleCloudSecuritycenterV1MuteConfig[]),
          ),
        );
        return items
          .filter((config) => hasOwnershipMarker(config.description))
          .map((config) => toAttrs(config, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const muteConfigId = yield* toResourceId(
        id,
        news.muteConfigId,
        output?.muteConfigId,
        "m",
      );
      const name = resourceName(env.project, muteConfigId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const type = news.type ?? "STATIC";
      const body: scc.GoogleCloudSecuritycenterV1MuteConfig = {
        filter: news.filter,
        description,
        type,
        expiryTime: news.expiryTime,
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* scc
          .createProjectsMuteConfigs({
            parent: `projects/${env.project}`,
            muteConfigId,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new MuteConfigNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const filterChanged = !sameText(current.filter, news.filter);
      const descriptionChanged = !sameText(current.description, description);
      const expiryChanged = !sameText(current.expiryTime, news.expiryTime);
      const updateMask = updateMaskOf(
        filterChanged ? "filter" : undefined,
        descriptionChanged ? "description" : undefined,
        expiryChanged ? "expiry_time" : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* scc.patchProjectsMuteConfigs({
          name: currentName,
          updateMask,
          body: {
            ...body,
            name: currentName,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* scc
        .deleteProjectsMuteConfigs({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
