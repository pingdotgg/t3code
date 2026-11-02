import { assert, describe, it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/compat";

import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";

import { fxPermissionDisposition, fxToolCallWasCancelled } from "./acpSupport.ts";

const editRequest = {
  sessionId: "fx-session-01",
  toolCall: { toolCallId: "tool-1", kind: "edit", title: "Write notes.md" },
  options: [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ],
} satisfies EffectAcpSchema.RequestPermissionRequest;

describe("fx permission prompts", () => {
  // In Auto, fx's own review asks only about what it refused itself; T3
  // answering those by its Auto policy would approve exactly what fx escalated.
  it("sends every Auto prompt to the user", () => {
    assert.equal(
      fxPermissionDisposition(
        ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "auto",
          interactionMode: "default",
          cwd: "/work",
        }),
        editRequest,
      ),
      "ask",
    );
  });
});

describe("fx cancellation failures", () => {
  it.each([
    { content: "Cancelled", cancelled: true },
    { content: "Cancelled.", cancelled: true },
    { content: '{"error":{"details":{"error":"Cancelled"}}}', cancelled: true },
    { content: '{"error":{"details":{"error":"Permission denied"}}}', cancelled: false },
    { content: "Command failed", cancelled: false },
    { content: "", cancelled: false },
  ])("recognizes $content as cancellation: $cancelled", ({ content, cancelled }) => {
    assert.equal(
      fxToolCallWasCancelled({ update: { content: [{ content: { text: content } }] } }),
      cancelled,
    );
  });

  it.each([
    {
      exit_code: null,
      signal: null,
      timed_out: false,
      termination_indeterminate: true,
      content: "",
      cancelled: true,
    },
    {
      exit_code: null,
      signal: null,
      timed_out: false,
      termination_indeterminate: true,
      content:
        '{"error":{"type":"tool_execution_failed","message":"Command started, but its final process status could not be confirmed",',
      cancelled: false,
    },
    {
      exit_code: 1,
      signal: null,
      timed_out: false,
      termination_indeterminate: false,
      content: "",
      cancelled: false,
    },
    {
      exit_code: null,
      signal: null,
      timed_out: true,
      termination_indeterminate: true,
      content: "",
      cancelled: false,
    },
  ])(
    "recognizes a command result with exit $exit_code, timeout $timed_out",
    ({ cancelled, content, ...commandResult }) => {
      assert.equal(
        fxToolCallWasCancelled({
          update: { command_result: commandResult, content: [{ content: { text: content } }] },
        }),
        cancelled,
      );
    },
  );
});
