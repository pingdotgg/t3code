// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type McpGatewayProfile,
} from "@t3tools/contracts";
import { useComposerDraftStore } from "../../composerDraftStore";

const state = vi.hoisted(() => ({
  environments: [] as unknown[],
  projects: [] as unknown[],
  createThread: vi.fn(async () => ({})),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({ _tag: "Success", value: {} }) }));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: state.environments }),
}));
vi.mock("../../state/entities", () => ({ useProjects: () => state.projects }));
vi.mock("@t3tools/client-runtime/gateway", () => ({
  createGatewayRuntimePortFromContext: () => ({ createThread: state.createThread }),
  resolveGatewayProfileModelSelection: () => ({ instanceId: "codex", model: "gpt-5" }),
}));
vi.mock("../../lib/composerDraftUploads", () => ({ releaseComposerDraftUploads: vi.fn() }));
vi.mock("../ChatView", () => ({ default: () => <div>Standard composer</div> }));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => children,
  DialogPopup: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));
import { AgentTaskDialog } from "./AgentTaskDialog";
const profile: McpGatewayProfile = {
  profileId: "agent",
  name: "Agent",
  revision: 1,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
};
const mac = EnvironmentId.make("mac");
const windows = EnvironmentId.make("windows");
const t3code = ProjectId.make("t3code");
const buildthings = ProjectId.make("buildthings");
const makeProject = (environmentId: EnvironmentId, id: ProjectId, title: string) => ({
  environmentId,
  id,
  title,
  workspaceRoot: `/projects/${environmentId}/${title}`,
});
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const onClose = vi.fn();
const render = () =>
  act(async () => {
    root.render(<AgentTaskDialog profile={profile} onClose={onClose} />);
  });
const select = async (index: number, value: string) =>
  act(async () => {
    const element = container.querySelectorAll("select")[index]!;
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
const submit = () =>
  act(async () => {
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Create empty chat")!
      .click();
  });
beforeEach(() => {
  vi.clearAllMocks();
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  state.environments = [mac, windows].map((environmentId) => ({
    environmentId,
    label: environmentId,
    connection: { phase: "connected" },
    serverConfig: { providers: [], environment: { capabilities: { agentThreadBootstrap: true } } },
  }));
  state.projects = [
    makeProject(mac, buildthings, "buildthings"),
    makeProject(windows, t3code, "windows-only"),
    makeProject(mac, t3code, "t3code"),
  ];
});
afterEach(async () => {
  await act(async () => root.render(null));
});
describe("Agents new chat workspace", () => {
  it("keeps disconnected machines visible and prevents submission if the selected machine disconnects", async () => {
    await render();
    await select(0, mac);
    await select(1, t3code);
    state.environments = [
      { environmentId: mac, label: "MacBook", connection: { phase: "offline" } },
    ];
    await render();
    const option = container.querySelectorAll("select")[0]!.options[1]!;
    expect(option.text).toContain("MacBook — Not connected");
    expect(option.disabled).toBe(true);
    expect(container.textContent).toContain("Settings → Connections");
    await submit();
    expect(state.createThread).not.toHaveBeenCalled();
  });
  it("only lists the chosen machine's projects and sends the explicit project despite updates", async () => {
    await render();
    await select(0, mac);
    expect(
      Array.from(container.querySelectorAll("select")[1]!.options).map((option) => option.text),
    ).toEqual(["Select project", "buildthings", "t3code"]);
    await select(1, t3code);
    state.projects = state.projects.toReversed();
    await render();
    expect(container.textContent).toContain("/projects/mac/t3code");
    await submit();
    expect(state.createThread).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: mac, projectId: t3code }),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("requires a fresh project choice after switching machines", async () => {
    await render();
    await select(0, mac);
    await select(1, t3code);
    await select(0, windows);
    await submit();
    expect(state.createThread).not.toHaveBeenCalled();
    expect(container.querySelectorAll("select")[1]!.value).toBe("");
    await select(1, t3code);
    await submit();
    expect(state.createThread).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: windows, projectId: t3code }),
    );
  });
  it("does not send an agent draft through an older server that would discard its profile", async () => {
    state.environments = [
      {
        environmentId: mac,
        label: "mac",
        connection: { phase: "connected" },
        serverConfig: { providers: [], environment: { capabilities: {} } },
      },
    ];
    await render();
    await select(0, mac);
    await select(1, t3code);
    expect(container.textContent).not.toContain("Standard composer");
    expect(container.textContent).toContain("Update this machine");
    await submit();
    expect(state.createThread).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: mac, projectId: t3code }),
    );
  });
  it("does not fall back when the selected project disappears", async () => {
    await render();
    await select(0, mac);
    await select(1, t3code);
    state.projects = [makeProject(mac, buildthings, "buildthings")];
    await render();
    await submit();
    expect(state.createThread).not.toHaveBeenCalled();
    expect(container.querySelectorAll("select")[1]!.value).toBe("");
  });
});
