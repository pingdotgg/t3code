import { EnvironmentId, ProjectId, ProviderDriverKind } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => false }));
vi.mock("~/state/entities", () => ({ useVisibleThreadShells: () => [] }));
vi.mock("~/state/environments", () => ({
  useEnvironmentIdentities: () => [],
  useEnvironmentMachines: () => new Map(),
}));
vi.mock("~/state/peerLinks", () => ({ offersLinkedEnvironmentsAtom: () => null }));
vi.mock("~/state/queries", () => ({
  useComposerPathSearch: () => ({ entries: [], isPending: false, searchedTarget: null }),
  useDebouncedValue: (value: unknown) => value,
  useThreadSearch: () => undefined,
}));
vi.mock("~/state/pullRequests", () => ({
  usePullRequestList: () => ({
    data: { entries: [], providers: [], errors: [] },
    isPending: false,
    error: null,
  }),
  pullRequestEnvironment: { detail: () => null },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: {
      provider: "azure-devops",
      projectId: "project",
      repository: "web",
      number: 7,
      title: "An older Azure review",
      url: "https://dev.azure.com/org-a/project/_git/web/pullrequest/7",
      headBranch: "feature",
      baseBranch: "main",
      state: "open",
      updatedAt: "2020-01-01T00:00:00.000Z",
    },
    isPending: false,
    error: null,
  }),
}));

import { render } from "../../../test/render";
import { useComposerMenuItems } from "./useComposerMenuItems";

function ExactNumberSuggestions() {
  const menu = useComposerMenuItems({
    composerTrigger: { kind: "pull-request", query: "7", rangeStart: 0, rangeEnd: 2 },
    environmentId: EnvironmentId.make("environment"),
    linkedEnvironments: new Map(),
    gitCwd: null,
    activeThreadId: null,
    pullRequestProjectId: ProjectId.make("project"),
    pullRequestRepository: "web",
    threadPullRequests: [],
    sideChatAvailable: false,
    sideChatDisabledReason: null,
    freshSessionAvailable: false,
    compactSlashCommandAvailable: false,
    selectedProvider: ProviderDriverKind.make("codex"),
    selectedProviderSkills: [],
    selectedProviderSlashCommands: [],
    showSkillsInSlashMenu: false,
    workspaceSkillsScanning: false,
    questionAttachmentTarget: null,
    modelMentions: { instanceEntries: [], modelOptionsByInstance: new Map() },
  });
  return menu.items.map((item) =>
    item.type === "pull-request" ? (
      <a key={item.id} href={item.pullRequest.url}>
        {item.pullRequest.title}
      </a>
    ) : null,
  );
}

it("offers an exact Azure review outside the recent list using the project's short repository", async () => {
  await using screen = await render(<ExactNumberSuggestions />);
  await expect
    .element(screen.getByRole("link", { name: "An older Azure review" }))
    .toHaveAttribute("href", "https://dev.azure.com/org-a/project/_git/web/pullrequest/7");
});
