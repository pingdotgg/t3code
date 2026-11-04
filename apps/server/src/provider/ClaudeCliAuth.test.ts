import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ClaudeSettings, ProviderInstanceId, type ProviderAuthState } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import { makeClaudeCliAuth } from "./ClaudeCliAuth.ts";
import { resolveClaudeRuntime } from "./Drivers/ClaudeHome.ts";

import { claudeCliFixtureSource } from "./ClaudeCliAuth.testkit.ts";

const decodeClaudeSettings = Schema.decodeEffect(ClaudeSettings);

const makeFixture = Effect.fnUntraced(function* (mode = "success") {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-cli-auth-" });
  const existing = path.join(root, "existing");
  yield* fs.makeDirectory(existing);
  yield* fs.writeFileString(
    path.join(existing, "account.json"),
    '{"email":"existing@example.test"}',
  );
  const binaryPath = path.join(root, "claude");
  yield* fs.writeFileString(binaryPath, `#!${process.execPath}\n${claudeCliFixtureSource}`, {
    mode: 0o755,
  });
  const native = yield* ChildProcessSpawner.ChildProcessSpawner;
  const children: Array<ChildProcessSpawner.ChildProcessHandle> = [];
  const started = yield* Deferred.make<void>();
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const child = yield* native.spawn(command);
      children.push(child);
      yield* Deferred.succeed(started, undefined);
      return {
        ...child,
        stdout: child.stdout.pipe(
          Stream.flatMap((chunk) =>
            Stream.fromIterable(Array.from(chunk, (byte) => new Uint8Array([byte]))),
          ),
        ),
      };
    }),
  );
  const create = Effect.fnUntraced(function* (id: string) {
    const runtime = yield* resolveClaudeRuntime({
      instanceId: ProviderInstanceId.make(id),
      config: yield* decodeClaudeSettings({
        setupMode: "cli",
        binaryPath,
        homePath: existing,
      }),
      environment: {
        ...process.env,
        HOME: root,
        CLAUDE_CONFIG_DIR: existing,
        ANTHROPIC_API_KEY: "host-key",
        CLAUDE_CODE_OAUTH_TOKEN: "host-token",
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_PROFILE: "project-profile",
        T3_TEST_MODE: mode,
        T3_TEST_EMAIL: `${id}@example.test`,
      },
      stateDir: root,
    });
    const auth = yield* makeClaudeCliAuth({
      instanceId: ProviderInstanceId.make(id),
      runtime,
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    const phase = (phase: ProviderAuthState["phase"]) =>
      auth.subscribe("owner").pipe(
        Stream.filter((state) => state.phase === phase),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
    const signIn = Effect.gen(function* () {
      const state = yield* auth.start("owner");
      yield* phase("waiting");
      yield* auth.complete!("owner", {
        flowId: state.flowId!,
        callbackUrl: "fixture-code#fixture-state",
      });
      return yield* phase("succeeded");
    });
    return { auth, phase, runtime, signIn };
  });
  return { ...(yield* create("one")), create, fs, path, root, existing, children, started };
});

it.effect("accepts a chunked native URL and verifies the private subscription", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture();
    const state = yield* fixture.auth.start("owner");
    expect((yield* fixture.phase("waiting")).interaction).toEqual({
      type: "browser",
      id: state.flowId,
      url: "https://claude.com/cai/oauth/authorize?state=fixture-state&client_id=fixture-client",
      requiresConsent: false,
      acceptsCallback: true,
      callbackInputKind: "code",
    });
    yield* fixture.auth.complete!("owner", {
      flowId: state.flowId!,
      callbackUrl: "fixture-code#fixture-state",
    });
    expect((yield* fixture.phase("succeeded")).message).toBe("Sign-in complete.");
    expect(
      JSON.parse(
        yield* fixture.fs.readFileString(
          fixture.path.join(fixture.runtime.configDir, "account.json"),
        ),
      ),
    ).toEqual({
      loggedIn: true,
      authMethod: "claude.ai",
      apiProvider: "firstParty",
      email: "one@example.test",
    });
    const launched = JSON.parse(
      yield* fixture.fs.readFileString(fixture.path.join(fixture.runtime.configDir, "launch.json")),
    );
    expect(launched.env).toEqual({
      HOME: fixture.root,
      CLAUDE_CONFIG_DIR: fixture.runtime.configDir,
      ANTHROPIC_API_KEY: null,
      CLAUDE_CODE_OAUTH_TOKEN: null,
      CLAUDE_CODE_USE_BEDROCK: null,
      AWS_PROFILE: "project-profile",
    });
    expect(JSON.parse(launched.args[1])).toMatchObject({
      forceLoginMethod: "claudeai",
      apiKeyHelper: "",
      env: {
        CLAUDE_CONFIG_DIR: fixture.runtime.configDir,
        CLAUDE_CODE_USE_BEDROCK: "0",
        ANTHROPIC_PROFILE: "",
      },
    });
    expect(yield* Effect.forEach(fixture.children, (child) => child.isRunning)).toEqual([
      false,
      false,
    ]);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each(["failure", "no-account", "api-key", "bad-status"])(
  "rejects unverified native completion %s with safe errors",
  (mode) =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture(mode);
      const state = yield* fixture.auth.start("owner");
      yield* fixture.phase("waiting");
      yield* fixture.auth.complete!("owner", { flowId: state.flowId!, callbackUrl: "secret-code" });
      expect((yield* fixture.phase("failed")).message).toBe(
        mode === "failure"
          ? "Claude sign-in failed. Start again and choose the intended Claude account."
          : mode === "bad-status"
            ? "Could not complete Claude sign-in. Try again."
            : "Claude could not verify a subscription account. Start sign-in again.",
      );
      expect(yield* fixture.auth.withAccess!(Effect.succeed("available"))).toBe("available");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each(["no-url", "success"])("cancels the owned process %s", (mode) =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture(mode);
    const state = yield* fixture.auth.start("owner");
    if (mode === "success") yield* fixture.phase("waiting");
    else yield* Deferred.await(fixture.started);
    expect((yield* fixture.auth.cancel("owner", state.flowId!)).phase).toBe("cancelled");
    expect(yield* fixture.children[0]!.isRunning).toBe(false);
    expect(yield* fixture.auth.withAccess!(Effect.succeed("available"))).toBe("available");
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("rejects malformed, stale, and other-client codes while keeping the login usable", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture();
    const state = yield* fixture.auth.start("owner");
    yield* fixture.phase("waiting");
    for (const code of ["\ncode", "code\rcode", "code\0", " ", "x".repeat(4097)]) {
      expect(
        (yield* fixture.auth.complete!("owner", { flowId: state.flowId!, callbackUrl: code }).pipe(
          Effect.flip,
        )).detail,
      ).toBe("Paste the single-line code from Claude.");
    }
    for (const [owner, flowId] of [
      ["other", state.flowId!],
      ["owner", "stale"],
    ]) {
      expect(
        (yield* fixture.auth.complete!(owner!, {
          flowId: flowId!,
          callbackUrl: "fixture-code",
        }).pipe(Effect.flip)).detail,
      ).toBe("This sign-in is no longer active in this client.");
    }
    yield* fixture.auth.complete!("owner", { flowId: state.flowId!, callbackUrl: "fixture-code" });
    expect((yield* fixture.phase("succeeded")).phase).toBe("succeeded");
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("expires sign-in and closes its native process", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture();
    yield* fixture.auth.start("owner");
    yield* fixture.phase("waiting");
    yield* TestClock.adjust("6 minutes");
    expect((yield* fixture.phase("failed")).message).toBe("Sign-in expired. Start again.");
    expect(yield* fixture.children[0]!.isRunning).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("signs out one private account and accepts repeated sign-out requests", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture();
    const second = yield* fixture.create("two");
    yield* Effect.all([fixture.signIn, second.signIn], { concurrency: 2 });
    let firstClosed = false;
    let secondClosed = false;
    yield* fixture.auth.withAccess!(
      Effect.addFinalizer(() =>
        Effect.sync(() => {
          firstClosed = true;
        }),
      ),
    );
    yield* second.auth.withAccess!(
      Effect.addFinalizer(() =>
        Effect.sync(() => {
          secondClosed = true;
        }),
      ),
    );
    expect((yield* fixture.auth.logout(Effect.void)).message).toBe("Signed out.");
    expect((yield* fixture.auth.logout(Effect.void)).phase).toBe("idle");
    expect({ firstClosed, secondClosed }).toEqual({ firstClosed: true, secondClosed: false });
    expect(
      JSON.parse(
        yield* fixture.fs.readFileString(
          fixture.path.join(second.runtime.configDir, "account.json"),
        ),
      ),
    ).toMatchObject({ email: "two@example.test" });
    expect(
      yield* fixture.fs.readFileString(fixture.path.join(fixture.existing, "account.json")),
    ).toBe('{"email":"existing@example.test"}');
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("does not claim logout when the CLI still has credentials", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture("logout-stuck");
    yield* fixture.signIn;
    expect((yield* fixture.auth.logout(Effect.void).pipe(Effect.flip)).detail).toBe(
      "Could not sign out of Claude. Try again.",
    );
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("submits only one code to the owned login", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture("wait-after-code");
    const state = yield* fixture.auth.start("owner");
    yield* fixture.phase("waiting");
    const input = { flowId: state.flowId!, callbackUrl: "first-code" };
    yield* fixture.auth.complete!("owner", input);
    expect(
      (yield* fixture.auth.complete!("owner", { ...input, callbackUrl: "second-code" }).pipe(
        Effect.flip,
      )).detail,
    ).toBe("A sign-in code was already submitted.");
    expect((yield* fixture.auth.cancel("owner", state.flowId!)).phase).toBe("cancelled");
    expect(yield* fixture.children[0]!.isRunning).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
