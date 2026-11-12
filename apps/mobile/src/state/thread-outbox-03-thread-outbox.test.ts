import { describe, expect, it } from "@effect/vitest";
import { EnvironmentNotRegisteredError } from "@t3tools/client-runtime/connection";
import { isTransportConnectionErrorMessage } from "@t3tools/client-runtime/errors";
import { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
import {
  CommandId,
  ComposerContextId,
  EnvironmentAuthorizationError,
  EnvironmentId,
  MessageId,
  OrchestrationDispatchCommandError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import * as RpcClientError from "effect/rpc/RpcClientError";
import * as Socket from "effect/socket/Socket";
import { onTestFinished, vi } from "vite-plus/test";

const outboxFiles = vi.hoisted(() => new Map<string, string | Error>());

vi.mock("expo-file-system", () => {
  class Directory {
    create() {}

    list() {
      return Array.from(outboxFiles.keys(), (name) => new File(name));
    }
  }

  class File {
    readonly name: string;
    readonly parentDirectory = new Directory();

    constructor(...parts: [string] | [Directory, string]) {
      this.name = parts.length === 1 ? parts[0] : parts[1];
    }

    get exists() {
      return outboxFiles.has(this.name);
    }

    create() {
      outboxFiles.set(this.name, "");
    }

    write(contents: string) {
      outboxFiles.set(this.name, contents);
    }

    moveSync(file: File) {
      const contents = outboxFiles.get(this.name);
      if (contents === undefined) throw new Error("Missing file");
      outboxFiles.set(file.name, contents);
      outboxFiles.delete(this.name);
    }

    delete() {
      outboxFiles.delete(this.name);
    }

    async text(): Promise<string> {
      const contents = outboxFiles.get(this.name);
      if (contents instanceof Error) throw contents;
      if (contents === undefined) throw new Error("Missing file");
      return contents;
    }
  }

  return {
    File,
    Directory,
    Paths: { document: "/documents" },
  };
});

import {
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
  isQueuedThreadCreationSendable,
  resolveThreadOutboxDeliveryAction,
  resolveThreadOutboxDispatchStep,
  resolveThreadOutboxFailureAction,
  resolveQueuedThreadSettings,
  shouldRetryThreadOutboxDelivery,
  type QueuedThreadMessage,
} from "./thread-outbox-model";
import { createThreadOutboxManager, ThreadOutboxManagerError } from "./thread-outbox-manager";
import {
  expoThreadOutboxStorage,
  ThreadOutboxStorageError,
  type ThreadOutboxLoadResult,
  type ThreadOutboxStorage,
} from "./thread-outbox-storage";

function queuedMessage(input: {
  readonly environmentId?: string;
  readonly threadId?: string;
  readonly messageId: string;
  readonly createdAt: string;
}): QueuedThreadMessage {
  return {
    environmentId: EnvironmentId.make(input.environmentId ?? "environment-1"),
    threadId: ThreadId.make(input.threadId ?? "thread-1"),
    messageId: MessageId.make(input.messageId),
    commandId: CommandId.make(`command-${input.messageId}`),
    text: input.messageId,
    attachments: [],
    createdAt: input.createdAt,
  };
}



describe("thread outbox", () => {
  it("round-trips queued PR checkout sources and gates incomplete creations from sending", () => {
    const base = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const creationMessage = {
      ...base,
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      creation: {
        projectId: ProjectId.make("project-1"),
        workspaceMode: "worktree",
        branch: "fork/feature",
        worktreePath: null,
        startFromOrigin: false,
        pullRequestReference: "https://github.com/acme/repo/pull/123",
      },
    } satisfies QueuedThreadMessage;

    expect(decodeQueuedThreadMessage(encodeQueuedThreadMessage(creationMessage))).toEqual(
      creationMessage,
    );
    expect(isQueuedThreadCreationSendable(creationMessage)).toBe(true);
    expect(
      isQueuedThreadCreationSendable({
        ...creationMessage,
        creation: { ...creationMessage.creation, branch: null },
      }),
    ).toBe(false);
    expect(
      isQueuedThreadCreationSendable({
        ...creationMessage,
        creation: { ...creationMessage.creation, branch: "" },
      }),
    ).toBe(false);
    expect(isQueuedThreadCreationSendable({ ...creationMessage, modelSelection: undefined })).toBe(
      false,
    );
    expect(isQueuedThreadCreationSendable(base)).toBe(false);
    expect(isQueuedThreadCreationSendable({ ...creationMessage, text: "  " })).toBe(false);
    expect(
      isQueuedThreadCreationSendable({
        ...creationMessage,
        text: "",
        attachments: [
          {
            id: "image-1",
            type: "image",
            name: "photo.png",
            mimeType: "image/png",
            sizeBytes: 3,
            fileUri: "file:///documents/t3-composer-attachments/photo.png",
            previewUri: "file:///documents/t3-composer-attachments/photo.png",
            uploadedAttachmentId: "pending-photo-png",
            uploadEnvironmentId: EnvironmentId.make("environment-1"),
          },
        ],
      }),
    ).toBe(true);
  });
  it("retries transport failures but drops deterministic command failures", () => {
    expect(shouldRetryThreadOutboxDelivery(new Error("Socket is not connected"))).toBe(true);
    expect(
      shouldRetryThreadOutboxDelivery({
        _tag: "ConnectionTransientError",
        message: "temporarily unavailable",
      }),
    ).toBe(true);
    expect(shouldRetryThreadOutboxDelivery(new Error("Thread no longer exists"))).toBe(false);
    expect(
      shouldRetryThreadOutboxDelivery(
        new OrchestrationDispatchCommandError({ message: "Thread no longer exists" }),
      ),
    ).toBe(false);
    expect(
      shouldRetryThreadOutboxDelivery(
        new EnvironmentAuthorizationError({
          message: "Missing scope",
          requiredScope: "orchestration:operate",
        }),
      ),
    ).toBe(false);
  });
  it("retries every in-flight transport failure by tag, not by message text", () => {
    const socketReasons = [
      new Socket.SocketReadError({ cause: new Error("The network connection was lost.") }),
      new Socket.SocketWriteError({ cause: new Error("Broken pipe") }),
      new Socket.SocketCloseError({ code: 1006 }),
      new Socket.SocketOpenError({ kind: "Timeout", cause: new Error("timeout") }),
    ];
    for (const reason of socketReasons) {
      const error = new RpcClientError.RpcClientError({ reason });
      expect(isTransportConnectionErrorMessage(error.message)).toBe(
        reason._tag === "SocketCloseError" || reason._tag === "SocketOpenError",
      );
      expect(shouldRetryThreadOutboxDelivery(error)).toBe(true);
    }
    expect(
      shouldRetryThreadOutboxDelivery(
        new RpcClientError.RpcClientError({
          reason: new RpcClientError.RpcClientDefect({
            message: "Error decoding message",
            cause: new Error("Unexpected end of JSON input"),
          }),
        }),
      ),
    ).toBe(true);
    expect(
      shouldRetryThreadOutboxDelivery(
        new EnvironmentRpcUnavailableError({
          environmentId: "environment-1",
          message: "Home is not connected.",
        }),
      ),
    ).toBe(true);
    expect(
      shouldRetryThreadOutboxDelivery(
        new EnvironmentNotRegisteredError({ environmentId: EnvironmentId.make("environment-1") }),
      ),
    ).toBe(true);
  });
  it("retains queued messages when settings synchronization fails before startTurn", () => {
    const deterministicFailure = new Error("Thread no longer exists");

    expect(
      resolveThreadOutboxFailureAction({
        stage: "settings-sync",
        error: deterministicFailure,
        interrupted: false,
      }),
    ).toBe("retry");
    expect(
      resolveThreadOutboxFailureAction({
        stage: "start-turn",
        error: deterministicFailure,
        interrupted: false,
      }),
    ).toBe("restore");
  });
});

