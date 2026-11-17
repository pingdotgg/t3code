import { describe, expect, it } from "vite-plus/test";

import { detectLoginFields, type LoginFieldCandidate } from "./loginFields.ts";

const input = (overrides: Partial<LoginFieldCandidate> = {}): LoginFieldCandidate => ({
  type: "text",
  autocomplete: "",
  inputMode: "",
  maxLength: -1,
  usable: true,
  ...overrides,
});

describe("detectLoginFields", () => {
  it.each<[string, ReadonlyArray<LoginFieldCandidate>, ReturnType<typeof detectLoginFields>]>([
    [
      "username by autocomplete, current password over new password",
      [
        input({ type: "search" }),
        input({ type: "password", autocomplete: "new-password" }),
        input({ autocomplete: "username" }),
        input({ type: "password", autocomplete: "current-password" }),
      ],
      { username: 2, password: 3 },
    ],
    [
      "email autocomplete counts as the username",
      [input({ type: "email", autocomplete: "section-login email" }), input({ type: "password" })],
      { username: 0, password: 1 },
    ],
    [
      "without autocomplete, the text field just before the password",
      [input(), input({ type: "email" }), input({ type: "checkbox" }), input({ type: "password" })],
      { username: 1, password: 3 },
    ],
    [
      "a hidden or disabled field is never chosen",
      [
        input({ autocomplete: "username", usable: false }),
        input(),
        input({ type: "password", usable: false }),
      ],
      {},
    ],
    [
      "a sign-up form's new password is not a login password",
      [input(), input({ type: "password", autocomplete: "new-password" })],
      {},
    ],
    [
      "otp by autocomplete",
      [input({ inputMode: "numeric", maxLength: 6 }), input({ autocomplete: "one-time-code" })],
      { otp: 1 },
    ],
    [
      "otp as the one short numeric field",
      [input({ inputMode: "numeric", maxLength: 6 })],
      { otp: 0 },
    ],
    [
      "no otp when two short numeric fields could be it",
      [input({ inputMode: "numeric", maxLength: 6 }), input({ type: "tel", maxLength: 6 })],
      {},
    ],
  ])("%s", (_name, candidates, expected) => {
    expect(detectLoginFields(candidates)).toEqual(expected);
  });
});
