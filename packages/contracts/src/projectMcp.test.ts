import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ProjectMcpCreateInput, ProjectMcpFailure, ProjectMcpListInput } from "./projectMcp.ts";

const decodeCreateInput = Schema.decodeUnknownSync(ProjectMcpCreateInput);
const decodeListInput = Schema.decodeUnknownSync(ProjectMcpListInput);
const decodeFailure = Schema.decodeUnknownSync(ProjectMcpFailure);

describe("project MCP contracts", () => {
  it("bounds project list pages", () => {
    expect(decodeListInput({})).toEqual({});
    expect(decodeListInput({ cursor: 25, limit: 100 })).toEqual({ cursor: 25, limit: 100 });
    expect(() => decodeListInput({ cursor: -1 })).toThrow();
    expect(() => decodeListInput({ limit: 101 })).toThrow();
  });

  it("accepts exactly one typed clone source", () => {
    expect(
      decodeCreateInput({
        title: "URL clone",
        source: {
          type: "clone",
          destinationPath: "/work/url-clone",
          remoteUrl: "https://example.com/acme/repo.git",
        },
      }).source,
    ).toMatchObject({ remoteUrl: "https://example.com/acme/repo.git" });
    expect(
      decodeCreateInput({
        title: "Provider clone",
        source: {
          type: "clone",
          destinationPath: "/work/provider-clone",
          provider: "github",
          repository: "acme/repo",
        },
      }).source,
    ).toMatchObject({ provider: "github", repository: "acme/repo" });

    expect(() =>
      decodeCreateInput({
        title: "Ambiguous clone",
        source: {
          type: "clone",
          destinationPath: "/work/ambiguous",
          remoteUrl: "https://example.com/acme/repo.git",
          provider: "github",
          repository: "acme/repo",
        },
      }),
    ).toThrow();
    expect(() =>
      decodeCreateInput({
        title: "Incomplete clone",
        source: {
          type: "clone",
          destinationPath: "/work/incomplete",
          provider: "github",
        },
      }),
    ).toThrow();
  });

  it("identifies retries bound to deleted project ids", () => {
    expect(
      decodeFailure({
        _tag: "ProjectMcpFailure",
        code: "project_deleted",
        message: "Use a new clientRequestId.",
      }),
    ).toMatchObject({ code: "project_deleted" });
  });
});
