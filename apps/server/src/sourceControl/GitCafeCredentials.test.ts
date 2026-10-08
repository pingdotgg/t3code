import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import { VcsProcessExitError, VcsProcessSpawnError } from "@t3tools/contracts";
import { ChildProcessSpawner } from "effect/process";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitCafeCredentials from "./GitCafeCredentials.ts";

const answer = (stdout: string) => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

function harness(run: VcsProcess.VcsProcess["Service"]["run"]) {
  const calls: Array<VcsProcess.VcsProcessInput> = [];
  const layer = GitCafeCredentials.layer.pipe(
    Layer.provide(
      Layer.mock(VcsProcess.VcsProcess)({
        run: (input) => {
          calls.push(input);
          return run(input);
        },
      }),
    ),
    Layer.provide(NodeServices.layer),
  );
  return { layer, calls };
}

describe("GitCafeCredentials", () => {
  beforeEach(() => {
    vi.stubEnv("CAFE_TOKEN", "");
    vi.stubEnv("CAFE_HOST", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("hands CAFE_TOKEN only to the host cafe itself targets", () => {
    const token = { CAFE_TOKEN: "env-token" };
    expect(GitCafeCredentials.environmentToken("git.cafe", token)).toBe("env-token");
    expect(GitCafeCredentials.environmentToken("staging.git.cafe", token)).toBeNull();
    for (const CAFE_HOST of ["https://staging.git.cafe/api", "staging.git.cafe"]) {
      const staging = { ...token, CAFE_HOST };
      expect(GitCafeCredentials.environmentToken("staging.git.cafe", staging)).toBe("env-token");
      expect(GitCafeCredentials.environmentToken("git.cafe", staging)).toBeNull();
    }
    expect(GitCafeCredentials.environmentToken("git.cafe", { CAFE_TOKEN: " " })).toBeNull();
  });

  it.effect("asks cafe's Git credential helper over stdin and reuses the token", () => {
    const { layer, calls } = harness(() =>
      Effect.succeed(answer("protocol=https\nhost=git.cafe\nusername=alice\npassword=gct_1\n")),
    );
    return Effect.gen(function* () {
      const credentials = yield* GitCafeCredentials.GitCafeCredentials;
      const credential = yield* credentials.get("Git.Cafe");
      expect(Redacted.value(credential.token)).toBe("gct_1");
      expect(credential.source).toBe("cafe");
      yield* credentials.get("git.cafe");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        command: "cafe",
        args: ["auth", "http", "credential", "--host", "https://git.cafe/api", "get"],
        stdin: "protocol=https\nhost=git.cafe\n\n",
      });
      // A refused token is asked for again rather than reused.
      yield* credentials.invalidate("git.cafe");
      yield* credentials.get("git.cafe");
      expect(calls).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("prefers CAFE_TOKEN without running cafe", () => {
    vi.stubEnv("CAFE_TOKEN", "env-token");
    const { layer, calls } = harness(() => Effect.die("cafe must not run"));
    return Effect.gen(function* () {
      const credentials = yield* GitCafeCredentials.GitCafeCredentials;
      const credential = yield* credentials.get("git.cafe");
      expect(Redacted.value(credential.token)).toBe("env-token");
      expect(credential.source).toBe("env");
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    [
      "a missing CLI",
      Effect.fail(
        new VcsProcessSpawnError({
          operation: "GitCafeCredentials.get",
          command: "cafe",
          cwd: "/",
          cause: PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
          }),
        }),
      ),
      "GitCafeCliMissingError",
    ],
    [
      "a helper with no login",
      Effect.fail(
        new VcsProcessExitError({
          operation: "GitCafeCredentials.get",
          command: "cafe",
          cwd: "/",
          exitCode: 1,
          detail: "not signed in",
        }),
      ),
      "GitCafeNotSignedInError",
    ],
    [
      "an answer without a password",
      Effect.succeed(answer("username=alice\n")),
      "GitCafeNotSignedInError",
    ],
  ] as const)("reports %s", ([, result, tag]) => {
    const { layer } = harness(() => result);
    return Effect.gen(function* () {
      const credentials = yield* GitCafeCredentials.GitCafeCredentials;
      expect((yield* credentials.get("git.cafe").pipe(Effect.flip))._tag).toBe(tag);
    }).pipe(Effect.provide(layer));
  });
});
