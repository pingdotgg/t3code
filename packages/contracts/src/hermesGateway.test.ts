import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import sanitizedFixture from "./fixtures/hermesGateway.sanitized.json" with { type: "json" };
import {
  HermesGatewayEvent,
  HermesGatewayInboundFrame,
  HermesGatewayMutationOutcome,
  HermesGatewayMutationStatusResult,
  HermesGatewayPromptSubmitResult,
  HermesGatewayReadyEvent,
  HermesGatewayToolEventPayload,
} from "./hermesGateway.ts";

const decodeFrame = Schema.decodeUnknownSync(HermesGatewayInboundFrame);
const decodeEvent = Schema.decodeUnknownSync(HermesGatewayEvent);
const decodeMutationOutcome = Schema.decodeUnknownSync(HermesGatewayMutationOutcome);
const decodeMutationStatus = Schema.decodeUnknownSync(HermesGatewayMutationStatusResult);
const decodePromptSubmitResult = Schema.decodeUnknownSync(HermesGatewayPromptSubmitResult);
const decodeReady = Schema.decodeUnknownSync(HermesGatewayReadyEvent);
const decodeToolPayload = Schema.decodeUnknownSync(HermesGatewayToolEventPayload);

describe("Hermes gateway contracts", () => {
  it("decodes every sanitized H0 golden frame without discarding stable identities", () => {
    const decoded = sanitizedFixture.frames.map((frame) => decodeFrame(frame));

    expect(decoded).toHaveLength(sanitizedFixture.frames.length);
    const futureReady = decodeReady(sanitizedFixture.frames.at(-1));
    expect(futureReady.params.event_id).toBe("<event-id:ready>");
    expect(futureReady.params.event_sequence).toBe(17);
    expect(futureReady.params.session_key).toBe("<stored-session-id:01>");
    expect(futureReady.params.run_id).toBe("<run-id:01>");
    expect(futureReady.params.message_id).toBe("<message-id:01>");
    expect(futureReady.params.payload.protocol?.capabilities).toMatchObject({
      version: "1",
      "mutation.stable_ids": "supported",
      branching: {
        mode: "latest",
        stable_boundaries: false,
      },
    });
  });

  it("keeps unknown events inspectable for independent capability degradation", () => {
    const unknown = decodeEvent(
      sanitizedFixture.frames.find(
        (frame) => frame.method === "event" && frame.params?.type === "future.unknown",
      ),
    );

    expect(unknown.params.type).toBe("future.unknown");
    expect(unknown.params.session_id).toBe("<session-id:01>");
    expect(unknown.params.payload).toEqual({ opaque: "<redacted-content>" });
  });

  it("decodes the upstream Hermes tool lifecycle payload fields", () => {
    expect(
      decodeToolPayload({
        tool_id: "call-1",
        name: "terminal",
        context: "echo hello",
        args_text: '{\n  "command": "echo hello"\n}',
        args: { command: "echo hello" },
        result: { output: "hello", exit_code: 0 },
        result_text: "hello",
        summary: "Ran command in 0.2s",
        duration_s: 0.2,
        todos: [{ content: "verify", status: "completed" }],
        inline_diff: "--- a/file\n+++ b/file",
        risk: "high",
        findings: ["prompt injection"],
        redacted: true,
      }),
    ).toMatchObject({
      tool_id: "call-1",
      name: "terminal",
      context: "echo hello",
      args: { command: "echo hello" },
      result: { output: "hello", exit_code: 0 },
      duration_s: 0.2,
      risk: "high",
      findings: ["prompt injection"],
      redacted: true,
    });
  });

  it("rejects malformed response correlation envelopes", () => {
    expect(() =>
      decodeFrame({
        jsonrpc: "2.0",
        result: { success: true },
      }),
    ).toThrow();
  });

  it("decodes field-light indeterminate mutation replays", () => {
    expect(
      decodeMutationOutcome({
        mutation_id: "mutation-1",
        mutation_status: "indeterminate",
        run_id: "run-1",
        replayed: true,
      }),
    ).toEqual({
      mutation_id: "mutation-1",
      mutation_status: "indeterminate",
      run_id: "run-1",
      replayed: true,
    });
  });

  it.each(["admitted", "completed"] as const)(
    "decodes an authoritative %s mutation status",
    (mutation_status) => {
      expect(decodeMutationStatus({ mutation_status })).toEqual({ mutation_status });
    },
  );

  it.each(["complete", "interrupted", "error"] as const)(
    "decodes a terminal %s prompt replay without admitted-result fields",
    (status) => {
      expect(
        decodePromptSubmitResult({
          status,
          mutation_id: `mutation-${status}`,
          mutation_status: "completed",
          run_id: `run-${status}`,
          message_id: `message-${status}`,
        }),
      ).toMatchObject({
        status,
        mutation_status: "completed",
      });
    },
  );
});
