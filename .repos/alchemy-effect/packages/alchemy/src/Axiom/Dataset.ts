import * as Axiom from "@distilled.cloud/axiom";
import { Credentials } from "@distilled.cloud/axiom/Credentials";
import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { Stack } from "../Stack.ts";
import { Stage } from "../Stage.ts";
import type { Providers } from "./Providers.ts";

export type DatasetKind =
  | "otel:metrics:v1"
  | "otel:traces:v1"
  | "otel:logs:v1"
  | "axiom:events:v1"
  | (string & {});

export type DatasetProps = {
  /**
   * Dataset name. Used as the dataset's stable identifier in Axiom — changing
   * this triggers a replacement.
   */
  name: string;
  /** Free-form description shown in the Axiom UI. */
  description?: string;
  /**
   * Edge deployment where Axiom stores and processes the dataset's data.
   * Defaults to the organization's default edge deployment.
   *
   * Cannot be changed after creation — triggers a replacement.
   */
  edgeDeployment?: string;
  /**
   * Dataset kind. Defaults to `axiom:events:v1`.
   *
   * For OTEL pipelines, choose:
   * - `otel:traces:v1` for traces
   * - `otel:logs:v1` for logs
   * - `otel:metrics:v1` for metrics
   *
   * Cannot be changed after creation — triggers a replacement.
   */
  kind?: DatasetKind;
  /** Retention in days. Plan-dependent — see Axiom docs. */
  retentionDays?: number;
  /** Whether to enforce the configured retention period. */
  useRetentionPeriod?: boolean;
};

