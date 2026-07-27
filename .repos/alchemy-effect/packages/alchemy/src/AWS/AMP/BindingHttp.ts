/**
 * Shared scaffolding for AMP data-plane HTTP bindings.
 *
 * Amazon Managed Service for Prometheus exposes its data plane as a
 * Prometheus-compatible HTTP API under the workspace's `prometheusEndpoint`
 * (`aps:RemoteWrite`, `aps:QueryMetrics`, `aps:GetLabels`, `aps:GetSeries`,
 * `aps:GetMetricMetadata`). There is no distilled operation for these — every
 * request is a SigV4-signed HTTP call (service `"aps"`) made with the host
 * Function's own credentials.
 *
 * NOT exported from `index.ts` — only the per-capability contracts and
 * `*Http` layers are public.
 */
import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Region from "@distilled.cloud/aws/Region";
import { AwsV4Signer } from "aws4fetch";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Binding from "../../Binding.ts";
import { toWireSeconds } from "../../Util/Duration.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { PrometheusApiError, type PrometheusTime } from "./PrometheusTypes.ts";
import type { Workspace } from "./Workspace.ts";

/** A request against the workspace's Prometheus-compatible endpoint. */
export interface AmpHttpRequest {
  method: "GET" | "POST";
  /** Path relative to `prometheusEndpoint`, e.g. `"api/v1/query"`. */
  path: string;
  /** Query-string parameters; array values are appended repeatedly. */
  query?: Record<string, string | string[] | undefined>;
  /** URL-encoded form body (`application/x-www-form-urlencoded`). */
  form?: Record<string, string | string[] | undefined>;
  /** Raw binary body (used by remote-write). */
  bytes?: {
    data: Uint8Array;
    contentType: string;
    headers?: Record<string, string>;
  };
}

/**
 * Signs and sends one {@link AmpHttpRequest}, unwraps the Prometheus
 * `{ status, data }` envelope, and returns `data` (or `undefined` for
 * empty-body responses like remote-write's `200`).
 */
export type AmpSend = (
  request: AmpHttpRequest,
) => Effect.Effect<unknown, PrometheusApiError | Credentials.CredentialsError>;

const appendParams = (
  target: URLSearchParams,
  params: Record<string, string | string[] | undefined>,
) => {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) target.append(key, item);
    } else {
      target.set(key, value);
    }
  }
};

/** Serialize a {@link PrometheusTime} for the query API. */
export const toPromTime = (time: PrometheusTime): string =>
  time instanceof Date ? time.toISOString() : String(time);

/** Serialize a `Duration.Input` as a Prometheus duration string (`"30s"`). */
export const toPromDuration = (input: Duration.Input): string =>
  `${toWireSeconds(input)}s`;

/**
 * Build the shared body of an AMP data-plane `*Http` binding layer:
 * resolve the ambient distilled `Credentials`/`Region` context once at layer
 * construction, register the least-privilege IAM statement on the host
 * Function at deploy time, and hand a signed-request `send` function to the
 * capability-specific `makeClient`.
 */
export const makeAmpWorkspaceHttpBinding = <Client>(options: {
  /** Capability name used in the binding SID and trace spans, e.g. `"QueryMetrics"`. */
  name: string;
  /** IAM actions the capability requires on the workspace, e.g. `["aps:QueryMetrics"]`. */
  iamActions: string[];
  /** Build the typed runtime client from the signed-request sender. */
  makeClient: (send: AmpSend) => Client;
}) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<
      Credentials.Credentials | Region.Region
    >();

    return Effect.fn(function* (workspace: Workspace) {
      const PrometheusEndpoint = yield* workspace.prometheusEndpoint;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.AMP.${options.name}(${workspace}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: options.iamActions,
                  Resource: [workspace.workspaceArn],
                },
              ],
            },
          );
        }
      }

      const send: AmpSend = Effect.fn(
        `AWS.AMP.${options.name}(${workspace.LogicalId})`,
      )(function* (request: AmpHttpRequest) {
        const endpoint = yield* PrometheusEndpoint;
        if (endpoint === undefined) {
          return yield* Effect.fail(
            new PrometheusApiError({
              method: request.method,
              path: request.path,
              status: 0,
              body: "workspace has no prometheusEndpoint",
            }),
          );
        }

        const base = endpoint.endsWith("/") ? endpoint : `${endpoint}/`;
        const url = new URL(request.path, base);
        appendParams(url.searchParams, request.query ?? {});

        const headers: Record<string, string> = {};
        let body: string | Uint8Array<ArrayBuffer> | undefined;
        if (request.form !== undefined) {
          const form = new URLSearchParams();
          appendParams(form, request.form);
          body = form.toString();
          headers["content-type"] = "application/x-www-form-urlencoded";
        } else if (request.bytes !== undefined) {
          // Copy into a fresh ArrayBuffer-backed view — `fetch`'s `BodyInit`
          // rejects `Uint8Array<ArrayBufferLike>` (SharedArrayBuffer-backed).
          body = new Uint8Array(request.bytes.data);
          headers["content-type"] = request.bytes.contentType;
          Object.assign(headers, request.bytes.headers);
        }

        // Resolve credentials fresh per request (SSO/STS sessions rotate) and
        // sign for the workspace's own region, parsed from its endpoint.
        const { credentials, region } = yield* Effect.gen(function* () {
          const credentials = yield* yield* Credentials.Credentials;
          const region =
            /^aps-workspaces\.([a-z0-9-]+)\.amazonaws\.com$/.exec(
              url.hostname,
            )?.[1] ?? (yield* yield* Region.Region);
          return { credentials, region };
        }).pipe(Effect.provideContext(services));

        const signer = new AwsV4Signer({
          method: request.method,
          url: url.toString(),
          headers,
          body,
          accessKeyId: Redacted.value(credentials.accessKeyId),
          secretAccessKey: Redacted.value(credentials.secretAccessKey),
          sessionToken: credentials.sessionToken
            ? Redacted.value(credentials.sessionToken)
            : undefined,
          service: "aps",
          region,
          allHeaders: true,
        });
        const signed = yield* Effect.promise(() => signer.sign());

        const toError = (status: number) => (cause: unknown) =>
          new PrometheusApiError({
            method: request.method,
            path: request.path,
            status,
            body: cause instanceof Error ? cause.message : String(cause),
          });

        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(signed.url.toString(), {
              method: signed.method,
              headers: signed.headers,
              body: signed.body as BodyInit | undefined,
            }),
          catch: toError(0),
        });
        const text = yield* Effect.tryPromise({
          try: () => response.text(),
          catch: toError(response.status),
        });

        if (response.status < 200 || response.status >= 300) {
          return yield* Effect.fail(
            new PrometheusApiError({
              method: request.method,
              path: request.path,
              status: response.status,
              body: text,
            }),
          );
        }
        if (text.trim() === "") {
          // remote-write success has no body.
          return undefined;
        }

        const envelope = yield* Effect.try({
          try: () =>
            JSON.parse(text) as {
              status?: string;
              data?: unknown;
              error?: string;
              errorType?: string;
            },
          catch: toError(response.status),
        });
        if (envelope.status !== undefined && envelope.status !== "success") {
          return yield* Effect.fail(
            new PrometheusApiError({
              method: request.method,
              path: request.path,
              status: response.status,
              body: text,
            }),
          );
        }
        return envelope.data;
      });

      return options.makeClient(send);
    });
  });
