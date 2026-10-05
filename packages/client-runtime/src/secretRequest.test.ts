import { ScheduledTaskError, ThreadId, TurnItemId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  secretRequestAnswerInput,
  secretRequestDisplay,
  secretRequestFailureMessage,
  type SecretRequestItem,
} from "./secretRequest.ts";

const item = {
  id: TurnItemId.make("turn-item:secret-request:1"),
  threadId: ThreadId.make("thread-1"),
};

describe("secretRequestDisplay", () => {
  it("shows the form only while pending and maps every answer to its outcome copy", () => {
    const display = (secretStatus: SecretRequestItem["secretStatus"]) =>
      secretRequestDisplay({ secretStatus } as SecretRequestItem);
    expect(display("pending")).toEqual({ kind: "pending" });
    expect(display("saved")).toEqual({
      kind: "answered",
      outcome: "saved",
      label: "Saved securely and kept private",
    });
    expect(display("declined")).toEqual({
      kind: "answered",
      outcome: "declined",
      label: "Declined",
    });
    expect(display("cancelled")).toEqual({
      kind: "answered",
      outcome: "ended",
      label: "Request ended",
    });
  });
});

describe("secretRequestAnswerInput", () => {
  it("refuses a blank save and trims the value the server will store", () => {
    expect(secretRequestAnswerInput(item, { type: "save", secret: "   " })).toBeNull();
    expect(secretRequestAnswerInput(item, { type: "save", secret: " whsec_1 " })).toEqual({
      threadId: item.threadId,
      turnItemId: item.id,
      answer: { type: "save", secret: "whsec_1" },
    });
    expect(secretRequestAnswerInput(item, { type: "decline" })).toEqual({
      threadId: item.threadId,
      turnItemId: item.id,
      answer: { type: "decline" },
    });
  });
});

describe("secretRequestFailureMessage", () => {
  it("passes through server errors but hides anything that could echo the payload", () => {
    expect(
      secretRequestFailureMessage(
        new ScheduledTaskError({ message: "This secret request was already answered." }),
      ),
    ).toBe("This secret request was already answered.");
    expect(secretRequestFailureMessage(new Error('Expected string, got "whsec_1"'))).toBe(
      "Could not answer the request. Try again.",
    );
    expect(secretRequestFailureMessage(undefined)).toBe("Could not answer the request. Try again.");
  });
});
