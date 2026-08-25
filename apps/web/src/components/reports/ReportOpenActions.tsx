/**
 * "Open in editor" and "Open terminal" for a PostHog report: both prepare the
 * same report worktree (branch + `.posthog/report.md`) without creating a T3
 * thread, so the user can implement the report with their own tools.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  DEFAULT_TERMINAL_ID,
  ThreadId,
  type EnvironmentId,
  type PostHogReport,
  type PostHogReportArtefact,
} from "@t3tools/contracts";
import { renderReportPrompt } from "@t3tools/shared/posthogReportPrompt";
import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import { useOpenInPreferredEditor } from "../../editorPreferences";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import {
  primaryServerKeybindingsAtom,
  primaryServerSettingsAtom,
  serverEnvironment,
} from "../../state/server";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { TerminalViewport } from "../ThreadTerminalDrawer";
import { Button } from "../ui/button";

const REPORT_FILE_DIR = ".posthog";
const REPORT_FILE_PATH = `${REPORT_FILE_DIR}/report.md`;
const TERMINAL_HEIGHT = 320;

interface PreparedWorktree {
  readonly path: string;
  readonly branch: string;
}

export function ReportOpenActions({
  environmentId,
  report,
  artefacts,
  project,
  defaultBranch,
  branchName,
}: {
  readonly environmentId: EnvironmentId;
  readonly report: PostHogReport;
  readonly artefacts: ReadonlyArray<PostHogReportArtefact>;
  readonly project: EnvironmentProject | null;
  readonly defaultBranch: string | null;
  readonly branchName: string;
}) {
  const serverSettings = useAtomValue(primaryServerSettingsAtom);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const openInPreferredEditor = useOpenInPreferredEditor(
    environmentId,
    serverConfig?.availableEditors ?? [],
  );
  const createWorktree = useAtomCommand(vcsEnvironment.createWorktree, { reportFailure: false });
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const addInfoExclude = useAtomCommand(vcsEnvironment.addInfoExclude, { reportFailure: false });
  const openTerminal = useAtomCommand(terminalEnvironment.open, { reportFailure: false });

  // Local branches matching the report branch tell us whether a worktree already exists.
  const refsQuery = useEnvironmentQuery(
    project === null
      ? null
      : vcsEnvironment.listRefs({
          environmentId,
          input: { cwd: project.workspaceRoot, query: branchName, refKind: "local", limit: 10 },
        }),
  );
  const existingRef = refsQuery.data?.refs.find((ref) => ref.name === branchName) ?? null;

  const [prepared, setPrepared] = useState<PreparedWorktree | null>(null);
  const [busy, setBusy] = useState<"editor" | "terminal" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [focusRequestId, setFocusRequestId] = useState(0);

  const threadId = ThreadId.make(`posthog-report:${report.id}`);
  const threadRef = scopeThreadRef(environmentId, threadId);

  const prepare = async (): Promise<PreparedWorktree | null> => {
    if (!project || !defaultBranch) return null;
    let worktreePath = prepared?.path ?? existingRef?.worktreePath ?? null;
    if (worktreePath === null) {
      const created = await createWorktree({
        environmentId,
        input: existingRef
          ? { cwd: project.workspaceRoot, refName: branchName, path: null }
          : {
              cwd: project.workspaceRoot,
              refName: defaultBranch,
              newRefName: branchName,
              baseRefName: defaultBranch,
              path: null,
            },
      });
      if (created._tag === "Failure") {
        setError(String(created.cause));
        return null;
      }
      worktreePath = created.value.worktree.path;
    }
    const contents = renderReportPrompt(report, artefacts, {
      host: serverSettings.posthog.host,
      projectId: serverSettings.posthog.projectId,
    });
    const written = await writeFile({
      environmentId,
      input: { cwd: worktreePath, relativePath: REPORT_FILE_PATH, contents },
    });
    if (written._tag === "Failure") {
      setError(String(written.cause));
      return null;
    }
    const excluded = await addInfoExclude({
      environmentId,
      input: { cwd: worktreePath, pattern: `${REPORT_FILE_DIR}/` },
    });
    if (excluded._tag === "Failure") {
      setError(String(excluded.cause));
      return null;
    }
    const result = { path: worktreePath, branch: branchName };
    setPrepared(result);
    return result;
  };

  const run = async (kind: "editor" | "terminal") => {
    if (busy !== null) return;
    setBusy(kind);
    setError(null);
    const worktree = await prepare();
    if (worktree !== null) {
      if (kind === "editor") {
        const opened = await openInPreferredEditor(worktree.path);
        if (opened._tag === "Failure") setError(String(opened.cause));
      } else {
        const opened = await openTerminal({
          environmentId,
          input: {
            threadId,
            terminalId: DEFAULT_TERMINAL_ID,
            cwd: worktree.path,
            worktreePath: worktree.path,
          },
        });
        if (opened._tag === "Failure") {
          setError(String(opened.cause));
        } else {
          setTerminalOpen(true);
          setFocusRequestId((value) => value + 1);
        }
      }
    }
    setBusy(null);
  };

  const ready = project !== null && defaultBranch !== null && !refsQuery.isPending;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!ready || busy !== null}
          onClick={() => void run("editor")}
        >
          {busy === "editor" ? "Preparing…" : "Open in editor"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!ready || busy !== null}
          onClick={() => void run("terminal")}
        >
          {busy === "terminal" ? "Preparing…" : "Open terminal"}
        </Button>
      </div>
      {prepared ? (
        <p className="font-mono text-xs text-muted-foreground">
          {prepared.branch} · {prepared.path} · {REPORT_FILE_PATH}
        </p>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {terminalOpen && prepared ? (
        <div
          className="overflow-hidden rounded-md border border-border"
          style={{ height: `${TERMINAL_HEIGHT}px` }}
        >
          <TerminalViewport
            advancedTypography={advancedTypography}
            threadRef={threadRef}
            threadId={threadId}
            terminalId={DEFAULT_TERMINAL_ID}
            terminalLabel="Terminal"
            cwd={prepared.path}
            worktreePath={prepared.path}
            onSessionExited={() => setTerminalOpen(false)}
            onAddTerminalContext={() => {}}
            focusRequestId={focusRequestId}
            autoFocus
            resizeEpoch={0}
            drawerHeight={TERMINAL_HEIGHT}
            keybindings={keybindings}
          />
        </div>
      ) : null}
    </div>
  );
}
