import { AsyncResult } from "effect/reactivity";
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, onTestFinished, vi } from "vite-plus/test";
import type { ServerConfig } from "@t3tools/contracts";

import type { ZipTreeRow } from "./zipTree";

const files = vi.hoisted(() => new Map<string, Uint8Array>());
const navigation = vi.hoisted(() => ({ remove: null as (() => void) | null }));
const server = vi.hoisted(() => ({
  capabilities: { repositoryIdentity: false } as ServerConfig["environment"]["capabilities"],
  refresh: vi.fn(async () => "file:///first.zip"),
}));

vi.mock("../../state/entities", () => ({
  useEnvironmentServerConfig: () => ({ environment: { capabilities: server.capabilities } }),
}));
vi.mock("../../state/assets", () => ({
  useRefreshAssetUrl: () => server.refresh,
  useFreshAssetUrl: () => AsyncResult.success({ url: "file:///first.zip", authorizedAt: 0 }),
}));

vi.mock("react-native", () => {
  const Slot = (props: { readonly children?: ReactNode }) => <div>{props.children}</div>;
  return {
    View: Slot,
    Text: Slot,
    ScrollView: Slot,
    ActivityIndicator: () => null,
    Platform: { OS: "ios" },
    Keyboard: { dismiss: vi.fn() },
    Pressable: (props: {
      readonly children?: ReactNode;
      readonly accessibilityLabel?: string;
      readonly disabled?: boolean;
      readonly onPress?: () => void;
    }) => (
      <button
        aria-label={props.accessibilityLabel}
        disabled={props.disabled}
        onClick={props.onPress}
      >
        {props.children}
      </button>
    ),
    TextInput: (props: {
      readonly accessibilityLabel?: string;
      readonly value: string;
      readonly onChangeText: (value: string) => void;
    }) => (
      <input
        aria-label={props.accessibilityLabel}
        value={props.value}
        onChange={(event) => props.onChangeText(event.target.value)}
      />
    ),
  };
});
vi.mock("@legendapp/list/react-native", () => ({
  LegendList: (props: {
    readonly data: ZipTreeRow[];
    readonly ListHeaderComponent: ReactNode;
    readonly ListEmptyComponent: ReactNode;
    readonly keyExtractor: (row: ZipTreeRow) => string;
    readonly renderItem: (input: { item: ZipTreeRow }) => ReactNode;
  }) => (
    <div>
      {props.ListHeaderComponent}
      {props.data.length === 0 ? props.ListEmptyComponent : null}
      {props.data.map((item) => (
        <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
      ))}
    </div>
  ),
}));
vi.mock("expo-file-system", () => ({
  Directory: class {
    create() {}
  },
  Paths: { document: { uri: "file:///documents" } },
  File: class {
    constructor(private readonly uri: string) {}
    get exists() {
      return false;
    }
    get size() {
      return files.get(this.uri)?.byteLength ?? null;
    }
    async arrayBuffer() {
      const bytes = files.get(this.uri);
      if (!bytes) throw new Error(`Missing ZIP fixture: ${this.uri}`);
      return Uint8Array.from(bytes).buffer;
    }
  },
}));
vi.mock("expo/fetch", () => ({ fetch: vi.fn() }));
vi.mock("expo-crypto", () => ({ randomUUID: vi.fn() }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ canGoBack: () => false }),
  usePreventRemove: (enabled: boolean, remove: () => void) => {
    navigation.remove = enabled ? remove : null;
  },
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock("../../native/NativeScrollViewMarker", () => ({ NativeScrollView: () => null }));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../components/ui/Toolbar", () => {
  const Slot = (props: { readonly children?: ReactNode }) => <div>{props.children}</div>;
  return {
    Toolbar: Object.assign(Slot, {
      Button: () => null,
      Menu: Slot,
      MenuAction: (props: {
        readonly children?: ReactNode;
        readonly disabled?: boolean;
        readonly onPress?: () => void;
      }) => (
        <button disabled={props.disabled} onClick={props.onPress}>
          {props.children}
        </button>
      ),
    }),
  };
});
vi.mock("../../components/ui/AndroidScreenHeader", () => ({ AndroidScreenHeader: () => null }));
vi.mock("../../components/ui/Menu", () => ({ Menu: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Progress", () => ({ Progress: () => null }));
vi.mock("../../components/PierreEntryIcon", () => ({ PierreEntryIcon: () => null }));
vi.mock("../../components/FilePreviewModal", () => ({ FilePreviewModal: () => null }));
vi.mock("../../lib/copyTextWithHaptic", () => ({}));
vi.mock("./SourceFileSurface", () => ({
  SourceFileSurface: (props: { readonly contents: string }) => <pre>{props.contents}</pre>,
}));
vi.mock("./AudioFilePreview", () => ({ AudioFilePreview: () => null }));
vi.mock("./FileMarkdownPreview", () => ({ FileMarkdownPreview: () => null }));
vi.mock("./WorkspaceFileWebPreview", () => ({ WorkspaceFileWebPreview: () => null }));
vi.mock("../threads/HtmlRenderWebView", () => ({ HtmlRenderWebView: () => null }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({
    appearance: { codeWordBreak: false },
    themeVariables: { "--color-icon": "#000000" },
    setCodeWordBreak: () => {},
  }),
}));

import { ZipArchiveView } from "./ZipArchiveView";
import { AttachmentFileScreen } from "./AttachmentFileScreen";
import { appAtomRegistry } from "../../state/atom-registry";
import { composerDraftsAtom } from "../../state/use-composer-drafts";

function setup() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setImmediate", "clearImmediate"] });
  files.clear();
  navigation.remove = null;
  server.capabilities = { repositoryIdentity: false };
  server.refresh.mockClear();
  appAtomRegistry.set(composerDraftsAtom, {});
  files.set(
    "file:///first.zip",
    Uint8Array.from(
      atob(
        "UEsDBBQAAAAAAAAAIVyzyFShFgAAABYAAAAJAAAAZmlyc3QudHh0Rmlyc3QgYXJjaGl2ZSBjb250ZW50c1BLAQIUAxQAAAAAAAAAIVyzyFShFgAAABYAAAAJAAAAAAAAAAAAAACAAQAAAABmaXJzdC50eHRQSwUGAAAAAAEAAQA3AAAAPQAAAAAA",
      ),
      (character) => character.charCodeAt(0),
    ),
  );

  const container = document.createElement("div");
  const root = createRoot(container);
  onTestFinished(() => {
    act(() => root.unmount());
    files.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const props: ComponentProps<typeof ZipArchiveView> = {
    name: "archive.zip",
    subtitle: "ZIP",
    tintColor: "#000000",
    sizeBytes: 0,
    uri: "file:///first.zip",
    isLocal: true,
    refresh: async () => null,
    environmentId: null,
    draftKey: null,
    maxAttachmentBytes: undefined,
    onSave: () => {},
    onRemove: null,
  };
  return {
    container,
    root,
    props,
    render: async (input = props) => {
      await act(async () => root.render(<ZipArchiveView {...input} />));
    },
    settle: async (assert: () => void) => {
      await act(async () => vi.runAllTimersAsync());
      assert();
    },
  };
}

it("opens a ZIP chat attachment as a browsable archive on the attachment file screen", async () => {
  const screen = setup();
  server.capabilities = {
    repositoryIdentity: false,
    attachmentUploads: true,
    fileAttachments: { maxUploadBytes: 1024 },
  };
  const { fetch } = await import("expo/fetch");
  vi.mocked(fetch, { partial: true }).mockImplementation(async () => ({
    ok: true,
    body: new Response(Uint8Array.from(files.get("file:///first.zip")!)).body,
  }));
  await act(async () =>
    screen.root.render(
      <AttachmentFileScreen
        route={{
          params: {
            environmentId: "environment-1",
            threadId: "thread-1",
            attachmentId: "attachment-1",
            name: "archive.zip",
            mimeType: "application/zip",
            sizeBytes: "200",
          },
        }}
      />,
    ),
  );
  await screen.settle(() =>
    expect(screen.container.querySelector('[aria-label="first.txt"]')).not.toBeNull(),
  );
  await act(async () =>
    screen.container.querySelector<HTMLButtonElement>('[aria-label="first.txt"]')!.click(),
  );
  await screen.settle(() =>
    expect(screen.container.querySelector("pre")?.textContent).toBe("First archive contents"),
  );
  const add = Array.from(screen.container.querySelectorAll("button")).find(
    (button) => button.textContent === "Add to chat",
  );
  expect(add?.disabled).toBe(false);
});

it("keeps the ZIP filter and archive open when native Back closes a selected entry", async () => {
  const screen = setup();
  await screen.render();
  await screen.settle(() =>
    expect(screen.container.querySelector('[aria-label="first.txt"]')).not.toBeNull(),
  );
  const filter = screen.container.querySelector<HTMLInputElement>(
    '[aria-label="Filter files in ZIP"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      filter,
      "first",
    );
    filter.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    screen.container.querySelector<HTMLButtonElement>('[aria-label="first.txt"]')!.click(),
  );
  await screen.settle(() =>
    expect(screen.container.querySelector("pre")?.textContent).toBe("First archive contents"),
  );

  expect(navigation.remove).not.toBeNull();
  await act(async () => navigation.remove!());

  expect(screen.container.querySelector("pre")).toBeNull();
  expect(screen.container.querySelector('[aria-label="first.txt"]')).not.toBeNull();
  expect(
    screen.container.querySelector<HTMLInputElement>('[aria-label="Filter files in ZIP"]')?.value,
  ).toBe("first");
});

it("explains why an encrypted ZIP cannot be browsed", async () => {
  const screen = setup();
  const bytes = files.get("file:///first.zip")!;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const directory = view.getUint32(bytes.length - 6, true);
  view.setUint16(directory + 8, view.getUint16(directory + 8, true) | 1, true);
  await screen.render();
  await screen.settle(() => expect(screen.container.textContent).toContain("Encrypted zip"));
  expect(screen.container.querySelector('[aria-label="first.txt"]')).toBeNull();
});

it("keeps the archive and selected entry when the parent re-renders with a new refresh", async () => {
  const screen = setup();
  await screen.render();
  await screen.settle(() =>
    expect(screen.container.querySelector('[aria-label="first.txt"]')).not.toBeNull(),
  );
  await act(async () =>
    screen.container.querySelector<HTMLButtonElement>('[aria-label="first.txt"]')!.click(),
  );
  await screen.settle(() =>
    expect(screen.container.querySelector("pre")?.textContent).toBe("First archive contents"),
  );
  files.delete("file:///first.zip");

  await screen.render({ ...screen.props, refresh: async () => null });
  await screen.settle(() =>
    expect(screen.container.querySelector("pre")?.textContent).toBe("First archive contents"),
  );
  expect(navigation.remove).not.toBeNull();
});