export type Dataset = Resource<
  "Axiom.Dataset",
  DatasetProps,
  {
    id: string;
    name: string;
    kind: DatasetKind;
    description: string;
    created: string;
    /** Edge deployment where the dataset's data is stored and processed. */
    edgeDeployment: string;
    /** Base URL for ingesting and querying data in the dataset's edge deployment. */
    edgeDeploymentUrl: string;
    /** Base URL for Axiom's centralized management API. */
    apiBaseUrl: string;
    /** Root OTLP endpoint. Most exporters auto-append the signal path. */
    otelEndpoint: string;
    /** OTLP/HTTP traces endpoint. */
    otelTracesEndpoint: string;
    /** OTLP/HTTP logs endpoint. */
    otelLogsEndpoint: string;
    /** OTLP/HTTP metrics endpoint. */
    otelMetricsEndpoint: string;
    /**
     * Headers required for OTLP shipping aside from the bearer token.
     * Add `Authorization: Bearer <AXIOM_TOKEN>` separately at runtime so the
     * secret is never persisted in resource state.
     */
    otelHeaders: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * An Axiom dataset — the top-level container that stores events, logs,
 * traces, or metrics. Pick a `kind` up-front: it determines schema and how
 * the data is shown in the UI, and **cannot be changed** after creation
 * (changing it triggers a replacement, which deletes the data).
 *
 * Datasets expose their edge deployment and Axiom's OTLP/HTTP endpoints
 * (`otelTracesEndpoint`, `otelLogsEndpoint`, `otelMetricsEndpoint`) as output
 * attributes so you can inject them into a Worker / Lambda's env vars for
 * OpenTelemetry shipping. The bearer token is **not** stored in resource state
 * — supply `Authorization: Bearer <AXIOM_TOKEN>` separately at runtime.
 * @see https://axiom.co/docs/reference/datasets
 * @see https://axiom.co/docs/send-data/opentelemetry — OTLP endpoint reference
 *
 * ### Creating a Dataset
 * **Example:** Logs dataset with 30-day retention
 * ```typescript
 * const logs = yield* Axiom.Dataset("app-logs", {
 *   name: "my-app-logs",
 *   kind: "otel:logs:v1",
 *   description: "Application logs from prod workers",
 *   retentionDays: 30,
 *   useRetentionPeriod: true,
 * });
 * ```
 *
 * **Example:** Separate datasets per OTEL signal
 * ```typescript
 * const traces  = yield* Axiom.Dataset("traces",  { name: "app-traces",  kind: "otel:traces:v1"  });
 * const logs    = yield* Axiom.Dataset("logs",    { name: "app-logs",    kind: "otel:logs:v1"    });
 * const metrics = yield* Axiom.Dataset("metrics", { name: "app-metrics", kind: "otel:metrics:v1" });
 * ```
 *
 * ### Shipping OTEL data
 * **Example:** Wire OTEL env vars into a Cloudflare Worker
 * ```typescript
 * yield* Cloudflare.Worker("api", {
 *   vars: {
 *     OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: traces.otelTracesEndpoint,
 *     OTEL_EXPORTER_OTLP_LOGS_ENDPOINT:   logs.otelLogsEndpoint,
 *     // Bearer token must come from a secret store, not the dataset state.
 *     OTEL_EXPORTER_OTLP_HEADERS:
 *       `Authorization=Bearer ${env.AXIOM_TOKEN},X-Axiom-Dataset=${traces.name}`,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Dataset = Resource<Dataset>("Axiom.Dataset");

/**
 * Axiom has no tags/labels API. The only writable field we can use to mark
 * ownership is `description`. We append a deterministic marker on create so
 * that on a re-apply (e.g. state was wiped) we can safely identify a dataset
 * that **we** previously created and adopt it idempotently — without
 * accidentally hijacking a dataset created by someone else with the same name.
 */
const MARKER_RE = /\s*\[alchemy:stack=([^;]+);stage=([^;]+);id=([^\]]+)\]\s*$/;

const buildMarker = (stack: string, stage: string, id: string) =>
  `[alchemy:stack=${stack};stage=${stage};id=${id}]`;

const augmentDescription = (
  description: string | undefined,
  marker: string,
) => {
  const base = stripMarker(description ?? "");
  return base.length > 0 ? `${base}\n${marker}` : marker;
};

const stripMarker = (description: string): string =>
  description.replace(MARKER_RE, "").trimEnd();

const parseMarker = (
  description: string | undefined,
): { stack: string; stage: string; id: string } | undefined => {
  if (!description) return undefined;
  const m = description.match(MARKER_RE);
  if (!m) return undefined;
  return { stack: m[1], stage: m[2], id: m[3] };
};

export const DatasetProvider = () =>
  Provider.effect(
    Dataset,
    Effect.gen(function* () {
      const { apiBaseUrl } = yield* yield* Credentials;
      const create = yield* Axiom.createDataset;
      const update = yield* Axiom.updateDataset;
      const get = yield* Axiom.getDataset;
      const listDatasets = yield* Axiom.getDatasets;
      const del = yield* Axiom.deleteDataset;

      const toAttrs = Effect.fn(function* (dataset: Axiom.Dataset) {
        if (!dataset.edgeDeployment || !dataset.edgeDeploymentUrl) {
          return yield* Effect.fail(
            new Error(
              `Axiom dataset "${dataset.name}" is missing its edge deployment metadata`,
            ),
          );
        }
        const apiRoot = apiBaseUrl.replace(/\/$/, "");
        const otelRoot = dataset.edgeDeploymentUrl.replace(/\/$/, "");
        return {
          id: dataset.id,
          name: dataset.name,
          kind: dataset.kind,
          description: stripMarker(dataset.description),
          created: dataset.created,
          edgeDeployment: dataset.edgeDeployment,
          edgeDeploymentUrl: dataset.edgeDeploymentUrl,
          apiBaseUrl: apiRoot,
          otelEndpoint: otelRoot,
          otelTracesEndpoint: `${otelRoot}/v1/traces`,
          otelLogsEndpoint: `${otelRoot}/v1/logs`,
          otelMetricsEndpoint: `${otelRoot}/v1/metrics`,
          otelHeaders: {
            "X-Axiom-Dataset": dataset.name,
          } as Record<string, string>,
        };
      });

      return {
        stables: ["id", "name", "kind", "edgeDeployment", "edgeDeploymentUrl"],
        // Enumerate every dataset in the org. Axiom exposes a single
        // account-wide `GET /v2/datasets` collection op (no pagination), so we
        // fetch it once and hydrate each row into the exact `read`/`toAttrs`
        // Attributes shape — directly usable by `delete` with no follow-up get.
        list: () =>
          Effect.gen(function* () {
            const datasets = yield* listDatasets({});
            return yield* Effect.forEach(datasets, toAttrs);
          }),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isResolved(news)) return undefined;
          if (output && news.name !== output.name) {
            return { action: "replace" } as const;
          }
          if (news.kind && output && news.kind !== output.kind) {
            return { action: "replace" } as const;
          }
          if (
            news.edgeDeployment &&
            output &&
            news.edgeDeployment !== output.edgeDeployment
          ) {
            return { action: "replace" } as const;
          }
          if (
            news.description !== olds?.description ||
            news.retentionDays !== olds?.retentionDays ||
            news.useRetentionPeriod !== olds?.useRetentionPeriod
          ) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const stack = yield* Stack;
          const stage = yield* Stage;
          const marker = buildMarker(stack.name, stage, id);

          // Observe — Axiom's dataset path identifier is `name`, which is
          // also stable input. Probe for live state by name (preferring the
          // cached `output.id` when present). `read` upstream has already
          // surfaced foreign datasets as `Unowned`, so by the time we land
          // here mutation is safe.
          const datasetId = output?.id ?? news.name;
          const observed = yield* get({ dataset_id: datasetId }).pipe(
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );

          // Ensure — POST creates the dataset. Tolerate Conflict/
          // UnprocessableEntity as a race with a peer reconciler (or with
          // upstream read↔create), falling through to the sync path.
          let current = observed;
          if (current === undefined) {
            current = yield* (
              create({
                name: news.name,
                description: augmentDescription(news.description, marker),
                edgeDeployment: news.edgeDeployment,
                kind: news.kind,
                retentionDays: news.retentionDays,
                useRetentionPeriod: news.useRetentionPeriod,
              }) as Effect.Effect<
                Axiom.Dataset,
                { readonly _tag: string },
                never
              >
            ).pipe(
              Effect.catchIf(
                (
                  e,
                ): e is { readonly _tag: "Conflict" | "UnprocessableEntity" } =>
                  e._tag === "Conflict" || e._tag === "UnprocessableEntity",
                () =>
                  update({
                    dataset_id: news.name,
                    description: augmentDescription(news.description, marker),
                    retentionDays: news.retentionDays,
                    useRetentionPeriod: news.useRetentionPeriod,
                  }),
              ),
            );
            return yield* toAttrs(current);
          }

          // Sync — the dataset exists. Apply mutable aspects (description,
          // retentionDays, useRetentionPeriod) via PATCH. `kind` and `name`
          // are stable and replacement-only via diff above.
          const desiredDescription = augmentDescription(
            news.description,
            marker,
          );
          const needsSync =
            current.description !== desiredDescription ||
            current.retentionDays !== news.retentionDays ||
            current.useRetentionPeriod !== news.useRetentionPeriod;
          if (!needsSync) {
            return yield* toAttrs(current);
          }
          const updated = yield* update({
            dataset_id: current.id,
            description: desiredDescription,
            retentionDays: news.retentionDays,
            useRetentionPeriod: news.useRetentionPeriod,
          });
          return yield* toAttrs(updated);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* del({ dataset_id: output.id }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const stack = yield* Stack;
          const stage = yield* Stage;
          const datasetId = output?.id ?? olds?.name;
          if (!datasetId) return undefined;
          const existing = yield* get({ dataset_id: datasetId }).pipe(
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
          if (!existing) return undefined;
          const ownership = parseMarker(existing.description);
          const isOurs =
            ownership !== undefined &&
            ownership.stack === stack.name &&
            ownership.stage === stage &&
            ownership.id === id;
          const attrs = yield* toAttrs(existing);
          return isOurs ? attrs : Unowned(attrs);
        }),
      };
    }),
  );
