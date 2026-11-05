import {
  SecretRequestAnswerInput,
  SecretRequestError,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  secretRequestAnswerInput,
  secretRequestDisplay,
  secretRequestFailureMessage,
  secretRequestPrivacyNote,
} from "./secretRequest.ts";

const decodeAnswerInput = Schema.decodeUnknownSync(SecretRequestAnswerInput);

describe("secretRequestDisplay", () => {
  it("never offers the form for a request inherited from another thread", () => {
    expect(secretRequestDisplay({ secretStatus: "pending" }, "inherited")).toEqual({
      kind: "pending-elsewhere",
      label: "Waiting for an answer in the original thread",
    });
    expect(secretRequestDisplay({ secretStatus: "saved" }, "inherited")).toMatchObject({
      outcome: "saved",
    });
  });
});

describe("secretRequestPrivacyNote", () => {
  it("does not promise to hide a value that the agent's commands can read", () => {
    expect(secretRequestPrivacyNote({})).toBe("Stored securely, never shown to the agent");
    expect(secretRequestPrivacyNote({ delivery: "file" })).not.toContain("never shown");
  });
});

describe("secretRequestAnswerInput", () => {
  const item = { id: TurnItemId.make("item-1"), threadId: ThreadId.make("thread-1") };
  const savedSecret = (secret: string) => {
    const input = secretRequestAnswerInput(item, { type: "save", secret });
    if (input === null) return null;
    const delivered = decodeAnswerInput(input).answer;
    return delivered.type === "save" ? delivered.secret : null;
  };

  it("delivers the secret exactly as typed, whitespace included", () => {
    expect(savedSecret("  pass word  ")).toBe("  pass word  ");
    expect(savedSecret(" ")).toBe(" ");
    expect(savedSecret("")).toBeNull();
    expect(() =>
      decodeAnswerInput({
        threadId: item.threadId,
        turnItemId: item.id,
        answer: { type: "save", secret: "" },
      }),
    ).toThrow();
  });
});

describe("secretRequestFailureMessage", () => {
  it("passes through server errors but hides anything that could echo the payload", () => {
    expect(
      secretRequestFailureMessage(new SecretRequestError({ reason: "already_answered" })),
    ).toBe("This secret request was already answered.");
    expect(secretRequestFailureMessage(new Error('Expected string, got "whsec_1"'))).toBe(
      "Could not answer the request. Try again.",
    );
    expect(secretRequestFailureMessage(undefined)).toBe("Could not answer the request. Try again.");
  });
});
