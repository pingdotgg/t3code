import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import { RegistryContext } from "@effect/atom-react";
import {
  AssetAccessError,
  AssetWorkspaceAssetNotFoundError,
  AssetPreviewTypeValidationError,
  type AssetCreateUrlResult,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AtomRegistry } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mint = vi.hoisted(() => vi.fn<() => Promise<AssetCreateUrlResult>>());
const remoteOpen = vi.hoisted(() => ({
  state: { mode: "local-exec" as "local-exec" | "remote-unavailable" },
  isResolved: true,
  label: "media-host",
  httpBaseUrl: "https://host.test",
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
// Keep the real query runner and registry: refreshes during waiting requests are skipped.
vi.mock(import("../state/assets"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const isAssetError = Schema.is(AssetAccessError);
  const family = Atom.family((_key: string) =>
    Atom.make(
      Effect.tryPromise({
        try: () => mint(),
        catch: (error) => (isAssetError(error) ? error : new Cause.UnknownError(error)),
      }),
    ).pipe(Atom.keepAlive),
  );
  return {
    ...actual,
    assetEnvironment: {
      ...actual.assetEnvironment,
      createUrl: (target) => family(JSON.stringify(target)),
    },
  };
});
vi.mock(import("../state/filesystem"), async (original) => ({
  ...(await original()),
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => false,
  useEnvironmentScope: () => false,
  readPreparedConnection: (() => ({
    httpBaseUrl: "https://host.test",
    target: remoteOpen.isResolved
      ? new PrimaryConnectionTarget({
          environmentId: EnvironmentId.make("media-environment"),
          label: remoteOpen.label,
          httpBaseUrl: remoteOpen.httpBaseUrl,
          wsBaseUrl: "wss://host.test",
        })
      : undefined,
  })) as never,
  usePreparedConnection: (() => ({
    _tag: "Some",
    value: { httpBaseUrl: "https://host.test" },
  })) as never,
}));

vi.mock(import("../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => remoteOpen,
}));

import ChatMarkdown from "./ChatMarkdown";
import { toastManager } from "./ui/toast";

const roots: Root[] = [];
let registry: AtomRegistry.AtomRegistry;

const imageUrl = (version: string) =>
  `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>#${version}`;
const assetResult = (version: string): AssetCreateUrlResult => ({
  relativeUrl: imageUrl(version),
  expiresAt: 1,
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  mint.mockReset().mockResolvedValue(assetResult("updated"));
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  registry.dispose();
  document.body.replaceChildren();
  remoteOpen.isResolved = true;
  remoteOpen.state.mode = "local-exec";
  remoteOpen.label = "media-host";
  remoteOpen.httpBaseUrl = "https://host.test";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createTestRoot() {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  return {
    container,
    render: (children: ReactNode) =>
      act(async () => {
        root.render(
          <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>,
        );
      }),
  };
}

it("opens host media through server authorization before the client grant loads", async () => {
  mint.mockResolvedValue({ relativeUrl: "/api/assets/image.png", expiresAt: 1 });
  const expanded = deferred<unknown>();
  const onImageExpand = vi.fn(expanded.resolve);
  const { container, render } = createTestRoot();
  await render(
    <ChatMarkdown
      cwd="/repo"
      threadRef={{
        environmentId: EnvironmentId.make("media-environment"),
        threadId: ThreadId.make("media-thread"),
      }}
      text="[Open image](/tmp/image.png)"
      onImageExpand={onImageExpand}
    />,
  );
  const link = container.querySelector<HTMLAnchorElement>('a[href="/tmp/image.png"]');
  expect(link).not.toBeNull();
  await act(async () => link!.click());
  expect(await expanded.promise).toMatchObject({
    images: [expect.objectContaining({ src: "https://host.test/api/assets/image.png" })],
  });
});

const threadRef = {
  environmentId: EnvironmentId.make("media-environment"),
  threadId: ThreadId.make("media-thread"),
};

it.each([
  {
    name: "a remote lookup whose host resolves while it is pending",
    checkedPath: "/home/remote/Downloads/image.png",
    description: "The file was not found on settled-host at /home/remote/Downloads/image.png.",
  },
  {
    name: "an older remote server without a checked path",
    description: "The file was not found on settled-host at ~/Downloads/image.png.",
  },
  {
    name: "a missing file on this device",
    local: true,
    checkedPath: "/home/local/Downloads/image.png",
    description: "Media file was not found.",
  },
  {
    name: "a different remote failure",
    unsupported: true,
    description: "Only images, videos, audio, HTML, and PDF files can be previewed.",
  },
])("reports the media failure for $name", async (scenario) => {
  const lookup = deferred<AssetCreateUrlResult>();
  const started = deferred<void>();
  const reported = deferred<Parameters<typeof toastManager.add>[0]>();
  mint.mockImplementation(() => {
    started.resolve();
    return lookup.promise;
  });
  vi.spyOn(toastManager, "add").mockImplementation((toast) => {
    reported.resolve(toast);
    return "media-toast";
  });
  remoteOpen.isResolved = false;
  const { container, render } = createTestRoot();
  const content = (
    <ChatMarkdown cwd="/repo" threadRef={threadRef} text="[Open image](~/Downloads/image.png)" />
  );
  await render(content);
  const link = container.querySelector<HTMLAnchorElement>('a[href="~/Downloads/image.png"]');
  expect(link).not.toBeNull();
  await act(async () => {
    link!.click();
    await started.promise;
  });

  remoteOpen.isResolved = true;
  remoteOpen.state.mode = scenario.local ? "local-exec" : "remote-unavailable";
  remoteOpen.httpBaseUrl = scenario.local ? "http://localhost:3773" : "https://host.test";
  remoteOpen.label = "settled-host";
  await render(content);
  const resource = {
    _tag: "media-file" as const,
    path: "~/Downloads/image.png",
    threadId: threadRef.threadId,
  };
  await act(async () => {
    lookup.reject(
      scenario.unsupported
        ? new AssetPreviewTypeValidationError({ resource })
        : new AssetWorkspaceAssetNotFoundError({
            resource,
            ...(scenario.checkedPath ? { checkedPath: scenario.checkedPath } : {}),
          }),
    );
    await reported.promise;
  });
  expect(await reported.promise).toMatchObject({
    title: "Media unavailable",
    description: scenario.description,
  });
});

function markdown(workspaceMutationId?: string | null) {
  return (
    <ChatMarkdown
      cwd="/repo"
      imageBaseDir="/repo"
      threadRef={threadRef}
      text="![Diagram](diagram.svg)"
      workspaceMutationId={workspaceMutationId}
    />
  );
}

function renderedImage(container: HTMLElement) {
  return container.querySelector<HTMLImageElement>('img[alt="Diagram"]')?.getAttribute("src");
}

it("ordinary chat keeps its embedded asset URL across renders and reopening", async () => {
  const { container, render } = createTestRoot();
  await render(markdown());
  expect(renderedImage(container)).toBe(imageUrl("updated"));
  mint.mockResolvedValue(assetResult("changed"));

  await render(markdown());
  await render(null);
  await render(markdown());

  expect(renderedImage(container)).toBe(imageUrl("updated"));
  expect(mint).toHaveBeenCalledTimes(1);
});

it.each(["URL", "failure"] as const)(
  "reopening a file preview with no workspace mutation replaces its cached %s",
  async (cached) => {
    if (cached === "failure") mint.mockRejectedValueOnce(new Error("Image missing"));
    else mint.mockResolvedValueOnce(assetResult("stale"));
    const { container, render } = createTestRoot();
    await render(markdown(null));
    expect(renderedImage(container)).toBe(cached === "URL" ? imageUrl("stale") : undefined);
    await render(null);

    mint.mockResolvedValue(assetResult("updated"));
    await render(markdown(null));

    expect(renderedImage(container)).toBe(imageUrl("updated"));
    expect(mint).toHaveBeenCalledTimes(2);
  },
);

it.each(["initial", "refresh"] as const)(
  "shows the latest workspace edit after a pending %s asset request settles",
  async (request) => {
    let resolvePending!: (value: AssetCreateUrlResult) => void;
    const pending = new Promise<AssetCreateUrlResult>((resolve) => {
      resolvePending = resolve;
    });
    const { container, render } = createTestRoot();
    if (request === "refresh") {
      await render(markdown("m0"));
      expect(renderedImage(container)).toBe(imageUrl("updated"));
    }

    mint.mockReturnValueOnce(pending).mockResolvedValue(assetResult("latest"));
    await render(markdown("m1"));
    const callsBeforeEdits = mint.mock.calls.length;
    await render(markdown("m2"));
    await render(markdown("m3"));
    expect(mint).toHaveBeenCalledTimes(callsBeforeEdits);

    await act(async () => {
      resolvePending(assetResult("before-edits"));
      await pending;
    });

    expect(renderedImage(container)).toBe(imageUrl("latest"));
    expect(mint).toHaveBeenCalledTimes(callsBeforeEdits + 1);
    await render(markdown("m3"));
    expect(mint).toHaveBeenCalledTimes(callsBeforeEdits + 1);
  },
);
