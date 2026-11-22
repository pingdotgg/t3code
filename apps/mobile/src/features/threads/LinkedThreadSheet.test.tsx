import { MessageId, type OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";
import {
  v2MessageRow,
  v2Projection,
} from "../../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures";

const { openURL, readThread, links } = vi.hoisted(() => ({
  openURL: vi.fn(async (_url: string) => {}),
  readThread: vi.fn(),
  links: new Map<string, () => void>(),
}));

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useSyncExternalStore: ((subscribe, getSnapshot, getServerSnapshot = getSnapshot) =>
      react.useSyncExternalStore(
        subscribe,
        getSnapshot,
        getServerSnapshot,
      )) satisfies typeof react.useSyncExternalStore,
  };
});

vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
  Linking: { openURL },
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => true,
  useNavigation: () => ({}),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("../../components/ui/ScreenContent", () => ({
  ScreenContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./ReadOnlyComposerBar", () => ({ ReadOnlyComposerBar: () => null }));
vi.mock("./thread-inspector-header", () => ({ ThreadInspectorHeader: () => null }));
vi.mock("../files/FileMarkdownPreview", () => ({
  useMarkdownPreviewStyles: () => ({ nativeTextStyle: {} }),
}));
vi.mock("../../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("../../state/linkedThread", () => ({
  useLinkedThreadView: readThread,
  useConnectLinkedEnvironment: () => ({ state: { phase: "idle" } }),
}));
vi.mock("../../state/peerLinks", () => ({}));
vi.mock("../../state/query", () => ({}));
vi.mock("./useOpenLinkedThread", () => ({ useOpenLinkedThread: () => () => {} }));

vi.mock("../../native/SelectableMarkdownText", () => ({
  SelectableMarkdownText: ({
    markdown,
    onLinkPress,
  }: {
    markdown: string;
    onLinkPress?: (href: string) => void;
  }) => {
    for (const [, label, href] of markdown.matchAll(/\[([^\]]+)\]\(([^)]*)\)/g)) {
      if (label) links.set(label, () => onLinkPress?.(href ?? ""));
    }
    return null;
  },
}));

import { LinkedThreadSheet } from "./LinkedThreadSheet";

it("opens web links from read-only agent messages through the system browser", () => {
  const reply = v2MessageRow("reply", 0);
  const sent = v2MessageRow("sent", 1);
  if (reply.item.type !== "user_message" || sent.item.type !== "user_message") {
    throw new Error("Expected message fixtures");
  }
  const visibleTurnItems: OrchestrationV2ProjectedTurnItem[] = [
    {
      ...reply,
      item: {
        ...reply.item,
        type: "assistant_message",
        messageId: MessageId.make("assistant-reply"),
        text: "[Example](https://example.com/) [Docs](docs/readme.md) [Other](t3-thread://v2/env/thread) [Empty]()",
        streaming: false,
      },
    },
    {
      ...sent,
      position: 1,
      item: {
        ...sent.item,
        type: "dynamic_tool",
        toolName: "send_to_user",
        input: {},
        output: { sentMessage: "[Reference](http://example.org/) [Guide](//example.net/guide)" },
      },
    },
  ];
  readThread.mockReturnValue({
    view: {
      thread: { projection: { ...v2Projection, visibleTurnItems }, historyCursor: null },
    },
    error: null,
  });
  openURL.mockClear();
  links.clear();

  renderToStaticMarkup(
    <LinkedThreadSheet
      route={{
        params: {
          viaEnvironmentId: "local",
          environmentId: "linked",
          threadId: v2Projection.thread.id,
          label: "Linked",
        },
      }}
    />,
  );
  expect([...links.keys()]).toEqual(["Example", "Docs", "Other", "Empty", "Reference", "Guide"]);
  for (const press of links.values()) press();
  expect(openURL.mock.calls).toEqual([
    ["https://example.com/"],
    ["http://example.org/"],
    ["https://example.net/guide"],
  ]);
});
