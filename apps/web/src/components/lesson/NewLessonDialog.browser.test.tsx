import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ModelSelection,
  type RuntimeMode,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  providers: new Map<EnvironmentId, ReadonlyArray<ServerProvider>>(),
  projects: new Map<string, unknown>(),
  configs: new Map<EnvironmentId, ServerConfig>(),
  createLesson: vi.fn(),
}));

vi.mock(import("../../state/environments"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentProviders: () => state.providers,
}));
vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useProject: ((ref: { projectId: string } | null) =>
    ref === null ? null : (state.projects.get(ref.projectId) ?? null)) as never,
  useServerConfigs: (() => state.configs) as never,
}));
vi.mock(import("../../state/server"), async (importOriginal) => ({
  ...(await importOriginal()),
  serverEnvironment: { createLesson: {} } as never,
}));
vi.mock(import("../../hooks/useSettings"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentSettings: ((_environmentId: unknown, select: (value: unknown) => unknown) =>
    select({
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: { "claude-public-pool": { driver: "claudeAgent", enabled: true } },
    })) as never,
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: () => state.createLesson,
}));

import { NewLessonDialogHost, newLessonRequest, openNewLesson } from "./NewLessonDialog";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-local");
const LESSON_MODEL = "claude-sonnet-5-5";
const PROJECT_DEFAULT: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6.1-sol",
  options: [{ id: "reasoningEffort", value: "ultra" }],
};
const LESSON_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("claude-public-pool"),
  model: LESSON_MODEL,
  options: [{ id: "effort", value: "high" }],
};

function provider(
  instanceId: string,
  driver: string,
  models: ReadonlyArray<string>,
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: driver as ServerProvider["driver"],
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: models.map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: null,
    })),
    slashCommands: [],
    skills: [],
  };
}

function setup(
  remembered: ModelSelection | null,
  providers: ReadonlyArray<ServerProvider>,
  defaultRuntimeMode: RuntimeMode,
  lessonProjects = false,
) {
  vi.clearAllMocks();
  state.providers = new Map([[ENVIRONMENT_ID, providers]]);
  state.projects = new Map([
    [
      PROJECT_ID,
      {
        id: PROJECT_ID,
        title: "Project",
        defaultModelSelection: PROJECT_DEFAULT,
      },
    ],
  ]);
  state.configs = new Map([
    [
      ENVIRONMENT_ID,
      {
        settings: { ...DEFAULT_SERVER_SETTINGS, defaultRuntimeMode },
        environment: {
          capabilities: { lessonProjects },
        },
      } as ServerConfig,
    ],
  ]);
  state.createLesson.mockResolvedValue({
    _tag: "Success",
    value: { threadId: "lesson-1" },
  });
  const key = `ominax:lesson-model:${ENVIRONMENT_ID}`;
  localStorage.removeItem(key);
  if (remembered !== null) localStorage.setItem(key, JSON.stringify(remembered));
  return {
    [Symbol.dispose]() {
      localStorage.removeItem(key);
    },
  };
}

const PROJECT_REF = { environmentId: ENVIRONMENT_ID, projectId: PROJECT_ID };

async function startLesson(request = newLessonRequest(null, PROJECT_REF)) {
  openNewLesson(request!);
  await using screen = await render(<NewLessonDialogHost />);
  await userEvent.fill(
    page.getByLabelText("What do you want to learn?"),
    "How does a buck converter work?",
  );
  await act(() => {
    (page.getByRole("dialog").element().querySelector("form") as HTMLFormElement).requestSubmit();
  });
  return screen;
}

const codex = provider("codex", "codex", ["gpt-6.1-sol"]);
const claude = provider("claudeAgent", "claudeAgent", [LESSON_MODEL, "claude-opus-5-5"]);
const pool = provider("claude-public-pool", "claudeAgent", [LESSON_MODEL]);
const ALL = [codex, claude, pool];
const NO_RUNNABLE_CLAUDE = [
  codex,
  { ...claude, status: "error" as const },
  { ...pool, status: "error" as const },
];

describe("NewLessonDialog", () => {
  it.each([
    [
      "uses the default model when nothing is remembered",
      null,
      ALL,
      "full-access",
      PROJECT_DEFAULT,
      "auto",
    ],
    [
      "uses a remembered lesson model",
      LESSON_SELECTION,
      ALL,
      "full-access",
      LESSON_SELECTION,
      "auto",
    ],
    [
      "ignores a remembered model whose provider disappeared",
      { ...LESSON_SELECTION, instanceId: ProviderInstanceId.make("missing") },
      ALL,
      "full-access",
      PROJECT_DEFAULT,
      "auto",
    ],
    [
      "ignores a remembered model the provider no longer lists",
      { ...LESSON_SELECTION, model: "claude-retired-4" },
      ALL,
      "full-access",
      PROJECT_DEFAULT,
      "auto",
    ],
    [
      "ignores a remembered model on a provider that can't run",
      { ...LESSON_SELECTION, instanceId: ProviderInstanceId.make("claudeAgent") },
      NO_RUNNABLE_CLAUDE,
      "full-access",
      PROJECT_DEFAULT,
      "auto",
    ],
    [
      "keeps a stricter default access mode",
      null,
      ALL,
      "approval-required",
      PROJECT_DEFAULT,
      "approval-required",
    ],
  ] as const)(
    "%s",
    async (_label, remembered, providers, defaultRuntimeMode, expectedModel, expectedRuntime) => {
      using _setup = setup(remembered, providers, defaultRuntimeMode);
      await startLesson();
      expect(state.createLesson).toHaveBeenCalledExactlyOnceWith({
        environmentId: ENVIRONMENT_ID,
        input: expect.objectContaining({
          modelSelection: expectedModel,
          runtimeMode: expectedRuntime,
          interactionMode: "default",
        }),
      });
    },
  );

  it.each([
    ["opened from a project's thread or draft, starts in that project", PROJECT_REF, PROJECT_ID],
    ["opened with no project open, starts a new lesson project", null, undefined],
  ] as const)("%s", async (_label, open, expectedProjectId) => {
    using _setup = setup(null, ALL, "full-access", true);
    await startLesson(newLessonRequest(open, PROJECT_REF));
    expect(state.createLesson.mock.calls[0]?.[0].input.projectId).toBe(expectedProjectId);
  });
});
