import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";

const checkout = vi.hoisted(() => ({
  projectRoot: "",
  worktreePath: null as string | null,
  branches: [] as Array<{ name: string; worktreePath: string | null }>,
}));

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children, disabled }: { children: ReactNode; disabled: boolean }) => (
    <button disabled={disabled}>{children}</button>
  ),
  useWindowDimensions: () => ({ height: 800 }),
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../../components/ui/AndroidScreenHeader", () => ({ AndroidSheetHeader: () => null }));
vi.mock("../../../components/ui/SheetHeader", () => ({ SheetHeader: () => null }));
vi.mock("../../../components/ui/ScreenContent", () => ({
  ScreenContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  AppTextInput: () => null,
}));
vi.mock("./gitSheetComponents", () => ({ SheetActionButton: () => null }));
vi.mock("../../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({
    selectedThread: { environmentId: "environment-1", worktreePath: checkout.worktreePath },
    selectedThreadProject: { workspaceRoot: checkout.projectRoot },
  }),
}));
vi.mock("../../../state/use-thread-detail", () => ({
  useSelectedThreadWorktreePath: () => checkout.worktreePath,
}));
vi.mock("../../../state/use-selected-thread-git-state", () => ({
  useSelectedThreadGitState: () => ({
    selectedThreadBranches: checkout.branches,
    selectedThreadBranchesLoading: false,
    gitOperationLabel: null,
  }),
}));
vi.mock("../../../state/use-selected-thread-git-actions", () => ({
  useSelectedThreadGitActions: () => ({ canChangeThreadBranch: true }),
}));
vi.mock("../../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("../../../state/vcs", () => ({ vcsEnvironment: { status: () => null } }));

import { GitBranchesSheet } from "./GitBranchesSheet";

it("recognizes both the main checkout and a linked worktree as this thread's checkout", () => {
  const directory = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "branch-occupancy-")),
  );
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
      cwd: directory,
      encoding: "utf8",
      stdio: "pipe",
    });
  try {
    git("init", "--initial-branch=main");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    );
    const linked = NodePath.join(directory, "linked");
    git("worktree", "add", "-b", "feature/linked", linked);
    git("branch", "feature/available");
    checkout.projectRoot = directory;
    checkout.branches = git(
      "for-each-ref",
      "--format=%(refname:short)%00%(worktreepath)",
      "refs/heads",
    )
      .trimEnd()
      .split("\n")
      .map((line) => {
        const [name = "", worktreePath] = line.split("\0");
        return { name, worktreePath: worktreePath || null };
      });

    const rows = () => {
      const html = renderToStaticMarkup(
        <GitBranchesSheet
          route={{
            params: { environmentId: "environment-1", threadId: "thread-1" },
          }}
        />,
      );
      return [
        ...html.matchAll(/<button([^>]*)><span>(.*?)<\/span><span>(.*?)<\/span><\/button>/g),
      ].map(([, attributes, name, subtitle]) => ({
        name,
        subtitle,
        disabled: attributes?.includes("disabled"),
      }));
    };

    checkout.worktreePath = null;
    expect(rows()).toEqual([
      { name: "feature/available", subtitle: "Local branch", disabled: false },
      { name: "feature/linked", subtitle: "Checked out in another worktree", disabled: true },
      { name: "main", subtitle: "Checked out in this thread", disabled: false },
    ]);

    checkout.worktreePath = linked;
    expect(rows()).toEqual([
      { name: "feature/available", subtitle: "Local branch", disabled: false },
      { name: "feature/linked", subtitle: "Checked out in this thread", disabled: false },
      { name: "main", subtitle: "Checked out in another worktree", disabled: true },
    ]);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
