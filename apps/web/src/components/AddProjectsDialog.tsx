import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { getAddProjectInitialQuery } from "@t3tools/client-runtime/operations/projects";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  PROJECT_DISCOVERY_ROOTS_LIMIT,
  type AgentSessionScanResult,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { T, useGT, useMessages, Var } from "gt-react";
import { useRef, useState, type ReactNode } from "react";
import { create } from "zustand";

import { m } from "../i18n/messages";
import { useProjectScans } from "../onboarding/useProjectScans";
import type { WelcomeImportSelection } from "../onboarding/welcomeState";
import { repositoryDiscovery } from "../state/agentSessions";
import { useEnvironments } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";
import {
  ImportCandidateList,
  useImportSourcesLabel,
  useProjectImport,
  type ProjectImportScan,
} from "./onboarding/ProjectImport";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { ScrollArea } from "./ui/scroll-area";
import { Textarea } from "./ui/textarea";
import { toastManager } from "./ui/toast";

type AddProjectsSource = "history" | "disk";

interface AddProjectsRequest {
  readonly environmentId: EnvironmentId;
  readonly source: AddProjectsSource;
}

const useRequest = create<{ request: AddProjectsRequest | null; session: number }>(() => ({
  request: null,
  session: 0,
}));

/** Opens the list that adds several projects at once, from agent history or folders on disk. */
export function openAddProjectsDialog(request: AddProjectsRequest) {
  useRequest.setState((state) => ({ request, session: state.session + 1 }));
}

function close() {
  useRequest.setState({ request: null });
}

export function AddProjectsDialogHost() {
  const request = useRequest((state) => state.request);
  const session = useRequest((state) => state.session);
  if (request === null) return null;
  return request.source === "history" ? (
    <HistoryProjectsDialog key={session} environmentId={request.environmentId} />
  ) : (
    <DiskProjectsDialog key={session} environmentId={request.environmentId} />
  );
}

function useEnvironmentLabel(environmentId: EnvironmentId) {
  const gt = useGT();
  const { environments } = useEnvironments();
  return (
    environments.find((environment) => environment.environmentId === environmentId)?.label ??
    gt("this computer")
  );
}

