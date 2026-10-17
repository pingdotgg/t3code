import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { AssetUrlState } from "../assets/assetUrls";
import { AsyncResult } from "effect/reactivity";
import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";

const mint = vi.hoisted(() => vi.fn());
const asset = vi.hoisted(() => ({
  state: { _tag: "Loading" } as AssetUrlState,
  connected: true,
  listeners: new Set<() => void>(),
}));
vi.mock("../assets/assetUrls", async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await importOriginal<typeof import("../assets/assetUrls")>()),
    useAssetUrlState: () =>
      useSyncExternalStore(
        (listener) => {
          asset.listeners.add(listener);
          return () => {
            asset.listeners.delete(listener);
          };
        },
        () => asset.state,
      ),
  };
});
vi.mock("./media/MediaActions", () => ({ MediaActions: () => null }));
// Atoms derived from the server config run in a real registry over a missing
// config; every other subscription reads nothing.
vi.mock("@effect/atom-react", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  const registry = AtomRegistry.make();
  const derived = new Set(["markdown-server-config-fields", "pull-request-link-mode"]);
  return {
    useAtomValue: (atom: { readonly label?: readonly [string, ...unknown[]] }) =>
      derived.has(atom.label?.[0] ?? "") ? registry.get(atom as never) : null,
  };
});
vi.mock("../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    serverEnvironment: { configValueAtom: () => noConfig },
    environmentServerConfigsAtom: Atom.make(new Map()),
  };
});
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../hooks/useFileMetadata", () => ({ useFileMetadata: () => undefined }));
vi.mock("../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useSettings")>();
  const settings = actual.getClientSettings();
  return {
    ...actual,
    useClientSettings: (select: (value: typeof settings) => unknown) => select(settings),
  };
});
vi.mock("./ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger({
      render,
      children,
    }: ComponentProps<typeof import("./ui/tooltip").TooltipTrigger>) {
      if (!isValidElement(render)) return <>{children}</>;
      return children === undefined ? render : cloneElement(render, undefined, children);
    },
    TooltipPopup: () => null,
  };
});
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => mint }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/session", async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await importOriginal<typeof import("../state/session")>()),
    readEnvironmentScope: () => false,
    useEnvironmentScope: () => false,
    readPreparedConnection: () => ({ httpBaseUrl: "https://host.test" }),
    usePreparedConnection: () => {
      const connected = useSyncExternalStore(
        (listener) => {
          asset.listeners.add(listener);
          return () => {
            asset.listeners.delete(listener);
          };
        },
        () => asset.connected,
      );
      return connected
        ? { _tag: "Some", value: { httpBaseUrl: "https://host.test" } }
        : { _tag: "None" };
    },
  };
});
vi.mock("../state/entities", () => ({
  readEnvironmentSupportsServerBrowser: () => false,
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectForChangeRequest: () => undefined,
  matchesLinkedPullRequestUrl: () => false,
  parseChangeRequestUrl: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import ChatMarkdown, { ChatMarkdownAssetImage } from "./ChatMarkdown";

const assetProps = {
  environmentId: EnvironmentId.make("media-environment"),
  resource: {
    _tag: "media-file",
    threadId: ThreadId.make("media-thread"),
    path: "/repo/diagram.svg",
  },
  alt: "Diagram",
} satisfies ComponentProps<typeof ChatMarkdownAssetImage>;

async function publishAssetState(state: AssetUrlState) {
  await act(async () => {
    asset.state = state;
    for (const listener of asset.listeners) listener();
  });
}

it.each(["opened", "edited"] as const)(
  "refreshes a cached failure after a file preview is %s offline and reconnects",
  async (action) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mint
      .mockReset()
      .mockResolvedValue(
        AsyncResult.success({ relativeUrl: "/api/assets/updated.svg", expiresAt: 1 }),
      );
    asset.state = { _tag: "Failure" };
    asset.connected = action === "edited";
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(<ChatMarkdownAssetImage {...assetProps} workspaceMutationId={null} />);
      });
      if (action === "edited") {
        await act(async () => {
          asset.connected = false;
          for (const listener of asset.listeners) listener();
        });
        mint.mockClear();
        for (const mutation of ["edit-1", "edit-2"]) {
          await act(async () => {
            renderer!.update(
              <ChatMarkdownAssetImage {...assetProps} workspaceMutationId={mutation} />,
            );
          });
        }
      }
      expect(mint).not.toHaveBeenCalled();
      await act(async () => {
        asset.connected = true;
        for (const listener of asset.listeners) listener();
      });
      expect(mint).toHaveBeenCalledExactlyOnceWith({
        environmentId: assetProps.environmentId,
        input: { resource: assetProps.resource },
      });
    } finally {
      await act(async () => renderer?.unmount());
      asset.connected = true;
      vi.unstubAllGlobals();
    }
  },
);

