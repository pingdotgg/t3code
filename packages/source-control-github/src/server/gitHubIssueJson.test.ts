import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import { decodeIssueDetailJson, decodeIssueViewerPermissionsJson } from "./gitHubIssueJson.ts";

const ISSUE = {
  number: 42,
  title: "Issue",
  url: "https://github.com/acme/web/issues/42",
  createdAt: "2026-10-15T00:00:00Z",
  updatedAt: "2026-10-15T00:00:00Z",
};

describe("GitHub issue viewer permissions", () => {
  it.each(["ADMIN", null, undefined])(
    "disables every write in an archived repository for %s",
    (role) => {
      const raw = JSON.stringify({
        data: {
          repository: {
            viewerPermission: role,
            isArchived: true,
            issue: { ...ISSUE, locked: false, viewerCanUpdate: true },
          },
        },
      });
      const expected = {
        setState: false,
        comment: false,
        edit: false,
        labels: false,
        assignees: false,
      };
      expect(Result.getOrThrow(decodeIssueViewerPermissionsJson(raw))).toEqual(expected);
      expect(Result.getOrThrow(decodeIssueDetailJson(raw))?.viewerPermissions).toEqual(expected);
    },
  );

  it.each([
    { role: "READ", comment: false, metadata: false },
    { role: "TRIAGE", comment: false, metadata: true },
    { role: "WRITE", comment: true, metadata: true },
    { role: "MAINTAIN", comment: true, metadata: true },
    { role: "ADMIN", comment: true, metadata: true },
    { role: null, comment: true, metadata: true },
    { role: undefined, comment: true, metadata: true },
  ])(
    "uses the native role for comments on a locked issue: $role",
    ({ role, comment, metadata }) => {
      const raw = JSON.stringify({
        data: {
          repository: {
            viewerPermission: role,
            isArchived: false,
            issue: { ...ISSUE, locked: true, viewerCanUpdate: false },
          },
        },
      });
      const expected = {
        setState: false,
        comment,
        edit: false,
        labels: metadata,
        assignees: metadata,
      };
      expect(Result.getOrThrow(decodeIssueViewerPermissionsJson(raw))).toEqual(expected);
      expect(Result.getOrThrow(decodeIssueDetailJson(raw))?.viewerPermissions).toEqual(expected);
    },
  );

  it.each([
    { role: null, metadata: true },
    { role: undefined, metadata: true },
    { role: "READ", metadata: false },
    { role: "TRIAGE", metadata: true },
    { role: "UNKNOWN", metadata: false },
  ])("keeps metadata permission for role $role separate from issue edits", ({ role, metadata }) => {
    const decoded = decodeIssueViewerPermissionsJson(
      JSON.stringify({
        data: { repository: { viewerPermission: role, issue: { viewerCanUpdate: false } } },
      }),
    );
    expect(Result.isSuccess(decoded)).toBe(true);
    if (!Result.isSuccess(decoded)) throw new Error("expected a successful decode");
    expect(decoded.success).toEqual({
      setState: false,
      comment: true,
      edit: false,
      labels: metadata,
      assignees: metadata,
    });
  });
});
