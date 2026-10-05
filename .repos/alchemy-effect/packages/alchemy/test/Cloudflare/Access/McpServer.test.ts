import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Output from "@/Output";
import * as Provider from "@/Provider";
import { isResourceState, State } from "@/State";
import * as Cause from "effect/Cause";
import * as Test from "@/Test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import { MinimumLogLevel } from "effect/References";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Deterministic identifiers — the server id is the API identity, so reruns
// converge on the same server instead of leaking. The cases run concurrently,
// so each MUST use a distinct server id.
const SERVER_ID = "alchemy-test-mcp-server";
const RECREATE_SERVER_ID = "alchemy-test-mcp-server-recreate";
const REPLACE_SERVER_ID = "alchemy-test-mcp-server-replace";
const REPLACE_SERVER_ID_V2 = "alchemy-test-mcp-replaced";
const SYNC_SERVER_ID = "alchemy-test-mcp-server-sync";
const DEFERRED_SYNC_SERVER_ID = "alchemy-test-mcp-deferred-sync";
const TOKEN_SERVER_ID = "alchemy-test-mcp-service-token";

// Placeholder upstreams on the standing test zone. These cases opt out of
// Alchemy's explicit capability sync; Cloudflare may still discover in the background.
const HOSTNAME = "https://mcp.alchemy-test-2.us/mcp";
const HOSTNAME_V2 = "https://mcp-v2.alchemy-test-2.us/mcp";
// A real, public, unauthenticated MCP server for the capability-sync case.
const PUBLIC_HOSTNAME = "https://docs.mcp.cloudflare.com/mcp";

test.provider(
  "enabling sync discovers capabilities without changing server configuration",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();

      const fetch = yield* FetchHttpClient.Fetch;
      let serverRequests = 0;
      let syncRequests = 0;
      // Observe real requests: Cloudflare may discover capabilities in the
      // background even when Alchemy has not called the sync endpoint.
      const trackSync = ((input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith(`/mcp/servers/${DEFERRED_SYNC_SERVER_ID}`)) {
          serverRequests++;
        }
        if (url.endsWith(`/mcp/servers/${DEFERRED_SYNC_SERVER_ID}/sync`)) {
          syncRequests++;
        }
        return fetch(input, init);
      }) as typeof globalThis.fetch;

      const deploy = (sync: boolean | undefined) =>
        stack
          .deploy(
            Cloudflare.Access.McpServer("DeferredSync", {
              serverId: DEFERRED_SYNC_SERVER_ID,
              hostname: PUBLIC_HOSTNAME,
              authType: "unauthenticated",
              sync,
            }),
          )
          .pipe(Effect.provideService(FetchHttpClient.Fetch, trackSync));

      const deferred = yield* deploy(false);
      expect(serverRequests).toBeGreaterThan(0);
      expect(syncRequests).toEqual(0);

      const synced = yield* deploy(true);
      expect(syncRequests).toEqual(1);
      expect(synced.serverId).toEqual(deferred.serverId);
      expect(synced.createdAt).toEqual(deferred.createdAt);
      expect(synced.status).toEqual("ready");
      expect(synced.tools.length).toBeGreaterThan(0);
      expect(synced.lastSuccessfulSync).toBeDefined();

      const live = yield* getLiveServer(accountId, DEFERRED_SYNC_SERVER_ID);
      expect(live?.status).toEqual("ready");
      expect(live?.tools.length).toBeGreaterThan(0);

      const noop = yield* deploy(true);
      expect(syncRequests).toEqual(1);
      expect(noop.lastSynced).toEqual(synced.lastSynced);

      yield* deploy(false);
      expect(syncRequests).toEqual(1);
      const defaultSync = yield* deploy(undefined);
      expect(syncRequests).toEqual(2);
      expect(defaultSync.status).toEqual("ready");
      yield* deploy(undefined);
      expect(syncRequests).toEqual(2);

      yield* stack.destroy();
      expect(
        yield* getLiveServer(accountId, DEFERRED_SYNC_SERVER_ID),
      ).toBeUndefined();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:access", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "service-token outputs resolve into redacted MCP authentication credentials",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const token = yield* Cloudflare.Access.ServiceToken("McpToken", {});
          const credentials = Output.all(
            token.clientId,
            token.clientSecret,
          ).pipe(
            Output.map(([clientId, clientSecret]) =>
              Redacted.make(
                JSON.stringify({
                  headers: {
                    "cf-access-client-id": clientId,
                    "cf-access-client-secret": Redacted.value(clientSecret!),
                  },
                }),
              ),
            ),
          );
          const server = yield* Cloudflare.Access.McpServer("GuardedTools", {
            serverId: TOKEN_SERVER_ID,
            hostname: HOSTNAME,
            authType: "bearer",
            authCredentials: credentials,
            sync: false,
          });
          return { token, server, credentials };
        }),
      );

      expect(Redacted.isRedacted(deployed.credentials)).toBe(true);
      // Compare without printing either credential on an assertion failure.
      expect(
        Redacted.value(deployed.credentials) ===
          JSON.stringify({
            headers: {
              "cf-access-client-id": deployed.token.clientId,
              "cf-access-client-secret": Redacted.value(
                deployed.token.clientSecret!,
              ),
            },
          }),
      ).toBe(true);
      expect(deployed.server.authType).toEqual("bearer");
      const live = yield* getLiveServer(accountId, TOKEN_SERVER_ID);
      expect(live?.authType).toEqual("bearer");

      yield* stack.destroy();
      expect(yield* getLiveServer(accountId, TOKEN_SERVER_ID)).toBeUndefined();
      const deletedToken = yield* zeroTrust
        .getAccessServiceTokenForAccount({
          accountId,
          serviceTokenId: deployed.token.serviceTokenId,
        })
        .pipe(
          Effect.catchTag("AccessServiceTokenNotFound", () =>
            Effect.succeed(undefined),
          ),
        );
      expect(deletedToken).toBeUndefined();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:access", "live"],
    timeout: 120_000,
  },
);

