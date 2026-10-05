import { deepEqual } from "@/Diff";
import { reconcileBlueGreen } from "@/Fly/bluegreen";
import { makeMachineLeases } from "@/Fly/leases";
import { alchemyMetadataKeys as keys } from "@/Fly/Metadata";
import type { ReconcileReplicasInput } from "@/Fly/replicas";
import { credentials } from "@distilled.cloud/fly-io/Credentials";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

export const appName = "protocol-branches";
export const candidateId = "controlled-candidate";
export const ownership = {
  [keys.stack]: "protocol-branches",
  [keys.stage]: "pure",
  [keys.id]: "Worker",
  [keys.type]: "Fly.Machine",
};
export const metadata = {
  ...ownership,
  [keys.instance]: "controlled-instance",
  [keys.fqn]: "protocol-branches/pure/Worker",
  [keys.baseName]: "protocol-worker",
};

const config: machines.FlyMachineConfig = {
  image: "registry.test/fixture:latest",
  checks: { ready: { type: "http", port: 80, path: "/" } },
  stop_config: { signal: "SIGTERM", timeout: "1s" },
};
const input: ReconcileReplicasInput = {
  appName,
  id: "Worker",
  type: "Fly.Machine",
  resourceInstanceId: metadata[keys.instance],
  fqn: metadata[keys.fqn],
  baseName: metadata[keys.baseName],
  regions: ["ord"],
  count: 1,
  disks: [],
  policy: {
    bluegreen: true,
    healthTimeoutMs: 5_000,
    shutdown: { signal: "SIGTERM", timeout: "1s", timeoutMs: 1_000 },
  },
  buildConfig: ({ metadata, mounts }) => ({ ...config, metadata, mounts }),
  configDrifted: (machine, { metadata, mounts }) =>
    !deepEqual(machine.config, { ...config, metadata, mounts }),
};

export const reconcile = Effect.gen(function* () {
  const leases = yield* makeMachineLeases(appName);
  return yield* reconcileBlueGreen(input, ownership, metadata, leases);
}).pipe(Effect.scoped);

export const withControlledClient =
  (client: HttpClient.HttpClient) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provide(
        credentials({
          apiKey: "pure-fixture-only",
          apiBaseUrl: "https://fly.test",
        }),
      ),
    );

export const reply = (
  request: HttpClientRequest.HttpClientRequest,
  body: unknown,
  status = 200,
) => HttpClientResponse.fromWeb(request, Response.json(body, { status }));

const Body = Schema.Struct({
  name: Schema.optional(Schema.String),
  config: Schema.optional(Schema.toType(machines.FlyMachineConfig)),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

export interface ProtocolEvent {
  method: string;
  path: string;
  phase?: string;
  visible?: boolean;
}

/** Controlled wire responses are algorithm evidence, never Fly platform observations. */
export const protocolClient = (
  options: {
    conflict?: boolean;
    hiddenLists?: number;
    missingImageRef?: "image_ref" | "digest" | "repository";
  } = {},
) =>
  Effect.sync(() => {
    const events: ProtocolEvent[] = [];
    let current: machines.Machine | undefined;
    let hidden = options.hiddenLists ?? 0;
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        return yield* Effect.sync(() => {
          const path = new URL(request.url).pathname;
          const body = Schema.decodeUnknownSync(Body)(
            request.body._tag === "Uint8Array"
              ? JSON.parse(new TextDecoder().decode(request.body.body))
              : {},
          );
          const event: ProtocolEvent = {
            method: request.method,
            path,
            phase: body.metadata?.[keys.phase],
          };
          events.push(event);
          if (path === `/v1/apps/${appName}/machines`) {
            if (request.method === "GET") {
              const visible = current !== undefined && hidden <= 0;
              event.visible = visible;
              if (current !== undefined && hidden > 0) hidden--;
              return reply(request, visible ? [current] : []);
            }
            if (request.method === "POST") {
              if (current)
                throw new Error("Controller replayed candidate creation");
              current = {
                id: candidateId,
                instance_id: "controlled-machine-version",
                name: body.name,
                region: "ord",
                state: "started",
                cordoned: true,
                config: body.config,
                checks: [{ name: "ready", status: "passing" }],
                image_ref:
                  options.missingImageRef === "image_ref"
                    ? undefined
                    : {
                        registry: "registry.test",
                        repository:
                          options.missingImageRef === "repository"
                            ? undefined
                            : "fixture",
                        digest:
                          options.missingImageRef === "digest"
                            ? undefined
                            : `sha256:${"a".repeat(64)}`,
                      },
              };
              return options.conflict
                ? reply(request, { error: "Machine name already exists" }, 409)
                : reply(request, current);
            }
          }
          if (path === `/v1/apps/${appName}/machines/${candidateId}/lease`) {
            if (request.method === "POST")
              return reply(request, {
                data: {
                  nonce: "pure-lease",
                  expires_at: Math.floor(now / 1000) + 120,
                },
              });
            if (request.method === "DELETE") return reply(request, {});
          }
          if (
            path === `/v1/apps/${appName}/machines/${candidateId}` &&
            request.method === "GET"
          )
            return current
              ? reply(request, current)
              : reply(request, { error: "not found" }, 404);
          if (
            path === `/v1/apps/${appName}/machines/${candidateId}/wait` &&
            request.method === "GET"
          )
            return reply(request, {});
          if (
            path === `/v1/apps/${appName}/machines/${candidateId}/metadata` &&
            request.method === "PATCH" &&
            current
          ) {
            current = {
              ...current,
              config: { ...current.config, metadata: body.metadata },
            };
            return reply(request, {});
          }
          if (
            path === `/v1/apps/${appName}/machines/${candidateId}/uncordon` &&
            request.method === "POST" &&
            current
          ) {
            current = { ...current, cordoned: false };
            return reply(request, {});
          }
          throw new Error(
            `Unexpected controlled request: ${request.method} ${path}`,
          );
        });
      }),
    );
    return { client, events };
  });
