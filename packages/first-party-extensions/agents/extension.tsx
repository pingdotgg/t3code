import {
  agentSessionsApi,
  orchestrationControlApi,
  orchestrationLogsApi,
  orchestrationStatusApi,
  terminalControlApi,
  uiNavigationApi,
  uiThemeApi,
  workspaceFilesApi,
  type AgentSessionSummary,
  type AgentSessionsScanResult,
  type AgentLogTail,
  type ApprovalDecision,
  type OrchestrationCapabilities,
  type OrchestrationControlMethods,
  type PendingApproval,
  type PendingUserInput,
  type RuntimeSubagent,
  type VcsDiffPreviewStreamEvent,
} from "@t3tools/extension-sdk/catalogue";
import {
  defineExtension,
  requireApi,
  useApiRead,
  type ApiReadState,
} from "@t3tools/extension-sdk/authoring";
import { bindApi, bindStreamApi } from "@t3tools/extension-sdk/capabilities";
import type { ClientHost } from "@t3tools/extension-sdk/environment";
import type { ViewSession } from "@t3tools/extension-sdk/host";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  AGENT_LOG_TAIL_REQUEST,
  DEFERRED_SECTIONS,
  EMPTY_AGENTS_FEED,
  HOST_CHROME_NOTE,
  SCRIPTS_SCOPE_NOTE,
  SETTLED_STATE_NOTE,
  agentActivityText,
  agentLogTailMarker,
  agentMetadataLine,
  agentStatusLabel,
  agentStatusVisual,
  agentVisibleRole,
  agentsFooterSummary,
  agentsTabBadge,
  applyAgentsEvent,
  approvalKindLabel,
  approvalOptions,
  buildUserInputAnswers,
  checkpointLabel,
  collectDiffStream,
  collectWorkflowScriptStream,
  countAnsweredQuestions,
  deriveAgentsPanelModel,
  describeAgentSessionReceipt,
  describeLaunchReceipt,
  describeNavigationReceipt,
  describeReceipt,
  describeScriptRun,
  describeSessionImport,
  describeSessionScan,
  describeSessionsError,
  describeAgentsError,
  elapsedBetween,
  finishedAgentIds,
  isWorkflowName,
  operationSupport,
  parseT3ProjectFile,
  planSourceThreadId,
  resolveQuestionAnswer,
  runWorkspaceScript,
  scriptRunNonce,
  setQuestionCustomAnswer,
  trackThemeVars,
  toggleQuestionOption,
  userInputOptionValue,
  workflowLaunchEffect,
  workspaceFromRevision,
  type AgentsFeedState,
  type AgentsWorkflowGroup,
  type OperationSupport,
  type ScriptRun,
  type ScriptWorkspace,
  type StreamFrameLike,
  type UserInputDraftAnswer,
  type VerifiedDiffPatch,
  type WorkspaceScript,
  type WorkflowScriptViewState,
} from "./viewModel.js";

const manifestId = "t3.agents";

// Every theme-backed value chains a `--t3-agents-*` hop (published on the view
// root from `t3.ui/theme` tokens) ahead of the legacy host vars. When the
// contract is unavailable the hop never resolves and the legacy chain renders.
const muted = "var(--t3-agents-muted-foreground, var(--muted-foreground, #667085))";
const border = "1px solid var(--t3-agents-border, var(--border, #dfe3e8))";
const mono = "var(--font-mono, ui-monospace, SFMono-Regular, Consolas, monospace)";
const control = {
  padding: "4px 8px",
  border,
  borderRadius: 5,
  background: "transparent",
  color: "inherit",
  font: "inherit",
  fontSize: 12,
  cursor: "pointer",
} as const;
const textInput = {
  padding: "4px 6px",
  border,
  borderRadius: 5,
  background: "transparent",
  color: "inherit",
  font: "inherit",
  fontSize: 12,
  minWidth: 0,
} as const;
const sectionTitle = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  color: muted,
  padding: "2px 0 6px",
} as const;
const toneColor = {
  // `--info`/`--success` are host constants deliberately outside the theme
  // contract's role set — the native panel reads the same variables.
  info: "var(--info, #2e90fa)",
  muted,
  success: "var(--success, #12b76a)",
  danger: "var(--t3-agents-error, var(--destructive, #f04438))",
} as const;

/** Long patches stay verified but render-capped so one frame cannot flood the DOM. */
const PATCH_DISPLAY_CHAR_CAP = 200_000;

// ---------------------------------------------------------------------------
// Stream + control plumbing
// ---------------------------------------------------------------------------

function useVisible(session: ViewSession): boolean {
  const [visible, setVisible] = useState(session.visible);
  useEffect(() => session.onVisibility(setVisible), [session]);
  return visible;
}

/**
 * `t3.ui/theme` consumer. `trackThemeVars` owns the read/subscribe lifecycle
 * (see viewModel.ts): the map lands on the view root as `--t3-agents-*`
 * custom properties, and emits null — the honest degraded path back to the
 * legacy `var()` chain — on an ungranted host, a failed token read, or a lost
 * state stream. Retaining a stale map after stream loss is banned by the
 * design's no-stale-fallback rule, so the map is also reset on re-show: the
 * subscription is torn down while hidden and the theme may have moved.
 */
function useThemeVars(
  host: ClientHost,
  session: ViewSession,
  visible: boolean,
): Record<string, string> | null {
  const [vars, setVars] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    const api = bindApi(uiThemeApi, host, session.context);
    const streams = bindStreamApi(uiThemeApi, host, session.context);
    trackThemeVars(
      {
        getTokens: (s) => api.invoke("getTokens", {}, s),
        subscribeState: (s) => streams.subscribe("subscribeState", {}, s),
      },
      signal,
      setVars,
    );
    return () => {
      controller.abort();
      // The subscription is dead from here on — drop the overrides so a
      // re-show never briefly paints a theme the panel stopped observing.
      setVars(null);
    };
  }, [host, session, visible]);
  return vars;
}

interface AgentsFeed {
  readonly feed: AgentsFeedState;
  /** Named failure state — never a silent spinner. */
  readonly problem: string | null;
}

/**
 * `subscribeAgents` consumer for the view session's lifetime: the host owns
 * cancellation/backpressure via the async iterator. Snapshot-first frames fold
 * through `applyAgentsEvent`; a server `closed` frame (queue overflow)
 * triggers a bounded resubscribe. The stream outlives hiding so the tab badge
 * stays honest in the background, but a hidden panel only folds into a ref and
 * republishes the badge — the hidden tree never re-renders per frame. Showing
 * the panel commits the folded state once and marks finished work seen.
 */
function useAgentsFeed(host: ClientHost, session: ViewSession, visible: boolean): AgentsFeed {
  const [feed, setFeed] = useState<AgentsFeedState>(EMPTY_AGENTS_FEED);
  const [problem, setProblem] = useState<string | null>(null);
  const latest = useRef<{ feed: AgentsFeedState; problem: string | null }>({
    feed: EMPTY_AGENTS_FEED,
    problem: null,
  });
  const seenFinished = useRef<ReadonlySet<string>>(new Set());

  const publish = useCallback(() => {
    const agents = latest.current.feed.state?.agents ?? [];
    if (session.visible) {
      seenFinished.current = finishedAgentIds(agents);
      setFeed(latest.current.feed);
      setProblem(latest.current.problem);
    }
    const badge = agentsTabBadge(agents, seenFinished.current);
    session.setTabIndicators(badge ? { badge } : null);
  }, [session]);

  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    const update = (next: Partial<typeof latest.current>) => {
      latest.current = { ...latest.current, ...next };
      publish();
    };
    void (async () => {
      const streams = bindStreamApi(orchestrationStatusApi, host, session.context);
      for (let attempt = 1; attempt <= 3 && !signal.aborted; attempt += 1) {
        update({ feed: EMPTY_AGENTS_FEED, problem: null });
        let closedByServer = false;
        try {
          for await (const frame of streams.subscribe("subscribeAgents", {}, signal)) {
            if (signal.aborted) return;
            update({ feed: applyAgentsEvent(latest.current.feed, frame.value) });
            if (frame.value.kind === "closed") {
              closedByServer = true;
              break;
            }
          }
        } catch (error) {
          if (signal.aborted) return;
          update({
            problem: describeAgentsError(error, "Agent stream is unavailable."),
          });
          return;
        }
        if (signal.aborted) return;
        if (!closedByServer) {
          update({ problem: "Agent stream ended without a close frame" });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      }
      if (!signal.aborted) {
        update({
          problem:
            "Agent stream closed repeatedly (queue overflow) — reopen the Agents tab to retry",
        });
      }
    })();
    return () => controller.abort();
  }, [host, session, publish]);

  useEffect(() => {
    if (visible) publish();
  }, [visible, publish]);

  return { feed, problem };
}

