import { describe, expect, it } from "vitest";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";

import { readCodexAccountSnapshotResponse } from "./codexAccount.ts";
import { buildCodexInitializeParams, parseCodexSkillsListResponse } from "./codexAppServer.ts";

describe("buildCodexInitializeParams", () => {
  it("returns the typed Codex initialize payload", () => {
    expect(buildCodexInitializeParams()).toEqual({
      clientInfo: {
        name: "t3code_desktop",
        title: "T3 Code Desktop",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
  });
});

describe("readCodexAccountSnapshotResponse", () => {
  it("maps chatgpt responses without lossy unknown parsing", () => {
    const response = {
      account: {
        type: "chatgpt",
        email: "julius@example.com",
        planType: "pro",
      },
      requiresOpenaiAuth: false,
    } satisfies EffectCodexSchema.V2GetAccountResponse;

    expect(readCodexAccountSnapshotResponse(response)).toEqual({
      type: "chatgpt",
      planType: "pro",
      sparkEnabled: true,
    });
  });
});

describe("parseCodexSkillsListResponse", () => {
  it("prefers the matching cwd bucket and keeps typed skill metadata", () => {
    const response = {
      data: [
        {
          cwd: "/tmp/other",
          errors: [],
          skills: [
            {
              name: "other",
              path: "/tmp/other/SKILL.md",
              description: "Other skill",
              enabled: true,
              scope: "repo",
            },
          ],
        },
        {
          cwd: "/work/project",
          errors: [],
          skills: [
            {
              name: "planner",
              path: "/work/project/.skills/planner/SKILL.md",
              description: "Plans work",
              enabled: true,
              scope: "repo",
              shortDescription: "Plan steps",
              interface: {
                displayName: "Planner",
                shortDescription: "Plan work",
              },
            },
          ],
        },
      ],
    } satisfies EffectCodexSchema.V2SkillsListResponse;

    expect(parseCodexSkillsListResponse(response, "/work/project")).toEqual([
      {
        name: "planner",
        path: "/work/project/.skills/planner/SKILL.md",
        enabled: true,
        description: "Plans work",
        scope: "repo",
        displayName: "Planner",
        shortDescription: "Plan steps",
      },
    ]);
  });
});
