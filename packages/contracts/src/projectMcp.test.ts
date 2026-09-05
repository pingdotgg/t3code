import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ProjectMcpCreateInput,
  ProjectMcpFailure,
  ProjectMcpListInput,
  ProjectMcpUpdateInput,
} from "./projectMcp.ts";

const decodeCreateInput = Schema.decodeUnknownSync(ProjectMcpCreateInput);
const decodeListInput = Schema.decodeUnknownSync(ProjectMcpListInput);
const decodeUpdateInput = Schema.decodeUnknownSync(ProjectMcpUpdateInput);
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

  it("accepts only favicon paths served by the project asset route", () => {
    expect(
      decodeCreateInput({
        title: "Icon project",
        source: { type: "existing_directory", workspaceRoot: "/work/icon" },
        faviconPath: "/work/icon/favicon.svg",
      }).faviconPath,
    ).toBe("/work/icon/favicon.svg");
    expect(() =>
      decodeCreateInput({
        title: "Secret project",
        source: { type: "existing_directory", workspaceRoot: "/work/secret" },
        faviconPath: "/work/secret/.env",
      }),
    ).toThrow();
    expect(decodeUpdateInput({ projectId: "project-1", faviconPath: null }).faviconPath).toBeNull();
    expect(() =>
      decodeUpdateInput({ projectId: "project-1", faviconPath: "/work/secret/.env" }),
    ).toThrow();
  });
});
