import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";

import * as NetService from "@t3tools/shared/Net";
import { EnvironmentConflictError } from "@t3tools/contracts";
import { RemoteCliError } from "./cli/remote.ts";
import { makeCli } from "./cli/root.ts";
import { reportRemoteCliFailure } from "./standalone-bin.ts";
import { resolveEmbeddedClientAsset, type EmbeddedClientFile } from "./standaloneClientAssets.ts";

const cli = makeCli({ cloudEnabled: true });
const CliTestLayer = Layer.mergeAll(BunServices.layer, NetService.layer, TestConsole.layer);

it("resolves exact standalone web assets and falls back to the SPA entry", () => {
  const index = Object.assign(new Blob(["index"]), {
    name: "standalone-client/apps/web/dist/index.html",
  }) satisfies EmbeddedClientFile;
  const script = Object.assign(new Blob(["script"]), {
    name: "standalone-client/apps/web/dist/assets/index.js",
  }) satisfies EmbeddedClientFile;

  assert.equal(resolveEmbeddedClientAsset("assets/index.js", [index, script]), script);
  assert.equal(resolveEmbeddedClientAsset("threads/one", [index, script]), index);
});

it.effect("exposes the complete CLI command tree", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Command.runWith(cli, { version: "1.2.3" })(["--help"]);
      const output = (yield* TestConsole.logLines).join("\n");

      for (const command of ["serve", "connect", "service", "project", "auth", "remote"]) {
        assert.include(output, command);
      }
    }),
  ).pipe(Effect.provide(CliTestLayer)),
);

it.effect("exposes additive pending commands without changing watch availability", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Command.runWith(cli, { version: "1.2.3" })(["remote", "--help"]);
      const output = (yield* TestConsole.logLines).join("\n");

      for (const command of ["pending", "answer", "approve", "reject", "watch"]) {
        assert.include(output, command);
      }
    }),
  ).pipe(Effect.provide(CliTestLayer)),
);

it.effect(
  "documents interaction inspection, response syntax, and acknowledgement in CLI help",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const command of ["watch", "pending", "answer", "approve", "reject"]) {
          yield* Command.runWith(cli, { version: "1.2.3" })(["remote", command, "--help"]);
        }
        const output = (yield* TestConsole.logLines).join("\n");

        assert.include(output, "next actionable interaction");
        assert.include(output, "one-line redacted JSON");
        assert.include(output, "sanitized pending/responding interactions");
        assert.include(output, "operate authorization and explicit --yes");
        assert.include(output, "--answers-json");
        assert.include(output, "--decision");
        assert.include(output, "--idempotency-key");
      }),
    ).pipe(Effect.provide(CliTestLayer)),
);

it.effect(
  "requires explicit confirmation before answer, approve, or reject can make a request",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const commands = [
          ["answer", "--answers-json", '[{"questionId":"question-1","values":["yes"]}]'],
          ["approve"],
          ["reject"],
        ] as const;
        for (const [command, ...extraFlags] of commands) {
          const failure = yield* Effect.flip(
            Command.runWith(cli, { version: "1.2.3" })([
              "remote",
              command,
              "thread-1",
              "request-1",
              "--host",
              "http://127.0.0.1:1",
              "--idempotency-key",
              `retry-${command}`,
              ...extraFlags,
            ]),
          );
          assert.instanceOf(failure, RemoteCliError);
          assert.equal(failure.reason, "confirmation-required");
        }
      }),
    ).pipe(Effect.provide(CliTestLayer)),
);

it.effect("rejects non-strict answer JSON before making a remote request", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        Command.runWith(cli, { version: "1.2.3" })([
          "remote",
          "answer",
          "thread-1",
          "request-1",
          "--host",
          "http://127.0.0.1:1",
          "--idempotency-key",
          "retry-1",
          "--answers-json",
          '[{"questionId":"question-1","values":["yes"],"providerEnvelope":{}}]',
          "--yes",
        ]),
      );
      assert.instanceOf(failure, RemoteCliError);
      assert.equal(failure.reason, "invalid-input");
    }),
  ).pipe(Effect.provide(CliTestLayer)),
);

it.effect("sanitizes standalone remote failures and preserves their exit code", () =>
  Effect.gen(function* () {
    let exitCode: number | undefined;
    yield* reportRemoteCliFailure(new RemoteCliError({ reason: "request-failed" }), (code) => {
      exitCode = code;
    });

    assert.equal(exitCode, 1);
    assert.deepEqual(yield* TestConsole.errorLines, [
      "Remote request failed: The remote environment request failed.",
    ]);
  }).pipe(Effect.provide(TestConsole.layer)),
);

it.effect("renders the sanitized server conflict reason and preserves no-success semantics", () =>
  Effect.gen(function* () {
    let exitCode: number | undefined;
    const traceId = "0123456789abcdef0123456789abcdef";
    yield* reportRemoteCliFailure(
      new EnvironmentConflictError({
        code: "conflict",
        reason: "worktree_ref_in_use",
        message:
          "The requested branch is already checked out in another worktree. Archive or remove that worktree, or choose a different branch.",
        traceId,
      }),
      (code) => {
        exitCode = code;
      },
    );

    assert.equal(exitCode, 1);
    assert.deepEqual(yield* TestConsole.errorLines, [
      `Remote dispatch failed: The requested branch is already checked out in another worktree. Archive or remove that worktree, or choose a different branch. No success was assumed. (trace: ${traceId})`,
    ]);
  }).pipe(Effect.provide(TestConsole.layer)),
);

it.effect("redacts and bounds an untrusted typed server conflict before rendering", () =>
  Effect.gen(function* () {
    const secret = "server-secret-value";
    yield* reportRemoteCliFailure(
      new EnvironmentConflictError({
        code: "conflict",
        reason: "worktree_path_exists",
        message: `token=${secret} ${"x".repeat(2_000)}`,
        traceId: `trace-${secret}`,
      }),
    );

    const output = (yield* TestConsole.errorLines).join("\n");
    assert.notInclude(output, secret);
    assert.notInclude(output, "x".repeat(513));
    assert.include(output, "No success was assumed.");
    assert.include(output, "(trace: unavailable)");
  }).pipe(Effect.provide(TestConsole.layer)),
);
