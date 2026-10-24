// Display-only records: no provider session, native thread, events or outbox effects.
export const namespace = "evidence-19307:";
export const timestamp = "2026-10-21T12:00:00.000Z";
export const fixtureNames = ["F0", "F1", "F2", "F2-watch", "F3", "F4"] as const;

export function buildFixture(name: string, foregroundStatus = "running") {
  if (!fixtureNames.some((candidate) => candidate === name)) throw new Error("Unknown fixture");
  if (
    !["idle", "queued", "preparing", "starting", "running", "waiting"].includes(foregroundStatus)
  ) {
    throw new Error("Unknown foreground status");
  }
  const threadId = `${namespace}thread`;
  const providerThreadId = `${namespace}provider-thread`;
  const provider = name === "F4" ? "claudeAgent" : "codex";
  const modelSelection = {
    instanceId: provider,
    model: name === "F4" ? "claude-sonnet-4-6" : "gpt-5.4",
  };
  const thread = {
    id: threadId,
    projectId: `${namespace}project`,
    title: "Background work evidence",
    providerInstanceId: provider,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: providerThreadId,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    pullRequests:
      name === "F3" || name === "F2-watch"
        ? [
            {
              host: "example.invalid",
              repository: "synthetic/evidence",
              number: 1,
              url: "https://example.invalid/synthetic/evidence/pull/1",
              source: "manual",
              linkedAt: timestamp,
              snapshot: null,
              stack: null,
              watch: {
                startedAt: timestamp,
                headSha: null,
                failedChecks: [],
                passed: false,
                passedChecks: [],
                remarksThrough: timestamp,
                remarkIds: [],
                conflicting: false,
                wakes: 0,
              },
            },
          ]
        : [],
    createdBy: "user",
    creationSource: "web",
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  const run = (ordinal: number, status: string) => ({
    id: `${namespace}run-${ordinal}`,
    threadId,
    ordinal,
    providerInstanceId: provider,
    modelSelection,
    providerThreadId,
    userMessageId: `${namespace}message-${ordinal}`,
    rootNodeId: null,
    activeAttemptId: null,
    status,
    queueHeld: false,
    queuePosition: null,
    requestedAt: timestamp,
    startedAt: status === "queued" ? null : timestamp,
    completedAt: status === "completed" ? timestamp : null,
    checkpointId: null,
    contextHandoffId: null,
  });
  const runs = [
    run(1, "completed"),
    run(2, foregroundStatus === "idle" ? "completed" : foregroundStatus),
  ];
  const baseItem = (id: string, ordinal: number, runId: string | null) => ({
    id: `${namespace}${id}`,
    threadId,
    runId,
    nodeId: null,
    providerThreadId,
    providerTurnId: null,
    nativeItemRef: { driver: provider, nativeId: `${namespace}${id}`, strength: "strong" },
    parentItemId: null,
    ordinal,
    status: "running",
    title: null,
    startedAt: timestamp,
    completedAt: null,
    updatedAt: timestamp,
  });
  const command = (
    id: string,
    ordinal: number,
    input: string,
    runId: string | null = runs[0]!.id,
  ) => ({
    ...baseItem(id, ordinal, runId),
    type: "command_execution",
    input,
  });
  const child = (id: string, ordinal: number, linked: boolean) => ({
    ...baseItem(id, ordinal, runs[0]!.id),
    type: "subagent",
    subagentId: `${namespace}node-${id}`,
    origin: "provider_native",
    driver: provider,
    providerInstanceId: provider,
    childThreadId: linked ? `${namespace}child` : null,
    prompt: "Inspect background result",
    result: null,
  });
  const history = [
    {
      ...baseItem("history-user", 0, runs[0]!.id),
      type: "user_message",
      status: "completed",
      messageId: `${namespace}message-1`,
      text: "Run the long task in the background, then inspect its result.",
      attachments: [],
      inputIntent: "turn_start",
      createdBy: "user",
      creationSource: "web",
    },
    {
      ...baseItem("history-assistant", 1, runs[0]!.id),
      type: "assistant_message",
      status: "completed",
      messageId: `${namespace}reply-1`,
      text: "The task is running in the background. You can continue working here.",
      streaming: false,
    },
  ];
  const tasks =
    name === "F0" || name === "F2-watch"
      ? []
      : name === "F4"
        ? [
            {
              ...baseItem("monitor-launch", 2, runs[0]!.id),
              type: "dynamic_tool",
              toolName: "Monitor",
              input: { command: "watch checks" },
              status: "completed",
              completedAt: timestamp,
            },
            {
              ...command("bash-launch", 3, "sleep 600 &"),
              status: "completed",
              completedAt: timestamp,
            },
          ]
        : name === "F2"
          ? [child("child-task", 2, true)]
          : name === "F3"
            ? [
                command("shell-1", 2, "sleep 600"),
                command("shell-2", 3, "Inspect_" + "long_unbroken_label_".repeat(12)),
                child("child-task", 4, true),
                child("unlinked-child", 5, false),
                {
                  ...baseItem("dynamic", 6, runs[0]!.id),
                  type: "dynamic_tool",
                  toolName: "Inspect background artifacts",
                  input: { persistent: false },
                },
              ]
            : [command("shell-1", 2, "sleep 600")];
  const foreground = [
    {
      ...command("foreground", 10, "sleep 15", runs[1]!.id),
      nativeItemRef: {
        driver: provider,
        nativeId: `${namespace}foreground-native`,
        strength: "strong",
      },
      status:
        foregroundStatus === "idle" || foregroundStatus === "waiting" ? "completed" : "running",
      completedAt: foregroundStatus === "idle" || foregroundStatus === "waiting" ? timestamp : null,
    },
  ];
  const roster =
    name === "F4"
      ? [
          {
            taskId: `${namespace}roster-monitor`,
            kind: "monitor",
            description: "Watch synthetic checks",
          },
          { taskId: `${namespace}roster-command`, kind: "command", description: "sleep 600" },
          ...(foregroundStatus === "idle" || foregroundStatus === "waiting"
            ? []
            : [
                {
                  taskId: `${namespace}foreground-native`,
                  kind: "command",
                  description: "sleep 15",
                },
              ]),
        ]
      : name === "F3"
        ? [
            { taskId: `${namespace}shell-1`, kind: "command", description: "sleep 600" },
            {
              taskId: `${namespace}roster-child`,
              kind: "subagent",
              description: "Inspect roster result",
            },
            {
              taskId: `${namespace}roster-monitor`,
              kind: "monitor",
              description: "Watch synthetic checks",
            },
            { taskId: `${namespace}roster-task`, kind: "background_task" },
          ]
        : [];
  const providerThread = {
    id: providerThreadId,
    driver: provider,
    providerInstanceId: provider,
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: runs.length,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: roster,
    contextUsage: null,
    nativeMetadata: null,
    goal:
      name === "F3"
        ? {
            objective: "Inspect the synthetic background results",
            status: "active",
            tokensUsed: 1000,
            tokenBudget: 10000,
          }
        : null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return {
    thread,
    runs,
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [providerThread],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [
      ...history,
      ...tasks,
      ...(name === "F3" ? [command("runless", 9, "Runless synthetic work", null)] : []),
      ...foreground,
    ],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: timestamp,
  };
}

export function buildChildFixture() {
  const projection = buildFixture("F0", "idle");
  const parentId = projection.thread.id;
  const childId = `${namespace}child`;
  const encoded = JSON.stringify(projection).replaceAll(parentId, childId);
  const child = JSON.parse(encoded) as typeof projection;
  return {
    ...child,
    thread: {
      ...child.thread,
      title: "Synthetic child result",
      activeProviderThreadId: null,
      lineage: {
        rootThreadId: parentId,
        parentThreadId: parentId,
        relationshipToParent: "subagent",
      },
    },
    turnItems: [],
    runs: [],
    providerThreads: [],
  };
}

// Vite-only imports run inside the app browser, not in the Node seed process.
export const browserInstaller = `async (fixtures, checkout) => {
    const root = globalThis;
    const atomModule = await import("/src/rpc/atomRegistry.ts");
    const threadModule = await import("/src/state/threads.ts");
    const schemaSource = await fetch(\`/@fs\${checkout}/packages/contracts/src/orchestrationV2.ts\`).then((response) => response.text());
    const schemaUrl = schemaSource.match(/import \\* as Schema from "([^"]+)"/)?.[1];
    if (!schemaUrl) throw new Error("Cannot locate the app's Schema module");
    const schema = await import(schemaUrl);
    const contracts = await import(\`/@fs\${checkout}/packages/contracts/src/orchestrationV2.ts\`);
    const registry = atomModule.appAtomRegistry;
    const threads = threadModule.environmentThreadShells;
    const details = threadModule.environmentThreadDetails;
    const parts = location.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const ref = { environmentId: parts[0], threadId: parts[1] };
    const original = registry.get(threads.threadShellAtom(ref));
    if (!original) throw new Error("Open the synthetic thread route before installing fixtures");
    // A repeated install must not capture the previous install's FixedDate.
    const RealDate = root.__evidenceRealDate ?? Date;
    root.__evidenceRealDate = RealDate;
    root.__evidenceClock = RealDate.parse("2026-10-21T12:00:00.000Z");
    // Patch wall-clock reads only; recordings keep normal browser animation timing.
    // A function, not a class, so Date() called without new still returns a string.
    function FixedDate(...args) {
      const clock = Number(root.__evidenceClock);
      if (!new.target) return new RealDate(clock).toString();
      return Reflect.construct(RealDate, args.length === 0 ? [clock] : args, new.target);
    }
    FixedDate.prototype = Object.create(RealDate.prototype, { constructor: { value: FixedDate, writable: true, configurable: true } });
    Object.setPrototypeOf(FixedDate, RealDate);
    FixedDate.now = () => Number(root.__evidenceClock);
    Object.defineProperty(globalThis, "Date", { value: FixedDate, configurable: true });
    const bind = (atom, value) => {
      atom.read = () => value;
      registry.ensureNode(atom).setValue(value);
    };
    const send = root.__evidenceOriginalSend ?? WebSocket.prototype.send;
    root.__evidenceOriginalSend = send;
    const requests = [];
    root.__evidenceRequests = requests;
    root.__evidenceHoldStops = true;
    WebSocket.prototype.send = function (data) {
      if (typeof data === "string" && /thread\\.stop|turn\\.interrupt/.test(data)) {
        requests.push({ socket: this, data });
        if (root.__evidenceHoldStops) return;
      }
      send.call(this, data);
    };
    root.acceptEvidenceStop = () => {
      const request = requests.at(-1);
      if (!request) throw new Error("No held Stop request");
      const frame = JSON.parse(request.data);
      request.socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
        _tag: "Exit", requestId: frame.id, exit: { _tag: "Success", value: { sequence: 0 } },
      }) }));
      return { accepted: true, synthetic: true, retainedTasks: true };
    };
    root.installEvidence = (name, phase, runtimeStatus = phase) => {
      const encoded = structuredClone(fixtures[\`\${name}:\${phase}\`]);
      if (phase === "queued" && runtimeStatus === "waiting") {
        encoded.runs[0].status = "waiting";
        encoded.runs[0].completedAt = null;
      }
      const projection = schema.decodeUnknownSync(contracts.OrchestrationV2ThreadProjectionJson)(encoded);
      projection.visibleTurnItems = projection.turnItems.map((item, position) => ({
        position, visibility: "local", sourceThreadId: projection.thread.id, sourceItemId: item.id, item,
      }));
      const latest = projection.runs.at(-1);
      const active = phase !== "idle";
      const now = "2026-10-21T12:00:00.000Z";
      const detailAtom = details.stateAtom(ref);
      const state = registry.get(detailAtom);
      bind(detailAtom, { ...state, status: "live", data: { ...state.data, value: projection } });
      const shell = { ...original, providerInstanceId: projection.thread.providerInstanceId, modelSelection: projection.thread.modelSelection, updatedAt: now, goal: projection.providerThreads[0].goal,
        latestRun: { runId: latest.id, status: latest.status, requestedAt: now, startedAt: phase === "queued" ? null : now, completedAt: active ? null : now, assistantMessageId: null },
        runtime: { ...original.runtime, status: active ? runtimeStatus : "idle", activeRunId: active ? (phase === "queued" && runtimeStatus === "waiting" ? projection.runs[0].id : latest.id) : null, activityStartedAt: active ? now : null, updatedAt: now },
      };
      for (const method of ["threadShellAtom", "quietThreadShellAtom"]) bind(threads[method](ref), shell);
      root.__evidenceProjection = projection;
      const derivedPhase = ["queued", "preparing", "starting"].includes(runtimeStatus) ? "connecting" : ["running", "waiting"].includes(runtimeStatus) ? "running" : "ready";
      root.__evidenceFixture = { name, phase, runtimeStatus, derivedPhase, syntheticRuntime: true };
      return { ...root.__evidenceFixture, tasks: projection.turnItems.length };
    };
    root.pinEvidenceEndpoint = async (appearance) => {
      localStorage.setItem("t3code:theme", appearance);
      localStorage.setItem("t3code:theme-follow-system", "false");
      localStorage.setItem("t3code:theme-appearance-mode", appearance);
      dispatchEvent(new StorageEvent("storage", { key: "t3code:theme" }));
      await document.fonts.ready;
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      for (const element of document.querySelectorAll("*")) {
        if (element.scrollHeight > element.clientHeight && element.clientHeight > 100) element.scrollTop = element.scrollHeight;
      }
      for (const animation of document.getAnimations()) {
        if (animation.effect?.getComputedTiming().iterations === Infinity) {
          animation.pause(); animation.currentTime = 0;
        } else animation.finish();
      }
      return { appearance, width: innerWidth, height: innerHeight, dpr: devicePixelRatio, dateNow: Date.now(), actualDate: new RealDate().toISOString(), fonts: document.fonts.status };
    };
    return { installed: true, fidelity: "real chat route with client projection fixture; Stop transport held and acceptance simulated", ref };
  }`;
