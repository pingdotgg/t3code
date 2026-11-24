import { VMTier } from "@codesandbox/sdk";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { makeCodeSandboxDriver, type CodeSandboxSdkLike } from "./CodeSandboxDriver.ts";
import {
  makeUpstashBoxDriver,
  type UpstashBoxHandleLike,
  type UpstashBoxSdkLike,
} from "./UpstashBoxDriver.ts";
import {
  makeVercelSandboxDriver,
  VERCEL_HOBBY_CEILING_MINUTES,
  VERCEL_HOBBY_SNAPSHOT_MINUTES,
  VERCEL_HOBBY_WARNING_MINUTES,
  type VercelSandboxHandleLike,
  type VercelSandboxSdkLike,
} from "./VercelSandboxDriver.ts";

describe("sandbox provider drivers", () => {
  it.effect(
    "CodeSandboxDriver creates Nano VM, executes commands, hibernates, resumes, and maps CommandError",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        let isRunning = true;
        let createOpts: Record<string, unknown> | undefined;

        const makeSession = () => ({
          keepActiveWhileConnected: (enabled: boolean) => {
            calls.push(`keepActive:${String(enabled)}`);
          },
          commands: {
            run: async (command: string) => {
              calls.push(`run:${command}`);
              if (command === "fail-me") {
                throw Object.assign(new Error("command failed"), {
                  exitCode: 42,
                  output: "boom stderr",
                });
              }
              return "ok-out";
            },
            runBackground: async (command: string) => {
              calls.push(`bg:${command}`);
            },
          },
          hosts: {
            getUrl: (port: number, protocol = "https") => `${protocol}://csb-1-${port}.csb.app`,
          },
          disconnect: async () => {
            calls.push("disconnect");
          },
          dispose: () => {
            calls.push("dispose");
          },
        });

        const sdk: CodeSandboxSdkLike = {
          sandboxes: {
            create: async (opts) => {
              createOpts = opts as Record<string, unknown>;
              return { id: "csb-1", connect: async () => makeSession() };
            },
            resume: async (id) => {
              isRunning = true;
              calls.push(`resume:${id}`);
              return { id, connect: async () => makeSession() };
            },
            hibernate: async (id) => {
              isRunning = false;
              calls.push(`hibernate:${id}`);
            },
            shutdown: async () => undefined,
            delete: async (id) => {
              calls.push(`delete:${id}`);
            },
            get: async (id) => ({ id }),
            listRunning: async () => ({ vms: isRunning ? [{ id: "csb-1" }] : [] }),
          },
        };

        const driver = makeCodeSandboxDriver({ apiKey: Redacted.make("csb_test_key"), sdk });

        const created = yield* driver.create({
          name: "kb-csb",
          idleTimeoutMinutes: 8,
          port: 3773,
        });
        expect(created.providerSandboxId).toBe("csb-1");
        expect(created.connectionUrl).toBe("https://csb-1-3773.csb.app");
        expect(createOpts?.privacy).toBe("public-hosts");
        expect(createOpts?.vmTier).toBe(VMTier.Nano);
        expect(createOpts?.hibernationTimeoutSeconds).toBe(480);

        const okExec = yield* driver.exec({ providerSandboxId: "csb-1", command: "echo hi" });
        expect(okExec).toEqual({ exitCode: 0, stdout: "ok-out", stderr: "" });

        const failedExec = yield* driver.exec({ providerSandboxId: "csb-1", command: "fail-me" });
        expect(failedExec).toEqual({ exitCode: 42, stdout: "", stderr: "boom stderr" });

        const snap = yield* driver.snapshot({ providerSandboxId: "csb-1", name: "base" });
        expect(snap).toEqual({ snapshotId: "csb-1", stoppedAfterSnapshot: true });

        const pausedStatus = yield* driver.getStatus("csb-1");
        expect(pausedStatus.state).toBe("paused");

        const resumed = yield* driver.resume("csb-1", { port: 3773 });
        expect(resumed.state).toBe("running");
        expect(resumed.connectionUrl).toBe("https://csb-1-3773.csb.app");

        yield* driver.destroy("csb-1");
        expect(calls).toContain("delete:csb-1");
        expect(calls).toContain("keepActive:false");
      }),
  );

  it.effect(
    "UpstashBoxDriver supports create/fromSnapshot, exec, snapshot, pause, resume, status, destroy",
    () =>
      Effect.gen(function* () {
        let currentStatus = "running";
        const commands: string[] = [];
        let usedFromSnapshot: string | null = null;

        const handle: UpstashBoxHandleLike = {
          id: "box-123",
          exec: {
            command: async (cmd) => {
              commands.push(cmd);
              return { exitCode: 0, stdout: "ran", stderr: "", result: "ran" };
            },
          },
          snapshot: async () => ({ id: "snap-up-1" }),
          pause: async () => {
            currentStatus = "paused";
          },
          resume: async () => {
            currentStatus = "running";
          },
          getStatus: async () => ({ status: currentStatus }),
          delete: async () => {
            currentStatus = "deleted";
          },
          getPublicURL: async (port) => ({ url: `https://box-123-${port}.upstash.app` }),
        };

        const sdk: UpstashBoxSdkLike = {
          create: async () => handle,
          fromSnapshot: async (snapshotId) => {
            usedFromSnapshot = snapshotId;
            return handle;
          },
          get: async () => handle,
        };

        const driver = makeUpstashBoxDriver({ apiKey: Redacted.make("upstash_key"), sdk });

        const created = yield* driver.create({
          name: "kb-upstash",
          snapshotId: "snap-seed",
          idleTimeoutMinutes: 8,
          port: 3773,
        });
        expect(usedFromSnapshot).toBe("snap-seed");
        expect(created.providerSandboxId).toBe("box-123");
        expect(created.connectionUrl).toBe("https://box-123-3773.upstash.app");

        const execRes = yield* driver.exec({
          providerSandboxId: "box-123",
          command: "node -v",
          cwd: "/workspace/repo",
          env: { FOO: "bar'baz" },
        });
        expect(execRes.exitCode).toBe(0);
        expect(commands[0]).toContain("export FOO='bar'\\''baz'");
        expect(commands[0]).toContain("cd '/workspace/repo'");

        const snap = yield* driver.snapshot({ providerSandboxId: "box-123", name: "cp1" });
        expect(snap).toEqual({ snapshotId: "snap-up-1", stoppedAfterSnapshot: false });

        const paused = yield* driver.pauseOrStop("box-123");
        expect(paused.state).toBe("paused");
        expect((yield* driver.getStatus("box-123")).state).toBe("paused");

        yield* driver.resume("box-123", { port: 3773 });
        expect((yield* driver.getStatus("box-123")).state).toBe("running");

        yield* driver.destroy("box-123");
        expect((yield* driver.getStatus("box-123")).state).toBe("stopped");
      }),
  );

  it.effect(
    "VercelSandboxDriver configures 45m Hobby timeout, persistent snapshots, stop/resume, and maps auth errors",
    () =>
      Effect.gen(function* () {
        expect(VERCEL_HOBBY_WARNING_MINUTES).toBe(40);
        expect(VERCEL_HOBBY_SNAPSHOT_MINUTES).toBe(43);
        expect(VERCEL_HOBBY_CEILING_MINUTES).toBe(45);

        let capturedCreateParams: Record<string, unknown> | undefined;
        let status: VercelSandboxHandleLike["status"] = "running";

        const handle: VercelSandboxHandleLike = {
          name: "kb-vercel-1",
          get status() {
            return status;
          },
          currentSnapshotId: "vsnap-0",
          runCommand: async () => ({
            exitCode: 0,
            stdout: async () => "vercel-ok",
            stderr: async () => "",
          }),
          domain: (port) => `https://kb-vercel-1-${port}.vercel.run`,
          snapshot: async () => {
            status = "stopped";
            return { snapshotId: "vsnap-43m" };
          },
          stop: async () => {
            status = "stopped";
            return { snapshot: { id: "vsnap-stop" } };
          },
          delete: async () => undefined,
        };

        const sdk: VercelSandboxSdkLike = {
          create: async (params) => {
            capturedCreateParams = params;
            return handle;
          },
          get: async () => handle,
        };

        const driver = makeVercelSandboxDriver({
          token: Redacted.make("vercel_tok"),
          teamId: "team_1",
          projectId: "prj_1",
          sdk,
        });

        const created = yield* driver.create({
          name: "kb-vercel-1",
          idleTimeoutMinutes: 8,
          port: 3773,
        });
        expect(created.providerSandboxId).toBe("kb-vercel-1");
        expect(created.connectionUrl).toBe("https://kb-vercel-1-3773.vercel.run");
        expect(capturedCreateParams?.timeout).toBe(45 * 60_000);
        expect(capturedCreateParams?.persistent).toBe(true);

        const execRes = yield* driver.exec({ providerSandboxId: "kb-vercel-1", command: "whoami" });
        expect(execRes).toEqual({ exitCode: 0, stdout: "vercel-ok", stderr: "" });

        const snap = yield* driver.snapshot({ providerSandboxId: "kb-vercel-1", name: "auto" });
        expect(snap).toEqual({ snapshotId: "vsnap-43m", stoppedAfterSnapshot: true });
        expect((yield* driver.getStatus("kb-vercel-1")).state).toBe("paused");

        const stopped = yield* driver.pauseOrStop("kb-vercel-1");
        expect(stopped).toEqual({ state: "paused", snapshotId: "vsnap-stop" });

        const authErrorSdk: VercelSandboxSdkLike = {
          create: async () => {
            const err = Object.assign(new Error("Unauthorized"), { statusCode: 401 });
            throw err;
          },
          get: async () => handle,
        };
        const failingDriver = makeVercelSandboxDriver({ sdk: authErrorSdk });
        const failure = yield* failingDriver
          .create({ name: "bad", idleTimeoutMinutes: 8, port: 3773 })
          .pipe(Effect.flip);
        expect(failure._tag).toBe("SandboxError");
        expect(failure.category).toBe("auth");
      }),
  );

  it.effect(
    "VercelSandboxDriver handles stopped sandboxes with no active session without throwing defects and normalizes names",
    () =>
      Effect.gen(function* () {
        let createdName: unknown;
        const stoppedHandle: VercelSandboxHandleLike = {
          name: "my-box-1",
          get status(): VercelSandboxHandleLike["status"] {
            throw new Error("No active session. Run a command or call resume first.");
          },
          get expiresAt(): Date | undefined {
            throw new Error("No active session. Run a command or call resume first.");
          },
          currentSnapshotId: "vsnap-paused",
          runCommand: async () => ({
            exitCode: 0,
            stdout: async () => "",
            stderr: async () => "",
          }),
          domain: (port) => `https://my-box-1-${port}.vercel.run`,
          snapshot: async () => ({ snapshotId: "vsnap-new" }),
          stop: async () => {
            throw new Error("No active session to stop.");
          },
          delete: async () => undefined,
        };

        const sdk: VercelSandboxSdkLike = {
          create: async (params) => {
            createdName = params.name;
            return stoppedHandle;
          },
          get: async () => stoppedHandle,
        };

        const driver = makeVercelSandboxDriver({ sdk });
        const created = yield* driver.create({
          name: "My Box #1!",
          idleTimeoutMinutes: 8,
          port: 3773,
        });
        expect(createdName).toBe("my-box-1");
        expect(created.state).toBe("paused");

        const statusRes = yield* driver.getStatus("my-box-1");
        expect(statusRes).toEqual({
          providerSandboxId: "my-box-1",
          state: "paused",
          snapshotId: "vsnap-paused",
        });

        const stopRes = yield* driver.pauseOrStop("my-box-1");
        expect(stopRes).toEqual({
          state: "paused",
          snapshotId: "vsnap-paused",
        });
      }),
  );
});
