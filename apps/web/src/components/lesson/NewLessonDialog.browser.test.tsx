import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ModelSelection,
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
    select(DEFAULT_UNIFIED_SETTINGS)) as never,
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: () => state.createLesson,
}));

import { lessonModelSelection, NewLessonDialogHost, openNewLesson } from "./NewLessonDialog";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-local");
const LESSON_MODEL = "claude-sonnet-5-5";
const DEFAULT_MODEL = "claude-opus-5-5";
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

function setup(remembered: ModelSelection | null = null) {
  vi.clearAllMocks();
  state.providers = new Map([
    [
      ENVIRONMENT_ID,
      [
        provider("claudeAgent", "claudeAgent", [LESSON_MODEL, DEFAULT_MODEL]),
        provider("claude-public-pool", "claudeAgent", [LESSON_MODEL]),
      ],
    ],
  ]);
  state.projects = new Map([
    [
      PROJECT_ID,
      {
        id: PROJECT_ID,
        title: "Project",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: DEFAULT_MODEL,
          options: [{ id: "effort", value: "ultracode" }],
        },
      },
    ],
  ]);
  state.configs = new Map([
    [
      ENVIRONMENT_ID,
      {
        settings: DEFAULT_SERVER_SETTINGS,
        environment: {
          capabilities: { lessonProjects: false },
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

async function startLesson() {
  openNewLesson({ projectRef: { environmentId: ENVIRONMENT_ID, projectId: PROJECT_ID } });
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

describe("NewLessonDialog", () => {
  it.each([
    ["prefers the public Claude pool", null, LESSON_SELECTION],
    ["uses a remembered lesson model", LESSON_SELECTION, LESSON_SELECTION],
    [
      "ignores a remembered model whose provider disappeared",
      { ...LESSON_SELECTION, instanceId: ProviderInstanceId.make("missing") },
      LESSON_SELECTION,
    ],
  ])("%s", async (_label, remembered, expectedModel) => {
    using _setup = setup(remembered);
    expect(
      lessonModelSelection(state.providers.get(ENVIRONMENT_ID) ?? [], remembered, null),
    ).toEqual(expectedModel);
    await startLesson();
    expect(state.createLesson).toHaveBeenCalledExactlyOnceWith({
      environmentId: ENVIRONMENT_ID,
      input: expect.objectContaining({
        modelSelection: expectedModel,
        runtimeMode: "auto",
        interactionMode: "default",
      }),
    });
  });
});
