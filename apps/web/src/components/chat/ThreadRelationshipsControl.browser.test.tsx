import {
  EnvironmentId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  projection: null as OrchestrationV2ThreadProjection | null,
  shells: [] as ReadonlyArray<OrchestrationV2ThreadShell>,
  providers: new Map<EnvironmentId, ReadonlyArray<ServerProvider>>(),
}));

// Workflow permission is unrelated to the model tooltip and must not start a connection.
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => false) as never,
}));
vi.mock(import("../../state/entities"), () => ({
  useThreadProjection: (() => ({ projection: state.projection })) as never,
  useThreadRelationshipShells: () => state.shells,
  useProjects: () => [],
}));
vi.mock(import("../../state/environments"), () => ({
  useEnvironmentProviders: () => state.providers,
}));
vi.mock(import("../../lib/archivedThreadsState"), () => ({
  useArchivedThreadSnapshots: () => ({
    snapshots: [],
    error: null,
    isLoading: false,
    refresh: () => undefined,
  }),
}));

import { render } from "../../../test/render";
import { makeThreadFixture, makeThreadProjectionFixture } from "../../test-fixtures";
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";

const environmentId = EnvironmentId.make("environment-test");
const childId = ThreadId.make("thread-child");
const codexId = ProviderInstanceId.make("codex");
const claudeId = ProviderInstanceId.make("claudeAgent");
const launchSelection = {
  instanceId: codexId,
  model: "gpt-6-astra",
  options: [{ id: "reasoningEffort", value: "high" }],
} satisfies ModelSelection;

function setup(
  origin: OrchestrationV2Subagent["origin"] = "app_owned",
  model: string | null = "gpt-6-astra",
  status: "running" | "completed" = "running",
) {
  const projection = makeThreadProjectionFixture();
  const child = makeThreadFixture({
    id: childId,
    title: "Audit sync",
    modelSelection: launchSelection,
    lineage: {
      parentThreadId: projection.thread.id,
      relationshipToParent: "subagent",
      rootThreadId: projection.thread.id,
    },
  }).source;
  state.projection = {
    ...projection,
    subagents: [
      {
        id: NodeId.make("agent"),
        threadId: projection.thread.id,
        runId: null,
        parentNodeId: NodeId.make("parent"),
        origin,
        createdBy: "agent",
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: codexId,
        providerThreadId: null,
        childThreadId: childId,
        nativeTaskRef: null,
        prompt: "Audit sync",
        title: "Audit sync",
        model,
        ...(model === null ? {} : { modelSelection: { ...launchSelection, model } }),
        status,
        result: null,
        startedAt: projection.thread.createdAt,
        completedAt: status === "completed" ? projection.updatedAt : null,
        updatedAt: projection.updatedAt,
      },
    ],
  };
  state.shells = [{ ...child, status: "running", activityRunStatus: "running" }];
  state.providers = new Map([
    [
      environmentId,
      [
        provider(codexId, "codex", ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"]),
        provider(claudeId, "claudeAgent", ["claude-opus-5-5"]),
      ],
    ],
  ]);
  return projection.thread.id;
}

function provider(
  instanceId: ProviderInstanceId,
  driver: string,
  models: ReadonlyArray<string>,
): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make(driver),
    displayName: instanceId,
    accentColor: "#445566",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: {} })),
    slashCommands: [],
    skills: [],
  };
}

it.each([
  {
    instanceId: codexId,
    model: "gpt-6.1-sol",
    options: [{ id: "reasoningEffort", value: "xhigh" }],
  },
  { instanceId: claudeId, model: "claude-opus-5-5", options: [{ id: "effort", value: "max" }] },
] satisfies ReadonlyArray<ModelSelection>)(
  "Lineage follows a delegated child's model selection ($model)",
  async (selection) => {
    const threadId = setup("app_owned", "gpt-6-astra", "completed");
    await using screen = await render(
      <ThreadRelationshipsPanel environmentId={environmentId} threadId={threadId} />,
    );
    await screen.getByText("Audit sync", { exact: true }).hover();
    await expect.element(page.getByText("gpt-6-astra · codex", { exact: true })).toBeVisible();

    state.shells = state.shells.map((child) => ({
      ...child,
      providerInstanceId: selection.instanceId,
      modelSelection: selection,
    }));
    await screen.rerender(
      <ThreadRelationshipsPanel environmentId={environmentId} threadId={threadId} />,
    );

    await expect
      .element(page.getByText(`${selection.model} · ${selection.instanceId}`, { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByText("gpt-6-astra · codex", { exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByText(selection.options![0]!.value, { exact: false }))
      .toBeVisible();
  },
);

it.each(["gpt-6-luna", null])(
  "Lineage preserves a native child's reported model (%s)",
  async (model) => {
    const threadId = setup("provider_native", model);
    await using screen = await render(
      <ThreadRelationshipsPanel environmentId={environmentId} threadId={threadId} />,
    );
    await screen.getByText("Audit sync", { exact: true }).hover();
    await expect
      .element(page.getByText(`${model ?? "Not reported"} · codex`, { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByText("gpt-6-astra · codex", { exact: true }))
      .not.toBeInTheDocument();
  },
);
