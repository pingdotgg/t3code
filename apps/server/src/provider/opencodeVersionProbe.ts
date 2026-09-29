/** Detects whether an OpenCode instance runs 1.x or 2.x, so the driver can pick its runtime. */
import { parseSemver } from "@t3tools/shared/semver";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import * as OpenCodeRuntime from "./opencodeRuntime.ts";
import { parseGenericCliVersion } from "./providerSnapshot.ts";

export interface ProbedOpenCode {
  readonly generation: "v1" | "v2";
  readonly version: string;
}

const OPENCODE_VERSION_PROBE_TIMEOUT = "4 seconds";
const OPENCODE_SERVER_PROBE_TIMEOUT = "5 seconds";
// 2.x's own CLI decodes `{version, pid}` from `/api/info`; requiring both keeps unrelated JSON out.
const decodeApiInfo = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String, pid: Schema.Int })),
);
const decodeGlobalHealth = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ healthy: Schema.Literal(true), version: Schema.String })),
);

function probed(version: string | null | undefined): ProbedOpenCode | undefined {
  const major = parseSemver(version ?? "")?.major;
  if (!version || major === undefined) return undefined;
  return { generation: major >= 2 ? "v2" : "v1", version };
}

/** `opencode --version` prints `1.18.32` on 1.x and `opencode v2.0.18` on 2.x. */
export const classifyOpenCodeCliVersion = (output: string) =>
  probed(parseGenericCliVersion(output));

/**
 * 2.x answers `/api/info` and 1.x answers `/global/health`. Each serves its web UI's HTML with a
 * 200 on the other's path, so only a JSON body counts. Both versions answer a wrong password with
 * a 401 on either path, so a 401 says nothing about the version.
 */
function classifyOpenCodeProbeResponse(
  path: "/api/info" | "/global/health",
  response: {
    readonly status: number;
    readonly contentType: string | undefined;
    readonly body: string;
  },
): ProbedOpenCode | "unauthorized" | undefined {
  if (response.status === 401) return "unauthorized";
  const mediaType = response.contentType?.split(";")[0]?.trim().toLowerCase();
  if (response.status !== 200 || mediaType !== "application/json") return undefined;
  const version: Option.Option<string> =
    path === "/api/info"
      ? Option.map(decodeApiInfo(response.body), (info) => info.version)
      : Option.map(decodeGlobalHealth(response.body), (health) => health.version);
  return probed(Option.getOrUndefined(version));
}

const probeOpenCodeBinary = Effect.fn("probeOpenCodeBinary")(function* (
  binaryPath: string,
  environment: NodeJS.ProcessEnv | undefined,
) {
  const runtime = yield* OpenCodeRuntime.OpenCodeRuntime;
  const { stdout } = yield* runtime
    .runOpenCodeCommand({
      binaryPath,
      args: ["--version"],
      ...(environment === undefined ? {} : { environment }),
    })
    .pipe(
      Effect.timeoutOrElse({
        duration: OPENCODE_VERSION_PROBE_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new OpenCodeRuntime.OpenCodeRuntimeError({
              operation: "probeOpenCodeBinary",
              detail: `OpenCode CLI version probe timed out after ${OPENCODE_VERSION_PROBE_TIMEOUT}.`,
            }),
          ),
      }),
    );
  const result = classifyOpenCodeCliVersion(stdout);
  if (result) return result;
  return yield* new OpenCodeRuntime.OpenCodeRuntimeError({
    operation: "probeOpenCodeBinary",
    detail: `Unable to determine OpenCode version from \`opencode --version\` output. T3 Code requires OpenCode v${OpenCodeRuntime.MINIMUM_OPENCODE_VERSION} or newer.`,
  });
});

