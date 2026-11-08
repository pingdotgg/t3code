import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { vi } from "vite-plus/test";

import { makeCli } from "../binCli.ts";

vi.mock("../auth/EnvironmentAuth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/EnvironmentAuth.ts")>();
  const environment = await import("../environment/ServerEnvironment.ts");
  return {
    ...actual,
    layerRuntime: Layer.merge(
      Layer.mock(actual.EnvironmentAuth)({}),
      Layer.succeed(environment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("this-host")),
      }),
    ),
  };
});
vi.mock("../auth/ServerSecretStore.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/ServerSecretStore.ts")>();
  return {
    ...actual,
    layer: Layer.effect(
      actual.ServerSecretStore,
      Effect.gen(function* () {
        const mode = yield* Config.String("TEST_LINK_MODE");
        const values: Record<string, string> =
          mode === "unlinked"
            ? {}
            : {
                "cloud-linked-user-id": "user",
                "cloud-relay-url": "https://relay.example.test",
                ...(mode === "revoked" ? { "cloud-link-revoked": "true" } : {}),
                ...(mode === "publish_only" ? { "cloud-cli-desired-link": "publish_only" } : {}),
              };
        return actual.ServerSecretStore.of({
          get: (key) =>
            Effect.succeed(
              Option.fromUndefinedOr(values[key]).pipe(
                Option.map((value) => new TextEncoder().encode(value)),
              ),
            ),
          set: () => Effect.die("status must not write secrets"),
          remove: () => Effect.die("status must not remove secrets"),
          create: () => Effect.die("status must not create secrets"),
          getOrCreateRandom: () => Effect.die("status must not create secrets"),
        });
      }),
    ),
  };
});
vi.mock("../cloud/CliTokenManager.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cloud/CliTokenManager.ts")>();
  return {
    ...actual,
    layer: Layer.mock(actual.CloudCliTokenManager)({
      hasCredential: Effect.succeed(true),
      getExisting: Effect.succeedSome({
        accessToken: "synthetic-token",
        refreshToken: "refresh",
        expiresAtEpochMs: 9999999999999,
      }),
    }),
  };
});

const decodeStatus = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      publicAddress: Schema.NullOr(Schema.String),
      mcpUrl: Schema.NullOr(Schema.String),
      addressLookupError: Schema.NullOr(Schema.String),
    }),
  ),
);

it.effect(
  "connect status reports only this host's public endpoint in text and JSON, without changing link state",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-connect-status-" });
      const replies = (
        providerKind = "cloudflare_tunnel",
        httpBaseUrl = "https://this.example.test/",
      ) => ({
        environments: [
          {
            environmentId: "other-host",
            label: "Other",
            linkedAt: "2026-11-01",
            endpoint: {
              httpBaseUrl: "https://other.example.test",
              wsBaseUrl: "wss://other.example.test",
              providerKind: "cloudflare_tunnel",
            },
          },
          {
            environmentId: "this-host",
            label: "This",
            linkedAt: "2026-11-01",
            endpoint: {
              httpBaseUrl,
              wsBaseUrl: "wss://this.example.test/",
              providerKind,
            },
          },
        ],
      });
      using fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        assert.equal(request.method, "GET");
        assert.equal(request.url, "https://relay.example.test/v1/environments");
        assert.equal(request.headers.get("authorization"), "Bearer synthetic-token");
        return Response.json(replies());
      });
      const run = (mode: string, json = true) =>
        Command.runWith(makeCli({ cloudEnabled: true }), { version: "0.0.0" })([
          "connect",
          "status",
          "--base-dir",
          baseDir,
          ...(json ? ["--json"] : []),
        ]).pipe(
          Effect.provide(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: { TEST_LINK_MODE: mode } })),
          ),
        );
      yield* run("linked");
      assert.deepStrictEqual(decodeStatus(String((yield* TestConsole.logLines).at(-1))), {
        publicAddress: "this.example.test",
        mcpUrl: "https://this.example.test/mcp",
        addressLookupError: null,
      });
      yield* run("linked", false);
      assert.include(
        String((yield* TestConsole.logLines).at(-1)),
        "MCP URL: https://this.example.test/mcp",
      );
      for (const mode of ["unlinked", "revoked", "publish_only"]) {
        fetch.mockClear();
        yield* run(mode);
        assert.deepStrictEqual(decodeStatus(String((yield* TestConsole.logLines).at(-1))), {
          publicAddress: null,
          mcpUrl: null,
          addressLookupError: null,
        });
        assert.equal(fetch.mock.calls.length, 0);
      }
      fetch.mockResolvedValue(Response.json(replies("manual")));
      yield* run("linked");
      assert.isNull(decodeStatus(String((yield* TestConsole.logLines).at(-1))).mcpUrl);
      fetch.mockResolvedValue(Response.json(replies("cloudflare_tunnel", "not a URL")));
      yield* run("linked");
      const malformed = decodeStatus(String((yield* TestConsole.logLines).at(-1)));
      assert.isNull(malformed.mcpUrl);
      assert.isNotNull(malformed.addressLookupError);
      fetch.mockResolvedValue(new Response("unavailable", { status: 503 }));
      yield* run("linked");
      const failed = decodeStatus(String((yield* TestConsole.logLines).at(-1)));
      assert.isNull(failed.publicAddress);
      assert.isNotNull(failed.addressLookupError);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer)),
    ),
);