/**
 * "Open agents there" for a turn implementing another thread's plan. The host
 * routes through `t3.ui/navigation` and opens this pack's view on that thread;
 * a refusal or a missing grant is rendered by name, never swallowed.
 */
function PlanSourceLink({
  host,
  session,
  threadId,
}: {
  readonly host: ClientHost;
  readonly session: ViewSession;
  readonly threadId: string;
}) {
  const api = useMemo(() => bindApi(uiNavigationApi, host, session.context), [host, session]);
  const capabilities = useApiRead(host, session, uiNavigationApi, "getCapabilities", {});
  const [outcome, setOutcome] = useState<string | null>(null);
  const supported =
    capabilities.status === "ready" && capabilities.value.operations.openThread === true;
  const open = () => {
    setOutcome(null);
    api.invoke("openThread", { threadId, surfaceId: `${manifestId}/view` }, session.signal).then(
      (receipt) => {
        if (receipt.status === "refused") setOutcome(describeNavigationReceipt(receipt));
      },
      (error: unknown) => setOutcome(describeAgentsError(error, "Could not open agents.")),
    );
  };
  return (
    <span style={{ color: muted, fontSize: 11, display: "inline-flex", gap: 4 }}>
      Plan from another thread ·
      <button type="button" onClick={open} disabled={!supported} style={control}>
        Open agents there
      </button>
      {capabilities.status === "unavailable" ? (
        <output aria-label="Navigation result">
          {describeAgentsError(capabilities.error, "Navigation is unavailable.")}
        </output>
      ) : capabilities.status === "ready" && !supported ? (
        <output aria-label="Navigation result">Navigation is not available on this client</output>
      ) : (
        outcome && <output aria-label="Navigation result">{outcome}</output>
      )}
    </span>
  );
}

/**
 * "Open session" for a roster row that carries a provider session handle. The
 * pack names the agent; the host resolves and opens its session page, so no
 * URL passes through here. Unsupported clients, a missing grant, and refusals
 * render by name.
 */
function useAgentSessionControl(
  host: ClientHost,
  session: ViewSession,
): (agent: RuntimeSubagent) => ReactNode {
  const api = useMemo(() => bindApi(uiNavigationApi, host, session.context), [host, session]);
  const capabilities = useApiRead(host, session, uiNavigationApi, "getCapabilities", {});
  const [outcomes, setOutcomes] = useState<Readonly<Record<string, string>>>({});
  const supported =
    capabilities.status === "ready" && capabilities.value.operations.openAgentSession === true;
  const unavailable =
    capabilities.status === "unavailable"
      ? describeAgentsError(capabilities.error, "Session pages are unavailable.")
      : capabilities.status === "ready" && !supported
        ? "Session pages are not available on this client"
        : null;
  return useCallback(
    (agent: RuntimeSubagent) => {
      if (!agent.runHandles?.sessionUrl) return null;
      const note = (text: string | null) =>
        setOutcomes(({ [agent.id]: _previous, ...rest }) =>
          text === null ? rest : { ...rest, [agent.id]: text },
        );
      const open = () => {
        note(null);
        api.invoke("openAgentSession", { agentId: agent.id }, session.signal).then(
          (receipt) => {
            if (receipt.status === "refused") note(describeAgentSessionReceipt(receipt));
          },
          (error: unknown) => note(describeAgentsError(error, "Could not open the session.")),
        );
      };
      const text = unavailable ?? outcomes[agent.id];
      return (
        <span style={{ display: "inline-flex", gap: 4, alignItems: "baseline" }}>
          <button
            type="button"
            onClick={open}
            disabled={!supported}
            style={{ ...control, padding: "0 6px", fontSize: 11 }}
          >
            Open session
          </button>
          {text && (
            <output aria-label="Session result" style={{ fontSize: 11, color: muted }}>
              {text}
            </output>
          )}
        </span>
      );
    },
    [api, session, supported, unavailable, outcomes],
  );
}

/**
 * Capability read that refetches when the projected inputs it derives from
 * change. The adapter computes operation support from the folded agents
 * (workflow script paths) and the thread's bound provider instance, so
 * `useApiRead`'s context/visibility keying would leave controls stuck on the
 * panel-open snapshot — a workflow that starts later would keep its Script
 * button "unsupported" until reopen. The last value stays rendered during a
 * refresh so controls don't flicker to disabled per frame.
 */
function useCapabilities(
  host: ClientHost,
  session: ViewSession,
  feed: AgentsFeedState,
): {
  readonly read: ApiReadState<OrchestrationCapabilities>;
  readonly refresh: () => void;
} {
  const state = feed.state;
  // `tick` backs the explicit Refresh control: a provider enabled from another
  // client produces no thread-scoped feed event (the stream only publishes on
  // aggregateKind "thread"), so support changes the feed cannot signal need a
  // manual recovery path.
  const [tick, setTick] = useState(0);
  const key = useMemo(
    () =>
      `${tick}:` +
      JSON.stringify([
        feed.streamEpoch,
        state?.session?.providerInstanceId ?? null,
        state?.session?.providerName ?? null,
        state?.session?.runtimeMode ?? null,
        state?.session?.status ?? null,
        state?.agents.map((agent) =>
          agent.kind === "workflow" ? (agent.runHandles?.scriptPath ?? null) : null,
        ) ?? [],
      ]),
    [tick, feed.streamEpoch, state],
  );
  const [visible, setVisible] = useState(session.visible);
  const [entry, setEntry] = useState<{
    readonly key: string;
    readonly read: ApiReadState<OrchestrationCapabilities>;
  }>();
  useEffect(() => session.onVisibility(setVisible), [session]);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session.signal]);
    void bindApi(orchestrationStatusApi, host, session.context)
      .invoke("getCapabilities", {}, signal)
      .then(
        (value) => {
          if (!signal.aborted) setEntry({ key, read: { status: "ready", value } });
        },
        (error: unknown) => {
          if (!signal.aborted)
            setEntry({
              key,
              read: {
                status: "unavailable",
                error: describeAgentsError(error, "Could not load orchestration capabilities."),
              },
            });
        },
      );
    return () => controller.abort();
  }, [key, host, session, visible]);
  // Keep rendering the last value while a refresh is in flight.
  return {
    read: entry?.read ?? { status: "loading" },
    refresh: useCallback(() => setTick((current) => current + 1), []),
  };
}

type OpOutcome =
  | { readonly kind: "pending" }
  | {
      readonly kind: "done";
      readonly receipt: {
        readonly commandId: string;
        readonly status: string;
        readonly sequence: number;
        readonly error: string | null;
      };
    }
  | { readonly kind: "error"; readonly message: string };

/**
 * `t3.orchestration/control` invoker. Every command carries a fresh
 * `commandId` (idempotent retry identity) and the feed's `expectedEpoch` so a
 * stale stream epoch rejects at the decider instead of landing blind.
 */
