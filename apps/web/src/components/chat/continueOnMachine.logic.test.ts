import { describe, expect, it } from "vite-plus/test";

import { continuedThreadFollowThrough } from "./continueOnMachine.logic";

describe("continuedThreadFollowThrough", () => {
  it.each([
    ["a machine this window has on", { enabled: true }, { kind: "open" }],
    ["a machine this window has switched off", { enabled: false }, { kind: "turn-on" }],
    [
      "a machine this window does not know",
      null,
      { kind: "connect", host: "https://box.example.test" },
    ],
  ] as const)("follows through to %s", (_name, saved, expected) => {
    expect(
      continuedThreadFollowThrough({
        saved,
        linkUrls: ["https://box.example.test", "https://box-alt.example.test"],
      }),
    ).toEqual(expected);
  });

  it("asks for an address when the link has none to offer", () => {
    expect(continuedThreadFollowThrough({ saved: null, linkUrls: [] })).toEqual({
      kind: "connect",
      host: null,
    });
  });
});
