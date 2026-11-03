import { Atom } from "effect/reactivity";
import { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { useComposerMenuItems } from "./useComposerMenuItems";

vi.mock("~/state/entities", () => ({ useVisibleThreadShells: () => [] }));
vi.mock("~/state/environments", () => ({
  useEnvironmentIdentities: () => [],
  useEnvironmentMachines: () => new Map(),
}));
vi.mock("~/state/peerLinks", () => ({ offersLinkedEnvironmentsAtom: () => Atom.make(false) }));
vi.mock("~/state/pullRequests", () => ({
  pullRequestEnvironment: () => undefined,
  usePullRequestList: () => ({ data: undefined, isPending: false, error: null }),
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({ data: undefined, isPending: false }),
}));
vi.mock("~/state/queries", () => ({
  useComposerPathSearch: () => ({ data: undefined, isPending: false }),
  useDebouncedValue: (value: unknown) => value,
  useThreadSearch: () => {},
}));

function Menu({ showSkills, query }: { showSkills: boolean; query: string }) {
  const { items } = useComposerMenuItems({
    composerTrigger: { kind: "slash-command", query, rangeStart: 0, rangeEnd: query.length + 1 },
    environmentId: EnvironmentId.make("test"),
    linkedEnvironments: new Map(),
    gitCwd: null,
    activeThreadId: null,
    pullRequestProjectId: null,
    pullRequestRepository: null,
    threadPullRequests: undefined,
    planModeUiEnabled: false,
    sideChatAvailable: false,
    sideChatDisabledReason: null,
    compactSlashCommandAvailable: true,
    selectedProvider: ProviderDriverKind.make("claudeAgent"),
    selectedProviderSkills: [
      { name: "pstack:bro", path: "/plugins/pstack/skills/bro/SKILL.md", enabled: true },
    ],
    selectedProviderSlashCommands: [{ name: "pstack:bro" }, { name: "compact" }],
    showSkillsInSlashMenu: showSkills,
    workspaceSkillsScanning: false,
    questionAttachmentTarget: null,
  });
  return <output>{JSON.stringify(items.map((item) => item.label))}</output>;
}

it("hides skill-backed commands when skills are off and restores one skill row when on", async () => {
  await using screen = await render(<Menu showSkills={false} query="" />);
  const commands = ["/model", "/compact"];
  await expect.element(screen.getByRole("status")).toHaveTextContent(JSON.stringify(commands));

  await screen.rerender(<Menu showSkills query="" />);
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent(JSON.stringify([...commands, "/skill:pstack:bro"]));

  await screen.rerender(<Menu showSkills={false} query="" />);
  await expect.element(screen.getByRole("status")).toHaveTextContent(JSON.stringify(commands));
});
