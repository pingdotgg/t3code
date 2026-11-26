import { useAtomValue } from "@effect/atom-react";
import type { FileContents } from "@pierre/diffs";
import { Editor, type EditorFactory, type EditorOptions, type Marker } from "@pierre/diffs/edit";
import { EditProvider, File, Virtualizer } from "@pierre/diffs/react";
import { type EnvironmentId, type WorkflowDefinitionProblem } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useBlocker } from "@tanstack/react-router";
import { T, useGT, Var } from "gt-react";
import { FileCode2Icon, PlusIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { requestConfirmDialog } from "../../confirmDialog";
import { useTheme } from "../../hooks/useTheme";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../../lib/syntaxHighlighting";
import { isMacPlatform } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { useEditableAfterHighlight } from "../files/useEditableAfterHighlight";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { type DiskChange, diskChange, staleAfterSave } from "./WorkflowDefinitionEditor.logic";
import { WorkflowsEmpty } from "./WorkflowRunsView";

type DefinitionEditor = Editor<"file", undefined, undefined>;
const createEditor: EditorFactory<undefined, undefined> = (editorType, options, editStateKey) =>
  new Editor(editorType, options, editStateKey);

const fileOf = (path: string, contents: string, revision: number): FileContents => ({
  name: path,
  contents,
  cacheKey: `workflow-definition:${path}:${revision}:${contents.length}`,
});

/** A problem that names a line, as a squiggle under that line. */
const markersOf = (problems: ReadonlyArray<WorkflowDefinitionProblem>): Array<Marker> =>
  problems.flatMap((problem) =>
    problem.line === undefined
      ? []
      : [
          {
            start: { line: problem.line - 1, character: 0 },
            end: { line: problem.line - 1, character: Number.MAX_SAFE_INTEGER },
            severity: "error" as const,
            message: problem.message,
            source: "workflows",
          },
        ],
  );

function ProblemList({
  title,
  problems,
}: {
  readonly title: string;
  readonly problems: ReadonlyArray<WorkflowDefinitionProblem>;
}) {
  return (
    <div role="alert" className="shrink-0 border-b bg-destructive/4 px-4 py-2 text-xs">
      <p className="font-medium text-destructive-foreground">{title}</p>
      <ul className="mt-1 max-h-32 space-y-1 overflow-auto text-muted-foreground">
        {problems.map((problem) => (
          <li key={`${problem.line}:${problem.message}`} className="whitespace-pre-wrap">
            {problem.line === undefined ? null : (
              <span className="font-mono text-foreground">
                <T>
                  Line <Var>{problem.line}</Var>:
                </T>{" "}
              </span>
            )}
            {problem.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Surface({
  environmentId,
  name,
  path,
  source,
  revision,
  onDisk,
  draft,
  offline,
  onDelete,
  onClose,
  actions,
}: {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly path: string;
  readonly source: string;
  readonly revision: number;
  /** Why the file on disk is not what runs, when it is not. */
  readonly onDisk: ReadonlyArray<WorkflowDefinitionProblem>;
  /** What a file that is not on disk yet starts as. */
  readonly draft?: string;
  /** The environment is away: the draft stays, and nothing is sent until it is back. */
  readonly offline: boolean;
  /** Take the file away, saying whether it went. Absent where that cannot be done. */
  readonly onDelete?: (() => Promise<boolean>) | undefined;
  /** Leave the file for the list. */
  readonly onClose: () => void;
  /** Where in the page's header the file's status and its actions go. */
  readonly actions: HTMLElement | null;
}) {
  const { resolvedTheme } = useTheme();
  const gt = useGT();
  const canSave = useAtomValue(
    serverEnvironment.saveWorkflowDefinition.permissionAtom(environmentId),
  );
  const save = useAtomCommand(serverEnvironment.saveWorkflowDefinition, {
    label: "workflow definition save",
  });
  // What the draft started from. The file on disk moving past it is someone else's edit.
  const [baseline, setBaseline] = useState(source);
  // The file as this editor last took note of it, so only a real change on disk is acted on: after
  // a save, `source` is still the old text until the server's answer is read again.
  const [seen, setSeen] = useState(source);
  // The disk text that changed under the person's edits, until they settle it.
  const [staleAt, setStaleAt] = useState<DiskChange | null>(null);
  const stale = staleAt !== null;
  const [shown, setShown] = useState(() => fileOf(path, draft ?? source, revision));
  const [edited, setEdited] = useState<string | null>(draft ?? null);
  const [problems, setProblems] = useState<ReadonlyArray<WorkflowDefinitionProblem>>([]);
  // The last save wrote the file, so its problems are why it does not run, not why it was refused.
  const [written, setWritten] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // The text a save in flight is writing, so its own echo from disk is told from a real change.
  const [savingText, setSavingText] = useState<string | null>(null);
  const saving = savingText !== null;
  const [savedOnce, setSavedOnce] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Set once the file is deleted, so leaving it does not ask about a draft of a file that is gone.
  const released = useRef(false);
  const [seenRevision, setSeenRevision] = useState(revision);
  const editorRef = useRef<DefinitionEditor | null>(null);
  const dirty = edited !== null && edited !== baseline;
  const adopt = () => {
    setBaseline(source);
    setShown(fileOf(path, source, revision));
    setEdited(null);
    setProblems([]);
    setStaleAt(null);
  };
  if (source !== seen) {
    setSeen(source);
    // With nothing of the person's own in the editor, it follows the file.
    const change = diskChange({ source, baseline, dirty, saving: savingText });
    if (change === "stale") setStaleAt({ source });
    else if (change === "follow") adopt();
  }
  // Why a saved file did not run is old news once the server loads it cleanly.
  if (revision !== seenRevision) {
    setSeenRevision(revision);
    if (written && onDisk.length === 0) setProblems([]);
  }
  const { ready: editable, onPostRender } = useEditableAfterHighlight(shown);

  const saveNow = async () => {
    if (!dirty || saving || deleting || offline || !canSave || edited === null) return;
    // Saving over a change on disk that was already shown is a choice. One that lands while this
    // save is out is not, and stays shown.
    const overwrote = staleAt;
    setSavingText(edited);
    setFailure(null);
    const result = await save({ environmentId, input: { name, source: edited } });
    setSavingText(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) setFailure(String(squashAtomCommandFailure(result)));
      return;
    }
    setProblems(result.value.problems);
    setWritten(result.value.changed);
    if (!result.value.changed) return;
    setBaseline(edited);
    setStaleAt((now) => staleAfterSave(now, overwrote));
    setSavedOnce(true);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const mac = isMacPlatform(navigator.platform);
    if (event.key.toLowerCase() !== "s" || !(mac ? event.metaKey : event.ctrlKey)) return;
    event.preventDefault();
    void saveNow();
  };
  const deleteNow = async () => {
    if (onDelete === undefined || deleting || saving) return;
    // Busy from the dialog on, so a save cannot slip in while it asks.
    setDeleting(true);
    const gone = await onDelete();
    setDeleting(false);
    if (!gone) return;
    released.current = true;
    onClose();
  };
  // Leaving with an unsaved draft, by a link in the app or by closing the tab, asks first.
  useBlocker({
    shouldBlockFn: async () =>
      dirty &&
      !released.current &&
      !(await (requestConfirmDialog(
        gt("Leave without saving? Your changes to this file are lost."),
        {
          variant: "destructive",
        },
      ) ?? Promise.resolve(false))),
    enableBeforeUnload: () => dirty && !released.current,
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the editor draws markers itself and takes them only through its own method
  useEffect(() => {
    editorRef.current?.setMarkers(markersOf(problems));
  }, [problems]);

  const editorOptions: EditorOptions<"file", undefined, undefined> = {
    onAttach: (editor) => {
      editorRef.current = editor;
      editor.setMarkers(markersOf(problems));
    },
    onComplete: () => {
      editorRef.current = null;
    },
  };
  const status = offline
    ? gt("Not connected")
    : saving
      ? gt("Checking…")
      : dirty
        ? gt("Unsaved changes")
        : savedOnce && problems.length === 0
          ? gt("Saved and running")
          : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      {actions === null
        ? null
        : createPortal(
            <>
              <span className="shrink-0 text-xs text-muted-foreground" role="status">
                {canSave || offline ? status : gt("Read-only")}
              </span>
              {canSave && onDelete !== undefined ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={saving || deleting || offline}
                  onClick={() => void deleteNow()}
                >
                  <T context="verb, delete the workflow file">Delete</T>
                </Button>
              ) : null}
              {canSave ? (
                <Button
                  size="sm"
                  disabled={!dirty || saving || deleting || offline}
                  onClick={() => void saveNow()}
                >
                  <T context="verb, save the workflow file">Save</T>
                </Button>
              ) : null}
            </>,
            actions,
          )}
      {stale ? (
        <div role="status" className="flex shrink-0 items-center gap-3 border-b px-4 py-2 text-xs">
          <span className="min-w-0 flex-1 text-muted-foreground">
            <T>The file changed on disk while you were editing. Saving replaces that change.</T>
          </span>
          <Button size="xs" variant="outline" disabled={saving} onClick={adopt}>
            <T>Load the file and drop my changes</T>
          </Button>
        </div>
      ) : null}
      {onDisk.length > 0 && problems.length === 0 ? (
        <ProblemList
          title={gt("The file on disk does not load. The last version that did keeps running.")}
          problems={onDisk}
        />
      ) : null}
      {problems.length > 0 ? (
        <ProblemList
          title={
            written
              ? gt("Saved, but it does not run yet.")
              : gt("Not saved. Nothing changed on the server.")
          }
          problems={problems}
        />
      ) : null}
      {failure === null ? null : (
        <ProblemList title={gt("Could not save")} problems={[{ message: failure }]} />
      )}
      <EditProvider createEditor={createEditor}>
        <Virtualizer
          className="min-h-0 flex-1 overflow-auto"
          config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
        >
          <File
            file={shown}
            // A draft stays editable while the permission is briefly unknown, so it is not lost.
            edit={editable && (canSave || dirty)}
            editorOptions={editorOptions}
            onEditChange={({ file }) => setEdited(file.contents)}
            options={{
              disableFileHeader: true,
              overflow: "scroll",
              theme: resolveDiffThemeName(resolvedTheme),
              preferredHighlighter: PREFERRED_HIGHLIGHTER,
              themeType: resolvedTheme,
              onPostRender: (_container, instance, phase) => onPostRender(instance.file, phase),
            }}
            className="min-h-full"
          />
        </Virtualizer>
      </EditProvider>
    </div>
  );
}

const NEW_FILE = `const { workflow, step, agent, ask, stop } = T3;

workflow(
  "my-workflow",
  { version: 1, payload: Schema.Struct({}) },
  Effect.fn(function* () {
    // yield* agent("first", { project: "/path/to/project", brief: "What to do." });
  }),
);
`;

/**
 * The files that define this server's workflows: the list of them, or `file` in an editor. A
 * `file` the folder does not have yet is a new one, which exists once it is saved.
 */
export default function WorkflowDefinitionEditor({
  environmentId,
  file,
  away,
  onOpen,
  actions,
}: {
  readonly environmentId: EnvironmentId;
  readonly file: string | null;
  /** The environment's name while it is not connected. */
  readonly away: string | null;
  readonly onOpen: (file: string | null) => void;
  readonly actions: HTMLElement | null;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.workflowDefinition({ environmentId, input: {} }),
  );
  const canChange = useAtomValue(
    serverEnvironment.saveWorkflowDefinition.permissionAtom(environmentId),
  );
  const remove = useAtomCommand(serverEnvironment.deleteWorkflowDefinition, {
    label: "workflow definition delete",
  });
  const gt = useGT();
  const [naming, setNaming] = useState<string | null>(null);
  // What the last delete said, on the page it belongs to: the file, or the list once it is gone.
  const [refusal, setRefusal] = useState<{
    readonly at: string | null;
    readonly problems: ReadonlyArray<WorkflowDefinitionProblem>;
    readonly deleted: boolean;
  } | null>(null);
  // Data already read stays on screen through a failed refresh or a dropped connection.
  if (!query.data) {
    if (away !== null) {
      return (
        <WorkflowsEmpty
          title={gt("{name} is not connected", { name: away })}
          description={gt(
            "Its workflows show again when it reconnects. Pick another environment to see its runs.",
          )}
        />
      );
    }
    if (query.error) {
      return (
        <WorkflowsEmpty title={gt("Could not read the workflow files")} description={query.error} />
      );
    }
    return (
      <p className="p-6 text-sm text-muted-foreground" role="status">
        <T>Loading the workflow files…</T>
      </p>
    );
  }
  const { directory, single, files, problems, revision } = query.data;
  const open = (next: string | null) => {
    setRefusal(null);
    onOpen(next);
  };
  const begin = () => {
    const wanted = (naming ?? "").trim();
    if (wanted === "") return;
    setNaming(null);
    open(/\.(ts|mts|js|mjs)$/.test(wanted) ? wanted : `${wanted}.ts`);
  };
  const removeFile = async (target: string) => {
    const confirmed = await (requestConfirmDialog(
      gt("Delete {file}? The workflows it defines can no longer be started.", { file: target }),
      { variant: "destructive" },
    ) ?? Promise.resolve(false));
    if (!confirmed) return false;
    const result = await remove({ environmentId, input: { name: target } });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setRefusal({
          at: target,
          problems: [{ message: String(squashAtomCommandFailure(result)) }],
          deleted: false,
        });
      }
      return false;
    }
    const { changed } = result.value;
    setRefusal(
      result.value.problems.length === 0
        ? null
        : { at: changed ? null : target, problems: result.value.problems, deleted: changed },
    );
    return changed;
  };
  const refused = refusal !== null && refusal.at === file ? refusal : null;
  const between = (
    <>
      {away === null ? null : (
        <div role="status" className="shrink-0 border-b px-4 py-2 text-xs text-muted-foreground">
          {gt("{name} is not connected. What you write here stays, and saves once it is back.", {
            name: away,
          })}
        </div>
      )}
      {query.error === null || away !== null ? null : (
        <ProblemList
          title={gt("Could not read the workflow files")}
          problems={[{ message: query.error }]}
        />
      )}
      {problems.length === 0 && refused === null ? null : (
        <ProblemList
          title={
            refused !== null
              ? refused.deleted
                ? gt("Deleted, but what runs has not caught up yet.")
                : gt("Not deleted. Nothing changed on the server.")
              : gt("These files do not fit together. What ran before keeps running.")
          }
          problems={refused !== null ? refused.problems : problems}
        />
      )}
    </>
  );

  if (file !== null) {
    const shown = files.find((candidate) => candidate.name === file) ?? null;
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {between}
        <DiffWorkerPoolProvider>
          <Surface
            key={file}
            environmentId={environmentId}
            name={file}
            path={`${directory}/${file}`}
            source={shown?.source ?? ""}
            revision={revision}
            onDisk={shown?.problems ?? []}
            {...(shown === null ? { draft: NEW_FILE } : {})}
            offline={away !== null}
            onDelete={single || shown === null ? undefined : () => removeFile(file)}
            onClose={() => onOpen(null)}
            actions={actions}
          />
        </DiffWorkerPoolProvider>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {between}
      <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-3xl space-y-3 p-4 sm:p-6">
          <div className="flex items-start gap-3">
            <p className="min-w-0 flex-1 text-xs text-muted-foreground">
              <T>
                Every file in{" "}
                <code className="font-mono text-foreground">
                  <Var>{directory}</Var>
                </code>{" "}
                defines workflows. A change to one is picked up without a restart.
              </T>
            </p>
            {single || !canChange ? null : naming === null ? (
              <Button size="sm" variant="outline" onClick={() => setNaming("")}>
                <PlusIcon />
                <T>New file</T>
              </Button>
            ) : (
              <form
                className="flex shrink-0 items-center gap-1"
                onSubmit={(event) => {
                  event.preventDefault();
                  begin();
                }}
              >
                <Input
                  autoFocus
                  size="sm"
                  aria-label={gt("File name")}
                  placeholder="release.ts"
                  value={naming}
                  onChange={(event) => setNaming(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setNaming(null);
                  }}
                />
                <Button size="sm" type="submit" variant="outline">
                  <T context="verb, create the workflow file">Create</T>
                </Button>
              </form>
            )}
          </div>
          {files.length === 0 ? (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              <T>
                No workflows yet. Make the first file here, or ask an agent to write one in that
                folder.
              </T>
            </p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {files.map((candidate) => (
                <li key={candidate.name}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-start hover:bg-accent/50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    onClick={() => open(candidate.name)}
                  >
                    <FileCode2Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-sm">{candidate.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {candidate.workflows.length === 0
                          ? gt("Defines no workflows")
                          : candidate.workflows.map((tag) => tag.replace(/@\d+$/, "")).join(", ")}
                      </span>
                    </span>
                    {candidate.problems.length > 0 ? (
                      <span className="shrink-0 text-xs font-medium text-destructive-foreground">
                        <T>Does not load</T>
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
