import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";
import {
  T3CODE_INTEGRATION_CONTEXT,
  withProviderIntegrationContext,
} from "./providerIntegrationContext.ts";

const TEST_THREAD_ID = ThreadId.make("thread-context-1");
const TEST_INSTANCE_ID = ProviderInstanceId.make("codex_personal");

const testLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-provider-integration-context-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const readContext = (environment: NodeJS.ProcessEnv | undefined): unknown => {
  const raw = environment?.[T3CODE_INTEGRATION_CONTEXT];
  expect(raw).toBeTypeOf("string");
  return JSON.parse(raw as string);
};

it("leaves the provider driver environment free of the integration marker", () => {
  const base = { PATH: "/bin", CODEX_HOME: "/home/.codex" };
  const merged = mergeProviderInstanceEnvironment(undefined, base);
  expect(T3CODE_INTEGRATION_CONTEXT in merged).toBe(false);
  expect(
    Object.keys(
      mergeProviderInstanceEnvironment(
        [{ name: "CUSTOM_VALUE", value: "1", sensitive: false }],
        base,
      ),
    ).sort(),
  ).toEqual(["CODEX_HOME", "CUSTOM_VALUE", "PATH"]);
});

it.layer(testLayer)("providerIntegrationContext", (it) => {
  it.effect("emits only the whitelisted conversation context", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(serverConfig.environmentIdPath, "environment-abc\n");

      const base = {
        PATH: "/usr/bin",
        SECRET_TOKEN: "super-secret-value",
        CWD_HINT: "/tmp/must-not-leak",
        T3CODE_INTEGRATION_CONTEXT: '{"inherited":true}',
      };
      const baseSnapshot = { ...base };

      const environment = yield* withProviderIntegrationContext(base, {
        kind: "conversation",
        threadId: TEST_THREAD_ID,
        providerInstanceId: TEST_INSTANCE_ID,
      });

      expect(environment).not.toBe(base);
      const context = readContext(environment);
      expect(context).toEqual({
        version: 1,
        kind: "conversation",
        environmentId: "environment-abc",
        threadId: "thread-context-1",
        providerInstanceId: "codex_personal",
      });
      expect(Object.keys(context as Record<string, unknown>).sort()).toEqual([
        "environmentId",
        "kind",
        "providerInstanceId",
        "threadId",
        "version",
      ]);
      const serialized = environment?.[T3CODE_INTEGRATION_CONTEXT] ?? "";
      expect(serialized).not.toContain("super-secret-value");
      expect(serialized).not.toContain("/tmp/must-not-leak");

      // The caller's environment is never mutated; only the copy gains the marker.
      expect(base).toEqual(baseSnapshot);
    }),
  );

  it.effect("fails open without the reserved key when the identity is missing or empty", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.remove(serverConfig.environmentIdPath).pipe(Effect.ignore);

      const withInherited = { PATH: "/bin", T3CODE_INTEGRATION_CONTEXT: '{"inherited":true}' };
      const missing = yield* withProviderIntegrationContext(withInherited, {
        kind: "auxiliary",
      });
      expect(missing?.[T3CODE_INTEGRATION_CONTEXT]).toBeUndefined();
      expect(missing?.PATH).toBe("/bin");
      expect(withInherited[T3CODE_INTEGRATION_CONTEXT]).toBe('{"inherited":true}');

      expect(
        yield* withProviderIntegrationContext(undefined, {
          kind: "conversation",
          threadId: TEST_THREAD_ID,
          providerInstanceId: TEST_INSTANCE_ID,
        }),
      ).toBeUndefined();

      yield* fileSystem.writeFileString(serverConfig.environmentIdPath, "   \n");
      const empty = yield* withProviderIntegrationContext(withInherited, { kind: "auxiliary" });
      expect(empty?.[T3CODE_INTEGRATION_CONTEXT]).toBeUndefined();
    }),
  );

  it.effect("emits an auxiliary context without conversation ids", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(serverConfig.environmentIdPath, "environment-xyz\n");

      const environment = yield* withProviderIntegrationContext(
        { PATH: "/bin", SECRET_TOKEN: "another-secret" },
        { kind: "auxiliary" },
      );

      expect(readContext(environment)).toEqual({
        version: 1,
        kind: "auxiliary",
        environmentId: "environment-xyz",
      });
    }),
  );

  it.effect(
    "strips a parent-process marker when identity is unavailable and no base env is supplied",
    () =>
      Effect.gen(function* () {
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.remove(serverConfig.environmentIdPath).pipe(Effect.ignore);
        const previous = process.env[T3CODE_INTEGRATION_CONTEXT];
        process.env[T3CODE_INTEGRATION_CONTEXT] = '{"kind":"conversation","threadId":"parent"}';
        try {
          const environment = yield* withProviderIntegrationContext(undefined, {
            kind: "auxiliary",
          });
          expect(environment).toBeDefined();
          expect(environment?.[T3CODE_INTEGRATION_CONTEXT]).toBeUndefined();
          expect(process.env[T3CODE_INTEGRATION_CONTEXT]).toContain("parent");
        } finally {
          if (previous === undefined) delete process.env[T3CODE_INTEGRATION_CONTEXT];
          else process.env[T3CODE_INTEGRATION_CONTEXT] = previous;
        }
      }),
  );

  it.effect("keeps two conversations in the same cwd distinct by thread id", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(serverConfig.environmentIdPath, "environment-shared\n");

      const first = yield* withProviderIntegrationContext(
        { PATH: "/bin" },
        {
          kind: "conversation",
          threadId: ThreadId.make("thread-a"),
          providerInstanceId: TEST_INSTANCE_ID,
        },
      );
      const second = yield* withProviderIntegrationContext(
        { PATH: "/bin" },
        {
          kind: "conversation",
          threadId: ThreadId.make("thread-b"),
          providerInstanceId: TEST_INSTANCE_ID,
        },
      );

      expect(readContext(first)).toMatchObject({
        environmentId: "environment-shared",
        threadId: "thread-a",
        providerInstanceId: "codex_personal",
      });
      expect(readContext(second)).toMatchObject({
        environmentId: "environment-shared",
        threadId: "thread-b",
        providerInstanceId: "codex_personal",
      });
    }),
  );
});
