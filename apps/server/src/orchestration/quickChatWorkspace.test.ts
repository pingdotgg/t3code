import { ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";
import { ServerConfig } from "../config.ts";
import { makeQuickChatWorkspace } from "./quickChatWorkspace.ts";

const layer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-quick-workspace-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const threadId = ThreadId.make("quick-chat");

it.effect("transfers files before cleanup and retains the hidden note until acknowledged", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspaces = yield* makeQuickChatWorkspace;
    const cwd = yield* fs.makeTempDirectoryScoped();
    const source = workspaces.directory(threadId);
    yield* fs.makeDirectory(path.join(source, "scripts"), { recursive: true });
    yield* fs.writeFileString(path.join(source, "scripts", "example.py"), "print('hello')");
    yield* fs.writeFileString(path.join(source, ".notes"), "Keep this too");
    yield* fs.symlink("scripts/example.py", path.join(source, "run.py"));
    const transfer = yield* workspaces.prepare(threadId, cwd);
    const destination = path.join(
      cwd,
      "quick-chat-files",
      Buffer.from(threadId).toString("base64url"),
    );
    expect(yield* fs.readFileString(path.join(destination, "scripts", "example.py"))).toBe(
      "print('hello')",
    );
    expect(yield* fs.readFileString(path.join(destination, ".notes"))).toBe("Keep this too");
    expect(yield* fs.exists(source)).toBe(true);
    yield* transfer.commit;
    expect(yield* fs.exists(source)).toBe(false);
    expect(yield* fs.readLink(path.join(destination, "run.py"))).toBe("scripts/example.py");
    expect(yield* fs.readFileString(path.join(destination, "run.py"))).toBe("print('hello')");
    const restarted = yield* makeQuickChatWorkspace;
    expect(yield* restarted.pendingNote(threadId, cwd)).toContain(destination);
    expect(yield* restarted.pendingNote(threadId, cwd)).toContain(source);
    // Changing the project workspace before the next turn must not lose the handoff.
    expect(yield* restarted.pendingNote(threadId, `${cwd}/another-worktree`)).toContain(
      destination,
    );
    yield* restarted.clearNote(threadId);
    expect(yield* restarted.pendingNote(threadId, cwd)).toBeNull();
    yield* restarted.remove(threadId);
    expect(yield* fs.exists(destination)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("rolls back a failed attachment without losing the original files", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspaces = yield* makeQuickChatWorkspace;
    const cwd = yield* fs.makeTempDirectoryScoped();
    const source = workspaces.directory(threadId);
    yield* fs.makeDirectory(source, { recursive: true });
    yield* fs.writeFileString(path.join(source, "script.sh"), "echo hello");
    const transfer = yield* workspaces.prepare(threadId, cwd);
    yield* transfer.rollback;
    expect(yield* fs.readFileString(path.join(source, "script.sh"))).toBe("echo hello");
    expect(yield* fs.readDirectory(path.join(cwd, "quick-chat-files"))).toEqual([]);
    expect(yield* workspaces.pendingNote(threadId, cwd)).toBeNull();
    const retry = yield* workspaces.prepare(threadId, cwd);
    yield* retry.commit;
    expect(yield* fs.exists(source)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("refuses to overwrite a destination and leaves both copies intact", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspaces = yield* makeQuickChatWorkspace;
    const cwd = yield* fs.makeTempDirectoryScoped();
    const source = workspaces.directory(threadId);
    const destination = path.join(
      cwd,
      "quick-chat-files",
      Buffer.from(threadId).toString("base64url"),
    );
    yield* fs.makeDirectory(source, { recursive: true });
    yield* fs.makeDirectory(destination, { recursive: true });
    yield* fs.writeFileString(path.join(source, "script.sh"), "new");
    yield* fs.writeFileString(path.join(destination, "script.sh"), "existing");
    expect((yield* Effect.result(workspaces.prepare(threadId, cwd)))._tag).toBe("Failure");
    expect(yield* fs.readFileString(path.join(source, "script.sh"))).toBe("new");
    expect(yield* fs.readFileString(path.join(destination, "script.sh"))).toBe("existing");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("cleans an empty workspace without creating a project folder", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspaces = yield* makeQuickChatWorkspace;
    const cwd = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(workspaces.directory(threadId), { recursive: true });
    const transfer = yield* workspaces.prepare(threadId, cwd);
    yield* transfer.commit;
    expect(yield* fs.exists(workspaces.directory(threadId))).toBe(false);
    expect(yield* fs.exists(path.join(cwd, "quick-chat-files"))).toBe(false);
    expect(yield* workspaces.pendingNote(threadId, cwd)).toContain("contained no files");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("rejects attachment into the scratch directory without deleting its files", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspace = yield* makeQuickChatWorkspace;
    const source = workspace.directory(threadId);
    yield* fs.makeDirectory(`${source}/nested`, { recursive: true });
    yield* fs.writeFileString(`${source}/script.sh`, "echo keep");
    for (const cwd of [source, `${source}/nested`]) {
      expect((yield* Effect.result(workspace.prepare(threadId, cwd)))._tag).toBe("Failure");
      expect(yield* fs.readFileString(`${source}/script.sh`)).toBe("echo keep");
    }
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
