import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";
import {
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderUploadFeedbackError,
} from "./provider.ts";

const decodeProviderSessionStartInput = Schema.decodeUnknownSync(ProviderSessionStartInput);
const decodeProviderSendTurnInput = Schema.decodeUnknownSync(ProviderSendTurnInput);

function getOptionValue(
  options: ReadonlyArray<{ id: string; value: unknown }> | undefined,
  id: string,
): unknown {
  return options?.find((option) => option.id === id)?.value;
}

describe("ProviderSessionStartInput", () => {
  it("accepts codex-compatible payloads", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "codex",
      cwd: "/tmp/workspace",
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      },
      runtimeMode: "full-access",
    });
    expect(parsed.runtimeMode).toBe("full-access");
    expect(parsed.modelSelection?.instanceId).toBe("codex");
    expect(parsed.modelSelection?.model).toBe("gpt-5.3-codex");
    expect(getOptionValue(parsed.modelSelection?.options, "reasoningEffort")).toBe("high");
    expect(getOptionValue(parsed.modelSelection?.options, "fastMode")).toBe(true);
  });

  it("rejects payloads without runtime mode", () => {
    expect(() =>
      decodeProviderSessionStartInput({
        threadId: "thread-1",
        provider: "codex",
      }),
    ).toThrow();
  });

  it("accepts fork-provided driver kinds as branded slugs", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "ollama",
      providerInstanceId: "ollama_local",
      cwd: "/tmp/workspace",
      runtimeMode: "full-access",
      modelSelection: {
        instanceId: "ollama_local",
        model: "llama3.3",
      },
    });

    expect(parsed.provider).toBe("ollama");
    expect(parsed.providerInstanceId).toBe("ollama_local");
    expect(parsed.modelSelection?.instanceId).toBe("ollama_local");
  });
});

describe("ProviderSendTurnInput", () => {
  it("accepts 100 attachments and rejects 101", () => {
    const attachments = Array.from({ length: 100 }, (_, index) => ({
      type: "image",
      id: `image-${index}`,
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 1,
    }));
    expect(
      decodeProviderSendTurnInput({ threadId: "thread-1", attachments }).attachments,
    ).toHaveLength(100);
    expect(() =>
      decodeProviderSendTurnInput({
        threadId: "thread-1",
        attachments: [...attachments, attachments[0]],
      }),
    ).toThrow();
  });

  it.each(["image", "file"])(
    "caps total image bytes for %s attachments without charging videos",
    (type) => {
      const image = {
        type,
        id: "image",
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: 10 * 1024 * 1024,
      };
      const video = {
        type: "file",
        id: "video",
        name: "video.mp4",
        mimeType: "video/mp4",
        sizeBytes: 50 * 1024 * 1024,
      };
      expect(
        decodeProviderSendTurnInput({
          threadId: "thread-1",
          attachments: [...Array.from({ length: 8 }, () => image), video],
        }).attachments,
      ).toHaveLength(9);
      expect(() =>
        decodeProviderSendTurnInput({
          threadId: "thread-1",
          attachments: [...Array.from({ length: 8 }, () => image), { ...image, sizeBytes: 1 }],
        }),
      ).toThrow(/80 MiB/);
    },
  );
});

describe("provider feedback", () => {
  it("keeps the failed thread and original cause without exposing upstream text", () => {
    const cause = new Error("provider request secret");
    const error = new ProviderUploadFeedbackError({
      threadId: ThreadId.make("thread-1"),
      cause,
    });

    expect(error.threadId).toBe("thread-1");
    expect(error.cause).toBe(cause);
    expect(error.message).toBe("Failed to upload feedback for thread thread-1.");
    expect(error.message).not.toContain("provider request secret");
  });
});

describe("providerInstanceId routing key (slice-2 invariant)", () => {
  it("decodes a ProviderSessionStartInput without providerInstanceId (legacy producer)", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "codex",
      runtimeMode: "full-access",
    });
    expect(parsed.providerInstanceId).toBeUndefined();
  });

  it("rejects providerInstanceId values that fail the slug pattern (defense in depth)", () => {
    expect(() =>
      decodeProviderSessionStartInput({
        threadId: "thread-1",
        provider: "codex",
        providerInstanceId: "1bad",
        runtimeMode: "full-access",
      }),
    ).toThrow();
  });
});