// Server failures reach clients through the provider status, so their details are fixed text:
// the underlying error can carry the configured URL, its credentials, or the password header.
const probeOpenCodeServer = Effect.fn("probeOpenCodeServer")(function* (
  serverUrl: string,
  serverPassword: string,
) {
  const client = yield* HttpClient.HttpClient;
  const baseUrl = URL.parse(serverUrl.trim());
  if (baseUrl?.protocol !== "http:" && baseUrl?.protocol !== "https:") {
    return yield* new OpenCodeRuntime.OpenCodeRuntimeError({
      operation: "probeOpenCodeServer",
      detail: "The OpenCode server URL is not a valid http:// or https:// URL.",
    });
  }
  // UTF-8, as the 1.x SDK client sends it; `HttpClientRequest.basicAuth` uses Latin-1 `btoa`.
  const authorization = serverPassword
    ? `Basic ${Buffer.from(`opencode:${serverPassword}`, "utf8").toString("base64")}`
    : undefined;
  for (const path of ["/api/info", "/global/health"] as const) {
    // A path prefix and query on the configured URL are kept: `/base/?x=1` → `/base/api/info?x=1`.
    const url = new URL(baseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
    const request = HttpClientRequest.get(url.href);
    const result = yield* client
      .execute(
        authorization
          ? HttpClientRequest.setHeader(request, "authorization", authorization)
          : request,
      )
      .pipe(
        Effect.flatMap((response) =>
          Effect.map(response.text, (body) =>
            classifyOpenCodeProbeResponse(path, {
              status: response.status,
              contentType: response.headers["content-type"],
              body,
            }),
          ),
        ),
        Effect.mapError(
          (cause) =>
            new OpenCodeRuntime.OpenCodeRuntimeError({
              operation: "probeOpenCodeServer",
              detail: "Couldn't reach the OpenCode server.",
              cause,
            }),
        ),
        Effect.timeoutOrElse({
          duration: OPENCODE_SERVER_PROBE_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new OpenCodeRuntime.OpenCodeRuntimeError({
                operation: "probeOpenCodeServer",
                detail: "Timed out while checking the OpenCode server version.",
              }),
            ),
        }),
      );
    if (result === "unauthorized") {
      return yield* new OpenCodeRuntime.OpenCodeRuntimeError({
        operation: "probeOpenCodeServer",
        detail: "401 Unauthorized: the OpenCode server rejected the password.",
      });
    }
    if (result !== undefined) return result;
  }
  return yield* new OpenCodeRuntime.OpenCodeRuntimeError({
    operation: "probeOpenCodeServer",
    detail: `The server did not identify itself as OpenCode. T3 Code requires OpenCode v${OpenCodeRuntime.MINIMUM_OPENCODE_VERSION} or newer.`,
  });
});

/** Probes a configured server when `serverUrl` is set, otherwise the local binary. */
export const probeOpenCodeRuntime = (
  settings: {
    readonly binaryPath: string;
    readonly serverUrl: string;
    readonly serverPassword: string;
  },
  environment?: NodeJS.ProcessEnv,
): Effect.Effect<
  ProbedOpenCode,
  OpenCodeRuntime.OpenCodeRuntimeError,
  HttpClient.HttpClient | OpenCodeRuntime.OpenCodeRuntime
> =>
  settings.serverUrl.trim().length > 0
    ? probeOpenCodeServer(settings.serverUrl, settings.serverPassword)
    : probeOpenCodeBinary(settings.binaryPath, environment);

/**
 * One instance's runtime, remembered after the first successful probe. Settings changes rebuild
 * the driver; `refresh` re-probes (status checks use it, so an in-place upgrade re-routes). A
 * failed probe is never remembered. `lastSuccess` never probes, for calls too hot to wait on one.
 */
export const makeOpenCodeRuntimeProbe = <E>(probe: Effect.Effect<ProbedOpenCode, E>) =>
  Effect.map(
    Cache.makeWith(() => probe, {
      capacity: 1,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
    }),
    (cache) => ({
      get: Cache.get(cache, undefined),
      refresh: Cache.refresh(cache, undefined),
      lastSuccess: Cache.getSuccess(cache, undefined),
    }),
  );
