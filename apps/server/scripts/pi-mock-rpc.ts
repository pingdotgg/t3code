#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Standalone JSONL process fixture.
// Fake `pi --mode rpc` for tests; driven by `PI_MOCK_*` env vars.
import * as NodeReadline from "node:readline";
import * as NodeTimers from "node:timers";

const assistantText = process.env["PI_MOCK_ASSISTANT_TEXT"] ?? '{"title":"Mock title"}';
const emitInvalidJson = process.env["PI_MOCK_EMIT_INVALID_JSON"] === "1";
const lastTextFails = process.env["PI_MOCK_LAST_TEXT_FAILS"] === "1";
const exitOnPrompt = process.env["PI_MOCK_EXIT_ON_PROMPT"] === "1";
const retryOnce = process.env["PI_MOCK_RETRY_ONCE"] === "1";
const requireImage = process.env["PI_MOCK_REQUIRE_IMAGE"] === "1";
const expectedImageData = process.env["PI_MOCK_EXPECT_IMAGE_DATA"];

const replyText = emitInvalidJson
  ? "Sure — here is the answer, with no JSON at all."
  : assistantText;
let lastAssistantText: string | null = null;
let didRetry = false;

function write(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const rl = NodeReadline.createInterface({ input: process.stdin });

rl.on("line", (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let command: { type?: string; id?: string; images?: unknown };
  try {
    command = JSON.parse(trimmed) as { type?: string; id?: string; images?: unknown };
  } catch {
    return;
  }

  switch (command.type) {
    case "prompt":
    case "steer":
    case "follow_up": {
      if (exitOnPrompt) {
        process.exit(17);
      }

      const hasExpectedImage =
        Array.isArray(command.images) &&
        command.images.some(
          (image) =>
            image !== null &&
            typeof image === "object" &&
            (image as Record<string, unknown>)["type"] === "image" &&
            (image as Record<string, unknown>)["mimeType"] === "image/png" &&
            (expectedImageData === undefined ||
              (image as Record<string, unknown>)["data"] === expectedImageData),
        );
      const responseText =
        requireImage && !hasExpectedImage
          ? "The required image payload was not received."
          : replyText;
      const emitSuccessfulAttempt = (): void => {
        write({ type: "agent_start" });
        write({ type: "turn_start" });
        write({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: responseText },
        });
        lastAssistantText = responseText;
        write({ type: "message_end" });
        write({ type: "turn_end" });
        write({ type: "agent_end", willRetry: false });
      };

      if (retryOnce && !didRetry) {
        didRetry = true;
        write({ type: "agent_start" });
        write({ type: "agent_end", messages: [], willRetry: true });
        NodeTimers.setTimeout(emitSuccessfulAttempt, 100);
      } else {
        emitSuccessfulAttempt();
      }
      return;
    }
    case "get_last_assistant_text": {
      write(
        lastTextFails
          ? {
              type: "response",
              id: command.id,
              command: "get_last_assistant_text",
              success: false,
              error: "no assistant text",
            }
          : {
              type: "response",
              id: command.id,
              command: "get_last_assistant_text",
              success: true,
              data: { text: lastAssistantText },
            },
      );
      return;
    }
    case "get_state": {
      write({
        type: "response",
        id: command.id,
        command: "get_state",
        success: true,
        data: {
          sessionId: "mock-session",
          sessionFile: "/tmp/pi-mock-session.json",
          thinkingLevel: "off",
          isStreaming: false,
          isCompacting: false,
          steeringMode: "all",
          followUpMode: "all",
          autoCompactionEnabled: false,
          messageCount: 0,
          pendingMessageCount: 0,
        },
      });
      return;
    }
    case "get_commands": {
      write({
        type: "response",
        id: command.id,
        command: "get_commands",
        success: true,
        data: { commands: [] },
      });
      return;
    }
    default: {
      if (command.id !== undefined) {
        write({
          type: "response",
          id: command.id,
          command: command.type ?? "unknown",
          success: true,
        });
      }
      return;
    }
  }
});

rl.on("close", () => {
  process.exit(0);
});
