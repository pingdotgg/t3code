import {
  SecretProviderId,
  SecretProviderKind,
  SecretRequestError,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  secretRequestAnswerInput,
  secretRequestDisplay,
  secretRequestFailureMessage,
  secretRequestPrivacyNote,
  secretRequestSources,
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
    // An unset field named like an Object.prototype member is empty, not that member.
    const named = { ...single, fields: [{ name: "constructor", label: "Key" }] } as const;
    expect(secretRequestAnswerInput(named as never, { type: "save", values: {} })).toBe(null);
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

describe("secretRequestSources", () => {
  const onePassword = SecretProviderId.make("1password");
  const providers = {
    [onePassword]: {
      kind: SecretProviderKind.make("one_password"),
      label: "1Password",
      config: { account: "my" },
    },
    [SecretProviderId.make("later")]: {
      kind: SecretProviderKind.make("from_a_newer_build"),
      label: "Later",
      config: {},
    },
  };

  it("offers configured providers only when the server accepts reference answers", () => {
    expect(secretRequestSources({ secretRequestReferences: true }, providers)).toMatchObject([
      { id: onePassword, label: "1Password" },
    ]);
    expect(secretRequestSources({}, providers)).toEqual([]);
    expect(secretRequestSources({ secretRequestReferences: true }, {})).toEqual([]);
  });

  it("answers with a reference only in the provider's syntax", () => {
    const [source] = secretRequestSources({ secretRequestReferences: true }, providers);
    if (source === undefined) throw new Error("expected a source");
    const item = {
      id: TurnItemId.make("item-1"),
      threadId: ThreadId.make("thread-1"),
      label: "Deploy token",
    };
    expect(
      secretRequestAnswerInput(item, {
        type: "reference",
        source,
        reference: " op://vault/item/field ",
      })?.answer,
    ).toEqual({
      type: "reference",
      reference: { provider: onePassword, reference: "op://vault/item/field" },
    });
    expect(
      secretRequestAnswerInput(item, { type: "reference", source, reference: "vault/item" }),
    ).toBeNull();
    // A reference answers one value, never a card with fields.
    const fields = [{ name: "password", label: "Password" }];
    expect(
      secretRequestAnswerInput(
        { ...item, fields },
        { type: "reference", source, reference: "op://vault/item/field" },
      ),
    ).toBeNull();
  });
});
