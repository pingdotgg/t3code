import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  owner: vi.fn(),
  preference: vi.fn(),
  open: vi.fn(),
  visit: vi.fn(),
  external: vi.fn(),
}));
vi.mock("react", () => ({ useCallback: (callback: unknown) => callback }));
vi.mock("~/state/taskWorkbench", () => ({ readWorkbenchOwner: mocks.owner }));
vi.mock("~/state/preview", () => ({ previewEnvironment: { open: {} } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.open }));
vi.mock("~/browserHistoryStore", () => ({ recordVisitForThread: mocks.visit }));
vi.mock("~/localApi", () => ({
  readLocalApi: () => ({ shell: { openExternal: mocks.external } }),
}));
vi.mock("./browserLinkTarget", () => ({
  canOpenLinksInApp: (hasThread: boolean) => hasThread,
  resolveBrowserLinkTargetPreference: mocks.preference,
  resolveLinkTarget: ({
    event,
    preference,
  }: {
    event: { metaKey: boolean; ctrlKey: boolean };
    preference: string;
  }) => (event.metaKey || event.ctrlKey ? "browser" : preference),
}));
vi.mock("./openFileInPreview", () => ({
  BrowserSettingsReadError: class extends Error {},
  openUrlInPreview: ({
    ownerRef,
    url,
    openPreview,
  }: {
    ownerRef: ScopedThreadRef;
    url: string;
    openPreview: typeof mocks.open;
  }) =>
    openPreview({
      environmentId: ownerRef.environmentId,
      input: { threadId: ownerRef.threadId, url },
    }),
}));
import { useOpenLink } from "./useOpenLink";
const threadRef = { environmentId: EnvironmentId.make("one"), threadId: ThreadId.make("member") };
const ownerRef = { ...threadRef, threadId: ThreadId.make("task:task") };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.owner.mockReturnValue({ status: "ready", ownerRef });
  mocks.preference.mockResolvedValue("app");
  mocks.open.mockResolvedValue(AsyncResult.success(undefined));
});
it("captures the member's owner before settings await and attributes the visit to the member", async () => {
  let release!: (value: string) => void;
  mocks.preference.mockReturnValue(
    new Promise<string>((resolve) => {
      release = resolve;
    }),
  );
  const pending = useOpenLink(threadRef)("https://example.com");
  mocks.owner.mockReturnValue({
    status: "ready",
    ownerRef: { ...ownerRef, threadId: ThreadId.make("task:other") },
  });
  release("app");
  await pending;
  expect(mocks.owner).toHaveBeenCalledExactlyOnceWith(threadRef);
  expect(mocks.open).toHaveBeenCalledWith({
    environmentId: ownerRef.environmentId,
    input: { threadId: ownerRef.threadId, url: "https://example.com" },
  });
  expect(mocks.visit).toHaveBeenCalledWith(threadRef, "https://example.com");
});
it("reports unavailable identity and keeps modifier-key external opening", async () => {
  mocks.owner.mockReturnValue({ status: "unavailable", reason: "loading" });
  await expect(useOpenLink(threadRef)("https://example.com")).rejects.toThrow(
    "workbench is unavailable",
  );
  expect(mocks.open).not.toHaveBeenCalled();
  await useOpenLink(threadRef)("https://example.com", { event: { metaKey: true, ctrlKey: false } });
  expect(mocks.external).toHaveBeenCalledWith("https://example.com");
});
it("uses explicit file-panel owners without reading a synthetic conversation or attributing a visit", async () => {
  await useOpenLink(ownerRef, ownerRef)("https://example.com");
  expect(mocks.owner).not.toHaveBeenCalled();
  expect(mocks.visit).not.toHaveBeenCalled();
});
it("preserves settings failures and external fallback", async () => {
  mocks.preference.mockRejectedValueOnce(new Error("settings unavailable"));
  await expect(useOpenLink(threadRef)("https://example.com")).rejects.toThrow(
    "settings unavailable",
  );
  expect(mocks.external).not.toHaveBeenCalled();
});

it("preserves a real source conversation when its owner is supplied explicitly", async () => {
  await useOpenLink(threadRef, ownerRef)("https://example.com");
  expect(mocks.owner).not.toHaveBeenCalled();
  expect(mocks.visit).toHaveBeenCalledWith(threadRef, "https://example.com");
});
