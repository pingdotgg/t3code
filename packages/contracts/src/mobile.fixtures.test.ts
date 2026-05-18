import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { MobileClientMessage, MobileDescriptorResult, MobileServerMessage } from "./mobile.ts";

const fixturesRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../apps/mobile/Fixtures/mobile-v1",
);

const decodeDescriptor = Schema.decodeUnknownSync(MobileDescriptorResult);
const encodeDescriptor = Schema.encodeUnknownSync(MobileDescriptorResult);
const decodeServerMessage = Schema.decodeUnknownSync(MobileServerMessage);
const encodeServerMessage = Schema.encodeUnknownSync(MobileServerMessage);
const decodeClientMessage = Schema.decodeUnknownSync(MobileClientMessage);
const encodeClientMessage = Schema.encodeUnknownSync(MobileClientMessage);

function readFixture(relativePath: string): unknown {
  return JSON.parse(readFileSync(join(fixturesRoot, relativePath), "utf8"));
}

function fixtureNames(folder: "server" | "client"): ReadonlyArray<string> {
  return readdirSync(join(fixturesRoot, folder))
    .filter((entry) => entry.endsWith(".json"))
    .sort();
}

describe("mobile v1 cross-language fixtures", () => {
  it("keeps server-authored fixtures decodable by Swift and TypeScript schemas", () => {
    expect(fixtureNames("server")).toEqual([
      "command-accepted.json",
      "descriptor.json",
      "error-invalid-message.json",
      "hello.json",
      "replay-complete.json",
      "replay-gap.json",
      "shell-snapshot.json",
      "thread-snapshot.json",
      "turn-diff.json",
    ]);

    const descriptor = readFixture("server/descriptor.json");
    expect(encodeDescriptor(decodeDescriptor(descriptor))).toEqual(descriptor);

    for (const fixtureName of fixtureNames("server").filter((name) => name !== "descriptor.json")) {
      const fixture = readFixture(`server/${fixtureName}`);
      expect(encodeServerMessage(decodeServerMessage(fixture))).toEqual(fixture);
    }
  });

  it("accepts Swift-emitted MVP command request fixtures", () => {
    expect(fixtureNames("client")).toEqual([
      "approval-respond-request.json",
      "checkpoint-revert-request.json",
      "session-stop-request.json",
      "turn-interrupt-request.json",
      "turn-start-request.json",
      "user-input-respond-request.json",
    ]);

    for (const fixtureName of fixtureNames("client")) {
      const fixture = readFixture(`client/${fixtureName}`);
      expect(encodeClientMessage(decodeClientMessage(fixture))).toEqual(fixture);
    }
  });
});
