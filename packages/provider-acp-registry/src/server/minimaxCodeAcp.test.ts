import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  isMinimaxCodeBusyFailure,
  minimaxCodeFlavorExtras,
  minimaxCodePromptBusyRetry,
} from "./minimaxCodeAcp.ts";

const busyError = new EffectAcpErrors.AcpRequestError({
  code: -32603,
  errorMessage:
    "MiniMax Code Runtime failed: Session already has an active Turn. Use queue send to deliver the message after it.",
});

describe("isMinimaxCodeBusyFailure", () => {
  it("recognizes the turn lease rejection", () => {
    assert.isTrue(isMinimaxCodeBusyFailure(Cause.fail(busyError)));
  });

  it.each([
    { code: -32603, errorMessage: "MiniMax Code Runtime failed: the model exploded." },
    { code: -32602, errorMessage: busyError.errorMessage },
    { code: -32603, errorMessage: "Tool failed: session already has an active turn." },
  ])("ignores other request errors ($code, $errorMessage)", (error) => {
    assert.isFalse(
      isMinimaxCodeBusyFailure(Cause.fail(new EffectAcpErrors.AcpRequestError(error))),
    );
  });

  it("ignores transport errors", () => {
    assert.isFalse(
      isMinimaxCodeBusyFailure(
        Cause.fail(
          new EffectAcpErrors.AcpTransportError({
            method: "session/prompt",
            detail: "gone",
            cause: undefined,
          }),
        ),
      ),
    );
  });

  it("ignores interrupts", () => {
    assert.isFalse(isMinimaxCodeBusyFailure(Cause.interrupt()));
  });
});

describe("minimaxCodePromptBusyRetry", () => {
  it("re-sends for 45 seconds in total", () => {
    const delays: Array<number> = [];
    for (let attempt = 1; attempt < minimaxCodePromptBusyRetry.maxAttempts; attempt += 1) {
      delays.push(minimaxCodePromptBusyRetry.delayMs(attempt));
    }

    // The last attempt is never followed by a delay, so the budget is the sum
    // of the delays the policy actually sleeps.
    assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 10_000]);
    assert.equal(
      delays.reduce((total, delay) => total + delay, 0),
      45_000,
    );
  });
});

describe("minimaxCodeFlavorExtras", () => {
  it("re-sends busy prompts for the registry agent", () => {
    assert.isDefined(
      minimaxCodeFlavorExtras({
        registryAgentId: "minimax-code",
        isLocal: false,
        commandPath: "",
      }).promptBusyRetry,
    );
  });

  it("re-sends busy prompts for a local install", () => {
    assert.isDefined(
      minimaxCodeFlavorExtras({
        registryAgentId: "",
        isLocal: true,
        commandPath: "/Users/someone/.minimax-code/bin/mcode",
      }).promptBusyRetry,
    );
    assert.isDefined(
      minimaxCodeFlavorExtras({
        registryAgentId: "",
        isLocal: true,
        commandPath: "C:\\tools\\mcode.exe",
      }).promptBusyRetry,
    );
  });

  it("leaves other agents alone", () => {
    assert.isUndefined(
      minimaxCodeFlavorExtras({
        registryAgentId: "claude-acp",
        isLocal: false,
        commandPath: "",
      }).promptBusyRetry,
    );
    assert.isUndefined(
      minimaxCodeFlavorExtras({
        registryAgentId: "codex",
        isLocal: false,
        commandPath: "",
      }).promptBusyRetry,
    );
    assert.isUndefined(
      minimaxCodeFlavorExtras({
        registryAgentId: "",
        isLocal: true,
        commandPath: "/usr/local/bin/mcode-tools",
      }).promptBusyRetry,
    );
    assert.isUndefined(
      minimaxCodeFlavorExtras({
        registryAgentId: "",
        isLocal: true,
        commandPath: "/usr/local/bin/other-agent",
      }).promptBusyRetry,
    );
  });

  it("does not match the local command of a registry install", () => {
    assert.isUndefined(
      minimaxCodeFlavorExtras({
        registryAgentId: "codex",
        isLocal: false,
        commandPath: "/usr/local/bin/mcode",
      }).promptBusyRetry,
    );
  });
});