// Read a server out-of-band, mapping "gone" to undefined.
const getLiveServer = (accountId: string, id: string) =>
  zeroTrust
    .readAccessAiControlMcpServer({ accountId, id })
    .pipe(
      Effect.catchTag("McpServerNotFound", () => Effect.succeed(undefined)),
    );

test.provider(
  "overlong server IDs surface the typed validation error and remain cleanable",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();
      const error = yield* zeroTrust
        .readAccessAiControlMcpServer({
          accountId,
          id: "alchemy-test-mcp-server-id-is-too-long",
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("McpServerInvalidId");
      const deployError = yield* stack
        .deploy(
          Cloudflare.Access.McpServer("InvalidId", {
            serverId: "alchemy-test-mcp-server-id-is-too-long",
            hostname: HOSTNAME,
            authType: "unauthenticated",
            sync: false,
          }),
        )
        .pipe(Effect.flip);
      expect(deployError._tag).toEqual("McpServerInvalidId");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:access", "live"] },
);

test.provider(
  "create, update in place, and destroy an MCP server",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const server = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.McpServer("Upstream", {
            serverId: SERVER_ID,
            hostname: HOSTNAME,
            authType: "bearer",
            authCredentials: Redacted.make("alchemy-test-token-v1"),
            description: "alchemy mcp server v1",
            sync: false,
          });
        }),
      );

      expect(server.serverId).toEqual(SERVER_ID);
      expect(server.accountId).toEqual(accountId);
      expect(server.hostname).toEqual(HOSTNAME);
      expect(server.authType).toEqual("bearer");
      expect(server.name).toEqual(SERVER_ID);
      expect(server.description).toEqual("alchemy mcp server v1");
      expect(server.secureWebGateway).toEqual(false);
      expect(server.isSharedOauthCallbackEnabled).toEqual(false);
      expect(server.updatedTools).toEqual([]);
      expect(server.updatedPrompts).toEqual([]);

      const live = yield* getLiveServer(accountId, SERVER_ID);
      expect(live?.id).toEqual(SERVER_ID);
      expect(live?.hostname).toEqual(HOSTNAME);
      expect(live?.authType).toEqual("bearer");

      // Name, description, gateway, overrides, and a credential rotation
      // converge in place — same server id.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.McpServer("Upstream", {
            serverId: SERVER_ID,
            name: "Alchemy MCP Server",
            hostname: HOSTNAME,
            authType: "bearer",
            authCredentials: Redacted.make("alchemy-test-token-v2"),
            description: "alchemy mcp server v2",
            secureWebGateway: true,
            updatedTools: [
              { name: "search", enabled: false },
              { name: "fetch", alias: "get_page" },
            ],
            sync: false,
          });
        }),
      );
      expect(updated.serverId).toEqual(SERVER_ID);
      expect(updated.name).toEqual("Alchemy MCP Server");
      expect(updated.description).toEqual("alchemy mcp server v2");
      expect(updated.secureWebGateway).toEqual(true);
      expect(updated.updatedTools).toHaveLength(2);
      expect(
        updated.updatedTools.find((tool) => tool.name === "search")?.enabled,
      ).toEqual(false);
      expect(
        updated.updatedTools.find((tool) => tool.name === "fetch")?.alias,
      ).toEqual("get_page");

      const liveUpdated = yield* getLiveServer(accountId, SERVER_ID);
      expect(liveUpdated?.name).toEqual("Alchemy MCP Server");
      expect(liveUpdated?.secureWebGateway).toEqual(true);

      // No-op redeploy keeps the same server without drift.
      const noop = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.McpServer("Upstream", {
            serverId: SERVER_ID,
            name: "Alchemy MCP Server",
            hostname: HOSTNAME,
            authType: "bearer",
            authCredentials: Redacted.make("alchemy-test-token-v2"),
            description: "alchemy mcp server v2",
            secureWebGateway: true,
            updatedTools: [
              { name: "search", enabled: false },
              { name: "fetch", alias: "get_page" },
            ],
            sync: false,
          });
        }),
      );
      expect(noop.serverId).toEqual(SERVER_ID);

      yield* stack.destroy();

      const afterDestroy = yield* getLiveServer(accountId, SERVER_ID);
      expect(afterDestroy).toBeUndefined();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:access", "live"],
    timeout: 90_000,
  },
);

