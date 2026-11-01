import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import {
  EnvironmentId,
  ProviderInstanceId,
  type BundledSkillsCatalog,
  type ManageBundledSkillInput,
} from "@t3tools/contracts";
import { render } from "../../../test/render";
import "~/index.css";

const state = vi.hoisted(() => ({
  catalog: null as BundledSkillsCatalog | null,
  allowed: true,
  manage: vi.fn(),
  refreshProviders: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      bundledSkills: (() => "skills") as never,
      manageBundledSkill: Object.assign(state.manage, {
        permissionAtom: () => Atom.make(state.allowed),
      }) as never,
      refreshProviders: state.refreshProviders as never,
    },
  };
});
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: state.catalog,
    error: null,
    isPending: false,
    refresh: state.refresh,
  })) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));

import { EnvironmentSkillsSettings } from "./SkillsSettingsPanel";

const environmentId = EnvironmentId.make("remote-device");
function setup() {
  state.allowed = true;
  state.refresh.mockReset();
  state.refreshProviders.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  state.catalog = {
    targets: [
      {
        instanceId: ProviderInstanceId.make("codex"),
        label: "Codex",
        directory: "/home/user/.codex/skills",
        skills: [
          {
            id: "t3code-threads",
            title: "Threads & worktrees",
            description: "Create threads and managed worktrees.",
            status: "not_installed",
            path: "/home/user/.codex/skills/t3code-threads",
            fingerprint: "absent",
          },
        ],
      },
      {
        instanceId: ProviderInstanceId.make("claude"),
        label: "Claude",
        directory: "/home/user/.claude/skills",
        skills: [
          {
            id: "t3code-orchestration",
            title: "Orchestration",
            description: "Coordinate background agents.",
            status: "update_available",
            path: "/home/user/.claude/skills/t3code-orchestration",
            fingerprint: "old",
          },
        ],
      },
    ],
  };
  state.manage
    .mockReset()
    .mockImplementation(async ({ input }: { input: ManageBundledSkillInput }) => {
      const target = state.catalog!.targets.find(
        (target) => target.instanceId === input.instanceId,
      )!;
      const skill = target.skills.find((skill) => skill.id === input.skillId)!;
      const updated = {
        ...skill,
        status: input.action === "remove" ? ("not_installed" as const) : ("installed" as const),
        fingerprint: input.action === "remove" ? "absent" : "installed",
      };
      state.catalog = {
        targets: state.catalog!.targets.map((entry) =>
          entry !== target ? entry : { ...entry, skills: [updated] },
        ),
      };
      return { _tag: "Success", value: updated };
    });
}

it("installs and removes a skill through a confirmation without changing providers", async () => {
  setup();
  await using screen = await render(<EnvironmentSkillsSettings environmentId={environmentId} />);
  await page.getByRole("button", { name: "Install Threads & worktrees" }).click();
  await expect.element(page.getByText("Up to date", { exact: true })).toBeVisible();
  await expect
    .element(
      page.getByText(
        "Threads & worktrees installed. Restart the agent session to apply the change.",
        { exact: true },
      ),
    )
    .toBeVisible();
  await page.getByRole("button", { name: "Remove Threads & worktrees" }).click();
  await expect.element(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.element(page.getByText("Up to date", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove Threads & worktrees" }).click();
  await page.getByRole("button", { name: "Remove skill", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Install Threads & worktrees" }))
    .toBeVisible();
  expect(state.manage.mock.calls.map(([request]) => request.environmentId)).toEqual([
    environmentId,
    environmentId,
  ]);
  await expect
    .element(screen.getByText("/home/user/.codex/skills/t3code-threads", { exact: true }))
    .toBeVisible();
});

it("updates the selected provider and leaves another provider's skill uninstalled", async () => {
  setup();
  await using screen = await render(<EnvironmentSkillsSettings environmentId={environmentId} />);
  await page.getByRole("combobox", { name: "Skill provider" }).click();
  await page.getByRole("option", { name: "Claude", exact: true }).click();
  await expect.element(page.getByText("Update available", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Update Orchestration" }).click();
  await expect.element(page.getByText("Up to date", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByText("/home/user/.claude/skills/t3code-orchestration", { exact: true }))
    .toBeVisible();
  expect(state.catalog!.targets[0]!.skills[0]!.status).toBe("not_installed");
});

it("keeps external connection requirements visible after installing instructions", async () => {
  setup();
  const target = state.catalog!.targets[0]!;
  const requirements =
    "Requires a Linear MCP connection. Installing this skill does not connect your account.";
  state.catalog = {
    targets: [
      {
        ...target,
        skills: [
          {
            ...target.skills[0]!,
            id: "t3code-linear",
            title: "Linear",
            description: "Read issues and report verified PR results to Linear.",
            path: "/home/user/.codex/skills/t3code-linear",
            requirements,
          },
        ],
      },
    ],
  };
  await using screen = await render(<EnvironmentSkillsSettings environmentId={environmentId} />);
  await expect.element(screen.getByText(requirements, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Install Linear" }).click();
  await expect.element(page.getByText("Up to date", { exact: true })).toBeVisible();
  await expect.element(screen.getByText(requirements, { exact: true })).toBeVisible();
});

it("keeps a removal confirmation bound to its provider when the catalog changes", async () => {
  setup();
  const original = state.catalog!.targets[0]!;
  state.catalog = {
    targets: [{ ...original, skills: [{ ...original.skills[0]!, status: "installed" }] }],
  };
  await using screen = await render(<EnvironmentSkillsSettings environmentId={environmentId} />);
  await page.getByRole("button", { name: "Remove Threads & worktrees" }).click();
  const codex = state.catalog!.targets[0]!;
  state.catalog = {
    targets: [{ ...codex, instanceId: ProviderInstanceId.make("claude"), label: "Claude" }, codex],
  };
  await screen.rerender(<EnvironmentSkillsSettings environmentId={environmentId} />);
  await page.getByRole("button", { name: "Remove skill", exact: true }).click();
  await expect.element(page.getByText("Up to date", { exact: true })).toBeVisible();
  expect(state.catalog!.targets[0]!.skills[0]!.status).toBe("installed");
  expect(state.catalog!.targets[1]!.skills[0]!.status).toBe("not_installed");
});

it("preserves local edits and disables installation without settings permission", async () => {
  setup();
  state.allowed = false;
  await using screen = await render(<EnvironmentSkillsSettings environmentId={environmentId} />);
  await expect
    .element(page.getByRole("button", { name: "Install Threads & worktrees" }))
    .toBeDisabled();
  state.catalog = {
    targets: [
      {
        ...state.catalog!.targets[0]!,
        skills: [{ ...state.catalog!.targets[0]!.skills[0]!, status: "modified" }],
      },
    ],
  };
  await screen.rerender(<EnvironmentSkillsSettings environmentId={environmentId} />);
  await expect.element(page.getByText("Locally modified", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Your files are preserved.", { exact: false })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Remove Threads & worktrees" }))
    .not.toBeInTheDocument();
  expect(state.manage).not.toHaveBeenCalled();
});