function useControls(host: ClientHost, session: ViewSession, feed: AgentsFeedState) {
  const api = useMemo(
    () => bindApi(orchestrationControlApi, host, session.context),
    [host, session],
  );
  const [outcomes, setOutcomes] = useState<Record<string, OpOutcome>>({});
  const epochRef = useRef<string | null>(null);
  useEffect(() => {
    epochRef.current = feed.streamEpoch;
  }, [feed.streamEpoch]);

  const run = useCallback(
    <K extends keyof OrchestrationControlMethods & string>(
      key: string,
      operation: K,
      input: OrchestrationControlMethods[K]["input"],
    ) => {
      setOutcomes((current) => ({ ...current, [key]: { kind: "pending" } }));
      const guarded = {
        ...input,
        commandId: crypto.randomUUID(),
        ...(epochRef.current ? { expectedEpoch: epochRef.current } : {}),
      };
      api
        .invoke(operation, guarded, session.signal)
        .then((receipt) =>
          setOutcomes((current) => ({ ...current, [key]: { kind: "done", receipt } })),
        )
        .catch((error: unknown) =>
          setOutcomes((current) => ({
            ...current,
            [key]: {
              kind: "error",
              message: describeAgentsError(error, "Could not complete the operation."),
            },
          })),
        );
    },
    [api, session],
  );

  const outcomeText = (key: string, format = describeReceipt): string | null => {
    const outcome = outcomes[key];
    if (!outcome) return null;
    if (outcome.kind === "pending") return "dispatching…";
    if (outcome.kind === "error") return outcome.message;
    return format({
      commandId: outcome.receipt.commandId,
      status: outcome.receipt.status === "accepted" ? "accepted" : "rejected",
      sequence: outcome.receipt.sequence,
      error: outcome.receipt.error,
    });
  };

  return { run, outcomeText };
}

// ---------------------------------------------------------------------------
// Live sections
// ---------------------------------------------------------------------------

function OpButton(props: {
  readonly label: string;
  readonly support: ReturnType<typeof operationSupport>;
  readonly disabled?: boolean;
  readonly expanded?: boolean;
  readonly onClick: () => void;
}) {
  const { label, support, disabled, expanded, onClick } = props;
  if (support.kind === "unsupported") {
    // The capability detail names the operation — no invented affordance.
    return (
      <span style={{ fontSize: 11, color: muted }}>
        {label}: {support.detail}
      </span>
    );
  }
  return (
    <button
      type="button"
      disabled={disabled || support.kind !== "ready"}
      aria-expanded={expanded}
      onClick={onClick}
      style={control}
    >
      {label}
      {support.kind === "unknown" ? "…" : ""}
    </button>
  );
}

