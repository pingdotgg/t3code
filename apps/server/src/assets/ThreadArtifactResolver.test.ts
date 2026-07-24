import { MessageId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  findThreadArtifactPath,
  normalizeThreadArtifactReference,
} from "./ThreadArtifactResolver.ts";

const TURN_ID = TurnId.make("turn-1");
const MESSAGE_ID = MessageId.make("message-1");

function message(
  id: MessageId = MESSAGE_ID,
  createdAt = "2026-01-01T00:00:03.000Z",
  updatedAt = createdAt,
) {
  return { id, role: "assistant", turnId: TURN_ID, createdAt, updatedAt };
}

function activity(
  path: string,
  options: {
    turnId?: TurnId | null;
    createdAt?: string;
    payload?: unknown;
  } = {},
) {
  return {
    turnId: options.turnId === undefined ? TURN_ID : options.turnId,
    createdAt: options.createdAt ?? "2026-01-01T00:00:02.000Z",
    payload: options.payload ?? { data: { rawOutput: { path } } },
  };
}

function thread(activities: ReadonlyArray<ReturnType<typeof activity>>) {
  return { messages: [message()], activities };
}

describe("thread artifact resolution", () => {
  it("normalizes relative Windows paths and accepts single-segment image references", () => {
    expect(normalizeThreadArtifactReference("images\\1.jpg")).toBe("images/1.jpg");
    expect(normalizeThreadArtifactReference("1.jpg")).toBe("1.jpg");
  });

  it("rejects absolute, traversal, and non-image references", () => {
    expect(normalizeThreadArtifactReference("/tmp/1.jpg")).toBeNull();
    expect(normalizeThreadArtifactReference("C:\\tmp\\1.jpg")).toBeNull();
    expect(normalizeThreadArtifactReference("images/../1.jpg")).toBeNull();
    expect(normalizeThreadArtifactReference("images/1.txt")).toBeNull();
  });

  it("matches unique paths including single-segment references", () => {
    const path = "/sessions/thread/images/1.jpg";
    expect(
      findThreadArtifactPath(thread([activity(path)]), TURN_ID, MESSAGE_ID, "images/1.jpg"),
    ).toBe(path);
    expect(findThreadArtifactPath(thread([activity(path)]), TURN_ID, MESSAGE_ID, "1.jpg")).toBe(
      path,
    );
  });

  it("reads Codex image generation and image view paths", () => {
    const generatedPath = "/sessions/thread/images/generated.png";
    const viewedPath = "/sessions/thread/images/viewed.png";
    const source = thread([
      activity(generatedPath, {
        payload: { data: { item: { type: "imageGeneration", savedPath: generatedPath } } },
      }),
      activity(viewedPath, {
        payload: { data: { item: { type: "imageView", path: viewedPath } } },
      }),
    ]);

    expect(findThreadArtifactPath(source, TURN_ID, MESSAGE_ID, "images/generated.png")).toBe(
      generatedPath,
    );
    expect(findThreadArtifactPath(source, TURN_ID, MESSAGE_ID, "images/viewed.png")).toBe(
      viewedPath,
    );
  });

  it("deduplicates repeated activities for the same artifact", () => {
    const path = "/sessions/thread/images/1.jpg";
    expect(
      findThreadArtifactPath(
        thread([activity(path), activity(path)]),
        TURN_ID,
        MESSAGE_ID,
        "1.jpg",
      ),
    ).toBe(path);
  });

  it("fails closed when distinct artifacts in the message window share a suffix", () => {
    expect(
      findThreadArtifactPath(
        thread([
          activity("/sessions/first/images/1.jpg"),
          activity("/sessions/second/images/1.jpg"),
        ]),
        TURN_ID,
        MESSAGE_ID,
        "images/1.jpg",
      ),
    ).toBeNull();
  });

  it("uses assistant message boundaries to exclude earlier and later artifacts", () => {
    const previousMessageId = MessageId.make("message-previous");
    const targetMessageId = MessageId.make("message-target");
    const source = {
      messages: [
        message(previousMessageId, "2026-01-01T00:00:02.000Z", "2026-01-01T00:00:03.000Z"),
        message(targetMessageId, "2026-01-01T00:00:06.000Z"),
      ],
      activities: [
        activity("/sessions/earlier/images/1.jpg", {
          createdAt: "2026-01-01T00:00:01.000Z",
        }),
        activity("/sessions/target/images/1.jpg", {
          createdAt: "2026-01-01T00:00:05.000Z",
        }),
        activity("/sessions/later/images/1.jpg", {
          createdAt: "2026-01-01T00:00:07.000Z",
        }),
      ],
    };

    expect(findThreadArtifactPath(source, TURN_ID, targetMessageId, "images/1.jpg")).toBe(
      "/sessions/target/images/1.jpg",
    );
  });

  it("ignores matching artifacts from other turns and unknown messages", () => {
    const path = "/sessions/thread/images/1.jpg";
    expect(
      findThreadArtifactPath(
        thread([activity(path, { turnId: TurnId.make("turn-2") })]),
        TURN_ID,
        MESSAGE_ID,
        "images/1.jpg",
      ),
    ).toBeNull();
    expect(
      findThreadArtifactPath(
        thread([activity(path)]),
        TURN_ID,
        MessageId.make("missing-message"),
        "images/1.jpg",
      ),
    ).toBeNull();
  });
});
