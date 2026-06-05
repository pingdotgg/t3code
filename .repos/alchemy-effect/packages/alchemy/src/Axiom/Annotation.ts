import * as Axiom from "@distilled.cloud/axiom";
import * as Effect from "effect/Effect";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

export type AnnotationProps = Axiom.CreateAnnotationInput;

export type Annotation = Resource<
  "Axiom.Annotation",
  AnnotationProps,
  Axiom.CreateAnnotationOutput,
  never,
  Providers
>;

/**
 * An Axiom annotation — a vertical marker overlaid on charts to flag a
 * deploy, incident, feature flag flip, or any other point/range event you
 * want correlated with telemetry.
 *
 * Annotations are scoped to one or more `datasets`. Use a single `time` for
 * a point marker or `time` + `endTime` for a range. The `type` (e.g.
 * `"deploy"`, `"incident"`) groups markers visually in the UI.
 *
 * Although typically created at deploy/release time (out-of-band of
 * regular IaC), modelling them as resources makes per-environment
 * annotation history reproducible.
 *
 * @see https://axiom.co/docs/query-data/annotate-charts
 *
 * @section Creating an Annotation
 * @example Point-in-time deploy marker
 * ```typescript
 * yield* Axiom.Annotation("deploy-1.2.3", {
 *   type: "deploy",
 *   title: "Release 1.2.3",
 *   description: "https://github.com/acme/app/releases/tag/v1.2.3",
 *   datasets: ["my-app-traces", "my-app-logs"],
 *   time: new Date().toISOString(),
 *   url: "https://github.com/acme/app/releases/tag/v1.2.3",
 * });
 * ```
 *
 * @example Incident time-range
 * ```typescript
 * yield* Axiom.Annotation("inc-2026-04-27", {
 *   type: "incident",
 *   title: "Database failover",
 *   datasets: ["my-app-traces"],
 *   time:    "2026-04-27T18:05:00Z",
 *   endTime: "2026-04-27T18:32:00Z",
 *   url: "https://incident.io/incidents/abc123",
 * });
 * ```
 */
export const Annotation = Resource<Annotation>("Axiom.Annotation");

export const AnnotationProvider = () =>
  Provider.effect(
    Annotation,
    Effect.gen(function* () {
      const create = yield* Axiom.createAnnotation;
      const update = yield* Axiom.updateAnnotation;
      const get = yield* Axiom.getAnnotation;
      const del = yield* Axiom.deleteAnnotation;

      return {
        stables: ["id"],
        reconcile: Effect.fn(function* ({ news, output }) {
          // Observe — Axiom assigns the annotation id server-side, so the
          // only handle to a previously-created annotation is the cached
          // `output.id`. Probe for live state with that id; treat NotFound
          // (deleted out-of-band, or never created) as "no observed state".
          const observed = output?.id
            ? yield* get({ id: output.id }).pipe(
                Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
              )
            : undefined;

          // Ensure — when no observed annotation exists, POST creates one
          // and Axiom assigns the id.
          if (observed === undefined) {
            return yield* create(news);
          }

          // Sync — the annotation exists; apply desired props with PUT and
          // preserve the stable id and original time as fallbacks.
          const result = yield* update({ ...news, id: observed.id! });
          return {
            ...result,
            id: observed.id!,
            time: result.time ?? output?.time ?? news.time,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* del({ id: output.id }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.id) return undefined;
          return yield* get({ id: output.id }).pipe(
            Effect.map((current) => ({
              ...current,
              id: current.id ?? output.id,
              time: current.time ?? output.time,
            })),
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
        }),
      };
    }),
  );
