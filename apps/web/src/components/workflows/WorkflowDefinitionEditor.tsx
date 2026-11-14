import { useAtomValue } from "@effect/atom-react";
import type { FileContents } from "@pierre/diffs";
import { Editor, type EditorFactory, type EditorOptions, type Marker } from "@pierre/diffs/edit";
import { EditProvider, File, Virtualizer } from "@pierre/diffs/react";
import { type EnvironmentId, type WorkflowDefinitionProblem } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { FileCode2Icon, PlusIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { useTheme } from "../../hooks/useTheme";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../../lib/syntaxHighlighting";
import { isMacPlatform } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { useEditableAfterHighlight } from "../files/useEditableAfterHighlight";
import { requestConfirmDialog } from "../../confirmDialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
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
              <span className="font-mono text-foreground">Line {problem.line}: </span>
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
  onDelete,
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
  /** Take the file away. Absent where that cannot be done. */
  readonly onDelete?: (() => void) | undefined;
}) {
  const { resolvedTheme } = useTheme();
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
  const [stale, setStale] = useState(false);
  const [shown, setShown] = useState(() => fileOf(path, draft ?? source, revision));
  const [edited, setEdited] = useState<string | null>(draft ?? null);
  const [problems, setProblems] = useState<ReadonlyArray<WorkflowDefinitionProblem>>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedOnce, setSavedOnce] = useState(false);
  const editorRef = useRef<DefinitionEditor | null>(null);
  const dirty = edited !== null && edited !== baseline;
  const adopt = () => {
    setBaseline(source);
    setShown(fileOf(path, source, revision));
    setEdited(null);
    setProblems([]);
    setStale(false);
  };
  if (source !== seen) {
    setSeen(source);
    // With nothing of the person's own in the editor, it follows the file.
    if (source !== baseline) {
      if (dirty) setStale(true);
      else adopt();
    }
  }
  const { ready: editable, onPostRender } = useEditableAfterHighlight(shown);

  const saveNow = async () => {
    if (!dirty || saving || !canSave || edited === null) return;
    setSaving(true);
    setFailure(null);
    const result = await save({ environmentId, input: { name, source: edited } });
    setSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) setFailure(String(squashAtomCommandFailure(result)));
      return;
    }
    setProblems(result.value.problems);
    if (result.value.problems.length > 0) return;
    setBaseline(edited);
    setStale(false);
    setSavedOnce(true);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const mac = isMacPlatform(navigator.platform);
    if (event.key.toLowerCase() !== "s" || !(mac ? event.metaKey : event.ctrlKey)) return;
    event.preventDefault();
    void saveNow();
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- warns before the tab closes on an unsaved draft, which only the browser's own event can do
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

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
  const status = saving
    ? "Checking…"
    : dirty
      ? "Unsaved changes"
      : savedOnce && problems.length === 0
        ? "Saved and running"
        : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <div className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-xs text-foreground">{path}</p>
          <p className="truncate text-xs text-muted-foreground">
            {canSave
              ? "Saving checks the file first. One that passes runs at once, without a restart."
              : "This connection can read the file but not change it."}
          </p>
        </div>
        {status === null ? null : (
          <span className="shrink-0 text-xs text-muted-foreground" role="status">
            {status}
          </span>
        )}
        {canSave && onDelete !== undefined ? (
          <Button size="sm" variant="ghost" disabled={saving} onClick={onDelete}>
            Delete
          </Button>
        ) : null}
        {canSave ? (
          <Button size="sm" disabled={!dirty || saving} onClick={() => void saveNow()}>
            Save
          </Button>
        ) : null}
      </div>
      {stale ? (
        <div role="status" className="flex shrink-0 items-center gap-3 border-b px-4 py-2 text-xs">
          <span className="min-w-0 flex-1 text-muted-foreground">
            The file changed on disk while you were editing. Saving replaces that change.
          </span>
          <Button size="xs" variant="outline" onClick={adopt}>
            Load the file and drop my changes
          </Button>
        </div>
      ) : null}
      {onDisk.length > 0 && problems.length === 0 ? (
        <ProblemList
          title="The file on disk does not load. The last version that did keeps running."
          problems={onDisk}
        />
      ) : null}
      {problems.length > 0 ? (
        <ProblemList title="Not saved. Nothing changed on the server." problems={problems} />
      ) : null}
      {failure === null ? null : (
        <ProblemList title="Could not save" problems={[{ message: failure }]} />
      )}
      <EditProvider createEditor={createEditor}>
        <Virtualizer
          className="min-h-0 flex-1 overflow-auto"
          config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
        >
          <File
            file={shown}
            edit={editable && canSave}
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
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly file: string | null;
  readonly onOpen: (file: string | null) => void;
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
  const [naming, setNaming] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<ReadonlyArray<WorkflowDefinitionProblem>>([]);
  if (query.error) {
    return <WorkflowsEmpty title="Could not read the workflow files" description={query.error} />;
  }
  if (!query.data) {
    return (
      <p className="p-6 text-sm text-muted-foreground" role="status">
        Loading the workflow files…
      </p>
    );
  }
  const { directory, single, files, problems, revision } = query.data;
  const begin = () => {
    const wanted = (naming ?? "").trim();
    if (wanted === "") return;
    setNaming(null);
    onOpen(/\.(ts|mts|js|mjs)$/.test(wanted) ? wanted : `${wanted}.ts`);
  };
  const removeFile = async (target: string) => {
    const confirmed = await (requestConfirmDialog(
      `Delete ${target}? The workflows it defines can no longer be started.`,
      { variant: "destructive" },
    ) ?? Promise.resolve(false));
    if (!confirmed) return;
    const result = await remove({ environmentId, input: { name: target } });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setRefusal([{ message: String(squashAtomCommandFailure(result)) }]);
      }
      return;
    }
    setRefusal(result.value.problems);
    if (result.value.problems.length === 0) onOpen(null);
  };
  const between =
    problems.length + refusal.length === 0 ? null : (
      <ProblemList
        title={
          refusal.length > 0
            ? "Not deleted. Nothing changed on the server."
            : "These files do not fit together. What ran before keeps running."
        }
        problems={refusal.length > 0 ? refusal : problems}
      />
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
            onDelete={single || shown === null ? undefined : () => void removeFile(file)}
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
              Every file in <code className="font-mono text-foreground">{directory}</code> defines
              workflows. A change to one is picked up without a restart.
            </p>
            {single || !canChange ? null : naming === null ? (
              <Button size="sm" variant="outline" onClick={() => setNaming("")}>
                <PlusIcon />
                New file
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
                  aria-label="File name"
                  placeholder="release.ts"
                  value={naming}
                  onChange={(event) => setNaming(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setNaming(null);
                  }}
                />
                <Button size="sm" type="submit" variant="outline">
                  Create
                </Button>
              </form>
            )}
          </div>
          {files.length === 0 ? (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              No workflows yet. Make the first file here, or ask an agent to write one in that
              folder.
            </p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {files.map((candidate) => (
                <li key={candidate.name}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-start hover:bg-accent/50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    onClick={() => onOpen(candidate.name)}
                  >
                    <FileCode2Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-sm">{candidate.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {candidate.workflows.length === 0
                          ? "Defines no workflows"
                          : candidate.workflows.map((tag) => tag.replace(/@\d+$/, "")).join(", ")}
                      </span>
                    </span>
                    {candidate.problems.length > 0 ? (
                      <span className="shrink-0 text-xs font-medium text-destructive-foreground">
                        Does not load
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
