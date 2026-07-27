import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  createInternalTags,
  hasAlchemyTags,
  stripInternalTags,
} from "../Tags.ts";
import { Docker, dockerPhysicalName } from "./Docker.ts";
import type { Providers } from "./Providers.ts";

export interface VolumeLabel {
  /** Label name. */
  name: string;
  /** Label value. */
  value: string;
}

export interface VolumeProps {
  /**
   * Docker volume name.
   *
   * @default Generated from stack, stage, logical id, and instance id.
   */
  name?: string;
  /** Volume driver. @default "local" */
  driver?: string;
  /** Driver-specific options. */
  driverOpts?: Record<string, string>;
  /** Custom metadata labels. */
  labels?: Record<string, string>;
}

export interface Volume extends Resource<
  "Docker.Volume",
  VolumeProps,
  {
    /** Docker volume name. */
    id: string;
    /** Docker volume name. */
    name: string;
    /** Volume driver. */
    driver: string;
    /** Driver-specific options reported by Docker. */
    driverOpts: Record<string, string>;
    /** Labels reported by Docker. */
    labels: Record<string, string>;
    /** Host mountpoint path. */
    mountpoint?: string;
    /** Creation timestamp in milliseconds since epoch. */
    createdAt: number;
  },
  never,
  Providers
> {}

/**
 * A Docker volume managed through the active Docker context.
 *
 * Pre-existing same-name volumes are treated as foreign until the engine is
 * allowed to adopt them with `--adopt` or `adopt(true)`.
 *
 * @resource
 *
 * @section Creating Volumes
 * @example Basic volume
 * ```typescript
 * const data = yield* Docker.Volume("data", {
 *   name: "app-data",
 * });
 * ```
 *
 * @example PostgreSQL data volume
 * ```typescript
 * const data = yield* Docker.Volume("postgres-data");
 * ```
 *
 * @example Driver options and labels
 * ```typescript
 * const data = yield* Docker.Volume("db-data", {
 *   driver: "local",
 *   driverOpts: {
 *     type: "nfs",
 *     o: "addr=10.0.0.1,rw",
 *     device: ":/path/to/dir",
 *   },
 *   labels: {
 *     "com.example.usage": "database",
 *   },
 * });
 * ```
 */
export const Volume = Resource<Volume>("Docker.Volume");

export const VolumeProvider = () =>
  Provider.effect(
    Volume,
    Effect.gen(function* () {
      const docker = yield* Docker;

      return Volume.Provider.of({
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ id, instanceId, olds, output }) {
          const name = yield* dockerPhysicalName(id, olds, instanceId);
          const info = yield* docker.volume
            .inspect(name)
            .pipe(
              Effect.catchReason(
                "PlatformError",
                "NotFound",
                () => Effect.undefined,
              ),
            );
          if (!info) return undefined;
          const attrs = toVolumeAttributes(info);
          if (output) return attrs;
          // Without prior state, only adopt a volume that carries our branding;
          // anything else is foreign and gated behind `--adopt`.
          const owned = yield* hasAlchemyTags(id, info.Labels ?? undefined);
          return owned ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, instanceId, output, news }) {
          if (!isResolved(news)) return undefined;
          const args = yield* makeVolumeArgs(id, news, instanceId);
          // Auto-generated names are engine-owned: the deployed name stays
          // authoritative even if the generator would name this id differently
          // today. Only an explicit user-provided name can force a replace.
          const desiredName = news?.name ?? output?.name ?? args.name;
          if (
            output?.name !== desiredName ||
            output?.driver !== args.driver ||
            !Equal.equals(output?.driverOpts ?? {}, args.opt ?? {}) ||
            // Compare only user labels; internal `alchemy::*` branding lives on
            // the observed volume but must not drive replacement.
            !Equal.equals(stripInternalTags(output?.labels), args.label ?? {})
          ) {
            return { action: "replace" as const, deleteFirst: true };
          }
        }),
        reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
          const args = yield* makeVolumeArgs(id, news, instanceId);
          // Prefer the deployed name: regenerating would target a different
          // volume if the generator's output for this id ever drifts.
          const name = news?.name ?? output?.name ?? args.name;
          const internalTags = yield* createInternalTags(id);
          const result = yield* docker.volume.create({
            ...args,
            name,
            label: { ...internalTags, ...args.label },
          });
          return toVolumeAttributes(
            yield* docker.volume.inspect(result.stdout),
          );
        }),
        delete: Effect.fn(({ output }) =>
          docker.volume
            .remove(output.name)
            .pipe(
              Effect.catchReason(
                "PlatformError",
                "NotFound",
                () => Effect.void,
              ),
            ),
        ),
      });
    }),
  );

const makeVolumeArgs = (id: string, props: VolumeProps, instanceId: string) =>
  dockerPhysicalName(id, props, instanceId).pipe(
    Effect.map(
      (name): Parameters<Docker["Service"]["volume"]["create"]>[0] => ({
        name,
        driver: props.driver ?? "local",
        opt: props.driverOpts,
        label: props.labels,
      }),
    ),
  );

export const toVolumeAttributes = (
  info: Docker.Volume,
): Volume["Attributes"] => ({
  id: info.Name,
  name: info.Name,
  driver: info.Driver,
  driverOpts: info.Options ?? {},
  labels: info.Labels ?? {},
  mountpoint: info.Mountpoint,
  createdAt: Date.parse(info.CreatedAt) || Date.now(),
});