// `hostname` and `authType` are create-only on the API. Changing either must
// converge by recreating the server under the same id rather than failing.
test.provider(
  "changing the upstream hostname or auth type recreates the server under the same id",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.McpServer("Recreated", {
            serverId: RECREATE_SERVER_ID,
            hostname: HOSTNAME,
            authType: "unauthenticated",
            sync: false,
          });
        }),
      );
      expect(initial.serverId).toEqual(RECREATE_SERVER_ID);
      expect(initial.authType).toEqual("unauthenticated");

      const rehostPlan = yield* stack.plan(
        Cloudflare.Access.McpServer("Recreated", {
          serverId: RECREATE_SERVER_ID,
          hostname: HOSTNAME_V2,
          authType: "unauthenticated",
          sync: false,
        }),
      );
      const rehostChange = rehostPlan.resources.Recreated!;
      expect(rehostChange.action).toEqual("replace");
      if (rehostChange.action === "replace")
        expect(rehostChange.deleteFirst).toBe(true);

      const rehosted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.McpServer("Recreated", {
            serverId: RECREATE_SERVER_ID,
            hostname: HOSTNAME_V2,
            authType: "unauthenticated",
            sync: false,
          });
        }),
      );
      expect(rehosted.serverId).toEqual(RECREATE_SERVER_ID);
      expect(rehosted.hostname).toEqual(HOSTNAME_V2);
      expect(rehosted.authType).toEqual("unauthenticated");

      const authPlan = yield* stack.plan(
        Cloudflare.Access.McpServer("Recreated", {
          serverId: RECREATE_SERVER_ID,
          hostname: HOSTNAME_V2,
          authType: "bearer",
          authCredentials: Redacted.make("alchemy-test-token-recreate"),
          sync: false,
        }),
      );
      const authChange = authPlan.resources.Recreated!;
      expect(authChange.action).toEqual("replace");
      if (authChange.action === "replace")
        expect(authChange.deleteFirst).toBe(true);

      const recreated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.McpServer("Recreated", {
            serverId: RECREATE_SERVER_ID,
            hostname: HOSTNAME_V2,
            authType: "bearer",
            authCredentials: Redacted.make("alchemy-test-token-recreate"),
            sync: false,
          });
        }),
      );
      expect(recreated.serverId).toEqual(RECREATE_SERVER_ID);
      expect(recreated.hostname).toEqual(HOSTNAME_V2);
      expect(recreated.authType).toEqual("bearer");

      const live = yield* getLiveServer(accountId, RECREATE_SERVER_ID);
      expect(live?.hostname).toEqual(HOSTNAME_V2);
      expect(live?.authType).toEqual("bearer");

      yield* stack.destroy();

      const afterDestroy = yield* getLiveServer(accountId, RECREATE_SERVER_ID);
      expect(afterDestroy).toBeUndefined();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:access", "live"],
    timeout: 90_000,
  },
);

