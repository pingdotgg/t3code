import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { MobileClientMessage, MobileDescriptorResult, MobileServerMessage } from "./mobile.ts";

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/mobile-v1");

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

describe("mobile v1 wire fixtures", () => {
  it("keeps server-authored fixtures decodable by the mobile protocol schemas", () => {
    const descriptor = readFixture("server/descriptor.json");
    expect(encodeDescriptor(decodeDescriptor(descriptor))).toEqual(descriptor);

    for (const fixtureName of fixtureNames("server").filter((name) => name !== "descriptor.json")) {
      const fixture = readFixture(`server/${fixtureName}`);
      expect(encodeServerMessage(decodeServerMessage(fixture))).toEqual(fixture);
    }
  });

  it("accepts client-authored MVP command request fixtures", () => {
    for (const fixtureName of fixtureNames("client")) {
      const fixture = readFixture(`client/${fixtureName}`);
      expect(encodeClientMessage(decodeClientMessage(fixture))).toEqual(fixture);
    }
  });

  it("rejects title regeneration requests with unrelated metadata mutations", () => {
    const unrelatedMetadata = [
      { title: "Manual rename" },
      { modelSelection: { instanceId: "codex", model: "gpt-5" } },
      { branch: null },
      { worktreePath: null },
      { pullRequest: null },
      { pullRequestOwnership: "transfer" },
    ];

    for (const metadata of unrelatedMetadata) {
      expect(() =>
        decodeClientMessage({
          id: "dispatch-title-regenerate-invalid",
          type: "request",
          protocolVersion: "mobile.v1",
          method: "orchestration.dispatchCommand",
          payload: {
            type: "thread.meta.update",
            commandId: "mobile-title-regenerate-invalid",
            threadId: "thread-fixture",
            regenerateTitle: true,
            ...metadata,
          },
        }),
      ).toThrow();
    }
  });
});
