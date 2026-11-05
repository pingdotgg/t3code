import "../../index.css";
import { RegistryContext } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  conversationSummarySourceKey,
  type ConversationSummary,
  type ConversationSummaryExpansion,
  type ConversationSummaryList,
  type ConversationSummaryListInput,
} from "@t3tools/contracts";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  config: null as unknown,
  list: null as unknown,
  expand: null as unknown,
  lists: [] as { environmentId: EnvironmentId; input: ConversationSummaryListInput }[],
  updateSettings: vi.fn(),
}));
vi.mock(
  import("../../state/server"),
  () =>
    ({
      serverEnvironment: {
        configValueAtom: () => state.config,
        updateSettings: { label: "updateSettings" },
      },
    }) as never,
);
vi.mock(import("../../state/session"), () => ({ useEnvironmentScope: () => true }) as never);
vi.mock(import("../../state/entities"), () => ({ useProject: () => null }) as never);
vi.mock(
  import("../../state/conversationSummaries"),
  () =>
    ({
      conversationSummaries: {
        list: (request: { environmentId: EnvironmentId; input: ConversationSummaryListInput }) => {
          state.lists.push(request);
          return state.list;
        },
        expand: () => state.expand,
      },
    }) as never,
);
vi.mock(
  import("../../state/use-atom-command"),
  () => ({ useAtomCommand: () => state.updateSettings }) as never,
);

import { ConversationSummariesDialog } from "./ConversationSummariesDialog";

const scope = {
  environmentId: EnvironmentId.make("summaries-browser"),
  projectId: ProjectId.make("project"),
  threadId: ThreadId.make("thread"),
};
const ref = (id: string) => ({
  kind: "message" as const,
  threadId: scope.threadId,
  messageId: MessageId.make(id),
  digest: "a".repeat(64),
});
const firstSource = { ...ref("first"), range: { start: 0, end: 33, total: 66 } };
const toolSource = {
  kind: "turn_item" as const,
  threadId: scope.threadId,
  itemId: TurnItemId.make("release-tool"),
  digest: "a".repeat(64),
};
const summary: ConversationSummary = {
  id: `summary:${"b".repeat(64)}`,
  projectId: scope.projectId,
  threadId: scope.threadId,
  sources: [firstSource, ref("second"), toolSource],
  statements: [
    {
      text: "The user wants releases signed.",
      citations: [firstSource, ref("second"), toolSource].map(conversationSummarySourceKey),
    },
  ],
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  createdAt: "2026-10-22T00:00:00.000Z",
};

const configFor = (searchSupported: boolean) => ({
  environment: {
    capabilities: {
      conversationSummaries: true,
      projectSettingsOverrides: true,
      ...(searchSupported ? { conversationSummarySourceFormat: 2 as const } : {}),
    },
  },
  settings: DEFAULT_SERVER_SETTINGS,
});

function setup() {
  const registry = AtomRegistry.make();
  state.lists = [];
  const config = Atom.make(configFor(true));
  state.config = config;
  const list: ConversationSummaryList = {
    enabled: false,
    lastPass: {
      runId: RunId.make("run"),
      result: "failed",
      reason: "No model",
      generated: 0,
      waitingMessages: 3,
      at: summary.createdAt,
    },
    summaries: [
      { state: "available", summary },
      {
        state: "stale",
        id: `summary:${"c".repeat(64)}`,
        sourceCount: 12,
        createdAt: summary.createdAt,
        reason: "changed",
      },
    ],
    nextCursor: `summary:${"c".repeat(64)}`,
  };
  state.list = Atom.make(AsyncResult.success(list));
  const expansion: ConversationSummaryExpansion = {
    summary: {
      state: "stale",
      id: summary.id,
      sourceCount: summary.sources.length,
      createdAt: summary.createdAt,
      reason: "deleted",
    },
    sources: [
      {
        ref: firstSource,
        result: {
          state: "available",
          source: firstSource,
          text: "Please sign every release bundle.",
          title: "Thread",
          role: "user",
          createdAt: summary.createdAt,
          archived: false,
        },
      },
      { ref: ref("second"), result: { state: "unavailable", reason: "deleted" } },
      {
        ref: toolSource,
        result: {
          state: "available",
          source: toolSource,
          text: "Release signature verified.",
          title: "Verification",
          role: "tool",
          createdAt: summary.createdAt,
          archived: false,
        },
      },
    ],
    nextOffset: null,
  };
  state.expand = Atom.make(AsyncResult.success(expansion));
  state.updateSettings.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  return { registry, config };
}

it("shows current summaries with their sources, hides outdated text, and opts the project in", async () => {
  const { registry, config } = setup();
  await using _screen = await render(
    <RegistryContext.Provider value={registry}>
      <ConversationSummariesDialog {...scope} open onOpenChange={vi.fn()} />
    </RegistryContext.Provider>,
  );

  await expect.element(page.getByText(/The user wants releases signed\./)).toBeVisible();
  await expect.element(page.getByText("[#1, #2, #3]")).toBeVisible();
  await expect
    .element(page.getByText("Last pass failed. No model 3 older sources wait for a summary."))
    .toBeVisible();
  await expect.element(page.getByText(/Outdated: source changed\./)).toBeVisible();

  await userEvent.click(page.getByRole("button", { name: "Show sources" }).first());
  await expect.element(page.getByText("Please sign every release bundle.")).toBeVisible();
  await expect.element(page.getByText("Source deleted.")).toBeVisible();
  await expect.element(page.getByText("#3 · Tool")).toBeVisible();
  await expect.element(page.getByText("Release signature verified.")).toBeVisible();
  await expect.element(page.getByText(/The user wants releases signed\./)).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "Hide sources" }));
  await expect.element(page.getByText(/The user wants releases signed\./)).not.toBeInTheDocument();

  await userEvent.click(page.getByRole("switch", { name: "Summarize older messages" }));
  expect(state.updateSettings).toHaveBeenCalledWith({
    environmentId: scope.environmentId,
    input: {
      patch: {
        projectSettingsOverrides: { [scope.projectId]: { enableConversationSummaries: true } },
      },
    },
  });

  await userEvent.click(page.getByRole("button", { name: "Later", exact: true }));
  expect(state.lists.at(-1)?.input.cursor).toBe(`summary:${"c".repeat(64)}`);
  await userEvent.fill(page.getByRole("textbox", { name: "Search summaries" }), "signed");
  await userEvent.click(page.getByRole("button", { name: "Search", exact: true }));
  expect(state.lists.at(-1)?.input).toEqual({
    projectId: scope.projectId,
    threadId: scope.threadId,
    limit: 20,
    query: "signed",
  });
  await userEvent.click(page.getByRole("button", { name: "Clear", exact: true }));
  expect(state.lists.at(-1)?.input.query).toBeUndefined();
  await userEvent.fill(page.getByRole("textbox", { name: "Search summaries" }), "bundle");
  await userEvent.click(page.getByRole("button", { name: "Search", exact: true }));
  registry.set(config, configFor(false));
  await expect.element(page.getByText("Update this server to search summaries.")).toBeVisible();
  await expect
    .element(page.getByRole("textbox", { name: "Search summaries" }))
    .not.toBeInTheDocument();
  expect(state.lists.at(-1)?.input.query).toBeUndefined();
  expect(state.lists.at(-1)?.input.cursor).toBeUndefined();
});
