import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";

import type { QueuedThreadMessage } from "./thread-outbox-model";

const fileSystem = vi.hoisted(() => ({
  files: new Map<string, string>(),
  failNextMove: false,
}));

vi.mock("expo-file-system", () => {
  class Directory {
    readonly uri: string;

    constructor(parent: string, name: string) {
      this.uri = `${parent}/${name}`;
    }

    create(): void {}

    list(): File[] {
      const prefix = `${this.uri}/`;
      return [...fileSystem.files.keys()]
        .filter((uri) => uri.startsWith(prefix))
        .map((uri) => new File(uri));
    }
  }

  class File {
    readonly uri: string;
    readonly name: string;

    constructor(parent: Directory | string, name?: string) {
      this.uri = typeof parent === "string" ? parent : `${parent.uri}/${name}`;
      this.name = this.uri.slice(this.uri.lastIndexOf("/") + 1);
    }

    get exists(): boolean {
      return fileSystem.files.has(this.uri);
    }

    create(): void {
      fileSystem.files.set(this.uri, "");
    }

    write(content: string): void {
      fileSystem.files.set(this.uri, content);
    }

    async text(): Promise<string> {
      const content = fileSystem.files.get(this.uri);
      if (content === undefined) {
        throw new Error("missing file");
      }
      return content;
    }

    delete(): void {
      fileSystem.files.delete(this.uri);
    }

    async move(destination: File): Promise<void> {
      if (fileSystem.failNextMove) {
        fileSystem.failNextMove = false;
        throw new Error("simulated process interruption before replace");
      }
      const content = fileSystem.files.get(this.uri);
      if (content === undefined) {
        throw new Error("missing source");
      }
      fileSystem.files.set(destination.uri, content);
      fileSystem.files.delete(this.uri);
    }
  }

  return {
    Directory,
    File,
    Paths: { document: "document://root" },
  };
});

import { expoThreadOutboxStorage } from "./thread-outbox-storage";

function queuedMessage(text: string): QueuedThreadMessage {
  return {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    messageId: MessageId.make("message-1"),
    commandId: CommandId.make("command-1"),
    text,
    attachments: [],
    createdAt: "2026-08-13T12:00:00.000Z",
  };
}

describe("expoThreadOutboxStorage", () => {
  beforeEach(() => {
    fileSystem.files.clear();
    fileSystem.failNextMove = false;
  });

  it("keeps the previous durable row when replacement is interrupted", async () => {
    await expoThreadOutboxStorage.write(queuedMessage("before"));

    fileSystem.failNextMove = true;
    await expect(expoThreadOutboxStorage.write(queuedMessage("after"))).rejects.toThrow(
      "Thread outbox storage operation write failed",
    );

    await expect(expoThreadOutboxStorage.load()).resolves.toEqual([queuedMessage("before")]);

    await expoThreadOutboxStorage.write(queuedMessage("after"));
    await expect(expoThreadOutboxStorage.load()).resolves.toEqual([queuedMessage("after")]);
  });

  it("removes an interrupted replacement together with the durable row", async () => {
    const message = queuedMessage("before");
    await expoThreadOutboxStorage.write(message);
    fileSystem.failNextMove = true;
    await expect(expoThreadOutboxStorage.write(queuedMessage("after"))).rejects.toThrow();

    await expoThreadOutboxStorage.remove(message);

    expect(fileSystem.files.size).toBe(0);
    await expect(expoThreadOutboxStorage.load()).resolves.toEqual([]);
  });
});
