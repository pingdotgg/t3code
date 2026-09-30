/** Detects whether an OpenCode instance runs 1.x or 2.x, so the driver can pick its runtime. */
import { parseSemver } from "@t3tools/shared/semver";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import {
  OpenCodeRuntimeError,
  openCodeRuntimeErrorDetail,
  type OpenCodeRuntimeShape,
} from "./opencodeRuntime.ts";
import { parseGenericCliVersion } from "./providerSnapshot.ts";

export interface ProbedOpenCode {
  readonly generation: "v1" | "v2";
  readonly version: string;
}

/**
 * First OpenCode major line the `opencode2` driver supports. Tracks the pinned
 * `@opencode/client` (`2.0.18`): older 2.x servers predate the list/s contracts
 * the inventory and session bindings rely on. The probe itself only splits
 * generations; the driver enforces this floor, the bundled manifest agrees
 * (`>=2.0.18` supported), and the probe's failure messages name it.
 */
export const MINIMUM_OPENCODE2_VERSION = "2.0.18";

const OPENCODE_VERSION_PROBE_TIMEOUT = "4 seconds";
const OPENCODE_SERVER_PROBE_TIMEOUT = "5 seconds";
const decodeApiInfo = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
);
const decodeGlobalHealth = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ healthy: Schema.Literal(true), version: Schema.String })),
);

const probeError = (detail: string, cause?: unknown) =>
  new OpenCodeRuntimeError({
    operation: "probeOpenCodeVersion",
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

/**
 * Versions arrive from an external server or CLI stdout, so they are
 * untrusted: cap the length before parsing (a multi-kilobyte "version"
 * must never land in status snapshots or user-facing messages) and require
 * a real semver. Anything else is "no version", reported as a typed probe
 * failure by the caller — never thrown.
 */
const MAX_VERSION_LENGTH = 64;

function probed(version: string | null | undefined): ProbedOpenCode | undefined {
  if (typeof version !== "string") return undefined;
  const trimmed = version.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_VERSION_LENGTH) return undefined;
  const major = parseSemver(trimmed)?.major;
  if (major === undefined) return undefined;
  return { generation: major >= 2 ? "v2" : "v1", version: trimmed };
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
): ProbedOpenCode | "unauthorized" | "forbidden" | undefined {
  if (response.status === 401) return "unauthorized";
  // A proxy (or a future locked-down server) can answer 403 where OpenCode
  // itself answers 401. Like a 401 it says nothing about the version, but it
  // must not fall through to the other path or to "did not identify itself".
  if (response.status === 403) return "forbidden";
  const mediaType = response.contentType?.split(";")[0]?.trim().toLowerCase();
  if (response.status !== 200 || mediaType !== "application/json") return undefined;
  const body = (path === "/api/info" ? decodeApiInfo : decodeGlobalHealth)(response.body);
  return probed(Option.getOrUndefined(body)?.version);
}

const probeOpenCodeBinary = (
  runtime: Pick<OpenCodeRuntimeShape, "runOpenCodeCommand">,
  input: { readonly binaryPath: string; readonly environment?: NodeJS.ProcessEnv },
) =>
  Effect.suspend(() => runtime.runOpenCodeCommand({ ...input, args: ["--version"] })).pipe(
    Effect.timeoutOrElse({
      duration: OPENCODE_VERSION_PROBE_TIMEOUT,
      orElse: () =>
        Effect.fail(
          probeError(
            `OpenCode CLI version probe timed out after ${OPENCODE_VERSION_PROBE_TIMEOUT}.`,
          ),
        ),
    }),
    Effect.flatMap(({ stdout }) => {
      const result = classifyOpenCodeCliVersion(stdout);
      return result
        ? Effect.succeed(result)
        : Effect.fail(
            probeError(
              `Unable to determine OpenCode version from \`opencode --version\` output. T3 Code requires OpenCode v${MINIMUM_OPENCODE2_VERSION} or newer.`,
            ),
          );
    }),
    Effect.withSpan("probeOpenCodeBinary"),
  );

const probeOpenCodeServer = Effect.fn("probeOpenCodeServer")(function* (
  serverUrl: string,
  serverPassword: string,
) {
  const client = yield* HttpClient.HttpClient;
  const baseUrl = serverUrl.trim().replace(/\/+$/, "");
  for (const path of ["/api/info", "/global/health"] as const) {
    const request = HttpClientRequest.get(`${baseUrl}${path}`);
    const result = yield* client
      .execute(
        serverPassword ? HttpClientRequest.basicAuth(request, "opencode", serverPassword) : request,
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
        Effect.mapError((cause) =>
          probeError(openCodeRuntimeErrorDetail(cause.cause ?? cause), cause),
        ),
        Effect.timeoutOrElse({
          duration: OPENCODE_SERVER_PROBE_TIMEOUT,
          orElse: () =>
            Effect.fail(probeError("Timed out while checking the OpenCode server version.")),
        }),
      );
    if (result === "unauthorized") {
      return yield* probeError("401 Unauthorized: the OpenCode server rejected the password.");
    }
    if (result === "forbidden") {
      return yield* probeError("403 Forbidden: the OpenCode server refused the request.");
    }
    if (result !== undefined) return result;
  }
  return yield* probeError(
    `The server did not identify itself as OpenCode. T3 Code requires OpenCode v${MINIMUM_OPENCODE2_VERSION} or newer.`,
  );
});

/** Probes a configured server when `serverUrl` is set, otherwise the local binary. */
export const probeOpenCodeRuntime = (
  runtime: Pick<OpenCodeRuntimeShape, "runOpenCodeCommand">,
  settings: {
    readonly binaryPath: string;
    readonly serverUrl: string;
    readonly serverPassword: string;
  },
  environment?: NodeJS.ProcessEnv,
) =>
  settings.serverUrl.trim().length > 0
    ? probeOpenCodeServer(settings.serverUrl, settings.serverPassword)
    : probeOpenCodeBinary(runtime, {
        binaryPath: settings.binaryPath,
        ...(environment === undefined ? {} : { environment }),
      });

/**
 * One instance's runtime, remembered after the first successful probe. Settings changes rebuild
 * the driver; `refresh` re-probes (status checks use it, so an in-place upgrade re-routes). A
 * failed probe is never remembered.
 */
export const makeOpenCodeRuntimeProbe = <E>(probe: Effect.Effect<ProbedOpenCode, E>) =>
  Effect.map(
    Cache.makeWith(() => probe, {
      capacity: 1,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
    }),
    (cache) => ({ get: Cache.get(cache, undefined), refresh: Cache.refresh(cache, undefined) }),
  );