// Canonical `list()` test (account collection): deploy a server, then resolve
// the provider via the typed helper and assert the deployed server appears in
// the exhaustively-paginated result.
test.provider(
  "generates a valid server ID and lists the deployed MCP server",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.McpServer(
            "ServerWithALongLogicalNameForGeneratedIdCoverage",
            {
              hostname: HOSTNAME,
              authType: "unauthenticated",
              sync: false,
            },
          );
        }),
      );
      expect(deployed.serverId.length).toBeLessThanOrEqual(32);

      const provider = yield* Provider.findProvider(
        Cloudflare.Access.McpServer,
      );
      const all = yield* provider.list();

      expect(all.some((s) => s.serverId === deployed.serverId)).toBe(true);

      yield* stack.destroy();

      const afterDestroy = yield* getLiveServer(accountId, deployed.serverId);
      expect(afterDestroy).toBeUndefined();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:access", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "changing the server ID replaces the server and removes the old ID",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();

      const deploy = (serverId: string) =>
        stack.deploy(
          Cloudflare.Access.McpServer("Replaced", {
            serverId,
            hostname: HOSTNAME,
            authType: "unauthenticated",
            sync: false,
          }),
        );

      const initial = yield* deploy(REPLACE_SERVER_ID);
      expect(initial.serverId).toEqual(REPLACE_SERVER_ID);

      const replaced = yield* deploy(REPLACE_SERVER_ID_V2);
      expect(replaced.serverId).toEqual(REPLACE_SERVER_ID_V2);
      expect(
        yield* getLiveServer(accountId, REPLACE_SERVER_ID),
      ).toBeUndefined();
      expect(
        (yield* getLiveServer(accountId, REPLACE_SERVER_ID_V2))?.id,
      ).toEqual(REPLACE_SERVER_ID_V2);

      yield* stack.destroy();
      expect(
        yield* getLiveServer(accountId, REPLACE_SERVER_ID_V2),
      ).toBeUndefined();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:access", "live"],
    timeout: 90_000,
  },
);

