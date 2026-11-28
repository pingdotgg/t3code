// @effect-diagnostics nodeBuiltinImport:off - A fake broker listens on the helper's private socket.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";
import { runManagedChatGptTokenCli } from "./managedChatGptToken.ts";

const profileKey = "a".repeat(64);
const sessionKey = "b".repeat(32);
const refusal = { kind: "refresh", message: "Your ChatGPT connection expired. Sign in again." };

/** Runs the helper against a fake broker that sends `answer`, or closes when it is null. */
const runAgainst = (answer: string | null) =>
  Effect.gen(function* () {
    // The helper connects to a real local socket, so this follows the host like the broker does.
    const platform = yield* HostProcess.Platform;
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-token-cli-"))),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    );
    const endpoint =
      platform === "win32"
        ? `\\\\.\\pipe\\t3-token-cli-${NodeCrypto.randomUUID()}`
        : NodePath.join(directory, "s");
    yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const server = NodeNet.createServer((socket) => {
          socket.once("data", () =>
            answer === null ? socket.destroy() : socket.end(`${answer}\n`),
          );
        });
        await new Promise<void>((resolve) => server.listen(endpoint, resolve));
        return server;
      }),
      (server) =>
        Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    const stdout: string[] = [];
    const stderr: string[] = [];
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
          stdout.push(String(chunk));
          return true;
        });
        vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
          stderr.push(String(chunk));
          return true;
        });
      }),
      () => Effect.sync(() => vi.restoreAllMocks()),
    );
    yield* Effect.promise(() =>
      runManagedChatGptTokenCli([
        endpoint,
        "codex-managed",
        "environment-1",
        profileKey,
        sessionKey,
      ]),
    );
    return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode: process.exitCode };
  }).pipe(Effect.scoped);

describe("managed ChatGPT token helper", () => {
  const exitCode = process.exitCode;
  afterEach(() => {
    process.exitCode = exitCode;
  });

  it.effect("prints a broker's refusal and gives Codex no token", () =>
    Effect.gen(function* () {
      const result = yield* runAgainst(JSON.stringify({ refusal }));
      expect(result).toEqual({ stdout: "", stderr: `${refusal.message}\n`, exitCode: 1 });
    }),
  );

  it.effect("hands Codex the broker's token on stdout", () =>
    Effect.gen(function* () {
      const result = yield* runAgainst(JSON.stringify({ token: "access-token" }));
      expect(result).toEqual({ stdout: "access-token", stderr: "", exitCode });
    }),
  );
});
