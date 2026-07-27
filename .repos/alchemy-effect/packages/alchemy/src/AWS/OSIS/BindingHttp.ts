/**
 * Shared scaffolding for Amazon OpenSearch Ingestion (OSIS) HTTP bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the builders
 * below. Everything except the operation, the injected identifier, and the
 * IAM action list is boilerplate:
 *
 * - Pipeline-scoped operations (`osis:GetPipeline`, `osis:StartPipeline`,
 *   `osis:StopPipeline`, …) inject the bound {@link Pipeline}'s name or ARN
 *   into the request and are granted on the pipeline ARN.
 * - Account-level operations (`osis:ValidatePipeline`,
 *   `osis:ListPipelineBlueprints`, …) take the caller's request as-is and
 *   are granted on `*` — they are not scoped to a single pipeline resource.
 * - The `osis:Ingest` data plane has no distilled operation — it is a
 *   SigV4-signed HTTP POST (service `"osis"`) against the pipeline's ingest
 *   endpoint, made with the host Function's own credentials.
 */
import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Region from "@distilled.cloud/aws/Region";
import { AwsV4Signer } from "aws4fetch";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Binding from "../../Binding.ts";
import type * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Pipeline } from "./Pipeline.ts";

/**
 * Build the impl Effect for an OSIS operation scoped to a {@link Pipeline}:
 * the deploy-time half grants `actions` on the bound pipeline's ARN, and the
 * runtime half injects the pipeline's identifier (name or ARN) as
 * `requestKey` into every request.
 */
export const makeOsisPipelineHttpBinding = <
  I extends object,
  K extends keyof I & string,
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.OSIS.StartPipeline`. */
  tag: string;
  /** The distilled operation; `requestKey` is injected from the pipeline. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the pipeline ARN. */
  actions: readonly string[];
  /** The request field the resolved identifier is injected as. */
  requestKey: K;
  /** Resolve the injected identifier from the bound pipeline. */
  identifier: (pipeline: Pipeline) => Output.Output<string, never>;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (pipeline: Pipeline) {
      const Identifier = yield* options.identifier(pipeline);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${pipeline}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [pipeline.pipelineArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${pipeline.LogicalId})`)(function* (
        request?: Omit<I, K>,
      ) {
        return yield* op({
          ...request,
          [options.requestKey]: yield* Identifier,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for an account-level OSIS operation (config
 * validation, blueprint catalog reads, endpoint-connection listing). The
 * deploy-time half grants `actions` on `*` — these operations are not scoped
 * to a single pipeline resource.
 */
export const makeOsisAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.OSIS.ValidatePipeline`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `*`. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(options.tag)(function* (request?: I) {
        return yield* op((request ?? {}) as I);
      });
    });
  });

/**
 * A failed `osis:Ingest` request against a pipeline's ingest endpoint —
 * carries the HTTP status and response body returned by Data Prepper.
 */
export class PipelineIngestError extends Data.TaggedError(
  "OsisPipelineIngestError",
)<{
  readonly pipelineName: string;
  /** Request path on the ingest endpoint, e.g. `/logs/ingest`. */
  readonly path: string;
  /** HTTP status; `0` when the request never reached the endpoint. */
  readonly status: number;
  readonly body: string;
}> {}

/** A single `osis:Ingest` request against the pipeline's ingest endpoint. */
export interface IngestRequest {
  /**
   * Path of the pipeline's HTTP source, e.g. `/logs/ingest` — must match the
   * `path` configured on the `http` (or `otel_*`) source in the pipeline
   * configuration body.
   */
  path: string;
  /**
   * Events to ingest, JSON-serialized as the request body. Data Prepper's
   * `http` source expects a JSON array of event objects.
   */
  events: ReadonlyArray<unknown>;
}

/**
 * Build the impl Effect for the `osis:Ingest` data plane: the deploy-time
 * half grants `osis:Ingest` on the bound pipeline's ARN, and the runtime half
 * signs (SigV4, service `"osis"`) and POSTs each batch of events to the
 * pipeline's ingest endpoint with the host Function's own credentials.
 */
export const makeOsisIngestBinding = Effect.gen(function* () {
  const services = yield* Effect.context<
    Credentials.Credentials | Region.Region
  >();

  return Effect.fn(function* (pipeline: Pipeline) {
    const PipelineName = yield* pipeline.pipelineName;
    const IngestEndpointUrls = yield* pipeline.ingestEndpointUrls;
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const host = yield* Binding.Host;
      if (isBindingHost(host)) {
        yield* host.bind`Allow(${host}, AWS.OSIS.Ingest(${pipeline}))`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["osis:Ingest"],
              Resource: [pipeline.pipelineArn],
            },
          ],
        });
      }
    }

    return Effect.fn(`AWS.OSIS.Ingest(${pipeline.LogicalId})`)(function* (
      request: IngestRequest,
    ) {
      const pipelineName = yield* PipelineName;
      const endpoints = yield* IngestEndpointUrls;
      const endpoint = endpoints?.[0];
      const fail = (status: number, body: string) =>
        Effect.fail(
          new PipelineIngestError({
            pipelineName,
            path: request.path,
            status,
            body,
          }),
        );
      if (endpoint === undefined) {
        return yield* fail(0, "pipeline has no ingestEndpointUrls");
      }

      // Ingest endpoint URLs are bare hostnames
      // (`{name}-{id}.{region}.osis.amazonaws.com`); sign for the endpoint's
      // own region, parsed from the hostname.
      const base = endpoint.startsWith("https://")
        ? endpoint
        : `https://${endpoint}`;
      const url = new URL(
        request.path.startsWith("/") ? request.path : `/${request.path}`,
        base,
      );

      // Resolve credentials fresh per request (STS sessions rotate).
      const { credentials, region } = yield* Effect.gen(function* () {
        const credentials = yield* yield* Credentials.Credentials;
        const region =
          /\.([a-z0-9-]+)\.osis\.amazonaws\.com$/.exec(url.hostname)?.[1] ??
          (yield* yield* Region.Region);
        return { credentials, region };
      }).pipe(Effect.provideContext(services));

      const signer = new AwsV4Signer({
        method: "POST",
        url: url.toString(),
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.events),
        accessKeyId: Redacted.value(credentials.accessKeyId),
        secretAccessKey: Redacted.value(credentials.secretAccessKey),
        sessionToken: credentials.sessionToken
          ? Redacted.value(credentials.sessionToken)
          : undefined,
        service: "osis",
        region,
        allHeaders: true,
      });
      const signed = yield* Effect.promise(() => signer.sign());

      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(signed.url.toString(), {
            method: signed.method,
            headers: signed.headers,
            body: signed.body as BodyInit | undefined,
          }),
        catch: (cause) =>
          new PipelineIngestError({
            pipelineName,
            path: request.path,
            status: 0,
            body: cause instanceof Error ? cause.message : String(cause),
          }),
      });
      const text = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (cause) =>
          new PipelineIngestError({
            pipelineName,
            path: request.path,
            status: response.status,
            body: cause instanceof Error ? cause.message : String(cause),
          }),
      });
      if (response.status < 200 || response.status >= 300) {
        return yield* fail(response.status, text);
      }
    });
  });
});
