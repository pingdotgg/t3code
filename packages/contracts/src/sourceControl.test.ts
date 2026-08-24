import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ChangeRequest,
  SourceControlProviderDiscoveryItem,
  SourceControlProviderInfo,
  SourceControlProviderKind,
} from "./sourceControl.ts";

const decodeKind = Schema.decodeUnknownSync(SourceControlProviderKind);
const encodeKind = Schema.encodeSync(SourceControlProviderKind);
const decodeProviderInfo = Schema.decodeUnknownSync(SourceControlProviderInfo);
const decodeChangeRequest = Schema.decodeUnknownSync(ChangeRequest);
const decodeDiscoveryItem = Schema.decodeUnknownSync(SourceControlProviderDiscoveryItem);

describe("SourceControlProviderKind", () => {
  it("round-trips every supported provider kind, including gitea", () => {
    for (const kind of ["github", "gitlab", "azure-devops", "bitbucket", "gitea", "unknown"]) {
      expect(encodeKind(decodeKind(kind))).toBe(kind);
    }
  });

  it("still rejects hosts this build does not support", () => {
    expect(() => decodeKind("forgejo")).toThrow();
    expect(() => decodeKind("sourcehut")).toThrow();
  });
});

describe("gitea across source-control contracts", () => {
  it("decodes a Gitea provider info", () => {
    expect(
      decodeProviderInfo({
        kind: "gitea",
        name: "Gitea Self-Hosted",
        baseUrl: "https://git.example.com",
      }),
    ).toEqual({
      kind: "gitea",
      name: "Gitea Self-Hosted",
      baseUrl: "https://git.example.com",
    });
  });

  it("decodes a Gitea change request", () => {
    const decoded = decodeChangeRequest({
      provider: "gitea",
      number: 42,
      title: "Add widget",
      url: "https://git.example.com/owner/repo/pulls/42",
      baseRefName: "main",
      headRefName: "t3code/abcd1234",
      state: "open",
      updatedAt: Option.some(DateTime.makeUnsafe("2026-01-02T03:04:05.000Z")),
    });
    expect(decoded.provider).toBe("gitea");
    expect(decoded.number).toBe(42);
  });

  it("decodes a Gitea discovery item", () => {
    const decoded = decodeDiscoveryItem({
      kind: "gitea",
      label: "Gitea",
      executable: "tea",
      status: "available",
      version: Option.some("0.15.1"),
      installHint: "Install tea.",
      detail: Option.none(),
      auth: {
        status: "authenticated",
        account: Option.some("mario"),
        host: Option.some("git.example.com"),
        detail: Option.none(),
      },
    });
    expect(decoded.kind).toBe("gitea");
    expect(decoded.auth.status).toBe("authenticated");
  });
});
