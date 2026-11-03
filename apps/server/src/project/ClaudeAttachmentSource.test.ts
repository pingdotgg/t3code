// @effect-diagnostics-next-line nodeBuiltinImport:off - this isolated fixture owns the processes it starts.
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off - fixtures exercise the native filesystem adapter.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off - fixture paths match the native adapter.
import * as NodePath from "node:path";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Source from "./ClaudeAttachmentSource.ts";

const fixture = Effect.acquireRelease(
  Effect.promise(async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-claude-attach-"));
    const sessionId = "00000000-0000-4000-8000-000000000001";
    const root = NodePath.join(home, "projects", "deleted-workspace");
    const file = NodePath.join(root, `${sessionId}.jsonl`);
    await NodeFSP.mkdir(root, { recursive: true });
    await NodeFSP.mkdir(NodePath.join(home, "sessions"));
    await NodeFSP.writeFile(
      NodePath.join(home, "sessions", `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        sessionId,
        cwd: "/a/deleted/workspace",
        name: "repair-session",
      }),
    );
    return { home, file, sessionId };
  }),
  (f) => Effect.promise(() => NodeFSP.rm(f.home, { recursive: true, force: true })),
);

it.effect("refuses handoff while the registered process is alive, including an idle owner", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const source = yield* Source.ClaudeAttachmentSource;
    const error = yield* source.assertStopped(f.home, f.sessionId).pipe(Effect.flip);
    expect(error.operation).toBe("handoff");
    yield* Effect.promise(() =>
      NodeFSP.unlink(NodePath.join(f.home, "sessions", `${process.pid}.json`)),
    );
    yield* source.assertStopped(f.home, f.sessionId);
    yield* Effect.promise(() =>
      NodeFSP.writeFile(NodePath.join(f.home, "sessions", "999999.json"), "{"),
    );
    expect((yield* source.assertStopped(f.home, f.sessionId).pipe(Effect.flip)).operation).toBe(
      "handoff",
    );
  }).pipe(Effect.provide(Source.layer)),
);

it.effect(
  "finds the exact live session even when its workspace was deleted and discovers new subagents",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const source = yield* Source.ClaudeAttachmentSource;
      yield* Effect.promise(() => NodeFSP.writeFile(f.file, "{}\n"));
      expect((yield* source.discover(f.home, "repair-session")).sessionId).toBe(f.sessionId);
      expect(yield* source.children(f.home, f.file)).toEqual([]);
      const dir = f.file.slice(0, -6) + "/subagents";
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(dir, { recursive: true });
        await NodeFSP.writeFile(NodePath.join(dir, "agent-child.jsonl"), "{}\n");
      });
      expect(yield* source.children(f.home, f.file)).toEqual([
        { agentId: "child", path: NodePath.join(dir, "agent-child.jsonl") },
      ]);
      expect((yield* source.discover(f.home, "repair").pipe(Effect.flip))._tag).toBe(
        "ClaudeAttachmentSourceError",
      );
    }).pipe(Effect.provide(Source.layer)),
);

it.effect("waits for complete UTF-8 records and restarts after file replacement", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const source = yield* Source.ClaudeAttachmentSource;
    yield* Effect.promise(() => NodeFSP.writeFile(f.file, '{"text":"olá"}\n{"text":'));
    const first = yield* source.read(f.home, f.file, { offset: 0 });
    expect(first.lines).toEqual(['{"text":"olá"}']);
    const partial = yield* source.read(f.home, f.file, first.cursor);
    expect(partial.lines).toEqual([]);
    expect(partial.cursor).toEqual(first.cursor);
    yield* Effect.promise(() => NodeFSP.appendFile(f.file, '"done"}\n'));
    const next = yield* source.read(f.home, f.file, partial.cursor);
    expect(next.lines).toEqual(['{"text":"done"}']);
    yield* Effect.promise(async () => {
      await NodeFSP.rm(f.file);
      await NodeFSP.writeFile(f.file, "{}\n");
    });
    expect((yield* source.read(f.home, f.file, next.cursor)).lines).toEqual(["{}"]);
  }).pipe(Effect.provide(Source.layer)),
);

it.effect("preserves large tool records without skipping the next record", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const source = yield* Source.ClaudeAttachmentSource;
    const line = JSON.stringify({ text: "x".repeat(26 * 1024 * 1024) });
    yield* Effect.promise(() => NodeFSP.writeFile(f.file, line + '\n{"next":true}\n'));
    const read = yield* source.read(f.home, f.file, { offset: 0 });
    expect(read.lines).toEqual([line, '{"next":true}']);
    expect(read.caughtUp).toBe(true);
    expect((yield* source.read(f.home, f.file, read.cursor)).lines).toEqual([]);
  }).pipe(Effect.provide(Source.layer)),
);

it.effect("rejects transcripts symlinked outside Claude projects", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const source = yield* Source.ClaudeAttachmentSource;
    yield* Effect.promise(async () => {
      const outside = NodePath.join(f.home, "secret.txt");
      await NodeFSP.writeFile(outside, "private\n");
      await NodeFSP.symlink(outside, f.file);
    });
    expect((yield* source.read(f.home, f.file, { offset: 0 }).pipe(Effect.flip))._tag).toBe(
      "ClaudeAttachmentSourceError",
    );
  }).pipe(Effect.provide(Source.layer)),
);

it.effect("reads the current tail independently of a historical cursor", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const source = yield* Source.ClaudeAttachmentSource;
    const latest = JSON.stringify({ type: "assistant", message: { stop_reason: "end_turn" } });
    yield* Effect.promise(() => NodeFSP.writeFile(f.file, "{}\n".repeat(200000) + latest + "\n"));
    const history = yield* source.read(f.home, f.file, { offset: 0 });
    expect(history.caughtUp).toBe(false);
    const tail = yield* source.tail(f.home, f.file);
    expect(tail.lines.at(-1)).toBe(latest);
    expect(tail.offset + Buffer.byteLength(tail.lines.join("\n")) + 1).toBe(tail.size);
    yield* Effect.promise(() => NodeFSP.appendFile(f.file, "{}\n"));
    expect((yield* source.tail(f.home, f.file)).lines.at(-1)).toBe("{}");
  }).pipe(Effect.provide(Source.layer)),
);

it.live("interrupts only the verified source owner and its descendants", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const source = yield* Source.ClaudeAttachmentSource;
    // An unverified registry entry must never authorize a signal, on any platform.
    yield* source.interrupt(f.home, f.sessionId).pipe(Effect.flip);
    if ((yield* HostProcess.Platform) !== "linux") return;
    yield* Effect.promise(() =>
      NodeFSP.unlink(NodePath.join(f.home, "sessions", `${process.pid}.json`)),
    );
    const owner = yield* Effect.acquireRelease(
      Effect.sync(() =>
        NodeChildProcess.spawn(
          process.execPath,
          [
            "-e",
            `
        const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        process.stdout.write(String(child.pid));
        setInterval(() => {}, 1000);
      `,
          ],
          { detached: true, stdio: ["ignore", "pipe", "ignore"] },
        ),
      ),
      (child) =>
        Effect.sync(() => {
          if (child.pid && child.exitCode === null && child.signalCode === null) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              /* Already exited. */
            }
          }
        }),
    );
    const childPid = yield* Effect.promise(
      () =>
        new Promise<number>((resolve, reject) => {
          owner.once("error", reject);
          owner.stdout!.once("data", (chunk) => resolve(Number(chunk.toString())));
        }),
    );
    const stat = yield* Effect.promise(() => NodeFSP.readFile(`/proc/${owner.pid}/stat`, "utf8"));
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!;
    const registry = NodePath.join(f.home, "sessions", `${owner.pid}.json`);
    const writeOwner = (procStart: string) =>
      Effect.promise(() =>
        NodeFSP.writeFile(
          registry,
          JSON.stringify({ pid: owner.pid, procStart, sessionId: f.sessionId, cwd: f.home }),
        ),
      );
    yield* writeOwner("wrong-start-identity");
    yield* source.interrupt(f.home, f.sessionId);
    yield* source.assertStopped(f.home, f.sessionId);
    expect(owner.signalCode).toBeNull();
    yield* writeOwner(start);
    expect((yield* source.assertStopped(f.home, f.sessionId).pipe(Effect.flip)).reason).toBe(
      "running",
    );
    yield* source.interrupt(f.home, f.sessionId);
    yield* source.assertStopped(f.home, f.sessionId);
    const child = yield* Effect.promise(() =>
      NodeFSP.readFile(`/proc/${childPid}/stat`, "utf8").catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      }),
    );
    expect(
      child === undefined || child.slice(child.lastIndexOf(")") + 2).split(" ")[0] === "Z",
    ).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(Source.layer)),
);
