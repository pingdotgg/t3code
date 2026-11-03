import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { CodexSettings, ProviderInstanceId, type ProviderAuthState } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import { makeCodexCliAuth } from "./CodexCliAuth.ts";
import { codexCliEnvironment, codexCliLaunchArgs } from "./Drivers/CodexRuntime.ts";
import { materializeCodexShadowHome, resolveCodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";

import { codexCliFixtureSource } from "./CodexCliAuth.testkit.ts";

const decodeCodexSettings = Schema.decodeEffect(CodexSettings);

it("removes mixed-case credentials before selecting the private Codex home", () => {
  expect(
    codexCliEnvironment(
      {
        OpenAI_Api_Key: "inherited-key",
        Codex_Api_Key: "configured-key",
        OpenAI_Base_Url: "https://other-provider.example",
        Access_Token: "inherited-token",
        T3code_Codex_Launch_Args: "--other-account",
        Codex_Home: "/other-account",
        PATH: "/tools",
        AWS_PROFILE: "project-tools",
      },
      "/private-account",
    ),
  ).toEqual({
    PATH: "/tools",
    AWS_PROFILE: "project-tools",
    CODEX_HOME: "/private-account",
  });
});

const makeFixture = Effect.fnUntraced(function* (mode: string, email = "one@example.test") {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-cli-auth-" });
  const sharedHome = path.join(root, "shared");
  yield* fs.makeDirectory(sharedHome);
  yield* fs.writeFileString(path.join(sharedHome, "auth.json"), '{"global":"unchanged"}');
  yield* fs.writeFileString(path.join(sharedHome, "config.toml"), "model = 'gpt-5.4'\n");
  const binaryPath = path.join(root, "codex");
  yield* fs.writeFileString(binaryPath, `#!${process.execPath}\n${codexCliFixtureSource}`, {
    mode: 0o755,
  });
  const spawn = yield* ChildProcessSpawner.ChildProcessSpawner;
  const requests: Array<{ method: string; params?: unknown }> = [];
  const children: Array<ChildProcessSpawner.ChildProcessHandle> = [];
  const started = yield* Deferred.make<void>();
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const child = yield* spawn.spawn(command);
      children.push(child);
      return {
        ...child,
        stdin: child.stdin.pipe(
          Sink.mapInputEffect((chunk: Uint8Array) =>
            Effect.gen(function* () {
              const request = JSON.parse(new TextDecoder().decode(chunk)) as {
                method: string;
                params?: unknown;
              };
              requests.push({
                method: request.method,
                ...(request.params !== undefined ? { params: request.params } : {}),
              });
              if (request.method === "account/login/start")
                yield* Deferred.succeed(started, undefined);
              return chunk;
            }),
          ),
        ),
      };
    }),
  );
  const create = Effect.fnUntraced(function* (id: string, accountEmail: string) {
    const homePath = path.join(root, id);
    const settings = yield* decodeCodexSettings({
      setupMode: "cli",
      binaryPath,
      homePath: sharedHome,
      shadowHomePath: homePath,
    });
    yield* materializeCodexShadowHome(yield* resolveCodexHomeLayout(settings));
    const runtime = {
      config: {
        ...settings,
        homePath,
        launchArgs: codexCliLaunchArgs("-c 'model_provider=\"other\"'"),
      },
      environment: codexCliEnvironment(
        {
          ...process.env,
          T3_TEST_MODE: mode,
          T3_TEST_EMAIL: accountEmail,
          OPENAI_API_KEY: "must-not-reach-child",
          CODEX_API_KEY: "must-not-reach-child",
          ACCESS_TOKEN: "must-not-reach-child",
          OPENAI_BASE_URL: "https://invalid.example.test",
          T3CODE_CODEX_LAUNCH_ARGS: "--invalid-override",
        },
        homePath,
      ),
      revision: binaryPath,
    };
    const auth = yield* makeCodexCliAuth({
      instanceId: ProviderInstanceId.make(id),
      homePath,
      resolveRuntime: Effect.succeed(runtime),
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    const phase = (phase: ProviderAuthState["phase"]) =>
      auth.subscribe("owner").pipe(
        Stream.filter((state) => state.phase === phase),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
    return { auth, phase, homePath, runtime };
  });
  return {
    ...(yield* create("one", email)),
    create,
    fs,
    path,
    sharedHome,
    requests,
    children,
    started,
  };
});

it.effect.each(["early", "after-response", "missing-id"])(
  "verifies native OAuth completion %s and isolates the real child environment",
  (mode) =>
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          for (const key of [
            "OPENAI_API_KEY",
            "CODEX_API_KEY",
            "OPENAI_BASE_URL",
            "ACCESS_TOKEN",
            "T3CODE_CODEX_LAUNCH_ARGS",
          ]) {
            vi.stubEnv(key, "ambient-must-not-reach-child");
          }
        }),
        () => Effect.sync(() => vi.unstubAllEnvs()),
      );
      const fixture = yield* makeFixture(mode);
      yield* fixture.auth.start("owner");
      expect((yield* fixture.phase("succeeded")).message).toBe("Sign-in complete.");
      expect(
        JSON.parse(
          yield* fixture.fs.readFileString(fixture.path.join(fixture.homePath, "auth.json")),
        ),
      ).toEqual({
        type: "chatgpt",
        email: "one@example.test",
        planType: "plus",
      });
      const launched = JSON.parse(
        yield* fixture.fs.readFileString(fixture.path.join(fixture.homePath, "launch.json")),
      );
      expect(launched.params).toEqual({ type: "chatgptDeviceCode" });
      expect(launched.env).toEqual({
        CODEX_HOME: fixture.homePath,
        OPENAI_API_KEY: null,
        CODEX_API_KEY: null,
        ACCESS_TOKEN: null,
        OPENAI_BASE_URL: null,
        T3CODE_CODEX_LAUNCH_ARGS: null,
      });
      expect(launched.args).toEqual([
        "app-server",
        "-c",
        'model_provider="other"',
        "-c",
        'cli_auth_credentials_store="file"',
        "-c",
        'model_provider="openai"',
        "-c",
        'chatgpt_base_url="https://chatgpt.com/backend-api/"',
      ]);
      expect(fixture.requests.map(({ method }) => method)).toEqual([
        "initialize",
        "initialized",
        "account/login/start",
        "account/read",
      ]);
      expect(yield* fixture.children[0]!.isRunning).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each(["failure", "no-account"])("does not accept unverified sign-in %s", (mode) =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture(mode);
    yield* fixture.auth.start("owner");
    expect((yield* fixture.phase("failed")).message).toBe(
      mode === "failure"
        ? "Codex sign-in failed. Start again and choose the intended OpenAI account."
        : "Codex could not verify the signed-in account. Try again.",
    );
    expect(fixture.requests.at(-1)).toEqual({
      method: "account/login/cancel",
      params: { loginId: "login-1" },
    });
    expect(
      yield* fixture.fs.readFileString(fixture.path.join(fixture.sharedHome, "auth.json")),
    ).toBe('{"global":"unchanged"}');
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each(["before-response", "waiting"])("cancels %s and closes its process", (mode) =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture(mode);
    const state = yield* fixture.auth.start("owner", undefined, "browser");
    if (mode === "waiting") {
      expect((yield* fixture.phase("waiting")).interaction).toEqual({
        type: "browser",
        id: state.flowId,
        url: "https://auth.openai.com/test",
        requiresConsent: false,
      });
    } else yield* Deferred.await(fixture.started);
    const result = yield* fixture.auth.cancel("owner", state.flowId!);
    expect(result.phase).toBe("cancelled");
    expect(yield* fixture.auth.isChangingCredentials!).toBe(false);
    expect(yield* fixture.children[0]!.isRunning).toBe(false);
    expect(fixture.requests.at(-1)).toEqual(
      mode === "waiting"
        ? { method: "account/login/cancel", params: { loginId: "login-1" } }
        : { method: "account/login/start", params: { type: "chatgpt" } },
    );
    expect(yield* fixture.fs.exists(fixture.path.join(fixture.homePath, "auth.json"))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("keeps two accounts independent and logs out only the selected overlay", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture("early");
    const second = yield* fixture.create("two", "two@example.test");
    yield* Effect.all([fixture.auth.start("owner"), second.auth.start("owner")], {
      concurrency: 2,
    });
    yield* Effect.all([fixture.phase("succeeded"), second.phase("succeeded")]);
    expect(yield* fixture.fs.readLink(fixture.path.join(second.homePath, "plugins"))).toBe(
      fixture.path.join(fixture.sharedHome, "plugins"),
    );
    let firstSessionClosed = false;
    let secondSessionClosed = false;
    yield* fixture.auth.withAccess!(
      Effect.addFinalizer(() =>
        Effect.sync(() => {
          firstSessionClosed = true;
        }),
      ),
    );
    yield* second.auth.withAccess!(
      Effect.addFinalizer(() =>
        Effect.sync(() => {
          secondSessionClosed = true;
        }),
      ),
    );
    let stopped = false;
    const result = yield* fixture.auth.logout(
      Effect.sync(() => {
        stopped = true;
      }),
    );
    expect({ phase: result.phase, message: result.message, stopped }).toEqual({
      phase: "idle",
      message: "Signed out.",
      stopped: true,
    });
    expect({ firstSessionClosed, secondSessionClosed }).toEqual({
      firstSessionClosed: true,
      secondSessionClosed: false,
    });
    expect(yield* fixture.fs.exists(fixture.path.join(fixture.homePath, "auth.json"))).toBe(false);
    expect(
      JSON.parse(yield* fixture.fs.readFileString(fixture.path.join(second.homePath, "auth.json"))),
    ).toEqual({ type: "chatgpt", email: "two@example.test", planType: "plus" });
    expect(
      yield* fixture.fs.readFileString(fixture.path.join(fixture.sharedHome, "auth.json")),
    ).toBe('{"global":"unchanged"}');
    expect((yield* fixture.auth.logout(Effect.void)).phase).toBe("idle");
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("fails logout when Codex still reports an account", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture("logout-stuck");
    yield* fixture.auth.start("owner");
    yield* fixture.phase("succeeded");
    expect(
      yield* fixture.auth.logout(Effect.void).pipe(
        Effect.flip,
        Effect.map((error) => error.detail),
      ),
    ).toBe("Could not sign out of Codex. Try again.");
    expect((yield* fixture.phase("failed")).message).toBe("Could not sign out. Try again.");
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("releases the credential gate when Codex exits while waiting for sign-in", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture("exit-after-start");
    yield* fixture.auth.start("owner");
    expect((yield* fixture.phase("failed")).message).toBe(
      "Codex closed before sign-in completed. Try again.",
    );
    expect(yield* fixture.auth.withAccess!(Effect.succeed("available"))).toBe("available");
    expect(yield* fixture.children[0]!.isRunning).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
