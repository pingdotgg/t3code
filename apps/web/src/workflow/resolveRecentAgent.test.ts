import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { resetAppAtomRegistryForTests } from "../rpc/atomRegistry";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type ThreadShell } from "../types";
import { useComposerDraftStore } from "../composerDraftStore";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { pickRecentAgent, resolveRecentAgent } from "./resolveRecentAgent";

const environmentId = EnvironmentId.make("environment-recent-agent");
const projectId = ProjectId.make("project-recent-agent");

const makeProvider = (input: {
  readonly instanceId: string;
  readonly driver?: string;
  readonly enabled?: boolean;
  readonly installed?: boolean;
  readonly availability?: "available" | "unavailable";
  readonly models?: ReadonlyArray<{ readonly slug: string; readonly isCustom?: boolean }>;
}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(input.instanceId),
  driver: ProviderDriverKind.make(input.driver ?? "codex"),
  enabled: input.enabled ?? true,
  installed: input.installed ?? true,
  version: "0.0.0-test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-06-07T00:00:00.000Z",
  availability: input.availability,
  models: (input.models ?? []).map((model) => ({
    slug: model.slug,
    name: model.slug,
    isCustom: model.isCustom ?? false,
    capabilities: {},
  })),
  slashCommands: [],
  skills: [],
});

const makeServerConfig = (providers: ReadonlyArray<ServerProvider>): ServerConfig => ({
  environment: {
    environmentId,
    label: "Recent agent test",
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "0.0.0-test",
    capabilities: { repositoryIdentity: true },
  },
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["browser-session-cookie", "bearer-access-token"],
    sessionCookieName: "t3_session",
  },
  cwd: "/tmp/recent-agent",
  keybindingsConfigPath: "/tmp/recent-agent/keybindings.json",
  keybindings: [],
  issues: [],
  providers,
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/tmp/recent-agent/logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
});

const makeShell = (input: {
  readonly id: string;
  readonly instanceId: string;
  readonly model: string;
  readonly createdAt: string;
  readonly updatedAt?: string;
}): ThreadShell => ({
  id: ThreadId.make(input.id),
  environmentId,
  projectId,
  title: input.id,
  modelSelection: {
    instanceId: ProviderInstanceId.make(input.instanceId),
    model: input.model,
  },
  runtimeMode: DEFAULT_RUNTIME_MODE,
  interactionMode: DEFAULT_INTERACTION_MODE,
  createdAt: input.createdAt,
  archivedAt: null,
  updatedAt: input.updatedAt ?? input.createdAt,
  branch: null,
  worktreePath: null,
  latestTurn: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  session: null,
});

beforeEach(() => {
  resetAppAtomRegistryForTests();
  useComposerDraftStore.setState({
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
});

describe("pickRecentAgent", () => {
  const avail = (id: string) => id === "codex" || id === "claude_main";

  it("prefers sticky when available", () => {
    expect(
      pickRecentAgent({
        sticky: { instance: "codex", model: "gpt-5.4" },
        recentThread: { instance: "claude_main", model: "sonnet" },
        defaultChoice: { instance: "claude_main", model: "sonnet" },
        isAvailable: avail,
      }),
    ).toEqual({ instance: "codex", model: "gpt-5.4" });
  });

  it("falls through unavailable sticky to recent thread", () => {
    expect(
      pickRecentAgent({
        sticky: { instance: "ghost", model: "x" },
        recentThread: { instance: "claude_main", model: "sonnet" },
        defaultChoice: null,
        isAvailable: avail,
      }),
    ).toEqual({ instance: "claude_main", model: "sonnet" });
  });

  it("returns null when nothing is available", () => {
    expect(
      pickRecentAgent({
        sticky: null,
        recentThread: null,
        defaultChoice: null,
        isAvailable: avail,
      }),
    ).toBeNull();
  });
});

describe("resolveRecentAgent", () => {
  it("uses thread shells for the most recent available agent before defaulting", () => {
    const providers = makeServerConfig([
      makeProvider({
        instanceId: "ghost",
        enabled: true,
        installed: true,
        availability: "unavailable",
        models: [{ slug: "ghost-model" }],
      }),
      makeProvider({
        instanceId: "claude_main",
        driver: "claudeAgent",
        models: [{ slug: "sonnet" }, { slug: "custom-claude", isCustom: true }],
      }),
    ]).providers;
    useComposerDraftStore.setState({
      stickyActiveProvider: ProviderInstanceId.make("ghost"),
      stickyModelSelectionByProvider: {
        [ProviderInstanceId.make("ghost")]: {
          instanceId: ProviderInstanceId.make("ghost"),
          model: "ghost-model",
        },
      },
    });
    const olderShell = makeShell({
      id: "thread-old",
      instanceId: "claude_main",
      model: "old-sonnet",
      createdAt: "2026-06-06T00:00:00.000Z",
    });
    const newerShell = makeShell({
      id: "thread-new",
      instanceId: "claude_main",
      model: "sonnet",
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-07T00:00:00.000Z",
    });

    expect(resolveRecentAgent(providers, [olderShell, newerShell])).toEqual({
      instance: "claude_main",
      model: "sonnet",
    });
  });
});
