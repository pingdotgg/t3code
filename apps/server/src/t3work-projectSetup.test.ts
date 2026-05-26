import { describe, expect, it } from "vitest";

import {
  createT3WorkProjectSetupContentHash,
  DEFAULT_T3WORK_PROJECT_SETUP_PROFILE_ID,
  readPersistedT3WorkProjectSetupState,
  renderT3WorkProjectSetupFiles,
  resolveT3WorkProjectSetupProfileId,
  resolveT3WorkProjectSetupWriteDecision,
  T3WORK_PROJECT_AGENTS_PATH,
  T3WORK_PROJECT_CONTEXT_ENTRYPOINT_PATH,
  T3WORK_PROJECT_PROFILE_MANIFEST_PATH,
} from "./t3work-projectSetup.js";

describe("resolveT3WorkProjectSetupProfileId", () => {
  it("falls back to the default profile for unknown ids", () => {
    expect(resolveT3WorkProjectSetupProfileId("unknown-profile")).toBe(
      DEFAULT_T3WORK_PROJECT_SETUP_PROFILE_ID,
    );
  });
});

describe("renderT3WorkProjectSetupFiles", () => {
  it("renders the default setup scaffold", () => {
    const files = renderT3WorkProjectSetupFiles();
    const agents = files.find((file) => file.relativePath === T3WORK_PROJECT_AGENTS_PATH);
    const contextReadme = files.find((file) => file.relativePath === ".t3work/context/README.md");
    const manifest = files.find(
      (file) => file.relativePath === T3WORK_PROJECT_PROFILE_MANIFEST_PATH,
    );
    const entrypoint = files.find(
      (file) => file.relativePath === T3WORK_PROJECT_CONTEXT_ENTRYPOINT_PATH,
    );
    const statusSkill = files.find(
      (file) => file.relativePath === ".t3work/skills/status-and-context-summary/SKILL.md",
    );
    const skillTemplate = files.find(
      (file) => file.relativePath === ".t3work/templates/skills/repeatable-workflow/SKILL.md",
    );

    expect(agents?.contents).toContain("Use plain, non-technical language");
    expect(agents?.contents).toContain("Do not mention cache paths, JSON file names");
    expect(agents?.contents).toContain("Keep the thread title current as the topic changes.");
    expect(agents?.contents).toContain(T3WORK_PROJECT_CONTEXT_ENTRYPOINT_PATH);
    expect(agents?.contents).toContain("prefer a read-only subagent");
    expect(agents?.managedRefresh?.knownContentHashes?.length).toBeGreaterThan(0);
    expect(contextReadme?.contents).toContain(
      "Use this context bundle to answer project questions",
    );
    expect(contextReadme?.contents).toContain("Do not mention internal cache paths");
    expect(manifest?.writeMode).toBe("overwrite");
    expect(manifest?.contents).toContain(DEFAULT_T3WORK_PROJECT_SETUP_PROFILE_ID);
    expect(entrypoint?.contents).toContain("pending-sync");
    expect(statusSkill?.contents).toContain("name: t3work-status-and-context-summary");
    expect(statusSkill?.contents).toContain("Do not narrate file exploration");
    expect(skillTemplate?.contents).toContain("use a read-only subagent");
  });

  it("includes managed file hashes in the profile manifest when provided", () => {
    const files = renderT3WorkProjectSetupFiles({
      managedFileHashes: {
        [T3WORK_PROJECT_AGENTS_PATH]: "sha256:known",
      },
    });
    const manifest = files.find(
      (file) => file.relativePath === T3WORK_PROJECT_PROFILE_MANIFEST_PATH,
    );

    expect(manifest?.contents).toContain("managedFileHashes");
    expect(manifest?.contents).toContain("sha256:known");
  });
});

describe("resolveT3WorkProjectSetupWriteDecision", () => {
  it("refreshes a managed file when the current contents match a known legacy hash", () => {
    const file = {
      relativePath: T3WORK_PROJECT_AGENTS_PATH,
      contents: "new scaffold contents\n",
      writeMode: "if-missing",
      managedRefresh: {
        knownContentHashes: [createT3WorkProjectSetupContentHash("legacy scaffold contents\n")],
      },
    } as const;

    expect(
      resolveT3WorkProjectSetupWriteDecision({
        file,
        currentContents: "legacy scaffold contents\n",
      }),
    ).toEqual({
      shouldWrite: true,
      nextManagedHash: createT3WorkProjectSetupContentHash("new scaffold contents\n"),
    });
  });

  it("does not overwrite a managed file when it no longer matches the last known scaffold hash", () => {
    const file = {
      relativePath: T3WORK_PROJECT_AGENTS_PATH,
      contents: "new scaffold contents\n",
      writeMode: "if-missing",
      managedRefresh: {
        knownContentHashes: [createT3WorkProjectSetupContentHash("legacy scaffold contents\n")],
      },
    } as const;

    expect(
      resolveT3WorkProjectSetupWriteDecision({
        file,
        currentContents: "manual user edits\n",
        persistedManagedHash: createT3WorkProjectSetupContentHash("legacy scaffold contents\n"),
      }),
    ).toEqual({
      shouldWrite: false,
    });
  });

  it("adopts the current managed hash without rewriting when the file already matches the scaffold", () => {
    const file = {
      relativePath: T3WORK_PROJECT_AGENTS_PATH,
      contents: "current scaffold contents\n",
      writeMode: "if-missing",
      managedRefresh: {
        knownContentHashes: [createT3WorkProjectSetupContentHash("legacy scaffold contents\n")],
      },
    } as const;

    expect(
      resolveT3WorkProjectSetupWriteDecision({
        file,
        currentContents: "current scaffold contents\n",
      }),
    ).toEqual({
      shouldWrite: false,
      nextManagedHash: createT3WorkProjectSetupContentHash("current scaffold contents\n"),
    });
  });
});

describe("readPersistedT3WorkProjectSetupState", () => {
  it("reads the stored profile id and managed file hashes", () => {
    expect(
      readPersistedT3WorkProjectSetupState(
        '{"profileId":"developer","managedFileHashes":{"AGENTS.md":"sha256:known"}}',
      ),
    ).toEqual({
      profileId: "developer",
      managedFileHashes: {
        "AGENTS.md": "sha256:known",
      },
    });
  });
});