// The default deploy runs a capability sync against the upstream. Against a
// real public server the discovered tools come back on the attributes.
test.provider(
  "sync discovers the capabilities of a public MCP server",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const server = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.McpServer("CloudflareDocs", {
            serverId: SYNC_SERVER_ID,
            hostname: PUBLIC_HOSTNAME,
            authType: "unauthenticated",
          });
        }),
      );

      expect(server.serverId).toEqual(SYNC_SERVER_ID);
      expect(server.status).toEqual("ready");
      expect(server.tools.length).toBeGreaterThan(0);

      yield* stack.destroy();

      const afterDestroy = yield* getLiveServer(accountId, SYNC_SERVER_ID);
      expect(afterDestroy).toBeUndefined();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:access", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "existing servers require adoption before their configuration can change",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();
      const serverId = "alchemy-test-mcp-adoption";
      const external = yield* zeroTrust.createAccessAiControlMcpServer({
        accountId,
        id: serverId,
        hostname: HOSTNAME,
        authType: "unauthenticated",
        name: "External MCP server",
      });
      const resource = () =>
        Cloudflare.Access.McpServer("Adopted", {
          serverId,
          hostname: HOSTNAME,
          authType: "unauthenticated",
          name: "Adopted MCP server",
          sync: false,
        });
      yield* Effect.gen(function* () {
        const refused = yield* stack.deploy(resource()).pipe(
          Effect.as(false),
          Effect.catchCause((cause) =>
            Effect.succeed(
              cause.reasons.some(
                (reason) =>
                  (Cause.isFailReason(reason) &&
                    reason.error instanceof OwnedBySomeoneElse) ||
                  (Cause.isDieReason(reason) &&
                    reason.defect instanceof OwnedBySomeoneElse),
              ),
            ),
          ),
        );
        expect(refused).toBe(true);
        expect((yield* getLiveServer(accountId, serverId))?.name).toEqual(
          external.name,
        );
        const adopted = yield* stack.deploy(resource().pipe(adopt(true)));
        expect(adopted.serverId).toEqual(external.id);
        expect(adopted.createdAt).toEqual(external.createdAt);
        expect((yield* getLiveServer(accountId, serverId))?.name).toEqual(
          "Adopted MCP server",
        );
        yield* stack.destroy();
        expect(yield* getLiveServer(accountId, serverId)).toBeUndefined();
      }).pipe(
        Effect.ensuring(
          // This test creates its fixture outside the stack. Reclaim that
          // exact fixture even if the adoption assertion fails.
          zeroTrust
            .deleteAccessAiControlMcpServer({ accountId, id: serverId })
            .pipe(
              Effect.catchTag("McpServerNotFound", () => Effect.void),
              Effect.orDie,
            ),
        ),
      );
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:access", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "recovers an interrupted create through explicit adoption and replaces across accounts",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();
      const props = {
        hostname: HOSTNAME,
        authType: "unauthenticated",
        sync: false,
      } as const;
      const resource = () => Cloudflare.Access.McpServer("Recovered", props);
      const initial = yield* stack.deploy(resource());
      const provider = yield* Provider.findProvider(
        Cloudflare.Access.McpServer,
      );
      // Validate account-change planning without needing credentials for a
      // second account or issuing any request to an invented account.
      const diff = yield* provider.diff!({
        id: "Recovered",
        fqn: "Recovered",
        instanceId: "test",
        olds: props,
        news: props,
        oldBindings: [],
        newBindings: [],
        output: { ...initial, accountId: "different-account" },
      });
      expect(diff?.action).toEqual("replace");

      const state = yield* yield* State;
      const fqns = yield* state.list({ stack: stack.name, stage: stack.stage });
      let interrupted = false;
      for (const fqn of fqns) {
        const row = yield* state.get({
          stack: stack.name,
          stage: stack.stage,
          fqn,
        });
        if (
          isResourceState(row) &&
          row.status === "created" &&
          row.resourceType === "Cloudflare.Access.McpServer"
        ) {
          yield* state.set({
            stack: stack.name,
            stage: stack.stage,
            fqn,
            value: { ...row, status: "creating", attr: undefined },
          });
          interrupted = true;
        }
      }
      expect(interrupted).toBe(true);
      const refused = yield* stack.deploy(resource()).pipe(
        Effect.as(false),
        Effect.catchCause((cause) =>
          Effect.succeed(
            cause.reasons.some(
              (reason) =>
                (Cause.isFailReason(reason) &&
                  reason.error instanceof OwnedBySomeoneElse) ||
                (Cause.isDieReason(reason) &&
                  reason.defect instanceof OwnedBySomeoneElse),
            ),
          ),
        ),
      );
      expect(refused).toBe(true);
      const recovered = yield* stack.deploy(resource().pipe(adopt(true)));
      expect(recovered.serverId).toEqual(initial.serverId);
      expect(recovered.createdAt).toEqual(initial.createdAt);
      yield* stack.destroy();
      expect(yield* getLiveServer(accountId, initial.serverId)).toBeUndefined();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:access", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "recreates a server deleted outside the stack",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();
      const resource = (name: string) =>
        Cloudflare.Access.McpServer("Deleted", {
          hostname: HOSTNAME,
          authType: "unauthenticated",
          name,
          sync: false,
        });
      const initial = yield* stack.deploy(resource("Before deletion"));
      yield* zeroTrust.deleteAccessAiControlMcpServer({
        accountId,
        id: initial.serverId,
      });
      expect(yield* getLiveServer(accountId, initial.serverId)).toBeUndefined();
      const recovered = yield* stack.deploy(resource("After deletion"));
      expect(recovered.serverId).toEqual(initial.serverId);
      expect(
        (yield* getLiveServer(accountId, recovered.serverId))?.name,
      ).toEqual("After deletion");
      yield* stack.destroy();
      expect(
        yield* getLiveServer(accountId, recovered.serverId),
      ).toBeUndefined();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:access", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "rotating only the bearer credential changes what the upstream receives",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();
      const upstream = () =>
        Cloudflare.Worker("AuthenticatedUpstream", {
          main: new URL("./fixtures/mcp-auth.ts", import.meta.url).pathname,
          // Cloudflare discovery can hit Worker-to-Worker error 1042 on
          // workers.dev. Custom domains support that fetch path.
          domain: "mcp-credential-rotation.alchemy-test-2.us",
          workersDev: true,
        });
      const worker = yield* stack.deploy(upstream());
      // Probe the script without negative-caching the new custom domain
      // in the local DNS resolver. Discovery checks the custom domain below.
      const health = yield* Test.getWhenReady(
        `${worker.urls.find((url) => url.endsWith(".workers.dev"))!}/health`,
      );
      expect(health.status).toEqual(200);
      const deploy = (version: "v1" | "v2") =>
        stack.deploy(
          Effect.gen(function* () {
            const endpoint = yield* upstream();
            return yield* Cloudflare.Access.McpServer("Rotating", {
              hostname: endpoint.url.pipe(Output.map((url) => `${url}/mcp`)),
              authType: "bearer",
              authCredentials: Redacted.make(`alchemy-mcp-rotation-${version}`),
            });
          }),
        );
      const initial = yield* deploy("v1");
      // Worker health and Cloudflare's discovery run in different locations.
      // Let the new route propagate before testing credential rotation. This
      // setup retry must not wrap the v2 deploy or mask a rotation failure.
      const ready =
        initial.status === "ready"
          ? initial
          : yield* zeroTrust
              .syncAccessAiControlMcpServer({ accountId, id: initial.serverId })
              .pipe(
                Effect.catchTag("McpServerSyncFailure", () => Effect.void),
                Effect.andThen(
                  zeroTrust.readAccessAiControlMcpServer({
                    accountId,
                    id: initial.serverId,
                  }),
                ),
                Effect.repeat({
                  while: (server) => server.status !== "ready",
                  schedule: Schedule.spaced("1 second"),
                  times: 8,
                }),
              );
      expect(ready.error || undefined).toBeUndefined();
      expect(ready.status).toEqual("ready");
      expect(ready.tools.map((tool) => tool.name)).toContain(
        "authenticated_v1",
      );
      // A rejected upstream credential must retain the complete failure body.
      yield* zeroTrust.updateAccessAiControlMcpServer({
        accountId,
        id: initial.serverId,
        authCredentials: "invalid-credential",
      });
      const failure = yield* zeroTrust
        .syncAccessAiControlMcpServer({
          accountId,
          id: initial.serverId,
        })
        .pipe(
          Effect.catchTag("McpServerSyncFailure", (error) =>
            Effect.succeed(error.body),
          ),
        );
      const body = Schema.decodeUnknownSync(
        Schema.Struct({
          success: Schema.Literal(false),
          result: Schema.Struct({
            status: Schema.Literal("error"),
            error: Schema.String,
            error_details: Schema.Struct({ status_code: Schema.Number }),
          }),
        }),
      )(failure);
      expect(body.result.error).toContain("Unauthorized");
      expect(body.result.error_details.status_code).toEqual(401);
      const rotated = yield* deploy("v2");
      expect(rotated.serverId).toEqual(initial.serverId);
      expect(rotated.createdAt).toEqual(initial.createdAt);
      // Discovery can report a transient routing error even after fetching
      // the new capabilities. Verify the credential through the returned tools.
      expect(rotated.tools.map((tool) => tool.name)).toContain(
        "authenticated_v2",
      );
      expect(rotated.tools.map((tool) => tool.name)).not.toContain(
        "authenticated_v1",
      );
      const live = yield* getLiveServer(accountId, rotated.serverId);
      expect(live?.tools.map((tool) => tool.name)).toContain(
        "authenticated_v2",
      );
      yield* stack.destroy();
      expect(yield* getLiveServer(accountId, rotated.serverId)).toBeUndefined();
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:access",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 120_000,
  },
);
