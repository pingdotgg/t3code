import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { IncomingShareDraft } from "./incoming-share-model";

const fixture = vi.hoisted(() => ({
  drafts: [] as Array<IncomingShareDraft>,
  dispatched: [] as Array<unknown>,
}));

vi.mock("../../components/ui/Dialog", () => ({ alert: () => {} }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: async () => "digest",
}));
vi.mock("expo-sharing", () => ({
  clearSharedPayloads: () => {},
  getResolvedSharedPayloadsAsync: async () => [],
  getSharedPayloads: () => [],
}));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("@react-navigation/native", () => ({
  CommonActions: { goBack: () => ({ type: "GO_BACK" }) },
}));
vi.mock("../../lib/composerImages", () => ({ persistComposerAttachmentFile: async () => "" }));
vi.mock("../../lib/appState", () => ({ subscribeAppActive: () => () => {} }));
vi.mock("../../lib/rootNavigation", () => ({
  rootNavigationRef: {
    isReady: () => true,
    getRootState: () => ({ key: "root", index: 0, routes: [{ key: "home", name: "Home" }] }),
    dispatch: (action: unknown) => fixture.dispatched.push(action),
  },
}));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerDraftSnapshot: () => ({}),
  mergeComposerDraftContent: async () => ({ skippedAttachmentCount: 0 }),
  scheduleUnusedComposerAttachmentCleanup: () => {},
  undoComposerDraftMerge: async () => {},
}));
vi.mock("./incoming-share-storage", () => ({
  loadIncomingShareDrafts: async () => fixture.drafts,
  removeIncomingShareDraft: async () => {},
  writeIncomingShareDraft: async () => {},
}));

function share(destination?: IncomingShareDraft["destination"]): IncomingShareDraft {
  return {
    schemaVersion: 1,
    id: "share-1",
    createdAt: "2026-10-30T17:00:00.000Z",
    ...(destination ? { destination } : {}),
    text: "shared text",
    attachments: [],
    warnings: [],
  };
}

async function presentedDraftParams(): Promise<unknown> {
  const { startIncomingShareInbox } = await import("./IncomingShareProvider");
  startIncomingShareInbox();
  await vi.waitFor(() => expect(fixture.dispatched).toHaveLength(1));
  return (fixture.dispatched[0] as { payload: { detail: { params: { draft: unknown } } } }).payload
    .detail.params.draft;
}

describe("presenting a pending share at launch", () => {
  beforeEach(() => {
    // The inbox and its presentation state are module-level, as on device.
    vi.resetModules();
    fixture.dispatched = [];
  });

  it("opens a share without a reservation in a draft with no project", async () => {
    fixture.drafts = [share()];
    expect(await presentedDraftParams()).toEqual({ incomingShareId: "share-1" });
  });

  it("resumes a share an interrupted import reserved in its reserved project", async () => {
    // Without the project the draft falls back to another one, and the import fails with
    // "The shared content is already reserved for another project draft." on every launch.
    fixture.drafts = [share({ environmentId: "environment-1", projectId: "project-2" })];
    expect(await presentedDraftParams()).toEqual({
      incomingShareId: "share-1",
      environmentId: "environment-1",
      projectId: "project-2",
    });
  });
});