it("does not mint a second URL when the initial file preview request completes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mint.mockClear();
  asset.state = { _tag: "Loading" };
  let renderer: ReactTestRenderer | undefined;
  const image = <ChatMarkdownAssetImage {...assetProps} workspaceMutationId="initial" />;
  try {
    await act(async () => {
      renderer = create(image);
    });
    await publishAssetState({
      _tag: "Success",
      url: "https://host.test/diagram.svg",
      expiresAt: 1,
    });
    expect(mint).not.toHaveBeenCalled();
  } finally {
    await act(async () => renderer?.unmount());
    vi.unstubAllGlobals();
  }
});

it.each(
  (["Loading", "Success", "Failure"] as const).flatMap((initial) =>
    (["Success", "Failure"] as const).map((outcome) => [initial, outcome] as const),
  ),
)(
  "refreshes a file changed during a pending %s request after it ends in %s",
  async (initial, outcome) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mint.mockReset();
    mint.mockResolvedValue(
      AsyncResult.success({ relativeUrl: "/api/assets/updated.svg", expiresAt: 1 }),
    );
    asset.state =
      initial === "Success"
        ? { _tag: "Success", url: "https://host.test/stale.svg", expiresAt: 1, waiting: true }
        : { _tag: initial, waiting: true };
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(<ChatMarkdownAssetImage {...assetProps} workspaceMutationId="initial" />);
      });
      for (const mutation of ["edit-1", "edit-2"]) {
        await act(async () => {
          renderer!.update(
            <ChatMarkdownAssetImage {...assetProps} workspaceMutationId={mutation} />,
          );
        });
      }
      expect(mint).not.toHaveBeenCalled();
      await publishAssetState(
        outcome === "Failure"
          ? { _tag: "Failure" }
          : { _tag: "Success", url: "https://host.test/stale.svg", expiresAt: 1 },
      );
      expect(mint).toHaveBeenCalledExactlyOnceWith({
        environmentId: assetProps.environmentId,
        input: { resource: assetProps.resource },
      });
      await act(async () => {
        renderer!.update(<ChatMarkdownAssetImage {...assetProps} workspaceMutationId="edit-2" />);
      });
      expect(mint).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  },
);

it("opens host media through server authorization before the client grant loads", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mint.mockResolvedValue(
    AsyncResult.success({ relativeUrl: "/api/assets/image.png", expiresAt: 1 }),
  );
  const onImageExpand = vi.fn();
  const threadRef = {
    environmentId: EnvironmentId.make("media-environment"),
    threadId: ThreadId.make("media-thread"),
  };
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(
        <ChatMarkdown
          cwd="/repo"
          threadRef={threadRef}
          text="[Open image](/tmp/image.png)"
          onImageExpand={onImageExpand}
        />,
      );
    });
    await act(async () => {
      const link = renderer!.root
        .findAllByType("a")
        .find((node) => node.props.href === "/tmp/image.png");
      expect(link).toBeDefined();
      link!.props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
    });
    expect(onImageExpand).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [expect.objectContaining({ src: "https://host.test/api/assets/image.png" })],
      }),
    );
  } finally {
    await act(async () => renderer?.unmount());
    vi.unstubAllGlobals();
  }
});
