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
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

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

const imageUrl = (version: string) =>
  `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>#${version}`;
const assetResult = (version: string): AssetCreateUrlResult => ({
  relativeUrl: imageUrl(version),
  expiresAt: 1,
});

function setup() {
  mint.mockReset().mockResolvedValue(assetResult("updated"));
  remoteOpen.isResolved = true;
  remoteOpen.state.mode = "local-exec";
  remoteOpen.label = "media-host";
  remoteOpen.httpBaseUrl = "https://host.test";
  const registry = AtomRegistry.make();
  return { registry, [Symbol.dispose]: () => registry.dispose() };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function renderInRegistry(registry: AtomRegistry.AtomRegistry, ui: ReactNode) {
  const wrap = (node: ReactNode) => (
    <RegistryContext.Provider value={registry}>{node}</RegistryContext.Provider>
  );
  const screen = await render(wrap(ui));
  return Object.assign(screen, { update: (node: ReactNode) => screen.rerender(wrap(node)) });
}

it("opens host media through server authorization before the client grant loads", async () => {
  using env = setup();
  mint.mockResolvedValue({ relativeUrl: "/api/assets/image.png", expiresAt: 1 });
  const expanded = deferred<unknown>();
  const onImageExpand = vi.fn(expanded.resolve);
  await using screen = await renderInRegistry(
    env.registry,
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
  const link = screen.container.querySelector<HTMLAnchorElement>('a[href="/tmp/image.png"]');
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
  using env = setup();
  const lookup = deferred<AssetCreateUrlResult>();
  const started = deferred<void>();
  const reported = deferred<Parameters<typeof toastManager.add>[0]>();
  mint.mockImplementation(() => {
    started.resolve();
    return lookup.promise;
  });
  using _toast = vi.spyOn(toastManager, "add").mockImplementation((toast) => {
    reported.resolve(toast);
    return "media-toast";
  });
  remoteOpen.isResolved = false;
  const content = (
    <ChatMarkdown cwd="/repo" threadRef={threadRef} text="[Open image](~/Downloads/image.png)" />
  );
  await using screen = await renderInRegistry(env.registry, content);
  const link = screen.container.querySelector<HTMLAnchorElement>('a[href="~/Downloads/image.png"]');
  expect(link).not.toBeNull();
  await act(async () => {
    link!.click();
    await started.promise;
  });

  remoteOpen.isResolved = true;
  remoteOpen.state.mode = scenario.local ? "local-exec" : "remote-unavailable";
  remoteOpen.httpBaseUrl = scenario.local ? "http://localhost:3773" : "https://host.test";
  remoteOpen.label = "settled-host";
  await screen.update(content);
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
  using env = setup();
  await using screen = await renderInRegistry(env.registry, markdown());
  expect(renderedImage(screen.container)).toBe(imageUrl("updated"));
  mint.mockResolvedValue(assetResult("changed"));

  await screen.update(markdown());
  await screen.update(null);
  await screen.update(markdown());

  expect(renderedImage(screen.container)).toBe(imageUrl("updated"));
  expect(mint).toHaveBeenCalledTimes(1);
});

it.each(["URL", "failure"] as const)(
  "reopening a file preview with no workspace mutation replaces its cached %s",
  async (cached) => {
    using env = setup();
    if (cached === "failure") mint.mockRejectedValueOnce(new Error("Image missing"));
    else mint.mockResolvedValueOnce(assetResult("stale"));
    await using screen = await renderInRegistry(env.registry, markdown(null));
    expect(renderedImage(screen.container)).toBe(cached === "URL" ? imageUrl("stale") : undefined);
    await screen.update(null);

    mint.mockResolvedValue(assetResult("updated"));
    await screen.update(markdown(null));

    expect(renderedImage(screen.container)).toBe(imageUrl("updated"));
    expect(mint).toHaveBeenCalledTimes(2);
  },
);

it.each(["initial", "refresh"] as const)(
  "shows the latest workspace edit after a pending %s asset request settles",
  async (request) => {
    using env = setup();
    let resolvePending!: (value: AssetCreateUrlResult) => void;
    const pending = new Promise<AssetCreateUrlResult>((resolve) => {
      resolvePending = resolve;
    });
    await using screen = await renderInRegistry(env.registry, null);
    if (request === "refresh") {
      await screen.update(markdown("m0"));
      expect(renderedImage(screen.container)).toBe(imageUrl("updated"));
    }

    mint.mockReturnValueOnce(pending).mockResolvedValue(assetResult("latest"));
    await screen.update(markdown("m1"));
    const callsBeforeEdits = mint.mock.calls.length;
    await screen.update(markdown("m2"));
    await screen.update(markdown("m3"));
    expect(mint).toHaveBeenCalledTimes(callsBeforeEdits);

    await act(async () => {
      resolvePending(assetResult("before-edits"));
      await pending;
    });

    expect(renderedImage(screen.container)).toBe(imageUrl("latest"));
    expect(mint).toHaveBeenCalledTimes(callsBeforeEdits + 1);
    await screen.update(markdown("m3"));
    expect(mint).toHaveBeenCalledTimes(callsBeforeEdits + 1);
  },
);
