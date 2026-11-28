import { expect, it } from "@effect/vitest";
import {
  followLinkedThread,
  type LinkedThreadView as LinkedThreadState,
} from "@t3tools/client-runtime/linked-thread";
import { EnvironmentId, type OrchestrationV2ThreadHistoryPage } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { vi } from "vite-plus/test";

import { v2Projection } from "../../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures";
import { useLinkedThreadView } from "../../state/linkedThread";
import { LinkedThreadView } from "./LinkedThreadSheet";

vi.mock("@react-navigation/native", () => ({
  StackActions: {},
  useIsFocused: () => true,
  useNavigation: () => ({}),
}));
vi.mock("react-native", () => {
  const Container = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
    Platform: { OS: "android" },
    Pressable: Container,
    ScrollView: Container,
    Text: Container,
    View: Container,
  };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button type="button" disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../../components/ui/ScreenContent", () => ({
  ScreenContent: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../native/SelectableMarkdownText", () => ({ SelectableMarkdownText: () => null }));
vi.mock("../../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("../../state/linkedThread", () => ({
  useConnectLinkedEnvironment: () => ({ state: { phase: "idle" } }),
  useLinkedThreadView: vi.fn(),
}));
vi.mock("../../state/peerLinks", () => ({ peerLinkEnvironment: {} }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({}) }));
vi.mock("../files/FileMarkdownPreview", () => ({ useMarkdownPreviewStyles: () => ({}) }));
vi.mock("./ReadOnlyComposerBar", () => ({
  ReadOnlyComposerBar: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./thread-inspector-header", () => ({ ThreadInspectorHeader: () => null }));
vi.mock("./useOpenLinkedThread", () => ({ useOpenLinkedThread: () => undefined }));

it.effect(
  "shows a page error after Load earlier fails on an already disconnected linked chat",
  () =>
    Effect.gen(function* () {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const container = document.createElement("div");
      const root = createRoot(container);
      const target = {
        viaEnvironmentId: EnvironmentId.make("via"),
        environmentId: EnvironmentId.make("linked"),
        threadId: v2Projection.thread.id,
        label: "Linked test environment",
        title: null,
      };
      const warning = "Linked test environment is not answering this environment";
      const pageError = "Could not load earlier turns. Try again.";
      const loadEarlier = () =>
        [...container.querySelectorAll("button")].find(
          (button) => button.textContent === "Load earlier",
        )!;

      try {
        const unavailable = { _tag: "PeerLinkThreadReadError", reason: "unreachable" };
        const pages =
          yield* Queue.unbounded<
            Effect.Effect<OrchestrationV2ThreadHistoryPage, typeof unavailable>
          >();
        const views = yield* Queue.unbounded<LinkedThreadState>();
        yield* followLinkedThread({
          items: Stream.make({
            kind: "snapshot",
            snapshotSequence: 1,
            projection: v2Projection,
            historyCursor: "before-recent",
            hasMoreHistory: true,
          } as const).pipe(Stream.concat(Stream.fail(unavailable))),
          historyPage: () => Queue.take(pages).pipe(Effect.flatten),
        }).pipe(
          Stream.runForEach((view) => Queue.offer(views, view)),
          Effect.forkScoped,
        );

        const renderNext = Effect.gen(function* () {
          const view = yield* Queue.take(views);
          vi.mocked(useLinkedThreadView).mockReturnValue({
            view,
            error: view.error ?? null,
            retry() {},
          });
          act(() => root.render(<LinkedThreadView target={target} />));
        });

        yield* renderNext; // Initial snapshot.
        yield* renderNext; // Connection warning.
        expect(container.textContent).toContain(warning);
        expect(container.textContent).not.toContain(pageError);

        act(() => loadEarlier().click());
        yield* renderNext;
        yield* Queue.offer(pages, Effect.fail(unavailable));
        yield* renderNext;
        expect(loadEarlier().parentElement?.textContent).toContain(pageError);
        expect(container.textContent).toContain(warning);

        act(() => loadEarlier().click());
        yield* renderNext;
        expect(container.textContent).not.toContain(pageError);
        expect(loadEarlier().disabled).toBe(true);
      } finally {
        act(() => root.unmount());
        vi.unstubAllGlobals();
      }
    }).pipe(Effect.scoped),
);
