import {
  SecretProviderId,
  SecretProviderKind,
  SecretRequestError,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vite-plus/test";

import {
  secretRequestAnswerInput,
  secretRequestDisplay,
  secretRequestFailureMessage,
  secretRequestLink,
  secretRequestPrivacyNote,
  secretRequestSources,
} from "./secretRequest.ts";

describe("secretRequestDisplay", () => {
  it("distinguishes approving a Gmail read from saving a secret or displaying its result", () => {
    expect(
      secretRequestDisplay(
        {
          secretStatus: "saved",
          taggedVault: { name: "mail", gmail: { folder: "spam", limit: 5 } },
        },
        "local",
      ),
    ).toMatchObject({ label: "Gmail read approved" });
  });
  it("does not reopen a retired mailbox request as a credential form", () => {
    expect(
      secretRequestDisplay(
        { id: TurnItemId.make("turn-item:vault-access:retired"), secretStatus: "pending" },
        "local",
      ),
    ).toMatchObject({ kind: "answered", outcome: "ended" });
  });
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

  it("approves a tagged Gmail read with only the vault PIN and no field mapping", () => {
    const gmail = {
      id: TurnItemId.make("item"),
      threadId: ThreadId.make("thread"),
      label: "Read Gmail",
      taggedVault: { name: "mail", gmail: { folder: "spam", limit: 3 } },
    } as const;
    const pin = Redacted.make("123456");
    expect(secretRequestAnswerInput(gmail, { type: "vault", pin })).toBeNull();
    const privateAnswer = {
      type: "vault_display",
      pin,
      account: "work@example.test",
    } as const;
    expect(secretRequestAnswerInput(gmail, privateAnswer)).toEqual({
      ...ids,
      answer: { type: "vault_gmail_display", name: "mail", account: privateAnswer.account, pin },
    });
    expect(
      secretRequestAnswerInput(
        { ...gmail, taggedVault: { name: "mail", field: "token" } },
        privateAnswer,
      ),
    ).toBeNull();
    expect(
      secretRequestAnswerInput({ ...gmail, delivery: "file" }, { type: "vault", pin }),
    ).toBeNull();
    expect(secretRequestAnswerInput(gmail, { type: "save", values: { "": "typed" } })).toBeNull();
    const [source] = secretRequestSources(
      { secretRequestReferences: true },
      {
        [SecretProviderId.make("1password")]: {
          kind: SecretProviderKind.make("one_password"),
          label: "1Password",
          config: { account: "my" },
        },
      },
    );
    if (!source) throw new Error("Missing test provider");
    expect(
      secretRequestAnswerInput(gmail, { type: "reference", source, reference: "op://v/i/f" }),
    ).toBeNull();
    expect(secretRequestAnswerInput(gmail, { type: "decline" })).toEqual({
      ...ids,
      answer: { type: "decline" },
    });
    expect(
      secretRequestAnswerInput(
        { ...gmail, taggedVault: { name: "mail", field: "token" } },
        { type: "vault", pin },
      ),
    ).toEqual({ ...ids, answer: { type: "vault", name: "mail", fields: { value: "token" }, pin } });
  });

  it("binds a service read to a private display approval and never exports a field", () => {
    const serviceRead = { service: "gitlab", limit: 4 } as const;
    const taggedVault = { name: "work", serviceRead };
    const request = {
      ...single,
      id: TurnItemId.make("item"),
      threadId: ThreadId.make("thread"),
      taggedVault,
    };
    const pin = Redacted.make("123456");
    const approval = { type: "vault_display", pin, account: "work-account" } as const;
    expect(secretRequestAnswerInput(request, approval)).toEqual({
      ...ids,
      answer: { type: "vault_service_display", name: "work", account: approval.account, pin },
    });
    expect(secretRequestAnswerInput(request, { type: "vault", pin })).toBeNull();
    expect(secretRequestAnswerInput(request, { type: "save", values: { "": "token" } })).toBeNull();
    expect(secretRequestAnswerInput({ ...request, delivery: "file" }, approval)).toBeNull();
    expect(secretRequestAnswerInput(request, { ...approval, account: "" })).toBeNull();
    expect(secretRequestAnswerInput(request, { type: "decline" })).toEqual({
      ...ids,
      answer: { type: "decline" },
    });
    expect(secretRequestDisplay({ taggedVault, secretStatus: "saved" }, "local")).toMatchObject({
      label: "Private read approved",
    });
    expect(secretRequestPrivacyNote({ taggedVault })).toContain("item count, not the contents");
  });
});

describe("secretRequestPrivacyNote", () => {
  it("does not promise to hide a value that the agent's commands can read", () => {
    expect(secretRequestPrivacyNote({})).toBe("Stored securely, never shown to the agent");
    expect(secretRequestPrivacyNote({ delivery: "file" })).not.toContain("never shown");
  });
});

describe("secretRequestLink", () => {
  it.each([
    [
      "Open this link and sign in: https://a.dev/x?s=1. Then paste the code.",
      "https://a.dev/x?s=1",
    ],
    ["Open [https://a.dev/x?s=1](https://a.dev/x?s=1) and sign in.", "https://a.dev/x?s=1"],
    ["Sign in [here](https://a.dev/login?state=abc(def)).", "https://a.dev/login?state=abc(def)"],
    ["Sign in at https://a.dev/login?state=abc(def).", "https://a.dev/login?state=abc(def)"],
    ["(Sign in at https://a.dev/login.)", "https://a.dev/login"],
    ["Open **https://a.dev/x?s=1** and sign in.", "https://a.dev/x?s=1"],
    ["Open https://a.dev/x?state=u7o_ and sign in.", "https://a.dev/x?state=u7o_"],
    ["**Sign in at https://a.dev/device**", "https://a.dev/device"],
    ["_Open https://a.dev/device_.", "https://a.dev/device"],
    ["_https://a.dev/x?state=u7o_&client_id=cli_", "https://a.dev/x?state=u7o_&client_id=cli"],
    ["Use client_id acme at https://a.dev/x?state=u7o_", "https://a.dev/x?state=u7o_"],
    ["_Sign in_ at https://a.dev/x?state=u7o_", "https://a.dev/x?state=u7o_"],
    ["_Required_: Open https://a.dev/x?state=u7o_", "https://a.dev/x?state=u7o_"],
    ["(**https://a.dev/login**)", "https://a.dev/login"],
    ["Open ***https://a.dev/device***", "https://a.dev/device"],
    ["Open **_https://a.dev/device_**", "https://a.dev/device"],
    [
      "Open [https://a.dev/x?s=u7o_](https://a.dev/x?s=u7o_) and sign in.",
      "https://a.dev/x?s=u7o_",
    ],
    ["Open `https://a.dev/x?s=1.` and sign in.", "https://a.dev/x?s=1."],
    ["Open https://a.dev/x?s=1, then if needed https://a.dev/x?s=1 again.", "https://a.dev/x?s=1"],
    ["Open https://a.dev or https://b.dev.", undefined],
    ["Open https://a.dev (also written https://a.dev/).", "https://a.dev/"],
    ["Paste the code the CLI printed.", undefined],
  ])("finds the one link in a reason: %s", (reason, href) => {
    expect(secretRequestLink({ reason })?.href).toBe(href);
  });

  it("prefers the agent's url over a link in the reason", () => {
    expect(
      secretRequestLink({ url: "https://auth.acme.dev/a", reason: "See https://docs.acme.dev" })
        ?.host,
    ).toBe("auth.acme.dev");
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
