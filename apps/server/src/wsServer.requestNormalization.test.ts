import path from "node:path";
import os from "node:os";

import type { ClientOrchestrationCommand, OrchestrationCommand } from "@t3tools/contracts";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveAttachmentPath } from "./attachmentStore.ts";
import { makeDispatchCommandNormalizer } from "./wsServer.requestNormalization.ts";

function makeFailRouteRequest() {
  return (message: string) => Effect.fail(new Error(message));
}

function makeFileSystem(overrides?: {
  readonly stat?: (targetPath: string) => Effect.Effect<unknown, never, never>;
  readonly makeDirectory?: (
    targetPath: string,
    options?: { readonly recursive?: boolean | undefined },
  ) => Effect.Effect<void, never, never>;
  readonly writeFile?: (
    targetPath: string,
    bytes: Uint8Array,
  ) => Effect.Effect<void, never, never>;
}) {
  return {
    stat:
      overrides?.stat ??
      (() =>
        Effect.succeed({
          type: "Directory",
        })),
    makeDirectory: overrides?.makeDirectory ?? (() => Effect.void),
    writeFile: overrides?.writeFile ?? (() => Effect.void),
  } as const;
}

describe("makeDispatchCommandNormalizer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("expands local project roots from the current home directory", async () => {
    vi.spyOn(os, "homedir").mockReturnValue("/home/reviewer");
    const statCalls: string[] = [];
    const normalize = makeDispatchCommandNormalizer({
      fileSystem: makeFileSystem({
        stat: (targetPath) =>
          Effect.sync(() => {
            statCalls.push(targetPath);
            return { type: "Directory" };
          }),
      }) as never,
      path: path.posix as never,
      stateDir: "/state",
      failRouteRequest: makeFailRouteRequest(),
    });

    const result = (await Effect.runPromise(
      normalize({
        command: {
          type: "project.create",
          commandId: "cmd-local",
          projectId: ProjectId.makeUnsafe("project-local"),
          title: "Review App",
          workspaceRoot: "~/workspace/review-app",
          executionTarget: "local",
          remoteHostId: null,
          remoteHostLabel: null,
          defaultModel: "gpt-5",
          createdAt: "2026-03-08T00:00:00.000Z",
        } as ClientOrchestrationCommand,
      }),
    )) as Extract<OrchestrationCommand, { readonly type: "project.create" }>;

    expect(result.workspaceRoot).toBe("/home/reviewer/workspace/review-app");
    expect(statCalls).toEqual(["/home/reviewer/workspace/review-app"]);
  });

  it("keeps remote project roots trimmed without touching the local filesystem", async () => {
    const stat = vi.fn(() => Effect.die("unexpected stat"));
    const normalize = makeDispatchCommandNormalizer({
      fileSystem: makeFileSystem({ stat }) as never,
      path: path.posix as never,
      stateDir: "/state",
      failRouteRequest: makeFailRouteRequest(),
    });

    const result = (await Effect.runPromise(
      normalize({
        command: {
          type: "project.create",
          commandId: "cmd-remote",
          projectId: ProjectId.makeUnsafe("project-remote"),
          title: "Remote Review App",
          workspaceRoot: "  ~/srv/review-app  ",
          executionTarget: "ssh-remote",
          remoteHostId: "host-review",
          remoteHostLabel: "Review Host",
          defaultModel: "gpt-5",
          createdAt: "2026-03-08T00:00:00.000Z",
        } as ClientOrchestrationCommand,
      }),
    )) as Extract<OrchestrationCommand, { readonly type: "project.create" }>;

    expect(result.workspaceRoot).toBe("~/srv/review-app");
    expect(stat).not.toHaveBeenCalled();
  });

  it("persists uploaded image attachments before dispatching turn start", async () => {
    const directories: string[] = [];
    const writes: Array<{ path: string; bytes: Uint8Array }> = [];
    const normalize = makeDispatchCommandNormalizer({
      fileSystem: makeFileSystem({
        makeDirectory: (targetPath) =>
          Effect.sync(() => {
            directories.push(targetPath);
          }),
        writeFile: (targetPath, bytes) =>
          Effect.sync(() => {
            writes.push({ path: targetPath, bytes });
          }),
      }) as never,
      path: path.posix as never,
      stateDir: "/state",
      failRouteRequest: makeFailRouteRequest(),
    });

    const result = (await Effect.runPromise(
      normalize({
        command: {
          type: "thread.turn.start",
          commandId: "cmd-turn",
          createdAt: "2026-03-08T00:00:00.000Z",
          threadId: ThreadId.makeUnsafe("thread-review"),
          provider: "codex",
          model: "gpt-5",
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: "/workspace/review-app",
          message: {
            id: "message-review",
            role: "user",
            text: "",
            attachments: [
              {
                type: "image",
                name: "diagram.png",
                mimeType: "image/png",
                sizeBytes: 4,
                dataUrl: "data:image/png;base64,QUJDRA==",
              },
            ],
          },
        } as unknown as ClientOrchestrationCommand,
      }),
    )) as Extract<OrchestrationCommand, { readonly type: "thread.turn.start" }>;

    expect(result.message.attachments).toHaveLength(1);
    const persistedAttachment = result.message.attachments[0];
    if (!persistedAttachment || persistedAttachment.type !== "image") {
      throw new Error("Expected persisted image attachment.");
    }

    const persistedPath = resolveAttachmentPath({
      stateDir: "/state",
      attachment: persistedAttachment,
    });
    expect(persistedPath).toBeTruthy();
    expect(directories).toEqual([path.posix.dirname(persistedPath!)]);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe(persistedPath);
    expect(Buffer.from(writes[0]?.bytes ?? []).toString("utf8")).toBe("ABCD");
  });
});
