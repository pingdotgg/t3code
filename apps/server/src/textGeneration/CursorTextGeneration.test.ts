import * as NodeServices from "@effect/platform-node/NodeServices";
import { CursorSettings, ProviderInstanceId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@t3tools/shared/model";
import { beforeEach, vi } from "vite-plus/test";

import { makeCursorTextGeneration } from "./CursorTextGeneration.ts";

const cursorSdkMock = vi.hoisted(() => ({
  prompt: vi.fn(async (_prompt: string, _options: unknown) => ({
    id: "run-cursor-text-generation-test",
    status: "finished" as const,
    result:
      '{"subject":"Add generated commit message","body":"- verify cursor sdk text generation"}',
  })),
}));

vi.mock("@cursor/sdk", () => ({
  Agent: {
    prompt: cursorSdkMock.prompt,
  },
}));

const decodeCursorSettings = Schema.decodeSync(CursorSettings);
const cursorSettings = decodeCursorSettings({ enabled: true });

beforeEach(() => {
  cursorSdkMock.prompt.mockReset();
  cursorSdkMock.prompt.mockResolvedValue({
    id: "run-cursor-text-generation-test",
    status: "finished",
    result:
      '{"subject":"Add generated commit message","body":"- verify cursor sdk text generation"}',
  });
});

it.layer(NodeServices.layer)("CursorTextGeneration", (it) => {
  it.effect("runs Cursor metadata generation in an isolated sandboxed workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const textGeneration = yield* makeCursorTextGeneration(cursorSettings, {
        CURSOR_API_KEY: "test-cursor-key",
      });

      const generated = yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/cursor-text-generation",
        stagedSummary: "M apps/server/src/textGeneration/CursorTextGeneration.ts",
        stagedPatch:
          "diff --git a/apps/server/src/textGeneration/CursorTextGeneration.ts b/apps/server/src/textGeneration/CursorTextGeneration.ts",
        modelSelection: createModelSelection(ProviderInstanceId.make("cursor"), "gpt-5.4", [
          { id: "thinking", value: "high" },
          { id: "contextWindow", value: "1m" },
          { id: "fastMode", value: true },
        ]),
      });

      expect(generated.subject).toBe("Add generated commit message");
      expect(generated.body).toBe("- verify cursor sdk text generation");

      expect(cursorSdkMock.prompt).toHaveBeenCalledTimes(1);
      const [prompt, options] = (
        cursorSdkMock.prompt.mock.calls as unknown as Array<[string, unknown]>
      )[0]!;
      const metadataWorkspace = (options as { local: { cwd: string } }).local.cwd;
      expect(prompt).toContain("Do not use tools, read or write files, run commands");
      expect(prompt).toContain("Staged patch:");
      expect(metadataWorkspace).toContain("t3-cursor-metadata-");
      expect(metadataWorkspace).not.toBe(process.cwd());
      expect(yield* fileSystem.exists(metadataWorkspace)).toBe(false);
      expect(options).toEqual({
        apiKey: "test-cursor-key",
        mode: "plan",
        model: {
          id: "gpt-5.4",
          params: [
            { id: "thinking", value: "high" },
            { id: "context", value: "1m" },
            { id: "fast", value: "true" },
          ],
        },
        local: {
          cwd: metadataWorkspace,
          autoReview: false,
          settingSources: [],
          sandboxOptions: { enabled: true },
          enableAgentRetries: true,
        },
      });
    }),
  );

  it.effect("removes the isolated workspace when the Cursor SDK request fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      let metadataWorkspace: string | undefined;
      cursorSdkMock.prompt.mockImplementationOnce(async (_prompt, options) => {
        metadataWorkspace = (options as { local: { cwd: string } }).local.cwd;
        throw new Error("cursor request failed");
      });
      const textGeneration = yield* makeCursorTextGeneration(cursorSettings, {
        CURSOR_API_KEY: "test-cursor-key",
      });

      const error = yield* Effect.flip(
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/cursor-cleanup",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: {
            instanceId: ProviderInstanceId.make("cursor"),
            model: "composer-2",
          },
        }),
      );

      expect(error.detail).toBe("Cursor SDK request failed.");
      expect(metadataWorkspace).toBeDefined();
      expect(yield* fileSystem.exists(metadataWorkspace!)).toBe(false);
    }),
  );

  it.effect("accepts json objects with extra assistant text around them", () =>
    Effect.gen(function* () {
      cursorSdkMock.prompt.mockResolvedValueOnce({
        id: "run-cursor-text-generation-test",
        status: "finished",
        result:
          'Sure, here is the JSON:\n```json\n{\n  "subject": "Update README dummy comment with attribution and date",\n  "body": ""\n}\n```\nDone.',
      });
      const textGeneration = yield* makeCursorTextGeneration(cursorSettings, {
        CURSOR_API_KEY: "test-cursor-key",
      });

      const generated = yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/cursor-noisy-json",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: {
          instanceId: ProviderInstanceId.make("cursor"),
          model: "composer-2",
        },
      });

      expect(generated.subject).toBe("Update README dummy comment with attribution and date");
      expect(generated.body).toBe("");
    }),
  );

  it.effect("generates thread titles through Cursor SDK text generation", () =>
    Effect.gen(function* () {
      cursorSdkMock.prompt.mockResolvedValueOnce({
        id: "run-cursor-title-generation-test",
        status: "finished",
        result: '{"title":"\\"Trim reconnect spinner status after resume.\\""}',
      });
      const textGeneration = yield* makeCursorTextGeneration(cursorSettings, {
        CURSOR_API_KEY: "test-cursor-key",
      });

      const generated = yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "Fix the reconnect spinner after a resumed session.",
        modelSelection: {
          instanceId: ProviderInstanceId.make("cursor"),
          model: "composer-2",
        },
      });

      expect(generated.title).toBe("Trim reconnect spinner status after resume.");
    }),
  );

  it.effect("requires CURSOR_API_KEY before calling the SDK", () =>
    Effect.gen(function* () {
      const textGeneration = yield* makeCursorTextGeneration(cursorSettings, {});

      const error = yield* Effect.flip(
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/cursor-api-key",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: {
            instanceId: ProviderInstanceId.make("cursor"),
            model: "composer-2",
          },
        }),
      );

      expect(error.detail).toBe(
        "Cursor API key is required. Add CURSOR_API_KEY in provider settings.",
      );
      expect(cursorSdkMock.prompt).not.toHaveBeenCalled();
    }),
  );
});
