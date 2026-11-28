import { describe, expect, it } from "@effect/vitest";

import {
  decodeIssueTrackerCredential,
  encodeIssueTrackerCredential,
} from "./IssueTrackerHostLive.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("issue tracker credential storage", () => {
  it("keeps a key alone as the bare key, the way one was saved before trackers had fields", () => {
    const credential = { token: "lin_api_123", fields: {} };
    expect(encodeIssueTrackerCredential(credential)).toEqual(bytes("lin_api_123"));
    expect(decodeIssueTrackerCredential(bytes("lin_api_123"))).toEqual(credential);
  });

  it("stores a key with its fields and reads both back", () => {
    const credential = {
      token: "tok",
      fields: { site: "acme.atlassian.net", email: "julius@acme.test" },
    };
    expect(decodeIssueTrackerCredential(encodeIssueTrackerCredential(credential))).toEqual(
      credential,
    );
  });
});
