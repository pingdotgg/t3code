import * as machines from "@distilled.cloud/fly-io/machines";
import * as Retry from "@distilled.cloud/fly-io/Retry";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import { throughProxy } from "./transport.ts";

const rolloutKeys = new Set([
  "alchemy.generation",
  "alchemy.workload",
  "alchemy.sequence",
  "alchemy.count",
  "alchemy.image",
  "alchemy.phase",
  "alchemy.deployment-protocol",
  "alchemy.readiness-roles",
  "alchemy.readiness-role",
  "alchemy.predecessors",
  "alchemy.idle-policy-restored",
  "alchemy.checked-instance",
  "alchemy.min-secrets-version",
]);

class LegacyWriterLeaseInvalid extends Data.TaggedError("LegacyWriterLeaseInvalid")<{
  machineId: string;
}> {}

/** Explicit legacy-protocol writer model, not an old Alchemy binary or global fence. */
export const writeLegacyProtocol = (
  appName: string,
  machineId: string,
  runtimeTimeoutMs?: number,
) =>
  Effect.gen(function* () {
    const target = { app_name: appName, machine_id: machineId };
    const lease = yield* machines
      .createMachineLease({
        ...target,
        description: "Live legacy-protocol writer model",
        ttl: 120,
      })
      .pipe(Retry.none, Effect.timeout("30 seconds"));
    const nonce = lease.data?.nonce;
    if (!nonce) return yield* new LegacyWriterLeaseInvalid({ machineId });
    try {
      const current = yield* machines.getMachine(target);
      const config = current.config!;
      return yield* machines
        .updateMachine({
          ...target,
          lease_nonce: nonce,
          current_version: current.instance_id,
          config: {
            ...config,
            stop_config: undefined,
            env: {
              ...Object.fromEntries(
                Object.entries(config.env ?? {}).filter(
                  ([key]) => key !== "ALCHEMY_FLY_SHUTDOWN_TIMEOUT_MS",
                ),
              ),
              ...(runtimeTimeoutMs === undefined
                ? {}
                : {
                    ALCHEMY_FLY_SHUTDOWN_TIMEOUT_MS: String(runtimeTimeoutMs),
                  }),
            },
            metadata: Object.fromEntries(
              Object.entries(config.metadata ?? {}).filter(([key]) => !rolloutKeys.has(key)),
            ),
          },
        })
        .pipe(Retry.none, Effect.timeout("45 seconds"));
    } finally {
      yield* machines.machinesReleaseLease({ ...target, lease_nonce: nonce }).pipe(
        Retry.none,
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.timeout("30 seconds"),
      );
    }
  });

export interface StopRequest {
  machineId: string;
  signal: string | undefined;
  timeout: string | undefined;
}

/** Observe only stop policy fields; forward every original request and response unchanged. */
export const observeStops = (
  endpoint: () => string | undefined,
  record: (request: StopRequest) => void,
) =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      return client.pipe(
        HttpClient.tapRequest((request) =>
          Effect.sync(() => {
            const target = request.url.match(/\/machines\/([^/]+)\/stop$/);
            if (request.method !== "POST" || !target) return;
            if (request.body._tag !== "Uint8Array") {
              throw new Error("Expected the native SDK's JSON stop request body");
            }
            const body = JSON.parse(new TextDecoder().decode(request.body.body));
            record({
              machineId: target[1]!,
              signal: typeof body.signal === "string" ? body.signal : undefined,
              timeout: typeof body.timeout === "string" ? body.timeout : undefined,
            });
          }),
        ),
      );
    }),
  ).pipe(Layer.provideMerge(throughProxy(endpoint)));
