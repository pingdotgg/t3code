import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import { AssetWorkspaceAssetNotFoundError, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mint = vi.hoisted(() => vi.fn());
const remoteOpen = vi.hoisted(() => ({
  state: { mode: "local-exec" as "local-exec" | "remote-unavailable" },
  isResolved: true,
}));
// Atoms derived from the server config run in the real registry over a missing config.
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
vi.mock(import("../state/use-atom-query-runner"), async (original) => ({
  ...(await original()),
  useAtomQueryRunner: (() => mint) as never,
}));
vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => false,
  useEnvironmentScope: () => false,
  readPreparedConnection: (() => ({
    httpBaseUrl: "https://host.test",
    target: new PrimaryConnectionTarget({
      environmentId: EnvironmentId.make("media-environment"),
      label: "media-host",
      httpBaseUrl: "https://host.test",
      wsBaseUrl: "wss://host.test",
    }),
  })) as never,
}));

vi.mock(import("../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => remoteOpen,
}));
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  readEnvironmentLabel: () => "media-host",
}));

import ChatMarkdown from "./ChatMarkdown";
import { toastManager } from "./ui/toast";

const roots: Root[] = [];
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  remoteOpen.isResolved = true;
  remoteOpen.state.mode = "local-exec";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("opens host media through server authorization before the client grant loads", async () => {
  mint.mockResolvedValue(
    AsyncResult.success({ relativeUrl: "/api/assets/image.png", expiresAt: 1 }),
  );
  const onImageExpand = vi.fn();
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <ChatMarkdown
        cwd="/repo"
        threadRef={{
          environmentId: EnvironmentId.make("media-environment"),
          threadId: ThreadId.make("media-thread"),
        }}
        text="[Open image](/tmp/image.png)"
        onImageExpand={onImageExpand}
      />,
    ),
  );
  const link = container.querySelector<HTMLAnchorElement>('a[href="/tmp/image.png"]');
  expect(link).not.toBeNull();
  await act(async () => link!.click());
  await vi.waitFor(() =>
    expect(onImageExpand).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [expect.objectContaining({ src: "https://host.test/api/assets/image.png" })],
      }),
    ),
  );
});

it("names the remote host when media fails after remote-open resolution settles", async () => {
  mint.mockClear();
  remoteOpen.isResolved = false;
  remoteOpen.state.mode = "local-exec";
  // The promise constructor assigns the rejection handler synchronously.
  let rejectLookup!: (error: Error) => void;
  const lookup = new Promise<never>((_, reject) => {
    rejectLookup = reject;
  });
  mint.mockReturnValue(lookup);
  const toast = vi.spyOn(toastManager, "add");
  const threadRef = {
    environmentId: EnvironmentId.make("media-environment"),
    threadId: ThreadId.make("media-thread"),
  };
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <ChatMarkdown cwd="/repo" threadRef={threadRef} text="[Open image](/tmp/image.png)" />,
    ),
  );
  const link = container.querySelector<HTMLAnchorElement>('a[href="/tmp/image.png"]');
  expect(link).not.toBeNull();
  await act(async () => link!.click());
  expect(mint).toHaveBeenCalled();
  remoteOpen.isResolved = true;
  remoteOpen.state.mode = "remote-unavailable";
  await act(async () =>
    root.render(
      <ChatMarkdown cwd="/repo" threadRef={threadRef} text="[Open image](/tmp/image.png)" />,
    ),
  );
  await act(async () => {
    rejectLookup(
      new AssetWorkspaceAssetNotFoundError({
        resource: { _tag: "media-file", path: "/tmp/image.png", threadId: threadRef.threadId },
        checkedPath: "/tmp/image.png",
      }),
    );
  });
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Media unavailable",
      description: "The file was not found on media-host at /tmp/image.png.",
    }),
  );
});
