import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_BROWSER_PROFILE_ID,
  INCOGNITO_BROWSER_PROFILE_ID,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { ensureClientSettingsHydrated } from "~/hooks/useSettings";

const settings = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("~/hooks/useSettings", () => ({
  getClientSettings: () => settings.current,
  useClientSettings: () => undefined,
  ensureClientSettingsHydrated: vi.fn(async () => undefined),
}));

const entities = vi.hoisted(() => ({
  threadProjectId: null as string | null,
  draftProjectId: null as string | null,
}));

vi.mock("~/state/entities", () => ({
  readThreadShell: () =>
    entities.threadProjectId === null ? null : { projectId: entities.threadProjectId },
  readProject: ({ projectId }: { projectId: string }) => ({
    environmentId: "local",
    workspaceRoot: `/work/${projectId}`,
  }),
}));

vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: {
    getState: () => ({
      getDraftThreadByRef: () =>
        entities.draftProjectId === null ? null : { projectId: entities.draftProjectId },
    }),
  },
}));

const { browserDefaultOpenProfileId, getBrowserDefaults, resolveBrowserDefaults } =
  await import("./browserDefaults");

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};

const withDefaultProfile = (
  browserDefaultProfileId: string,
  browserProjectProfileIds: Record<string, string> = {},
) => {
  settings.current = {
    browserDefaultViewport: { _tag: "fill" },
    browserDefaultZoomFactor: 1,
    browserDefaultAppearance: "system",
    browserAutoShowFloatingPreview: true,
    browserProfiles: [
      { id: "work", name: "Work", kind: "persistent" },
      { id: "personal", name: "Personal", kind: "persistent" },
    ],
    browserDefaultProfileId,
    browserProjectProfileIds,
  };
  return getBrowserDefaults();
};

describe("getBrowserDefaults profile resolution", () => {
  it("keeps a configured persistent profile", () => {
    expect(withDefaultProfile("work").profileId).toBe("work");
  });

  it("falls back for an unknown profile", () => {
    expect(withDefaultProfile("deleted").profileId).toBe(DEFAULT_BROWSER_PROFILE_ID);
  });

  it("refuses incognito as the default", () => {
    // A stored incognito default would open every new tab into storage that is
    // discarded on close, and the settings list no longer offers it — so the
    // row badged "Default" must be the one tabs actually open under.
    expect(withDefaultProfile(INCOGNITO_BROWSER_PROFILE_ID).profileId).toBe(
      DEFAULT_BROWSER_PROFILE_ID,
    );
  });
});

describe("browserDefaultOpenProfileId", () => {
  beforeEach(() => {
    entities.threadProjectId = null;
    entities.draftProjectId = null;
  });

  it("uses the thread's project profile over the global default", () => {
    entities.threadProjectId = "client";
    const defaults = withDefaultProfile("personal", { "local:/work/client": "work" });
    expect(browserDefaultOpenProfileId(threadRef, defaults)).toBe("work");
  });

  it("uses the project profile for a draft thread", () => {
    entities.draftProjectId = "client";
    const defaults = withDefaultProfile("personal", { "local:/work/client": "work" });
    expect(browserDefaultOpenProfileId(threadRef, defaults)).toBe("work");
  });

  it("falls back to the global default for other projects and unusable profiles", () => {
    entities.threadProjectId = "other";
    expect(
      browserDefaultOpenProfileId(
        threadRef,
        withDefaultProfile("personal", { "local:/work/client": "work" }),
      ),
    ).toBe("personal");

    entities.threadProjectId = "client";
    for (const profileId of ["deleted", INCOGNITO_BROWSER_PROFILE_ID]) {
      expect(
        browserDefaultOpenProfileId(
          threadRef,
          withDefaultProfile("personal", { "local:/work/client": profileId }),
        ),
      ).toBe("personal");
    }
  });
});

describe("resolveBrowserDefaults", () => {
  it("rejects failed reads and uses the saved profile after a successful retry", async () => {
    withDefaultProfile("work");
    settings.current.browserDefaultZoomFactor = 1.25;
    settings.current.browserDefaultAppearance = "dark";
    const failure = new Error("Settings read failed");
    vi.mocked(ensureClientSettingsHydrated).mockRejectedValueOnce(failure);

    await expect(resolveBrowserDefaults()).rejects.toBe(failure);
    await expect(resolveBrowserDefaults()).resolves.toMatchObject({
      viewport: { _tag: "fill" },
      zoomFactor: 1.25,
      appearance: "dark",
      autoShowFloatingPreview: true,
      profileId: "work",
    });
  });
});
