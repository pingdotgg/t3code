import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type OrchestrationV2ShellSnapshot,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Option from "effect/Option";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "../backend/DesktopLocalEnvironmentAuth.ts";

const { logWarning } = makeComponentLogger("desktop-local-activity-probe");

export interface LocalActivityProbeInput {
  readonly pool: DesktopBackendPool.DesktopBackendPool["Service"];
  readonly auth: DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth["Service"];
  readonly httpClient: HttpClient.HttpClient;
}

// Bounds the whole probe (bearer exchange included) so a wedged local backend
// can never delay a window close by more than this.
const PROBE_TIMEOUT = Duration.seconds(3);

/**
 * Counts local threads with a live agent activity ("preparing" | "starting" |
 * "running" | "waiting"). Resolves 0 whenever the answer is unknown -- the
 * local backend is gone, the token exchange failed, the request failed --
 * because an unreachable local backend also means nothing is running on this
 * machine.
 */
export const makeLocalActivityProbe = (input: LocalActivityProbeInput): Effect.Effect<number> =>
  Effect.gen(function* () {
    const instances = yield* input.pool.list;
    const primary = instances.find((instance) => instance.id === PRIMARY_LOCAL_ENVIRONMENT_ID);
    if (primary === undefined) return 0;
    const configOption = yield* primary.currentConfig;
    if (Option.isNone(configOption)) return 0;
    const bearerToken = yield* input.auth.getBearerToken;
    const response = yield* input.httpClient.get(
      new URL("/api/orchestration/shell", configOption.value.httpBaseUrl),
      {
        headers: {
          authorization: `Bearer ${bearerToken}`,
          [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
        },
      },
    );
    const snapshot = (yield* response.json) as Partial<OrchestrationV2ShellSnapshot>;
    return snapshot.threads?.filter((thread) => thread?.activityRunStatus != null).length ?? 0;
  }).pipe(
    Effect.timeout(PROBE_TIMEOUT),
    Effect.catchCause((cause) =>
      logWarning("local activity probe failed; treating as idle", { cause }).pipe(Effect.as(0)),
    ),
  );
