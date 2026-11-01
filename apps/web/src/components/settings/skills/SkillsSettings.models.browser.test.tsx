import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type SkillModelCell,
  type SkillReviewDetail,
  type SkillReviewListItem,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../../test/render";

const environmentId = EnvironmentId.make("skills-model-picker");
const driver = ProviderDriverKind.make("codex");

const cell = (model: string): SkillModelCell => ({
  driver,
  model,
  delivery: "developer-context",
  gating: "instruction",
  effectiveMode: "base",
  ruleId: null,
  verdict: {
    verdict: "not-enough-data",
    reason: "no-evaluations",
    effect: null,
    ciLow: null,
    ciHigh: null,
    pAdjusted: null,
    nTasks: 0,
  },
  observational: {
    turns: 0,
    activationRate: null,
    completionRate: null,
    completionCiLow: null,
    completionCiHigh: null,
    revertRate: null,
    revertCiLow: null,
    revertCiHigh: null,
    toolFailureRate: null,
    medianTokens: null,
    medianDurationMs: null,
    confounded: true,
  },
});

const baseCell = cell("model-base");
const listItem: SkillReviewListItem = {
  skillName: "review",
  description: "Review changes",
  providers: [driver],
  cells: [baseCell],
};
const detail = (models: ReadonlyArray<{ readonly model: string }>): SkillReviewDetail => ({
  skillName: "review",
  description: "Review changes",
  providers: [driver],
  rules: [],
  revisions: [],
  tasks: [],
  runs: [],
  cells: [baseCell, ...models.map((model) => cell(model.model))],
});
const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-29T00:00:00.000Z",
  models: [
    { slug: "model-base", name: "Base", isCustom: false, capabilities: null },
    { slug: "model-a", name: "Model A", isCustom: false, capabilities: null },
    { slug: "model-b", name: "Model B", isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
};

vi.mock(import("../SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: "environment", label: "Skills server" },
    environment: {
      environmentId,
      label: "Skills server",
      serverConfig: { environment: { capabilities: { skills: true } } },
    },
  })) as never,
}));
vi.mock(import("../../../state/skills"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const command = { label: "test", permissionAtom: () => allowed };
  return {
    ...actual,
    skillEnvironment: {
      reviewList: (() => ({ kind: "list" })) as never,
      reviewDetail: ((request: unknown) => ({ kind: "detail", request })) as never,
      runDetail: (() => ({ kind: "run" })) as never,
      refreshReviewList: command,
      mutateVariant: command,
      mutateEvalTask: command,
      controlEvalRun: command,
    } as never,
  };
});
vi.mock(import("../../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((
    request: {
      readonly kind: string;
      readonly request?: {
        readonly input?: { readonly models?: ReadonlyArray<{ readonly model: string }> };
      };
    } | null,
  ) => ({
    data:
      request?.kind === "list"
        ? [listItem]
        : request?.kind === "detail"
          ? detail(request.request?.input?.models ?? [])
          : null,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  })) as never,
}));
vi.mock(import("../../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => vi.fn()) as never,
}));
vi.mock(import("../../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentProviders: (() => new Map([[environmentId, [provider]]])) as never,
}));
vi.mock(import("../../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => []) as never,
}));
vi.mock(import("../../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => DEFAULT_UNIFIED_SETTINGS) as never,
}));

import { SkillsSettings } from "./SkillsSettings";

it("can add, remove, and replace an extra review model", async () => {
  await using screen = await render(<SkillsSettings />);

  await userEvent.click(screen.getByLabelText("Add a model to review"));
  await userEvent.click(page.getByRole("option", { name: "Codex · Model A" }));
  await expect.element(screen.getByRole("button", { name: "Remove model-a" })).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "Remove model-a" }));
  await expect
    .element(screen.getByRole("button", { name: "Remove model-a" }))
    .not.toBeInTheDocument();

  await userEvent.click(screen.getByLabelText("Add a model to review"));
  await userEvent.click(page.getByRole("option", { name: "Codex · Model B" }));
  await expect.element(screen.getByRole("button", { name: "Remove model-b" })).toBeVisible();
});
