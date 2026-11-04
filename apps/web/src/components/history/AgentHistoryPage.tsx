import { continueAgentSession } from "@t3tools/client-runtime/state/agent-sessions";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import type {
  AgentSessionHistoryResult,
  AgentSessionPreviewInput,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { ArrowLeftIcon, RefreshCwIcon } from "lucide-react";
import { useContext, useEffect, useRef, useState } from "react";
import { agentSessions } from "../../state/agentSessions";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { environmentProjects, projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatEnvironmentQueryError } from "../../state/query";
import { cn, newProjectId } from "../../lib/utils";
import { RelativeTime } from "../RelativeTime";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { AppRouteModal, AppRouteModalClose } from "../AppRouteModal";

type Session = AgentSessionHistoryResult["sessions"][number];

export function AgentHistoryPage(props: { environmentId?: EnvironmentId; projectId?: ProjectId }) {
  const { environments } = useEnvironments();
  const primary = usePrimaryEnvironmentId();
  const [chosenEnvironment, setChosenEnvironment] = useState<EnvironmentId | null>(
    props.environmentId ?? null,
  );
  const environmentId = chosenEnvironment ?? primary ?? environments[0]?.environmentId;
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  return (
    <AppRouteModal label="Agent history">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b p-4 sm:px-6">
        <div className="flex w-full items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">Agent history</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Find a conversation. Pick up where you left off.
            </p>
          </div>
          <AppRouteModalClose />
        </div>
        <div className="w-full sm:w-48">
          <Select value={environmentId ?? null} onValueChange={setChosenEnvironment}>
            <SelectTrigger aria-label="Computer">
              <SelectValue placeholder="Choose a computer">
                {environment?.label ?? "Choose a computer"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {environments.map((entry) => (
                <SelectItem key={entry.environmentId} value={entry.environmentId}>
                  {entry.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </header>
      {environmentId === undefined ? (
        <p className="p-6 text-sm text-muted-foreground">
          Connect a computer to browse its agent history.
        </p>
      ) : (
        <HistoryBrowser
          key={environmentId}
          environmentId={environmentId}
          initialProjectId={environmentId === props.environmentId ? props.projectId : undefined}
          connected={environment?.connection.phase === "connected"}
          environmentLabel={environment?.label ?? "this computer"}
        />
      )}
    </AppRouteModal>
  );
}

function HistoryBrowser({
  environmentId,
  initialProjectId,
  connected,
  environmentLabel,
}: {
  environmentId: EnvironmentId;
  initialProjectId: ProjectId | undefined;
  connected: boolean;
  environmentLabel: string;
}) {
  const projects = useAtomValue(environmentProjects.environmentProjectsAtom(environmentId));
  const [chosenProject, setProjectId] = useState<string | null>(initialProjectId ?? null);
  const projectId = chosenProject ?? projects[0]?.id ?? "all";
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Session | null>(null);
  const [cursor, setCursor] = useState<AgentSessionHistoryResult["nextCursor"]>(null);
  const registry = useContext(RegistryContext);
  const project = projects.find((entry) => entry.id === projectId);
  const atom = agentSessions.history({
    environmentId,
    input: {
      query,
      ...(project === undefined ? {} : { workspaceRoot: project.workspaceRoot }),
      ...(cursor === null ? {} : { cursor }),
    },
  });
  const result = useAtomValue(atom);
  const data = AsyncResult.getOrElse(result, () => null);
  const sessions = data?.sessions ?? [];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-b p-4 sm:grid-cols-[minmax(0,1fr)_11rem_auto] sm:px-6">
        <div className="col-span-2 min-w-0 sm:col-span-1">
          <Input
            aria-label="Search sessions"
            placeholder="Search titles, projects and cached context…"
            value={query}
            maxLength={200}
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(null);
            }}
          />
        </div>
        <div className="min-w-0">
          <Select
            value={projectId}
            onValueChange={(value) => {
              setProjectId(value ?? "all");
              setCursor(null);
              setSelected(null);
            }}
          >
            <SelectTrigger aria-label="Project">
              <SelectValue>{project?.title ?? "All projects"}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="all">All projects</SelectItem>
              {projects.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <Button
          variant="outline"
          size="icon"
          aria-label="Refresh history"
          disabled={!connected || result.waiting}
          onClick={() => registry.refresh(atom)}
        >
          <RefreshCwIcon />
        </Button>
      </div>
      {!connected && (
        <p role="status" className="border-b px-6 py-3 text-sm text-muted-foreground">
          Offline · Cached history is read-only. Reconnect {environmentLabel} to continue.
        </p>
      )}
      {result._tag === "Failure" && (
        <p role="alert" className="px-6 py-3 text-sm text-destructive">
          {formatEnvironmentQueryError(result.cause)}
        </p>
      )}
      <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(16rem,0.85fr)_minmax(0,1.15fr)]">
        <section
          aria-label="Conversations"
          className={cn("overflow-y-auto p-3 md:border-r", selected !== null && "hidden md:block")}
        >
          <p className="mb-3 px-3 text-xs text-muted-foreground">
            Recent first
            {data && (
              <>
                {" "}
                · Checked <RelativeTime timestamp={data.scannedAt} />
              </>
            )}
          </p>
          {result._tag === "Initial" && <p className="p-3 text-sm">Reading session metadata…</p>}
          {data !== null && sessions.length === 0 && !data.nextCursor && (
            <p className="p-3 text-sm text-muted-foreground">
              No conversations found in this scope.
            </p>
          )}
          {sessions.map((session) => {
            const active =
              selected?.providerInstanceId === session.providerInstanceId &&
              selected?.providerSessionId === session.providerSessionId;
            return (
              <button
                key={`${session.providerInstanceId}:${session.providerSessionId}`}
                type="button"
                aria-pressed={active}
                onClick={() => setSelected(session)}
                className={cn(
                  "mb-1 block w-full rounded-lg p-4 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  active ? "bg-primary/20 text-foreground" : "hover:bg-accent",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <h2 className="min-w-0 break-words text-sm font-medium">{session.title}</h2>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    <RelativeTime timestamp={session.updatedAt} />
                  </span>
                </div>
                {(session.recap?.summary ?? session.recentExcerpt) && (
                  <p className="mt-2 line-clamp-2 text-sm leading-5 text-muted-foreground">
                    {session.recap?.summary ?? session.recentExcerpt}
                  </p>
                )}
                <p className="mt-2 truncate text-xs text-muted-foreground">
                  {session.workspaceRoot}
                </p>
                <div className="mt-3 flex justify-between text-xs text-muted-foreground">
                  <span>
                    {session.provider === "claudeAgent"
                      ? "Claude"
                      : session.provider === "codex"
                        ? "Codex"
                        : "Pi"}
                  </span>
                  <span>Session log</span>
                </div>
              </button>
            );
          })}
          <div className="mt-4 flex gap-2">
            {cursor !== null && (
              <Button variant="ghost" onClick={() => setCursor(null)}>
                Newest
              </Button>
            )}
            {data?.nextCursor && (
              <Button
                variant="outline"
                onClick={() => {
                  setCursor(data.nextCursor);
                  setSelected(null);
                }}
              >
                {data.truncated ? "Continue discovery" : "Older sessions"}
              </Button>
            )}
          </div>
          {data?.truncated && (
            <p className="mt-3 px-3 text-xs text-muted-foreground">
              Discovery is still in progress. Continue to find sessions beyond this scan.
            </p>
          )}
        </section>
        {selected === null ? (
          <p className="hidden p-8 text-sm text-muted-foreground md:block">
            Select a conversation to review its recent context.
          </p>
        ) : (
          <HistoryDetail
            key={`${selected.providerInstanceId}:${selected.providerSessionId}`}
            session={selected}
            environmentId={environmentId}
            connected={connected}
            environmentLabel={environmentLabel}
            onBack={() => setSelected(null)}
          />
        )}
      </div>
    </div>
  );
}

function HistoryDetail({
  session,
  environmentId,
  connected,
  environmentLabel,
  onBack,
}: {
  session: Session;
  environmentId: EnvironmentId;
  connected: boolean;
  environmentLabel: string;
  onBack: () => void;
}) {
  const input = {
    workspaceRoot: session.workspaceRoot,
    session: {
      providerInstanceId: session.providerInstanceId,
      providerSessionId: session.providerSessionId,
    },
  };
  const result = useAtomValue(agentSessions.preview({ environmentId, input }));
  const preview = AsyncResult.getOrElse(result, () => null);
  const projects = useAtomValue(environmentProjects.environmentProjectsAtom(environmentId));
  const canImport = useAtomValue(agentSessions.importSession.permissionAtom(environmentId));
  const importSession = useAtomCommand(agentSessions.importSession);
  const generateRecap = useAtomCommand(agentSessions.generateRecap);
  const canRecap = useAtomValue(agentSessions.generateRecap.permissionAtom(environmentId));
  const registry = useContext(RegistryContext);
  const [recapping, setRecapping] = useState(false);
  const createProject = useAtomCommand(projectEnvironment.create);
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const mounted = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Ignore async import completion after the selected conversation unmounts.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const requestRecap = async () => {
    setRecapping(true);
    setError(null);
    const generated = await generateRecap({ environmentId, input });
    if (!mounted.current) return;
    setRecapping(false);
    if (generated._tag !== "Success" || generated.value.status !== "ready") {
      setError("Could not generate a recap. The conversation may have changed; try again.");
      return;
    }
    registry.refresh(agentSessions.preview({ environmentId, input }));
  };
  const continueSession = async () => {
    setPending(true);
    setError(null);
    const continued = await continueAgentSession({
      environmentId,
      workspaceRoot: session.workspaceRoot,
      session: input.session,
      projects,
      newProjectId,
      isMounted: () => mounted.current,
      createProject,
      importSession,
    });
    if (!mounted.current || continued.status === "cancelled") return;
    setPending(false);
    if (continued.status === "project-error") {
      setError("Could not open the original project. Restore its folder and try again.");
      return;
    }
    if (continued.status === "import-error") {
      setError("Could not open this session. Refresh history and try again.");
      return;
    }
    await navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: continued.threadId },
    });
  };
  return (
    <section aria-label="Conversation details" className="min-w-0 overflow-y-auto p-5 sm:p-8">
      <div className="mb-5 md:hidden">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeftIcon />
          Back to history
        </Button>
      </div>
      <h2 className="break-words text-xl font-semibold">
        {preview?.status === "ready" ? preview.title : session.title}
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {session.providerInstanceId}
        {preview?.status === "ready" && preview.model ? ` · ${preview.model}` : ""} ·{" "}
        <RelativeTime timestamp={session.updatedAt} />
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-medium">Recent context</h3>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger openOnHover render={<Button variant="ghost" size="sm" />}>
            Recent messages
          </PopoverTrigger>
          <PopoverPopup width="lg" align="end">
            {open && (
              <RecentMessages environmentId={environmentId} input={input} connected={connected} />
            )}
          </PopoverPopup>
        </Popover>
      </div>
      <div className="mt-4 space-y-4 text-sm leading-6">
        {preview === null ? (
          <p className="text-muted-foreground">
            {result._tag === "Failure"
              ? "Preview unavailable. Reconnect and refresh to try again."
              : "Reading recent context…"}
          </p>
        ) : preview.status === "unavailable" ? (
          <p className="text-muted-foreground">
            Preview unavailable. You can still open a supported native session for review.
          </p>
        ) : preview.recap ? (
          <>
            <p>{preview.recap.summary}</p>
            {preview.recap.nextAction && (
              <p>
                <span className="font-medium">Next: </span>
                {preview.recap.nextAction}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Generated from the recent message excerpts.
            </p>
          </>
        ) : (
          preview.messages.slice(-2).map((message) => (
            <p key={message.id} className="whitespace-pre-wrap break-words">
              <span className="mr-2 text-muted-foreground">
                {message.role === "user" ? "You" : "Agent"}:
              </span>
              {message.text.slice(0, 500)}
              {message.text.length > 500 || message.truncated ? "…" : ""}
            </p>
          ))
        )}
      </div>
      {preview?.status === "ready" && !preview.recap && (
        <div className="mt-4">
          <Button
            variant="outline"
            size="sm"
            disabled={!connected || !canRecap || recapping}
            onClick={() => void requestRecap()}
          >
            {recapping ? "Writing recap…" : "Generate a short recap"}
          </Button>
          <p className="mt-2 text-xs text-muted-foreground">
            Uses your configured text-generation model.
          </p>
        </div>
      )}
      <div className="mt-8 border-t pt-6">
        <h3 className="text-sm font-medium">Continue on {environmentLabel}</h3>
        <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
          {session.workspaceRoot}
        </p>
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer text-muted-foreground">Session settings</summary>
          <p className="mt-2 break-all text-xs">
            Original provider profile: {session.providerInstanceId}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Provider and model can be changed in the thread composer.
          </p>
        </details>
        <p className="mt-6 text-sm text-muted-foreground">
          Activity unknown. Confirm that the external CLI has stopped before continuing.
        </p>
        <div className="mt-3">
          <Button
            variant={confirmed ? "secondary" : "outline"}
            size="sm"
            aria-pressed={confirmed}
            onClick={() => setConfirmed(!confirmed)}
          >
            {" "}
            {confirmed ? "CLI confirmed stopped" : "The CLI is stopped"}
          </Button>
        </div>
        <div className="mt-5 grid">
          <Button
            disabled={!connected || !canImport || !confirmed || pending}
            onClick={() => void continueSession()}
          >
            {pending ? "Opening…" : "Continue in T3"}
          </Button>
        </div>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          Opens for review. The agent resumes only when you send a message.
        </p>
        {error && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

function RecentMessages({
  environmentId,
  input,
  connected,
}: {
  environmentId: EnvironmentId;
  input: AgentSessionPreviewInput;
  connected: boolean;
}) {
  const [cursor, setCursor] = useState<AgentSessionPreviewInput["cursor"]>(undefined);
  const result = useAtomValue(
    (connected ? agentSessions.livePreview : agentSessions.preview)({
      environmentId,
      input: { ...input, ...(cursor === undefined ? {} : { cursor }) },
    }),
  );
  const preview = AsyncResult.getOrElse(result, () => null);
  return (
    <div className="h-96 max-h-[60dvh] space-y-4 overflow-y-auto text-sm">
      <h4 className="font-medium">{cursor ? "Earlier messages" : "Recent messages"}</h4>
      {preview?.status === "ready" ? (
        <>
          {preview.messages.length === 0 && preview.nextCursor?.scan && (
            <p className="text-muted-foreground">
              This history needs another reading step before its messages are ready.
            </p>
          )}
          {preview.messages.map((message) => (
            <div key={message.id}>
              <p className="mb-1 text-xs text-muted-foreground">
                {message.role === "user" ? "You" : "Agent"}
                {message.truncated ? " · Partial message" : ""}
              </p>
              <p className="whitespace-pre-wrap break-words leading-6">{message.text}</p>
            </div>
          ))}
          {preview.boundedWindow && (
            <p className="text-xs text-muted-foreground">
              History loads a few messages at a time. Native continuation uses the original session.
            </p>
          )}
          {preview.nextCursor && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCursor(preview.nextCursor ?? undefined)}
            >
              {preview.nextCursor.scan && preview.messages.length === 0
                ? "Continue reading history"
                : preview.nextCursor.textBefore === undefined
                  ? "Load older"
                  : "Load earlier text"}
            </Button>
          )}
        </>
      ) : (
        <p className="text-muted-foreground">
          {preview === null
            ? result._tag === "Failure"
              ? "No cached preview is available. Reconnect to read messages."
              : "Reading messages…"
            : preview.reason === "changed"
              ? "The transcript changed. Return to recent messages to refresh."
              : "Preview unavailable. Return to recent messages to try again."}
        </p>
      )}
      {cursor && (
        <Button variant="ghost" size="sm" onClick={() => setCursor(undefined)}>
          Back to recent
        </Button>
      )}
    </div>
  );
}