/** Session line + thread-level controls. */
function SessionControls(props: {
  readonly feed: AgentsFeedState;
  readonly capabilities: OrchestrationCapabilities | null;
  readonly run: ReturnType<typeof useControls>["run"];
  readonly outcomeText: (key: string) => string | null;
  readonly onRefreshCapabilities: () => void;
}) {
  const { feed, capabilities, run, outcomeText, onRefreshCapabilities } = props;
  const state = feed.state;
  const [draft, setDraft] = useState("");
  const turnRunning = state?.turn?.state === "running";
  const sessionLive =
    state?.session !== null && state?.session !== undefined && state.session.status !== "stopped";

  return (
    <section aria-label="Session controls" style={{ padding: "6px 10px", borderBottom: border }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <input
          aria-label="Start a turn"
          placeholder="Start a turn…"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          style={{ ...textInput, flex: 1 }}
        />
        <OpButton
          label="Start"
          support={operationSupport(capabilities, "turn.start")}
          disabled={draft.trim().length === 0}
          onClick={() => {
            const text = draft.trim();
            if (!text) return;
            setDraft("");
            run("turn.start", "turn.start", { text });
          }}
        />
        <OpButton
          label="Interrupt turn"
          support={operationSupport(capabilities, "turn.interrupt")}
          disabled={!turnRunning}
          onClick={() => run("turn.interrupt", "turn.interrupt", {})}
        />
        <OpButton
          label="Stop session"
          support={operationSupport(capabilities, "session.stop")}
          disabled={!sessionLive}
          onClick={() => run("session.stop", "session.stop", {})}
        />
        <OpButton
          label="Settle"
          support={operationSupport(capabilities, "thread.settle")}
          onClick={() => run("thread.settle", "thread.settle", {})}
        />
        <OpButton
          label="Unsettle"
          support={operationSupport(capabilities, "thread.unsettle")}
          onClick={() => run("thread.unsettle", "thread.unsettle", {})}
        />
        <button
          type="button"
          aria-label="Refresh capabilities"
          onClick={onRefreshCapabilities}
          style={{ ...control, marginLeft: "auto" }}
        >
          Refresh
        </button>
      </div>
      <p style={{ margin: "4px 0 0", color: muted, fontSize: 11 }}>
        Provider enabled elsewhere? Refresh re-reads the operation support map — the live feed
        carries no provider-registry signal.
      </p>
      {(
        [
          "turn.start",
          "turn.interrupt",
          "session.stop",
          "thread.settle",
          "thread.unsettle",
        ] as const
      )
        .map((key) => ({ key, text: outcomeText(key) }))
        .filter((entry) => entry.text !== null)
        .map((entry) => (
          <output
            key={entry.key}
            aria-label={`Outcome of ${entry.key}`}
            style={{ display: "block", fontSize: 11, color: muted, marginTop: 4 }}
          >
            {entry.key}: {entry.text}
          </output>
        ))}
      <p style={{ margin: "6px 0 0", color: muted, fontSize: 11 }}>{SETTLED_STATE_NOTE}</p>
    </section>
  );
}

/**
 * Workflow launch (`t3.orchestration/control` 1.1.0 `workflow.launch`, under
 * the extra `t3.orchestration/launch-workflow` grant). Launch starts a turn on
 * the user's behalf, so it takes the same inline confirm as checkpoint revert.
 * The receipt line is the whole lifecycle here; the run itself appears in the
 * roster once the provider starts it.
 */
function WorkflowLaunchSection(props: {
  readonly capabilities: OrchestrationCapabilities | null;
  readonly run: ReturnType<typeof useControls>["run"];
  readonly outcomeText: ReturnType<typeof useControls>["outcomeText"];
}) {
  const { capabilities, run, outcomeText } = props;
  const [name, setName] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const workflowName = name.trim();
  const outcome = outcomeText("workflow.launch", describeLaunchReceipt);
  return (
    <section aria-label="Launch workflow" style={{ padding: "6px 10px", borderBottom: border }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <input
          aria-label="Workflow name"
          placeholder="Workflow name…"
          value={name}
          disabled={confirming !== null}
          onChange={(event) => setName(event.target.value)}
          style={{ ...textInput, flex: 1 }}
        />
        {confirming !== null ? (
          <>
            <button
              type="button"
              style={{ ...control, borderColor: toneColor.danger, color: toneColor.danger }}
              onClick={() => {
                setConfirming(null);
                run("workflow.launch", "workflow.launch", { workflowName: confirming });
              }}
            >
              Confirm launch
            </button>
            <button type="button" style={control} onClick={() => setConfirming(null)}>
              Keep
            </button>
          </>
        ) : (
          <OpButton
            label="Launch"
            support={operationSupport(capabilities, "workflow.launch")}
            disabled={!isWorkflowName(workflowName)}
            onClick={() => setConfirming(workflowName)}
          />
        )}
      </div>
      {confirming !== null && (
        <span style={{ display: "block", fontSize: 11, color: toneColor.danger, marginTop: 4 }}>
          {workflowLaunchEffect(confirming)}
        </span>
      )}
      {outcome && (
        <output
          aria-label="Outcome of workflow.launch"
          style={{ display: "block", fontSize: 11, color: muted, marginTop: 4 }}
        >
          {outcome}
        </output>
      )}
    </section>
  );
}

function ApprovalRow(props: {
  readonly approval: PendingApproval;
  readonly pending: boolean;
  readonly respondSupport: OperationSupport;
  readonly onRespond: (decision: ApprovalDecision) => void;
}) {
  const { approval, pending, respondSupport, onRespond } = props;
  return (
    <li style={{ display: "flex", flexDirection: "column", gap: 4, padding: "4px 0" }}>
      <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
        <strong style={{ fontSize: 12 }}>{approvalKindLabel(approval.requestKind)}</strong>
        {approval.appName && <span style={{ color: muted, fontSize: 11 }}>{approval.appName}</span>}
      </div>
      {approval.detail && (
        <pre
          style={{
            margin: 0,
            fontFamily: mono,
            fontSize: 11,
            color: muted,
            whiteSpace: "pre-wrap",
            maxHeight: 120,
            overflow: "auto",
          }}
        >
          {approval.detail}
        </pre>
      )}
      {respondSupport.kind === "unsupported" ? (
        <span style={{ fontSize: 11, color: muted }}>{respondSupport.detail}</span>
      ) : (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {approvalOptions(approval).map((option) => (
            <button
              key={option.decision}
              type="button"
              disabled={pending || respondSupport.kind !== "ready"}
              onClick={() => onRespond(option.decision)}
              style={control}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
      {approvalOptions(approval)
        .filter((option) => option.warning)
        .map((option) => (
          <span key={option.decision} style={{ display: "block", fontSize: 11, color: muted }}>
            {option.label}: {option.warning}
          </span>
        ))}
    </li>
  );
}

function UserInputRow(props: {
  readonly request: PendingUserInput;
  readonly pending: boolean;
  readonly respondSupport: OperationSupport;
  readonly dismissSupport: OperationSupport;
  readonly onRespond: (answers: Record<string, string | string[]>) => void;
  readonly onDismiss: () => void;
}) {
  const { request, pending, respondSupport, dismissSupport, onRespond, onDismiss } = props;
  const [drafts, setDrafts] = useState<Record<string, UserInputDraftAnswer>>({});
  const answered = countAnsweredQuestions(request.questions, drafts);
  const answers = buildUserInputAnswers(request.questions, drafts);
  const singleQuestion = request.questions.length === 1;

  const setDraft = (questionId: string, draft: UserInputDraftAnswer) =>
    setDrafts((current) => ({ ...current, [questionId]: draft }));

  return (
    <li style={{ display: "flex", flexDirection: "column", gap: 6, padding: "4px 0" }}>
      {request.questions.map((question) => {
        const draft = drafts[question.id];
        const selected = new Set(draft?.selectedOptionValues ?? []);
        return (
          <fieldset
            key={question.id}
            style={{ border: "none", margin: 0, padding: 0, minWidth: 0 }}
          >
            <legend style={{ fontSize: 11, fontWeight: 600, padding: 0 }}>{question.header}</legend>
            <p style={{ margin: "2px 0 4px", fontSize: 12 }}>{question.question}</p>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {question.options.map((option) => {
                const value = userInputOptionValue(option);
                const isSelected = selected.has(value);
                return (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={isSelected}
                    disabled={pending || respondSupport.kind !== "ready"}
                    onClick={() => {
                      // One-question single-select submits on click — the native
                      // quick-pick behavior. Everything else stages a draft.
                      if (singleQuestion && !question.multiSelect) {
                        onRespond({ [question.id]: value });
                        return;
                      }
                      setDraft(question.id, toggleQuestionOption(question, draft, value));
                    }}
                    style={{
                      ...control,
                      ...(isSelected ? { borderColor: toneColor.info } : {}),
                    }}
                  >
                    {isSelected ? "✓ " : ""}
                    {option.label}
                    {option.description ? (
                      <span style={{ fontSize: 10, color: muted }}> — {option.description}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
            {question.allowCustomAnswer !== false && (
              <input
                aria-label={`Custom answer for ${question.header}`}
                placeholder="Type a custom answer…"
                value={draft?.customAnswer ?? ""}
                disabled={pending || respondSupport.kind !== "ready"}
                onChange={(event) =>
                  setDraft(
                    question.id,
                    setQuestionCustomAnswer(question, draft, event.target.value),
                  )
                }
                style={{ ...textInput, width: "100%", marginTop: 4, boxSizing: "border-box" }}
              />
            )}
            {resolveQuestionAnswer(question, draft) !== null && (
              <span style={{ fontSize: 11, color: muted }}>answered</span>
            )}
          </fieldset>
        );
      })}
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        {respondSupport.kind === "unsupported" ? (
          <span style={{ fontSize: 11, color: muted }}>{respondSupport.detail}</span>
        ) : (
          <button
            type="button"
            disabled={pending || answers === null || respondSupport.kind !== "ready"}
            onClick={() => answers && onRespond(answers)}
            style={control}
          >
            Submit{request.questions.length > 1 ? ` (${answered}/${request.questions.length})` : ""}
          </button>
        )}
        {request.dismissible &&
          (dismissSupport.kind === "unsupported" ? (
            <span style={{ fontSize: 11, color: muted }}>{dismissSupport.detail}</span>
          ) : (
            <button
              type="button"
              disabled={pending || dismissSupport.kind !== "ready"}
              onClick={onDismiss}
              style={control}
            >
              Dismiss
            </button>
          ))}
      </div>
    </li>
  );
}

/** Pending approvals and user inputs. */
function PendingSection(props: {
  readonly feed: AgentsFeedState;
  readonly capabilities: OrchestrationCapabilities | null;
  readonly run: ReturnType<typeof useControls>["run"];
  readonly outcomeText: (key: string) => string | null;
}) {
  const { feed, capabilities, run, outcomeText } = props;
  const state = feed.state;
  if (!state) return null;
  const approvals = state.pendingApprovals;
  const inputs = state.pendingUserInputs;
  if (approvals.length === 0 && inputs.length === 0) return null;
  const respondKey = (requestId: string) => `req:${requestId}`;
  // Each operation is gated independently — the capability map can support
  // respond but not dismiss, or vice versa.
  const approvalRespond = operationSupport(capabilities, "approval.respond");
  const inputRespond = operationSupport(capabilities, "userInput.respond");
  const inputDismiss = operationSupport(capabilities, "userInput.dismiss");

  return (
    <section
      aria-label="Pending requests"
      style={{ padding: "6px 10px", borderBottom: border, flexShrink: 0 }}
    >
      <div style={sectionTitle}>Pending requests</div>
      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {approvals.map((approval) => (
          <ApprovalRow
            key={approval.requestId}
            approval={approval}
            pending={outcomeText(respondKey(approval.requestId)) === "dispatching…"}
            respondSupport={approvalRespond}
            onRespond={(decision) =>
              run(respondKey(approval.requestId), "approval.respond", {
                requestId: approval.requestId,
                decision,
              })
            }
          />
        ))}
        {inputs.map((request) => (
          <UserInputRow
            key={request.requestId}
            request={request}
            pending={outcomeText(respondKey(request.requestId)) === "dispatching…"}
            respondSupport={inputRespond}
            dismissSupport={inputDismiss}
            onRespond={(answers) =>
              run(respondKey(request.requestId), "userInput.respond", {
                requestId: request.requestId,
                answers,
              })
            }
            onDismiss={() =>
              run(respondKey(request.requestId), "userInput.dismiss", {
                requestId: request.requestId,
              })
            }
          />
        ))}
      </ul>
      {approvals
        .map((approval) => respondKey(approval.requestId))
        .concat(inputs.map((request) => respondKey(request.requestId)))
        .map((key) => ({ key, text: outcomeText(key) }))
        .filter((entry) => entry.text !== null && entry.text !== "dispatching…")
        .map((entry) => (
          <output key={entry.key} style={{ display: "block", fontSize: 11, color: muted }}>
            {entry.text}
          </output>
        ))}
    </section>
  );
}

/** Elapsed time: live agents self-tick via DOM writes (zero React commits). */
function AgentElapsed(props: { readonly agent: RuntimeSubagent }) {
  const { agent } = props;
  const textRef = useRef<HTMLSpanElement>(null);
  const live = agent.status === "running" || agent.status === "waiting";
  const startedAt = agent.startedAt;

  useEffect(() => {
    if (!live || !startedAt) return;
    const update = () => {
      if (textRef.current) textRef.current.textContent = elapsedBetween(startedAt, null);
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [live, startedAt]);

  if (!startedAt) return null;
  return (
    <span ref={textRef} style={{ fontVariantNumeric: "tabular-nums" }}>
      {elapsedBetween(startedAt, live ? null : agent.completedAt)}
    </span>
  );
}

type ReadAgentLog = (runId: string, signal: AbortSignal) => Promise<AgentLogTail>;
type AgentLogView =
  | { readonly kind: "ready"; readonly tail: AgentLogTail }
  | { readonly kind: "error"; readonly detail: string };

/**
 * On-demand output tail over `t3.orchestration/logs`. While open it re-reads
 * only when the roster stream reports the run changed (`updatedAt`) — no
 * polling. A superseded read is aborted and its result dropped; the last
 * tail stays painted until its replacement lands.
 */
function AgentOutput(props: { readonly agent: RuntimeSubagent; readonly readLog: ReadAgentLog }) {
  const { agent, readLog } = props;
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<AgentLogView | null>(null);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    readLog(agent.id, controller.signal).then(
      (tail) => {
        if (!controller.signal.aborted) setView({ kind: "ready", tail });
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setView({
            kind: "error",
            detail: describeAgentsError(error, "Could not load the output."),
          });
      },
    );
    return () => controller.abort();
    // `updatedAt` is the refresh signal: the roster stream bumps it when the run changes.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [open, agent.id, agent.updatedAt, readLog]);
  const tail = view?.kind === "ready" ? view.tail : null;
  const marker = tail ? agentLogTailMarker(tail) : null;
  return (
    <span style={{ gridColumn: "2 / 4", minWidth: 0 }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        style={{ ...control, padding: "1px 6px", fontSize: 11, marginTop: 2 }}
      >
        {open ? "Hide output" : "Output"}
      </button>
      {open && view === null && (
        <span style={{ marginLeft: 6, fontSize: 11, color: muted }}>reading…</span>
      )}
      {open && view?.kind === "error" && (
        <output style={{ display: "block", fontSize: 11, color: toneColor.danger }}>
          {view.detail}
        </output>
      )}
      {open && tail && (
        <pre
          aria-label={`${agent.title} output`}
          style={{
            margin: "4px 0 0",
            fontFamily: mono,
            fontSize: 11,
            color: muted,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            maxHeight: 160,
            overflow: "auto",
          }}
        >
          {marker ? `${marker}\n` : ""}
          {tail.contents || "(no output yet)"}
        </pre>
      )}
    </span>
  );
}

function AgentRow(props: {
  readonly agent: RuntimeSubagent;
  readonly sessionControl: (agent: RuntimeSubagent) => ReactNode;
  readonly readLog: ReadAgentLog;
}) {
  const { agent, sessionControl, readLog } = props;
  const visual = agentStatusVisual(agent.status);
  const role = agentVisibleRole(agent);
  return (
    <li
      style={{
        display: "grid",
        gridTemplateColumns: "8px minmax(0,1fr) auto",
        columnGap: 8,
        alignItems: "center",
        padding: "4px 0",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: toneColor[visual.tone],
        }}
      />
      <span style={{ minWidth: 0 }}>
        <span
          style={{
            display: "flex",
            gap: 6,
            alignItems: "baseline",
            minWidth: 0,
          }}
        >
          <span
            style={{
              fontSize: 12,
              fontWeight: 500,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {agent.title}
          </span>
          {role && (
            <span
              style={{
                fontFamily: mono,
                fontSize: 10,
                color: muted,
                border,
                borderRadius: 3,
                padding: "0 3px",
                flexShrink: 0,
              }}
            >
              {role}
            </span>
          )}
        </span>
        <span style={{ display: "block", fontSize: 11, color: muted }}>
          {agentStatusLabel(agent)}
          {agentMetadataLine(agent).length > 0 && ` · ${agentMetadataLine(agent).join(" · ")}`}
        </span>
        {agentActivityText(agent) && (
          <span
            style={{
              display: "block",
              fontSize: 11,
              color: muted,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {agentActivityText(agent)}
          </span>
        )}
        {sessionControl(agent)}
      </span>
      <span style={{ fontFamily: mono, fontSize: 11, color: muted, textAlign: "right" }}>
        <AgentElapsed agent={agent} />
      </span>
      {agent.outputFile !== null && <AgentOutput agent={agent} readLog={readLog} />}
    </li>
  );
}

function WorkflowGroupView(props: {
  readonly group: AgentsWorkflowGroup;
  readonly scriptSupport: ReturnType<typeof operationSupport>;
  readonly onToggleScript: (workflowId: string, scriptPath: string) => void;
  readonly onCloseScript: (workflowId: string, scriptPath: string) => void;
  readonly sessionControl: (agent: RuntimeSubagent) => ReactNode;
  readonly readLog: ReadAgentLog;
  readonly script: WorkflowScriptViewState | null;
}) {
  const { group, scriptSupport, onToggleScript, onCloseScript, sessionControl, readLog, script } =
    props;
  const workflow = group.workflow;
  return (
    <li style={{ padding: "4px 0" }}>
      <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
        <strong style={{ fontSize: 12 }}>{workflow.title}</strong>
        <span style={{ fontSize: 11, color: muted }}>{agentStatusLabel(workflow)}</span>
        {workflow.runHandles?.scriptPath && (
          <OpButton
            label="Script"
            support={scriptSupport}
            expanded={script?.open ?? false}
            onClick={() => onToggleScript(workflow.id, workflow.runHandles!.scriptPath!)}
          />
        )}
        {sessionControl(workflow)}
      </div>
      {script?.open && (
        <div style={{ margin: "4px 6px", border, borderRadius: 6 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "4px 8px",
              borderBottom: border,
            }}
          >
            <span
              style={{
                fontFamily: mono,
                fontSize: 10,
                color: muted,
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {workflow.runHandles?.scriptPath?.split("/").at(-1)}
            </span>
            <button
              type="button"
              aria-label="Close script"
              onClick={() => onCloseScript(workflow.id, workflow.runHandles!.scriptPath!)}
              style={control}
            >
              ×
            </button>
          </div>
          <div style={{ maxHeight: 288, overflow: "auto", padding: 8 }}>
            {script.result === "loading" ? (
              <p style={{ margin: 0, fontSize: 12, color: muted }}>Loading…</p>
            ) : script.result === "error" ? (
              <p style={{ margin: 0, fontSize: 12, color: toneColor.danger }}>
                Could not load the script.
              </p>
            ) : (
              <pre
                style={{
                  margin: 0,
                  fontFamily: mono,
                  fontSize: 11,
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                  lineHeight: 1.625,
                }}
              >
                {script.result.contents}
                {script.result.truncated ? "\n… (truncated)" : ""}
              </pre>
            )}
          </div>
        </div>
      )}
      {group.phases.map((phase) => (
        <div key={phase.index} style={{ marginTop: 4 }}>
          <div style={{ fontSize: 11, color: muted }}>
            {phase.title} · {phase.state} · {phase.members.length} agent
            {phase.members.length === 1 ? "" : "s"}
          </div>
          <ul style={{ listStyle: "none", margin: 0, padding: "0 0 0 12px" }}>
            {phase.members.map((member) => (
              <AgentRow
                key={member.id}
                agent={member}
                sessionControl={sessionControl}
                readLog={readLog}
              />
            ))}
          </ul>
        </div>
      ))}
      {group.unphasedMembers.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: "0 0 0 12px" }}>
          {group.unphasedMembers.map((member) => (
            <AgentRow
              key={member.id}
              agent={member}
              sessionControl={sessionControl}
              readLog={readLog}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

type DiffView =
  | { readonly key: string; readonly kind: "loading" }
  | { readonly key: string; readonly kind: "ready"; readonly patch: VerifiedDiffPatch }
  | { readonly key: string; readonly kind: "error"; readonly detail: string };

/** Checkpoints list + verified turn/thread diff rendering. */
function CheckpointsSection(props: {
  readonly feed: AgentsFeedState;
  readonly capabilities: OrchestrationCapabilities | null;
  readonly host: ClientHost;
  readonly session: ViewSession;
  readonly run: ReturnType<typeof useControls>["run"];
  readonly outcomeText: (key: string) => string | null;
}) {
  const { feed, capabilities, host, session, run, outcomeText } = props;
  const state = feed.state;
  const [diffView, setDiffView] = useState<DiffView | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const streams = useMemo(
    () => bindStreamApi(orchestrationStatusApi, host, session.context),
    [host, session],
  );

  const fetchDiff = (
    key: string,
    subscribe: (signal: AbortSignal) => AsyncIterable<StreamFrameLike<VcsDiffPreviewStreamEvent>>,
  ) => {
    setDiffView({ key, kind: "loading" });
    void collectDiffStream(subscribe(session.signal), session.signal)
      .then((outcome) => {
        if (outcome.kind === "verified") setDiffView({ key, kind: "ready", patch: outcome.patch });
        else if (outcome.kind === "cancelled") setDiffView(null);
        else setDiffView({ key, kind: "error", detail: outcome.detail });
      })
      .catch((error: unknown) =>
        setDiffView({
          key,
          kind: "error",
          detail: describeAgentsError(error, "Could not load the diff."),
        }),
      );
  };

  if (!state) return null;
  const checkpoints = state.checkpoints;

  return (
    <section
      aria-label="Checkpoints"
      style={{ padding: "6px 10px", borderBottom: border, flexShrink: 0 }}
    >
      <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
        <div style={{ ...sectionTitle, flex: 1, padding: "2px 0" }}>Checkpoints</div>
        <OpButton
          label="Thread diff"
          support={operationSupport(capabilities, "getThreadDiff")}
          disabled={diffView?.kind === "loading"}
          onClick={() =>
            fetchDiff("thread", (signal) => streams.subscribe("getThreadDiff", {}, signal))
          }
        />
      </div>
      {checkpoints.length === 0 ? (
        <p style={{ margin: "0 0 4px", color: muted, fontSize: 12 }}>
          No checkpoints yet — a checkpoint lands when a turn completes.
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {checkpoints.map((checkpoint) => {
            const key = `cp:${checkpoint.turnId}`;
            const reverting = outcomeText(`revert:${checkpoint.turnId}`);
            return (
              <li
                key={checkpoint.turnId}
                style={{ padding: "4px 0", display: "flex", flexDirection: "column", gap: 2 }}
              >
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12 }}>{checkpointLabel(checkpoint)}</span>
                  <span style={{ fontSize: 11, color: muted }}>
                    {checkpoint.status}
                    {checkpoint.completedAt ? ` · ${checkpoint.completedAt}` : ""}
                  </span>
                  <OpButton
                    label="Diff"
                    support={operationSupport(capabilities, "getTurnDiff")}
                    disabled={diffView?.kind === "loading"}
                    onClick={() =>
                      fetchDiff(key, (signal) =>
                        streams.subscribe(
                          "getTurnDiff",
                          { turnCount: checkpoint.checkpointTurnCount },
                          signal,
                        ),
                      )
                    }
                  />
                  {confirming === checkpoint.turnId ? (
                    <>
                      <button
                        type="button"
                        style={{
                          ...control,
                          borderColor: toneColor.danger,
                          color: toneColor.danger,
                        }}
                        onClick={() => {
                          setConfirming(null);
                          run(`revert:${checkpoint.turnId}`, "checkpoint.revert", {
                            turnCount: checkpoint.checkpointTurnCount,
                          });
                        }}
                      >
                        Confirm revert
                      </button>
                      <button type="button" style={control} onClick={() => setConfirming(null)}>
                        Keep
                      </button>
                    </>
                  ) : (
                    <OpButton
                      label="Revert"
                      support={operationSupport(capabilities, "checkpoint.revert")}
                      disabled={checkpoint.status !== "ready"}
                      onClick={() => setConfirming(checkpoint.turnId)}
                    />
                  )}
                </div>
                {confirming === checkpoint.turnId && (
                  <span style={{ fontSize: 11, color: toneColor.danger }}>
                    Reverting discards messages after this checkpoint and restores its tree.
                  </span>
                )}
                {reverting && (
                  <output style={{ fontSize: 11, color: muted }}>revert: {reverting}</output>
                )}
                {diffView?.key === key && <DiffViewPane view={diffView} />}
              </li>
            );
          })}
        </ul>
      )}
      {diffView?.key === "thread" && <DiffViewPane view={diffView} />}
    </section>
  );
}

type SessionScan =
  | { readonly kind: "idle" | "scanning" }
  | { readonly kind: "ready"; readonly result: AgentSessionsScanResult }
  | { readonly kind: "error"; readonly message: string };

const sessionRowKey = (entry: AgentSessionSummary) =>
  `${entry.providerInstanceId}:${entry.providerSessionId}`;

/**
 * Claude/Codex sessions that ran in this project, imported one at a time
 * through `t3.agents/sessions` behind the same two-step confirm as revert.
 * Scanning reads transcripts on the host, so it runs only when asked.
 */
function SessionImportSection(props: { readonly host: ClientHost; readonly session: ViewSession }) {
  const { host, session } = props;
  const api = useMemo(() => bindApi(agentSessionsApi, host, session.context), [host, session]);
  const [scan, setScan] = useState<SessionScan>({ kind: "idle" });
  const [confirming, setConfirming] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, string>>({});

  const runScan = () => {
    setScan({ kind: "scanning" });
    setConfirming(null);
    api
      .invoke("scan", {}, session.signal)
      .then((result) => setScan({ kind: "ready", result }))
      .catch((error: unknown) => setScan({ kind: "error", message: describeSessionsError(error) }));
  };
  const runImport = (entry: AgentSessionSummary) => {
    const key = sessionRowKey(entry);
    setConfirming(null);
    setOutcomes((current) => ({ ...current, [key]: "importing…" }));
    api
      .invoke(
        "import",
        {
          providerInstanceId: entry.providerInstanceId,
          providerSessionId: entry.providerSessionId,
        },
        session.signal,
      )
      .then((receipt) => {
        setOutcomes((current) => ({ ...current, [key]: describeSessionImport(receipt) }));
        const threadId = receipt.threadId;
        if (receipt.status === "imported" || receipt.error === "AgentSessionAlreadyImported")
          setScan((current) =>
            current.kind !== "ready"
              ? current
              : {
                  kind: "ready",
                  result: {
                    ...current.result,
                    sessions: current.result.sessions.map((row) =>
                      sessionRowKey(row) === key ? { ...row, status: "imported", threadId } : row,
                    ),
                  },
                },
          );
      })
      .catch((error: unknown) =>
        setOutcomes((current) => ({ ...current, [key]: describeSessionsError(error) })),
      );
  };
  const scanStatus = scan.kind === "ready" ? describeSessionScan(scan.result) : null;

  return (
    <section
      aria-label="Import sessions"
      style={{ padding: "6px 10px", borderBottom: border, flexShrink: 0 }}
    >
      <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
        <div style={{ ...sectionTitle, flex: 1, padding: "2px 0" }}>Import sessions</div>
        <button type="button" style={control} disabled={scan.kind === "scanning"} onClick={runScan}>
          {scan.kind === "idle" ? "Scan" : "Rescan"}
        </button>
      </div>
      {scan.kind === "idle" && (
        <p style={{ margin: "0 0 4px", color: muted, fontSize: 12 }}>
          Find Claude and Codex sessions from the last 30 days that ran in this project.
        </p>
      )}
      {scan.kind === "scanning" && (
        <p style={{ margin: "0 0 4px", color: muted, fontSize: 12 }}>Scanning…</p>
      )}
      {scan.kind === "error" && (
        <p style={{ margin: "0 0 4px", color: toneColor.danger, fontSize: 12 }}>{scan.message}</p>
      )}
      {scanStatus?.empty && (
        <p style={{ margin: "0 0 4px", color: muted, fontSize: 12 }}>{scanStatus.empty}</p>
      )}
      {scan.kind === "ready" && scan.result.sessions.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {scan.result.sessions.map((entry) => {
            const key = sessionRowKey(entry);
            const outcome = outcomes[key];
            return (
              <li
                key={key}
                style={{ padding: "4px 0", display: "flex", flexDirection: "column", gap: 2 }}
              >
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <span
                    style={{
                      fontSize: 12,
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {entry.providerSessionId}
                  </span>
                  <span style={{ fontSize: 11, color: muted }}>
                    {entry.source === "claudeAgent" ? "Claude" : "Codex"} · {entry.lastActiveAt}
                  </span>
                  {entry.status === "imported" ? (
                    <span style={{ fontSize: 11, color: muted }}>imported</span>
                  ) : confirming === key ? (
                    <>
                      <button
                        type="button"
                        style={{ ...control, borderColor: toneColor.info, color: toneColor.info }}
                        onClick={() => runImport(entry)}
                      >
                        Confirm import
                      </button>
                      <button type="button" style={control} onClick={() => setConfirming(null)}>
                        Keep
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      style={control}
                      disabled={outcome === "importing…"}
                      onClick={() => setConfirming(key)}
                    >
                      Import
                    </button>
                  )}
                </div>
                {confirming === key && (
                  <span style={{ fontSize: 11, color: muted }}>
                    Creates a new thread in this project with the session&apos;s recent messages.
                  </span>
                )}
                {outcome && (
                  <output style={{ fontSize: 11, color: muted }}>import: {outcome}</output>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {scanStatus?.note && (
        <p style={{ margin: "4px 0 0", color: muted, fontSize: 11 }}>{scanStatus.note}</p>
      )}
    </section>
  );
}

function DiffViewPane(props: { readonly view: DiffView }) {
  const { view } = props;
  if (view.kind === "loading") {
    return (
      <p style={{ margin: "4px 0", fontSize: 11, color: muted }}>Reassembling verified diff…</p>
    );
  }
  if (view.kind === "error") {
    return (
      <p style={{ margin: "4px 0", fontSize: 11, color: toneColor.danger }}>
        Diff unavailable — {view.detail}
      </p>
    );
  }
  return (
    <div style={{ margin: "4px 0" }}>
      {view.patch.sources.map((source) => {
        const capped =
          source.diff.length > PATCH_DISPLAY_CHAR_CAP
            ? `${source.diff.slice(0, PATCH_DISPLAY_CHAR_CAP)}\n… (${source.diff.length - PATCH_DISPLAY_CHAR_CAP} more chars — display-capped, payload verified)`
            : source.diff;
        return (
          <div key={source.id}>
            <div style={{ fontSize: 11, color: muted }}>
              {source.title}
              {source.truncated ? " · source truncated by the server bound" : ""}
            </div>
            <pre
              style={{
                margin: "2px 0 6px",
                fontFamily: mono,
                fontSize: 11,
                whiteSpace: "pre-wrap",
                maxHeight: 260,
                overflow: "auto",
                border,
                borderRadius: 4,
                padding: 6,
              }}
            >
              {capped || "(empty diff)"}
            </pre>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

async function runScript(
  host: ClientHost,
  session: ViewSession,
  script: WorkspaceScript,
  workspace: ScriptWorkspace,
  nonce: string,
  report: (run: ScriptRun) => void,
): Promise<void> {
  const api = bindApi(terminalControlApi, host, session.context);
  await runWorkspaceScript({
    control: {
      attach: (input) => api.invoke("attach", input, session.signal),
      write: (input) => api.invoke("write", input, session.signal),
    },
    script,
    workspace,
    nonce,
    report,
  });
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

function AgentsView(props: { host: ClientHost; session: ViewSession }) {
  const { host, session } = props;
  const visible = useVisible(session);
  const themeVars = useThemeVars(host, session, visible);
  const workspace = workspaceFromRevision(session.context.workspaceRevision);
  const scriptsRead = useApiRead(host, session, workspaceFilesApi, "readText", {
    relativePath: "t3.json",
  });
  const { feed, problem } = useAgentsFeed(host, session, visible);
  const { read: capabilitiesRead, refresh: refreshCapabilities } = useCapabilities(
    host,
    session,
    feed,
  );
  const capabilities = capabilitiesRead.status === "ready" ? capabilitiesRead.value : null;
  const { run, outcomeText } = useControls(host, session, feed);
  const sessionControl = useAgentSessionControl(host, session);
  const [runs, setRuns] = useState<Record<string, ScriptRun>>({});
  // Fresh per panel mount: recreated panels never re-pick overflow ids their
  // previous incarnation may have left running; concurrent clients allocate
  // disjoint families.
  const [runNonce] = useState(scriptRunNonce);
  const [scripts, setScripts] = useState<Record<string, WorkflowScriptViewState>>({});
  const scriptsRef = useRef(scripts);

  const runScriptEntry = (script: WorkspaceScript) => {
    if (!workspace || runs[script.name]?.kind === "running") return;
    void runScript(host, session, script, workspace, runNonce, (next) =>
      setRuns((current) => ({ ...current, [script.name]: next })),
    );
  };

  const updateWorkflowScript = (key: string, value: WorkflowScriptViewState) => {
    scriptsRef.current = { ...scriptsRef.current, [key]: value };
    setScripts(scriptsRef.current);
  };
  const toggleWorkflowScript = async (workflowId: string, scriptPath: string) => {
    const key = JSON.stringify([workflowId, scriptPath]);
    const previous = scriptsRef.current[key];
    if (previous && (previous.open || previous.result !== "error")) {
      updateWorkflowScript(key, { ...previous, open: !previous.open });
      return;
    }
    updateWorkflowScript(key, { open: true, result: "loading" });
    try {
      const result = await collectWorkflowScriptStream(
        bindStreamApi(orchestrationStatusApi, host, session.context, "^1.1.0").subscribe(
          "readWorkflowScript",
          { workflowId },
          session.signal,
        ),
        session.signal,
      );
      if (!session.signal.aborted)
        updateWorkflowScript(key, { open: scriptsRef.current[key]!.open, result });
    } catch {
      if (!session.signal.aborted)
        updateWorkflowScript(key, { open: scriptsRef.current[key]!.open, result: "error" });
    }
  };
  const closeWorkflowScript = (workflowId: string, scriptPath: string) => {
    const key = JSON.stringify([workflowId, scriptPath]);
    const previous = scriptsRef.current[key];
    if (previous) updateWorkflowScript(key, { ...previous, open: false });
  };

  const readLog = useCallback<ReadAgentLog>(
    (runId, signal) =>
      bindApi(orchestrationLogsApi, host, session.context).invoke(
        "readTail",
        { runId, ...AGENT_LOG_TAIL_REQUEST },
        AbortSignal.any([session.signal, signal]),
      ),
    [host, session],
  );

  const state = feed.state;
  const model = state ? deriveAgentsPanelModel(state.agents) : null;
  const planSource = planSourceThreadId(state, session.context.resource.threadId);

  return (
    <section
      aria-label="Agents"
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        color: "var(--t3-agents-text, var(--foreground, #20252d))",
        background: "var(--t3-agents-canvas, var(--background, #fff))",
        fontFamily: "var(--font-sans, system-ui, sans-serif)",
        fontSize: 13,
        ...themeVars,
      }}
    >
      <header
        style={{
          display: "flex",
          gap: 6,
          padding: 8,
          borderBottom: border,
          flexShrink: 0,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <strong style={{ fontSize: 13 }}>Agents</strong>
        <span style={{ color: muted, fontSize: 11 }}>thread scope</span>
        {state?.session && (
          <span style={{ color: muted, fontSize: 11 }}>
            {state.session.providerName ?? "provider"} · {state.session.status}
            {state.session.runtimeMode ? ` · ${state.session.runtimeMode}` : ""}
          </span>
        )}
        {state?.turn && <span style={{ color: muted, fontSize: 11 }}>turn {state.turn.state}</span>}
        {planSource && <PlanSourceLink host={host} session={session} threadId={planSource} />}
        {feed.streamEpoch && (
          <span style={{ color: muted, fontSize: 10, fontFamily: mono }}>rev {feed.revision}</span>
        )}
      </header>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {problem && (
          <div
            role="status"
            aria-label="Agent stream status"
            style={{ padding: "8px 10px", color: muted, fontSize: 12, borderBottom: border }}
          >
            Agent stream unavailable — {problem}
          </div>
        )}
        {capabilitiesRead.status === "unavailable" && (
          <div
            role="status"
            aria-label="Orchestration capability status"
            style={{ padding: "8px 10px", color: muted, fontSize: 12, borderBottom: border }}
          >
            Orchestration status unavailable — {capabilitiesRead.error}
          </div>
        )}
        {!problem && !state && capabilitiesRead.status !== "unavailable" && (
          <div
            role="status"
            aria-label="Agent stream status"
            style={{ padding: "8px 10px", color: muted, fontSize: 12, borderBottom: border }}
          >
            Waiting for the agent stream snapshot…
          </div>
        )}

        {state && (
          <>
            <SessionControls
              feed={feed}
              capabilities={capabilities}
              run={run}
              outcomeText={outcomeText}
              onRefreshCapabilities={refreshCapabilities}
            />
            <WorkflowLaunchSection
              capabilities={capabilities}
              run={run}
              outcomeText={outcomeText}
            />
            <PendingSection
              feed={feed}
              capabilities={capabilities}
              run={run}
              outcomeText={outcomeText}
            />
            <section
              aria-label="Agent roster"
              style={{ padding: "6px 10px", borderBottom: border }}
            >
              <div style={sectionTitle}>Roster</div>
              {model && !model.hasAgents && (
                <p style={{ margin: "0 0 4px", color: muted, fontSize: 12 }}>
                  No agents on this thread yet.
                </p>
              )}
              {model && model.hasAgents && (
                <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                  {model.workflows.map((group) => (
                    <WorkflowGroupView
                      key={group.workflow.id}
                      group={group}
                      scriptSupport={operationSupport(capabilities, "readWorkflowScript")}
                      onToggleScript={toggleWorkflowScript}
                      onCloseScript={closeWorkflowScript}
                      sessionControl={sessionControl}
                      readLog={readLog}
                      script={
                        scripts[
                          JSON.stringify([group.workflow.id, group.workflow.runHandles?.scriptPath])
                        ] ?? null
                      }
                    />
                  ))}
                  {model.directAgents.map((agent) => (
                    <AgentRow
                      key={agent.id}
                      agent={agent}
                      sessionControl={sessionControl}
                      readLog={readLog}
                    />
                  ))}
                </ul>
              )}
            </section>
            <CheckpointsSection
              feed={feed}
              capabilities={capabilities}
              host={host}
              session={session}
              run={run}
              outcomeText={outcomeText}
            />
          </>
        )}

        <section aria-label="Project scripts" style={{ padding: "6px 10px", borderBottom: border }}>
          <div style={sectionTitle}>Project scripts</div>
          {scriptsRead.status === "loading" && (
            <p style={{ margin: "0 0 6px", color: muted, fontSize: 12 }}>Reading t3.json…</p>
          )}
          {scriptsRead.status === "unavailable" && (
            <p style={{ margin: "0 0 6px", color: muted, fontSize: 12 }}>
              {describeAgentsError(scriptsRead.error, "t3.json is not readable in this workspace.")}
            </p>
          )}
          {scriptsRead.status === "ready" &&
            (() => {
              const source = parseT3ProjectFile(scriptsRead.value.contents);
              if (source.kind === "invalid")
                return (
                  <p style={{ margin: "0 0 6px", color: muted, fontSize: 12 }}>
                    {source.message} — fix t3.json to list its scripts here.
                  </p>
                );
              if (source.kind === "empty")
                return (
                  <p style={{ margin: "0 0 6px", color: muted, fontSize: 12 }}>
                    No checked-in t3.json scripts in this workspace.
                  </p>
                );
              return (
                <ul
                  aria-label="Checked-in t3.json scripts"
                  style={{
                    listStyle: "none",
                    margin: 0,
                    padding: 0,
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                  }}
                >
                  {source.scripts.map((script) => {
                    const runState = runs[script.name];
                    return (
                      <li
                        key={script.name}
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 2,
                          padding: "4px 0",
                        }}
                      >
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          <button
                            type="button"
                            aria-label={`Run ${script.name}`}
                            disabled={!workspace || runState?.kind === "running"}
                            onClick={() => runScriptEntry(script)}
                            style={control}
                          >
                            Run
                          </button>
                          <span
                            style={{
                              fontSize: 12,
                              minWidth: 0,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {script.name}
                            {script.runOnWorktreeCreate && (
                              <span style={{ color: muted }}> · setup</span>
                            )}
                            {script.previewUrl && (
                              <span style={{ color: muted }}> · preview is host-only</span>
                            )}
                          </span>
                        </div>
                        <code
                          style={{
                            fontFamily: mono,
                            fontSize: 11,
                            color: muted,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {script.command}
                        </code>
                        {runState && (
                          <output
                            aria-label={`Run status for ${script.name}`}
                            style={{ fontSize: 11, color: muted }}
                          >
                            {describeScriptRun(runState)}
                          </output>
                        )}
                      </li>
                    );
                  })}
                </ul>
              );
            })()}
          <p style={{ margin: "6px 0 0", color: muted, fontSize: 11 }}>{SCRIPTS_SCOPE_NOTE}</p>
        </section>

        <SessionImportSection host={host} session={session} />

        <section aria-label="Deferred capabilities" style={{ padding: "6px 10px" }}>
          <div style={sectionTitle}>Not available yet</div>
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {DEFERRED_SECTIONS.map((section) => (
              <li key={section.title} style={{ fontSize: 12 }}>
                <div>{section.title}</div>
                <div style={{ color: muted, fontSize: 11 }}>{section.blocker}</div>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <footer
        style={{
          padding: "6px 10px",
          borderTop: border,
          color: muted,
          fontSize: 11,
          flexShrink: 0,
        }}
      >
        {model?.hasAgents ? `${agentsFooterSummary(model)} — ` : ""}
        {HOST_CHROME_NOTE}
      </footer>
    </section>
  );
}

export default defineExtension({
  id: manifestId,
  version: "0.2.1",
  requires: [
    requireApi(workspaceFilesApi),
    requireApi(terminalControlApi),
    requireApi(orchestrationStatusApi, "^1.1.0"),
    requireApi(orchestrationControlApi),
    requireApi(agentSessionsApi),
    requireApi(orchestrationLogsApi),
    requireApi(uiThemeApi),
    requireApi(uiNavigationApi),
  ],
  surfaces: [
    {
      name: "view",
      title: "Agents",
      scope: "thread",
      placements: ["side-panel"],
      clients: ["web", "desktop"],
      capabilities: [],
      stateVersion: 1,
      // The panel keeps no persisted state — same null-only rule as native.
      validateRestore: (state) => state === null,
      createView(host, session) {
        return { renderer: () => <AgentsView host={host} session={session} /> };
      },
    },
  ],
});
