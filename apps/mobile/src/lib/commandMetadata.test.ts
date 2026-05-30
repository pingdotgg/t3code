import { describe, expect, it, vi } from "vitest";

import { makeQueuedMessageMetadata, makeTurnCommandMetadata } from "./commandMetadata";

vi.mock("expo-crypto", () => ({
  randomUUID: () => crypto.randomUUID(),
}));

describe("mobile command metadata", () => {
  it("creates ids and timestamps for thread starts", () => {
    const metadata = makeTurnCommandMetadata();

    expect(metadata.commandId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(metadata.messageId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(metadata.threadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(metadata.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("creates ids and timestamps for queued messages", () => {
    const metadata = makeQueuedMessageMetadata();

    expect(metadata.commandId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(metadata.messageId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(metadata.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
