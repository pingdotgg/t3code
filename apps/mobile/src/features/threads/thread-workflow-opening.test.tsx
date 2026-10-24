import { RegistryProvider } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { v2Projection } from "../../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures";

vi.mock("react-native", () => ({ Pressable: "button", View: "div" }));
vi.mock("@react-navigation/native", () => ({ StackActions: {}, useNavigation: vi.fn() }));
vi.mock("../../components/ui/AppText", () => ({ AppText: "span" }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: vi.fn(),
}));
vi.mock("./markdownCodeHighlightState", () => ({ useMarkdownCodeHighlight: vi.fn() }));
vi.mock("./SubagentRow", () => ({ SubagentRow: "div" }));
vi.mock("./work-log-layout", () => ({ WorkLogBlock: "div" }));
vi.mock("../../state/threads", () => ({ environmentThreadDetails: { threadAtom: vi.fn() } }));

import { environmentThreadDetails } from "../../state/threads";
import { useWorkflowOpening } from "./thread-workflow-opening";

const environmentId = EnvironmentId.make("test-environment");
const threadId = ThreadId.make("new-thread");

function setup() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const loads: string[] = [];
  const available = new Map<string, typeof v2Projection>();
  const detailAtom = Atom.family((id: string) =>
    Atom.make(() => {
      loads.push(id);
      return available.has(id) ? { environmentId, projection: available.get(id)! } : null;
    }),
  );
  vi.mocked(environmentThreadDetails.threadAtom).mockImplementation((ref) =>
    detailAtom(ref.threadId),
  );
  function Consumer({ ready }: { ready: boolean }) {
    const opening = useWorkflowOpening(environmentId, threadId, ready);
    return (
      <span>{opening === null ? "ordinary thread" : `${opening.name}: ${opening.script}`}</span>
    );
  }
  return {
    container,
    loads,
    available,
    render: async (ready: boolean) => {
      await act(async () =>
        root.render(
          <RegistryProvider>
            <Consumer ready={ready} />
          </RegistryProvider>,
        ),
      );
    },
    async [Symbol.asyncDispose]() {
      await act(async () => root.unmount());
      vi.mocked(environmentThreadDetails.threadAtom).mockReset();
      vi.unstubAllGlobals();
    },
  };
}

it("does not load a pending thread before creation, then loads it after delivery without a restart", async () => {
  await using test = setup();
  await test.render(false);
  expect(test.loads).toEqual([]);
  test.available.set(threadId, v2Projection);
  await test.render(true);
  expect(test.loads).toEqual([threadId]);
});

it("loads an existing ordinary thread without loading a parent", async () => {
  await using test = setup();
  test.available.set(threadId, v2Projection);
  await test.render(true);
  expect(test.loads).toEqual([threadId]);
  expect(environmentThreadDetails.threadAtom).toHaveBeenCalledWith(
    scopeThreadRef(environmentId, threadId),
  );
});

it("loads an existing workflow and its parent metadata", async () => {
  await using test = setup();
  const parentId = ThreadId.make("parent-thread");
  const script = 'export const meta = { name: "test-workflow" };';
  test.available.set(threadId, {
    ...v2Projection,
    thread: {
      ...v2Projection.thread,
      id: threadId,
      creationSource: "provider",
      lineage: {
        rootThreadId: parentId,
        parentThreadId: parentId,
        relationshipToParent: "subagent",
      },
    },
    messages: [
      {
        id: MessageId.make("script-message"),
        threadId,
        runId: null,
        nodeId: null,
        role: "user",
        createdBy: "user",
        creationSource: "provider",
        text: script,
        workflowScript: true,
        attachments: [],
        streaming: false,
        createdAt: v2Projection.updatedAt,
        updatedAt: v2Projection.updatedAt,
      },
    ],
  });
  test.available.set(parentId, {
    ...v2Projection,
    subagents: [
      {
        id: NodeId.make("coordinator"),
        threadId: parentId,
        runId: null,
        parentNodeId: NodeId.make("parent-node"),
        origin: "provider_native",
        createdBy: "agent",
        driver: ProviderDriverKind.make("codexAppServer"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerThreadId: null,
        nativeTaskRef: null,
        childThreadId: threadId,
        title: "Run test workflow",
        prompt: script,
        model: "test-model",
        status: "running",
        result: null,
        startedAt: v2Projection.updatedAt,
        completedAt: null,
        updatedAt: v2Projection.updatedAt,
        workflow: { name: "test-workflow", phases: [], agents: [] },
      },
    ],
  });
  await test.render(true);
  expect(test.loads).toEqual([threadId, parentId]);
  expect(test.container.textContent).toBe(`test-workflow: ${script}`);
});
