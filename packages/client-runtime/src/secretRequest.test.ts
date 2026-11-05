import { SecretRequestError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  secretRequestAnswerInput,
  secretRequestDisplay,
  secretRequestFailureMessage,
  secretRequestPrivacyNote,
} from "./secretRequest.ts";

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

describe("secretRequestAnswerInput", () => {
  const single = { id: "item", threadId: "thread", label: "Token" } as const;
  const login = {
    ...single,
    delivery: "file",
    fields: [
      { name: "email", label: "Email", secret: false },
      { name: "password", label: "Password" },
    ],
  } as const;
  const ids = { threadId: "thread", turnItemId: "item" };

  it("answers a single request with its trimmed secret", () => {
    expect(
      secretRequestAnswerInput(single as never, { type: "save", values: { "": " t " } }),
    ).toEqual({ ...ids, answer: { type: "save", secret: "t" } });
    expect(secretRequestAnswerInput(single as never, { type: "save", values: { "": " " } })).toBe(
      null,
    );
  });

  it("answers a fields request only once every field has a value, keyed by name", () => {
    expect(
      secretRequestAnswerInput(login as never, {
        type: "save",
        values: { email: "a@acme.dev ", password: "pw" },
      }),
    ).toEqual({
      ...ids,
      answer: { type: "save", values: { email: "a@acme.dev", password: "pw" } },
    });
    expect(
      secretRequestAnswerInput(login as never, { type: "save", values: { email: "a@acme.dev" } }),
    ).toBe(null);
  });
});

describe("secretRequestPrivacyNote", () => {
  it("does not promise to hide a value that the agent's commands can read", () => {
    expect(secretRequestPrivacyNote({})).toBe("Stored securely, never shown to the agent");
    expect(secretRequestPrivacyNote({ delivery: "file" })).not.toContain("never shown");
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
