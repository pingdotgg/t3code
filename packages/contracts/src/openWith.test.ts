import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  MAX_OPEN_WITH_ARGUMENTS,
  OpenWithEntry,
  OpenWithEntries,
  OpenWithEntryRef,
} from "./openWith.ts";

const decodeEntry = Schema.decodeUnknownSync(OpenWithEntry);
const encodeEntry = Schema.encodeSync(OpenWithEntry);
const decodeEntries = Schema.decodeUnknownSync(OpenWithEntries);
const decodeEntryRef = Schema.decodeUnknownSync(OpenWithEntryRef);

describe("Open With contracts", () => {
  it("round-trips macOS application and command entries", () => {
    const entries = [
      {
        id: "terminal",
        name: "Terminal",
        kind: "terminal",
        invocation: { type: "mac-application", applicationPath: "/Applications/Terminal.app" },
        directoryMode: "open-target",
        arguments: [],
      },
      {
        id: "zed-cli",
        name: "Zed CLI",
        kind: "editor",
        invocation: { type: "command", executable: "zed" },
        directoryMode: "custom-arguments",
        arguments: ["--new", "{directory}"],
      },
    ] as const;

    expect(entries.map((entry) => encodeEntry(decodeEntry(entry)))).toEqual(entries);
  });

  it("rejects malformed ids, empty names, excessive arguments, and invocation variants", () => {
    const valid = {
      id: "terminal",
      name: "Terminal",
      kind: "terminal",
      invocation: { type: "command", executable: "open" },
      directoryMode: "open-target",
      arguments: [],
    };
    expect(() => decodeEntry({ ...valid, id: "Terminal App" })).toThrow();
    expect(() => decodeEntry({ ...valid, name: " " })).toThrow();
    expect(() =>
      decodeEntry({
        ...valid,
        arguments: Array.from({ length: MAX_OPEN_WITH_ARGUMENTS + 1 }, () => "x"),
      }),
    ).toThrow();
    expect(() =>
      decodeEntry({ ...valid, invocation: { type: "shell", command: "open" } }),
    ).toThrow();
  });

  it("bounds the entry list and validates preference references", () => {
    const entry = decodeEntry({
      id: "terminal",
      name: "Terminal",
      kind: "terminal",
      invocation: { type: "command", executable: "open" },
      directoryMode: "open-target",
      arguments: [],
    });
    expect(() => decodeEntries(Array.from({ length: 65 }, () => entry))).toThrow();
    expect(decodeEntryRef({ type: "builtin", id: "vscode" })).toEqual({
      type: "builtin",
      id: "vscode",
    });
  });
});
