import * as amp from "@distilled.cloud/aws/amp";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { decodeDefinition, encodeDefinition } from "./internal.ts";

export interface AlertManagerDefinitionProps {
  /**
   * Id of the AMP workspace this alert manager definition belongs to. A
   * workspace has at most one alert manager definition. Changing the
   * workspace replaces the definition.
   */
  workspaceId: string;
  /**
   * The Alertmanager configuration as a YAML document (the `alertmanager.yml`
   * shape, with `alertmanager_config` and optional `template_files` keys).
   * Updated in place.
   */
  definition: string;
}

export interface AlertManagerDefinition extends Resource<
  "AWS.AMP.AlertManagerDefinition",
  AlertManagerDefinitionProps,
  {
    workspaceId: string;
    status: string;
  },
  never,
  Providers
> {}

/**
 * The Alertmanager definition for an Amazon Managed Service for Prometheus
 * workspace — configures how firing alerts are grouped, routed, and
 * dispatched to receivers (SNS, etc.). A workspace has at most one.
 *
 * @resource
 * @section Creating an Alert Manager Definition
 * @example Basic Definition
 * ```typescript
 * const workspace = yield* AMP.Workspace("Metrics", {});
 * const alerts = yield* AMP.AlertManagerDefinition("Alerts", {
 *   workspaceId: workspace.workspaceId,
 *   definition: `alertmanager_config: |
 *   route:
 *     receiver: default
 *   receivers:
 *     - name: default`,
 * });
 * ```
 */
export const AlertManagerDefinition = Resource<AlertManagerDefinition>(
  "AWS.AMP.AlertManagerDefinition",
);

export const AlertManagerDefinitionProvider = () =>
  Provider.effect(
    AlertManagerDefinition,
    Effect.gen(function* () {
      /** Describe the definition; typed not-found → undefined. */
      const describe = Effect.fn(function* (workspaceId: string) {
        const response = yield* amp
          .describeAlertManagerDefinition({ workspaceId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.alertManagerDefinition;
      });

      /**
       * Best-effort poll toward ACTIVE. The workspace's Alertmanager
       * component can take a few minutes to provision, so we do not block a
       * deploy on it: we wait a bounded window and return the last observed
       * status (CREATING converges on a later reconcile). A definition in
       * CREATING / UPDATING omits its `data` blob from the description.
       */
      const waitActive = Effect.fn(function* (workspaceId: string) {
        return yield* amp.describeAlertManagerDefinition({ workspaceId }).pipe(
          Effect.map((r) => r.alertManagerDefinition),
          Effect.repeat({
            schedule: Schedule.max([
              Schedule.fixed("3 seconds"),
              Schedule.recurs(20),
            ]),
            until: (d) => d.status.statusCode === "ACTIVE",
          }),
        );
      });

      return {
        stables: ["workspaceId"],

        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (olds?.workspaceId !== news.workspaceId) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ olds, output }) {
          const workspaceId = output?.workspaceId ?? olds?.workspaceId;
          if (!workspaceId) return undefined;
          const def = yield* describe(workspaceId);
          if (def === undefined) return undefined;
          // AMP alert manager definitions are not taggable — ownership is
          // implied by the owned parent workspace.
          return { workspaceId, status: def.status.statusCode };
        }),

        reconcile: Effect.fn(function* ({ news, session }) {
          const workspaceId = news!.workspaceId;
          const desiredData = yield* encodeDefinition(news!.definition);

          // 1. Observe — the live definition is authoritative.
          const existing = yield* describe(workspaceId);

          // 2/3. Ensure + sync — create when absent, put when the YAML drifts.
          // `data` is present once ACTIVE (omitted while CREATING).
          if (existing === undefined) {
            yield* amp.createAlertManagerDefinition({
              workspaceId,
              data: desiredData,
            });
          } else {
            const currentDefinition =
              existing.data !== undefined
                ? yield* decodeDefinition(existing.data)
                : undefined;
            if (currentDefinition !== news!.definition) {
              yield* amp.putAlertManagerDefinition({
                workspaceId,
                data: desiredData,
              });
            }
          }

          // Wait for ACTIVE so the returned status and data blob are settled.
          const fresh = yield* waitActive(workspaceId);

          yield* session.note(workspaceId);
          return { workspaceId, status: fresh.status.statusCode };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* amp
            .deleteAlertManagerDefinition({ workspaceId: output.workspaceId })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              Effect.retry({
                while: (e) => e._tag === "ConflictException",
                schedule: Schedule.max([
                  Schedule.fixed("3 seconds"),
                  Schedule.recurs(20),
                ]),
              }),
            );
        }),

        // Singleton sub-resource keyed by its parent workspace.
        list: () => Effect.succeed([]),
      };
    }),
  );