function HistoryProjectsDialog({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const label = useEnvironmentLabel(environmentId);
  const sources = useImportSourcesLabel();
  const scan = useProjectScans([environmentId])[0]!;
  return (
    <AddProjectsDialogFrame
      scan={scan}
      importHistory
      title={gt("Import from agent history")}
      description={
        <T>
          Projects your <Var>{sources}</Var> sessions ran in on <Var>{label}</Var>, with their
          recent threads.
        </T>
      }
      status={
        scan.isPending && scan.data === null
          ? gt("Looking for projects…")
          : scan.error !== null
            ? gt("Could not check projects. {error}", { error: scan.error })
            : null
      }
      truncated={scan.data?.truncated === true}
    />
  );
}

function DiskProjectsDialog({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const label = useEnvironmentLabel(environmentId);
  const { environments } = useEnvironments();
  const serverConfig = environments.find(
    (environment) => environment.environmentId === environmentId,
  )?.serverConfig;
  const baseDirectory = serverConfig?.settings.addProjectBaseDirectory.trim() ?? "";
  // The folder Add project browses from, then where New project creates projects.
  const suggestedFolders = [
    ...new Set([
      ...(baseDirectory.length > 0 ? [getAddProjectInitialQuery(baseDirectory)] : []),
      ...(serverConfig?.newProjectsRoot === undefined ? [] : [serverConfig.newProjectsRoot]),
    ]),
  ].join("\n");
  const canDiscover = useAtomValue(repositoryDiscovery.permissionAtom(environmentId));
  const discover = useAtomCommand(repositoryDiscovery, { reportFailure: false });
  const [folders, setFolders] = useState(suggestedFolders);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AgentSessionScanResult | null>(null);
  const roots = [
    ...new Set(
      folders
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
  const search = async () => {
    setSearching(true);
    setError(null);
    const outcome = await discover({ environmentId, input: { roots } });
    setSearching(false);
    if (outcome._tag === "Success") {
      setResult(outcome.value);
      return;
    }
    setError(
      thrownErrorMessage(squashAtomCommandFailure(outcome), m) ??
        gt("Could not look for repositories."),
    );
  };
  const scan: ProjectImportScan = {
    environmentId,
    // Projects already here have nothing left to add.
    data:
      result === null
        ? null
        : { candidates: result.candidates.filter((candidate) => !candidate.alreadyImported) },
    refresh: () => void search(),
  };
  const tooMany = roots.length > PROJECT_DISCOVERY_ROOTS_LIMIT;
  return (
    <AddProjectsDialogFrame
      scan={scan}
      importHistory={false}
      title={gt("Find Git repositories")}
      description={
        <T>
          Looks for Git repositories in folders on <Var>{label}</Var>. To add a folder without Git,
          use Local folder.
        </T>
      }
      header={
        <div className="flex flex-col gap-2">
          <Textarea
            aria-label={gt("Folders to search, one per line")}
            placeholder={gt("One folder per line, like ~/code")}
            value={folders}
            rows={3}
            onChange={(event) => setFolders(event.currentTarget.value)}
          />
          <div className="flex items-center justify-between gap-3 text-muted-foreground text-xs">
            <span>
              {tooMany
                ? gt("Search at most {count} folders at once.", {
                    count: PROJECT_DISCOVERY_ROOTS_LIMIT,
                  })
                : canDiscover
                  ? gt("Searches 4 levels deep and skips hidden and dependency folders.")
                  : gt("This connection cannot read folders on {environment}.", {
                      environment: label,
                    })}
            </span>
            <Button
              size="xs"
              variant="outline"
              disabled={!canDiscover || searching || roots.length === 0 || tooMany}
              onClick={() => void search()}
            >
              {searching ? gt("Searching…") : gt("Search")}
            </Button>
          </div>
        </div>
      }
      status={
        error ??
        (result !== null && scan.data?.candidates.length === 0
          ? gt("No new Git repositories found.")
          : null)
      }
      truncated={result?.truncated === true}
    />
  );
}

function AddProjectsDialogFrame({
  scan,
  importHistory,
  title,
  description,
  header,
  status,
  truncated,
}: {
  readonly scan: ProjectImportScan;
  readonly importHistory: boolean;
  readonly title: string;
  readonly description: ReactNode;
  readonly header?: ReactNode;
  readonly status: string | null;
  readonly truncated: boolean;
}) {
  const gt = useGT();
  const messages = useMessages();
  const [importSelection, setImportSelection] = useState<WelcomeImportSelection | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const holdPageRef = useRef(false);
  const projectImport = useProjectImport({
    scans: [scan],
    importSelection,
    onImportSelectionChange: setImportSelection,
    isImporting,
    setIsImporting,
    holdPageRef,
    importHistory,
    onDone: async (_landing, importWarning, importedThreadCount = 0) => {
      close();
      if (importWarning) {
        toastManager.add({
          type: "warning",
          title: importHistory ? gt("Some history was not imported") : importWarning,
          ...(importHistory ? { description: importWarning } : {}),
          timeout: 0,
        });
      } else if (importedThreadCount > 0) {
        toastManager.add({
          type: "success",
          title: gt(
            "{count, plural, one {Imported {count} thread} other {Imported {count} threads}}",
            { count: importedThreadCount },
          ),
        });
      }
      return true;
    },
  });
  const { candidates, selected, selectedKeys, setSelectedKeys, canWrite, visibleImportError } =
    projectImport;
  const newCount = selected.filter(projectImport.isNew).length;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isImporting) close();
      }}
    >
      <DialogPopup className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            {header}
            {candidates.length > 0 ? (
              <fieldset className="min-w-0" disabled={isImporting || !canWrite}>
                <div className="flex items-center justify-between gap-3 px-2 text-muted-foreground text-xs">
                  <span role="status">
                    {gt(
                      "{selected, plural, one {{selected} of {total} selected} other {{selected} of {total} selected}}",
                      { selected: selected.length, total: candidates.length },
                    )}
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={selected.length === candidates.length}
                      onClick={() => setSelectedKeys(new Set(candidates.map((c) => c.key)))}
                    >
                      <T>Select all</T>
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={selected.length === 0}
                      onClick={() => setSelectedKeys(new Set())}
                    >
                      <T>Select none</T>
                    </Button>
                  </div>
                </div>
                <ScrollArea scrollFade className="mt-1 h-auto max-h-80">
                  <div className="space-y-0.5 pr-3">
                    <ImportCandidateList
                      candidates={candidates}
                      selectedKeys={selectedKeys}
                      onSelectionChange={setSelectedKeys}
                    />
                  </div>
                </ScrollArea>
              </fieldset>
            ) : null}
            {status !== null ? (
              <p className="text-muted-foreground text-sm" role="status">
                {status}
              </p>
            ) : null}
            {truncated ? (
              <p className="text-muted-foreground text-xs" role="status">
                {gt("Search limit reached. Some projects may be missing.")}
              </p>
            ) : null}
            {visibleImportError ? (
              <p className="text-destructive text-sm">{messages(visibleImportError)}</p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={isImporting} onClick={close}>
            <T>Cancel</T>
          </Button>
          <Button
            disabled={!canWrite || isImporting || selected.length === 0}
            onClick={() => void projectImport.runImport(selected)}
          >
            {isImporting
              ? gt("Adding…")
              : newCount > 0
                ? gt("{count, plural, one {Add {count} project} other {Add {count} projects}}", {
                    count: newCount,
                  })
                : importHistory
                  ? gt("Import threads")
                  : gt("Add", { $context: "button, adds the selected projects" })}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
