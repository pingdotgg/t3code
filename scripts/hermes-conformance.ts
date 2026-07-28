#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalFetch:off globalTimers:off - The harness verifies and launches an external runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

import {
  HERMES_PINNED_REVISION,
  canRunModeProbe,
  exitCodeFor,
  renderEvidenceReport,
  sanitizeRecords,
  verifyPinnedSource,
  type CaptureRecord,
  type ProbeResult,
  type ProbeSafety,
} from "./lib/hermes-conformance.ts";

interface Options {
  readonly mode: "launch" | "attach";
  readonly source: string | undefined;
  readonly outputDirectory: string;
  readonly url: string | undefined;
}

interface RpcResponse {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
  readonly conformanceDisposition?: "indeterminate";
}

interface PythonRuntimeEvidence {
  readonly executable: string;
  readonly version: string;
  readonly sysPath: ReadonlyArray<string>;
  readonly modulePaths: Readonly<Record<string, string>>;
  readonly dependencyFingerprint: string;
}

interface CapturedEvent {
  readonly type: string;
  readonly sequence: number;
  readonly sessionId: string | undefined;
  readonly status: string | undefined;
  readonly toolId: string | undefined;
}

const options = parseOptions(process.argv.slice(2));
const hostPlatform = Effect.runSync(HostProcessPlatform);
const rawDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hermes-conformance-"));
NodeFS.chmodSync(rawDirectory, 0o700);
const rawCapturePath = NodePath.join(rawDirectory, "capture.raw.jsonl");
const processLogPath = NodePath.join(rawDirectory, "hermes-serve.log");
const revision = verifyPinnedSource(options.source);
const harnessFingerprint = computeHarnessFingerprint();
const results: ProbeResult[] = [
  {
    id: "runtime-revision",
    area: "handshake/version",
    safety: "read",
    status:
      options.mode === "launch" && revision.verified
        ? "passed"
        : options.mode === "attach"
          ? "blocked"
          : "failed",
    summary:
      options.mode === "attach"
        ? "gateway.ready carries no build revision; an attached process cannot prove the pinned runtime"
        : revision.reason,
    critical: true,
  },
];
const records: CaptureRecord[] = [];
let sequence = 0;
let child: NodeChildProcess.ChildProcess | undefined;
let client: RpcClient | undefined;
let automaticWritesHalted = false;
let cleanupPromise: Promise<void> | undefined;
let cleanupVerified: boolean | undefined;
let cleanupEvidenceSequence: number | undefined;
let cleanupOwnedProcessCount = 0;

for (const [signal, exitCode] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(exitCode));
  });
}

async function main(): Promise<void> {
  try {
    const revisionSequence = record("harness", {
      type: "source-verification",
      expected_revision: revision.expected,
      actual_revision: revision.actual,
      clean: revision.clean,
      verified: revision.verified,
      source: revision.sourcePath,
    });
    const runtimeRevisionResult = results[0];
    if (!runtimeRevisionResult) throw new Error("runtime revision probe was not initialized");
    results[0] = { ...runtimeRevisionResult, evidence: [revisionSequence] };
    const endpoint =
      options.mode === "launch" ? await launchPinnedHermes() : requireAttachUrl(options);
    client = new RpcClient(endpoint, record);
    await client.connect();

    const ready = await client.waitForEvent("gateway.ready", 5_000);
    results.push({
      id: "gateway-ready",
      area: "handshake/version",
      safety: "read",
      status: ready ? "passed" : "failed",
      summary: ready
        ? "gateway.ready observed; payload has skin only and no protocol version/capability inventory"
        : "gateway.ready was not observed",
      critical: true,
      ...(ready ? { evidence: [ready.sequence] } : {}),
    });
    results.push({
      id: "protocol-negotiation",
      area: "handshake/version",
      safety: "read",
      status: "blocked",
      summary:
        "pinned gateway exposes desktop_contract later, but no negotiated protocol or capabilities",
      critical: true,
    });

    await runReadProbe(client, results, "sessions-list", "sessions", "session.list", {});
    await runReadProbe(
      client,
      results,
      "commands-catalog",
      "commands/models",
      "commands.catalog",
      {},
    );
    await runReadProbe(client, results, "models-inventory", "commands/models", "model.options", {
      explicit_only: true,
      include_unconfigured: false,
    });
    await runReadProbe(client, results, "cron-list", "cron", "cron.manage", { action: "list" });

    const unknownStart = records.length;
    client.notify("t3.conformance.unknown", { sentinel: "unknown-notification" });
    await delay(100);
    const connectionCheck = await client.request("session.list", {});
    const unknownRecords = records.slice(unknownStart);
    const returnedNullIdError = unknownRecords.some((entry) => {
      const frame = asRecord(entry.frame);
      return (
        entry.direction === "server" && frame?.id === null && asRecord(frame.error) !== undefined
      );
    });
    results.push({
      id: "unknown-method-connection-survival",
      area: "unknown notifications",
      safety: "read",
      status: isOk(connectionCheck) ? "passed" : "failed",
      summary: returnedNullIdError
        ? "gateway returned an id-null method-not-found error, but a known read still succeeded on the same connection"
        : "gateway produced no correlated response and a known read succeeded on the same connection",
      evidence: unknownRecords.map((entry) => entry.sequence),
    });

    const writeGate = probeGate("disposable-write");
    let sessionId: string | undefined;
    let storedSessionId: string | undefined;
    if (!writeGate.allowed) {
      for (const [id, area] of [
        ["session-lifecycle", "sessions"],
        ["prompt-events", "prompt/events"],
        ["synthetic-interrupt", "prompt/events"],
        ["attachment-image", "attachments"],
        ["attachment-file", "attachments"],
        ["attachment-pdf", "attachments"],
        ["title-fork", "fork/title"],
        ["cold-durable-resume", "disconnect/reconnect"],
        ["durable-transcript-recovery", "disconnect/reconnect"],
        ["ambiguous-mutation", "ambiguous mutations"],
      ] as const) {
        results.push(blocked(id, area, "disposable-write", writeGate.reason));
      }
    } else {
      const created = await client.request("session.create", {
        cwd: NodePath.join(rawDirectory, "workspace"),
        close_on_disconnect: true,
        source: "t3-h0-conformance",
        title: "T3 H0 disposable conformance",
      });
      const creation = asRecord(created.result);
      sessionId = asString(creation?.session_id);
      storedSessionId = asString(creation?.stored_session_id);
      results.push(
        responseResult({
          id: "session-lifecycle",
          area: "sessions",
          safety: "disposable-write",
          response: created,
          summary:
            sessionId && storedSessionId
              ? "created disposable session; stored_session_id retained separately from ephemeral live sid"
              : "session.create did not return both identities",
          require: Boolean(sessionId && storedSessionId),
          critical: true,
        }),
      );

      if (sessionId) {
        await runSessionWriteProbes(client, results, sessionId, storedSessionId, rawDirectory);
        const reconnected = await runReconnectProbe(
          client,
          results,
          endpoint,
          sessionId,
          storedSessionId,
        );
        client = reconnected.client;
        sessionId = reconnected.sessionId;
      }
    }

    await runOptionalLiveScenarios(client, results, sessionId);
    runKnownGapResults(results);
    await runCronMutationProbe(client, results);
    if (sessionId) {
      client = await runAmbiguousMutationProbe(
        client,
        results,
        endpoint,
        sessionId,
        storedSessionId,
      );
    }

    await cleanup();
    results.push({
      id: "runtime-cleanup",
      area: "process isolation",
      safety: "read",
      status: cleanupVerified ? "passed" : "failed",
      summary: child
        ? cleanupVerified
          ? `snapshotted ${cleanupOwnedProcessCount} owned process(es) and verified every PID exited`
          : "could not prove that every snapshotted Hermes descendant exited"
        : "attach mode launched no process",
      critical: true,
      ...(cleanupEvidenceSequence ? { evidence: [cleanupEvidenceSequence] } : {}),
    });

    const outputDirectory = NodePath.resolve(options.outputDirectory);
    NodeFS.mkdirSync(outputDirectory, { recursive: true });
    const fixturePath = NodePath.join(outputDirectory, "capture.sanitized.jsonl");
    const reportPath = NodePath.join(outputDirectory, "evidence.md");
    writeJsonLines(rawCapturePath, records, 0o600);
    writeJsonLines(fixturePath, sanitizeRecords(records));
    NodeFS.writeFileSync(
      reportPath,
      renderEvidenceReport({
        generatedAt: new Date().toISOString(),
        mode: options.mode,
        endpoint: redactEndpoint(endpoint),
        revision,
        rawCapturePath: "<private temporary capture; printed by harness>",
        fixturePath: NodePath.basename(fixturePath),
        harnessFingerprint,
        invocation: renderInvocation(),
        results,
      }),
    );

    const code = exitCodeFor(results);
    console.log(`Sanitized fixture: ${fixturePath}`);
    console.log(`Evidence report: ${reportPath}`);
    console.log(`Sensitive raw capture: ${rawCapturePath}`);
    process.exitCode = code;
  } catch (error) {
    record("harness", { type: "fatal", error: errorMessage(error) });
    writeJsonLines(rawCapturePath, records, 0o600);
    console.error(`Hermes H0 conformance failed: ${errorMessage(error)}`);
    console.error(`Sensitive raw capture: ${rawCapturePath}`);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
}

function cleanup(): Promise<void> {
  cleanupPromise ??= (async () => {
    client?.close();
    if (!child) {
      cleanupVerified = true;
      cleanupEvidenceSequence = record("harness", {
        type: "cleanup-skipped",
        reason: "attach mode launched no process",
        verified: true,
      });
      return;
    }

    if (hostPlatform === "win32" || !child.pid || !childRunning(child)) {
      cleanupVerified = false;
      cleanupEvidenceSequence = record("harness", {
        type: "cleanup-failed",
        reason:
          hostPlatform === "win32"
            ? "process-tree inspection is unavailable on Windows"
            : "top-level Hermes process exited before its descendants could be snapshotted",
        verified: false,
      });
      process.exitCode = 1;
      return;
    }

    let ownedProcessIds: ReadonlyArray<number>;
    try {
      ownedProcessIds = collectDescendantProcessIds(child.pid);
    } catch (error) {
      cleanupVerified = false;
      cleanupEvidenceSequence = record("harness", {
        type: "cleanup-failed",
        reason: errorMessage(error),
        verified: false,
      });
      process.exitCode = 1;
      return;
    }
    cleanupOwnedProcessCount = ownedProcessIds.length;

    signalOwnedProcesses(child, ownedProcessIds, "SIGTERM");
    let survivors = await waitForProcessIdsExit(ownedProcessIds, 2_000);
    if (survivors.length > 0) {
      signalOwnedProcesses(child, survivors, "SIGKILL");
      survivors = await waitForProcessIdsExit(survivors, 2_000);
    }
    await waitForChildExit(child, 100);
    cleanupVerified = survivors.length === 0 && !childRunning(child);
    cleanupEvidenceSequence = record("harness", {
      type: cleanupVerified ? "cleanup-complete" : "cleanup-failed",
      count: ownedProcessIds.length,
      survivors,
      verified: cleanupVerified,
    });
    if (!cleanupVerified) process.exitCode = 1;
  })();
  return cleanupPromise;
}

function signalOwnedProcesses(
  processHandle: NodeChildProcess.ChildProcess,
  processIds: ReadonlyArray<number>,
  signal: NodeJS.Signals,
): void {
  if (hostPlatform !== "win32" && processHandle.pid) {
    try {
      process.kill(-processHandle.pid, signal);
    } catch {
      // Detached descendants are signalled individually below.
    }
  }
  for (const pid of processIds.toReversed()) {
    if (pid === process.pid) continue;
    try {
      process.kill(pid, signal);
    } catch {
      // A process that exited between the snapshot and signal is already clean.
    }
  }
}

function childRunning(processHandle: NodeChildProcess.ChildProcess): boolean {
  return processHandle.exitCode === null && processHandle.signalCode === null;
}

function collectDescendantProcessIds(rootPid: number): ReadonlyArray<number> {
  const processTable = NodeChildProcess.spawnSync("ps", ["-axo", "pid=,ppid="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (processTable.status !== 0) {
    throw new Error(`unable to inspect Hermes process tree: ${processTable.stderr.trim()}`);
  }
  const childrenByParent = new Map<number, number[]>();
  for (const line of processTable.stdout.split("\n")) {
    const [pidText, parentPidText] = line.trim().split(/\s+/, 2);
    const pid = Number(pidText);
    const parentPid = Number(parentPidText);
    if (!Number.isInteger(pid) || !Number.isInteger(parentPid)) continue;
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(pid);
    childrenByParent.set(parentPid, children);
  }
  const owned = [rootPid];
  for (let index = 0; index < owned.length; index += 1) {
    for (const childPid of childrenByParent.get(owned[index]!) ?? []) {
      if (!owned.includes(childPid)) owned.push(childPid);
    }
  }
  return owned;
}

async function waitForProcessIdsExit(
  processIds: ReadonlyArray<number>,
  timeoutMs: number,
): Promise<ReadonlyArray<number>> {
  const deadline = Date.now() + timeoutMs;
  let survivors = processIds.filter(isProcessAlive);
  while (survivors.length > 0 && Date.now() < deadline) {
    await delay(20);
    survivors = survivors.filter(isProcessAlive);
  }
  return survivors;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function launchPinnedHermes(): Promise<string> {
  if (!revision.verified || !revision.sourcePath) {
    throw new Error(`Refusing to launch an unverified Hermes checkout: ${revision.reason}`);
  }
  const python =
    process.env.HERMES_CONFORMANCE_PYTHON ||
    NodePath.join(revision.sourcePath, ".venv", "bin", "python");
  if (!NodeFS.existsSync(python)) {
    throw new Error(
      `Pinned checkout Python not found at ${python}; set HERMES_CONFORMANCE_PYTHON explicitly`,
    );
  }

  const port = await reserveLoopbackPort();
  const token = NodeCrypto.randomBytes(32).toString("hex");
  const workspace = NodePath.join(rawDirectory, "workspace");
  const profile = NodePath.join(rawDirectory, "profile");
  NodeFS.mkdirSync(workspace, { recursive: true });
  NodeFS.mkdirSync(profile, { recursive: true });
  const log = NodeFS.openSync(processLogPath, "a", 0o600);
  const childEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    GATEWAY_MULTIPLEX_PROFILES: "0",
    HERMES_DASHBOARD_SESSION_TOKEN: token,
    HERMES_HOME: profile,
    HERMES_ISO_CERTIFY_SYNTH_TURN: process.env.HERMES_CONFORMANCE_ALLOW_LIVE === "1" ? "" : "1",
    HERMES_TUI_WS_ORPHAN_REAP_GRACE_S: "0",
    PYTHONHASHSEED: "0",
    PYTHONNOUSERSITE: "1",
    PYTHONPATH: revision.sourcePath,
    PYTHONSAFEPATH: "1",
  };
  delete childEnvironment.HERMES_PROFILE;
  delete childEnvironment.PYTHONSTARTUP;
  const pythonRuntime = verifyPythonImport(
    python,
    revision.sourcePath,
    workspace,
    childEnvironment,
  );

  child = NodeChildProcess.spawn(
    python,
    [
      "-m",
      "hermes_cli.main",
      "serve",
      "--isolated",
      "--skip-build",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: workspace,
      detached: hostPlatform !== "win32",
      env: childEnvironment,
      stdio: ["ignore", log, log],
    },
  );
  record("harness", {
    type: "launch",
    executable: python,
    args: [
      "-m",
      "hermes_cli.main",
      "serve",
      "--isolated",
      "--skip-build",
      "--host",
      "127.0.0.1",
      "--port",
      port,
    ],
    cwd: workspace,
    profile,
    source: revision.sourcePath,
    python_runtime: pythonRuntime,
    revision: HERMES_PINNED_REVISION,
  });
  await waitForBackendSentinel(port, child);
  return `ws://127.0.0.1:${port}/api/ws?token=${token}`;
}

async function runSessionWriteProbes(
  rpc: RpcClient,
  targetResults: ProbeResult[],
  sessionId: string,
  storedSessionId: string | undefined,
  runDirectory: string,
): Promise<void> {
  const promptSafety: ProbeSafety =
    options.mode === "launch" && process.env.HERMES_CONFORMANCE_ALLOW_LIVE !== "1"
      ? "disposable-write"
      : "live";
  const promptGate = probeGate(promptSafety);
  if (!promptGate.allowed) {
    targetResults.push(blocked("prompt-events", "prompt/events", promptSafety, promptGate.reason));
  } else {
    const start = records.length;
    const startSequence = sequence;
    const response = await rpc.request(
      "prompt.submit",
      {
        session_id: sessionId,
        text:
          promptSafety === "live"
            ? process.env.HERMES_CONFORMANCE_TEXT_PROMPT || "Reply with exactly H0-CONFORMANCE."
            : JSON.stringify({ duration_s: 0.15, delta_interval_s: 0.02, chunk: 2_000 }),
      },
      30_000,
    );
    const complete = isIndeterminate(response)
      ? undefined
      : await rpc.waitForEvent("message.complete", 30_000, startSequence, sessionId);
    const promptEvents = eventsSince(start, sessionId);
    const orderedTypes = promptEvents.map((event) => event.type);
    const startIndex = orderedTypes.indexOf("message.start");
    const deltaIndex = orderedTypes.indexOf("message.delta");
    const completeIndex = orderedTypes.indexOf("message.complete");
    targetResults.push(
      responseResult({
        id: "prompt-events",
        area: "prompt/events",
        safety: promptSafety,
        response,
        require:
          complete?.status === "complete" &&
          startIndex >= 0 &&
          deltaIndex > startIndex &&
          completeIndex > deltaIndex,
        summary: `session-correlated event order: ${orderedTypes.join(" → ") || "none"}`,
        critical: true,
        evidence: [response.sequence, ...promptEvents.map((event) => event.sequence)].sort(
          (left, right) => left - right,
        ),
      }),
    );
  }

  if (options.mode === "launch" && process.env.HERMES_CONFORMANCE_ALLOW_LIVE !== "1") {
    const start = records.length;
    const startSequence = sequence;
    const submitted = await rpc.request("prompt.submit", {
      session_id: sessionId,
      text: JSON.stringify({ duration_s: 2, delta_interval_s: 0.02, chunk: 2_000 }),
    });
    const started = await rpc.waitForEvent("message.start", 5_000, startSequence, sessionId);
    const interrupted = started
      ? await rpc.request("session.interrupt", { session_id: sessionId })
      : undefined;
    const completed = started
      ? await rpc.waitForEvent("message.complete", 5_000, startSequence, sessionId)
      : undefined;
    const interruptResult = asRecord(interrupted?.result);
    const interruptEvents = eventsSince(start, sessionId);
    targetResults.push({
      id: "synthetic-interrupt",
      area: "prompt/events",
      safety: "disposable-write",
      status:
        isIndeterminate(submitted) || (interrupted && isIndeterminate(interrupted))
          ? "indeterminate"
          : isOk(submitted) &&
              started &&
              interrupted &&
              isOk(interrupted) &&
              interruptResult?.status === "interrupted" &&
              completed?.status === "interrupted"
            ? "passed"
            : "failed",
      summary: `interrupt response and session-correlated completion observed; events: ${interruptEvents.map((event) => event.type).join(" → ") || "none"}`,
      critical: true,
      evidence: [
        submitted.sequence,
        ...(started ? [started.sequence] : []),
        ...(interrupted ? [interrupted.sequence] : []),
        ...(completed ? [completed.sequence] : []),
      ].sort((left, right) => left - right),
    });
  } else {
    targetResults.push(
      blocked(
        "synthetic-interrupt",
        "prompt/events",
        "disposable-write",
        "deterministic interrupt probe runs only in launch-mode synthetic isolation",
        true,
      ),
    );
  }

  const image = await rpc.request("image.attach_bytes", {
    session_id: sessionId,
    filename: "h0.png",
    content_base64:
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  });
  const file = await rpc.request("file.attach", {
    session_id: sessionId,
    name: "h0.txt",
    data_url: `data:text/plain;base64,${Buffer.from("H0 disposable attachment\n").toString("base64")}`,
  });
  const pdf = await rpc.request("pdf.attach", {
    session_id: sessionId,
    filename: "h0.pdf",
    content_base64: Buffer.from(minimalPdf()).toString("base64"),
    first_page: 1,
    last_page: 1,
  });
  const imageResult = asRecord(image.result);
  targetResults.push({
    id: "attachment-image",
    area: "attachments",
    safety: "disposable-write",
    status: isIndeterminate(image)
      ? "indeterminate"
      : isOk(image) && imageResult?.attached === true && Number(imageResult.bytes) > 0
        ? "passed"
        : "failed",
    summary: "image bytes were accepted and reported attached with a non-zero byte count",
    evidence: [image.sequence],
  });
  const fileResult = asRecord(file.result);
  targetResults.push({
    id: "attachment-file",
    area: "attachments",
    safety: "disposable-write",
    status: isIndeterminate(file)
      ? "indeterminate"
      : isOk(file) &&
          fileResult?.attached === true &&
          fileResult.uploaded === true &&
          fileResult.name === "h0.txt"
        ? "passed"
        : "failed",
    summary: "ordinary file bytes were uploaded under the expected disposable identity",
    evidence: [file.sequence],
  });
  const pdfResult = asRecord(pdf.result);
  const pdfPages = Array.isArray(pdfResult?.pages) ? pdfResult.pages : [];
  const missingPoppler =
    pdf.error?.code === 5028 && (pdf.error.message || "").includes("pdftoppm not installed");
  targetResults.push({
    id: "attachment-pdf",
    area: "attachments",
    safety: "disposable-write",
    status: isIndeterminate(pdf)
      ? "indeterminate"
      : missingPoppler
        ? "blocked"
        : isOk(pdf) &&
            pdfResult?.attached === true &&
            pdfResult.filename === "h0.pdf" &&
            pdfResult.pages_attached === 1 &&
            pdfPages.length === 1 &&
            asRecord(pdfPages[0])?.page === 1
          ? "passed"
          : "failed",
    summary: missingPoppler
      ? "PDF rendering blocked because the pinned runtime reported missing pdftoppm"
      : "one-page PDF upload required attached page identity and page metadata",
    evidence: [pdf.sequence],
  });

  if (!storedSessionId) {
    targetResults.push(
      blocked("title-fork", "fork/title", "disposable-write", "stored session identity missing"),
    );
    return;
  }
  const title = await rpc.request("session.title", {
    session_id: sessionId,
    title: "T3 H0 renamed",
  });
  const branch = await rpc.request("session.branch", {
    session_id: sessionId,
    name: "T3 H0 latest-only branch",
  });
  targetResults.push({
    id: "title-fork",
    area: "fork/title",
    safety: "disposable-write",
    status:
      isIndeterminate(title) || isIndeterminate(branch)
        ? "indeterminate"
        : isOk(title) && isOk(branch)
          ? "passed"
          : "failed",
    summary:
      "title acknowledgement and latest-head branch probed; protocol has no message/run boundary parameter",
    evidence: [title.sequence, branch.sequence],
  });

  NodeFS.writeFileSync(NodePath.join(runDirectory, "workspace", "identity.txt"), storedSessionId);
}

async function runReconnectProbe(
  rpc: RpcClient,
  targetResults: ProbeResult[],
  endpoint: string,
  sessionId: string,
  storedSessionId: string | undefined,
): Promise<{ readonly client: RpcClient; readonly sessionId: string }> {
  if (!storedSessionId) return { client: rpc, sessionId };
  rpc.close();
  await delay(150);
  const replacement = new RpcClient(endpoint, record);
  await replacement.connect();
  await replacement.waitForEvent("gateway.ready", 5_000);
  const resumed = await replacement.request("session.resume", {
    session_id: storedSessionId,
    cols: 80,
  });
  const resumeResult = asRecord(resumed.result);
  const resumedSid = asString(resumeResult?.session_id) || sessionId;
  const resumedStoredSessionId =
    asString(resumeResult?.session_key) || asString(resumeResult?.stored_session_id);
  const history = await replacement.request("session.history", { session_id: resumedSid });
  const historyCount = Number(asRecord(history.result)?.count ?? 0);
  targetResults.push({
    id: "cold-durable-resume",
    area: "disconnect/reconnect",
    safety: "disposable-write",
    status:
      isOk(resumed) &&
      isOk(history) &&
      resumeResult?.resumed === storedSessionId &&
      resumedStoredSessionId === storedSessionId &&
      resumedSid !== sessionId
        ? "passed"
        : "failed",
    summary:
      "close_on_disconnect forced live teardown; cold resume returned a new sid bound to the original durable session key",
    critical: true,
    evidence: [resumed.sequence, history.sequence],
  });
  targetResults.push({
    id: "durable-transcript-recovery",
    area: "disconnect/reconnect",
    safety: process.env.HERMES_CONFORMANCE_ALLOW_LIVE === "1" ? "live" : "disposable-write",
    status:
      process.env.HERMES_CONFORMANCE_ALLOW_LIVE === "1" && historyCount > 0 ? "passed" : "blocked",
    summary:
      process.env.HERMES_CONFORMANCE_ALLOW_LIVE === "1"
        ? historyCount > 0
          ? `history contained ${historyCount} persisted message(s) after reconnect`
          : "configured live turn did not yield persisted history"
        : "synthetic streaming seam does not persist transcript history; a configured real provider/test seam is required",
    critical: true,
    evidence: [history.sequence],
  });
  return { client: replacement, sessionId: resumedSid };
}

async function runAmbiguousMutationProbe(
  rpc: RpcClient,
  targetResults: ProbeResult[],
  endpoint: string,
  sessionId: string,
  storedSessionId: string | undefined,
): Promise<RpcClient> {
  const gate = probeGate("live");
  if (!gate.allowed || !storedSessionId) {
    targetResults.push(
      blocked(
        "ambiguous-mutation",
        "ambiguous mutations",
        "live",
        !storedSessionId ? "stored session identity missing" : gate.reason,
        true,
      ),
    );
    return rpc;
  }

  const admission = rpc.sendWithoutWaiting("prompt.submit", {
    session_id: sessionId,
    text:
      process.env.HERMES_CONFORMANCE_AMBIGUOUS_PROMPT ||
      "Reply with exactly AMBIGUOUS-H0 and perform no tools.",
  });
  if (!admission.sent) {
    targetResults.push({
      id: "ambiguous-mutation",
      area: "ambiguous mutations",
      safety: "live",
      status: "indeterminate",
      summary:
        "probe was not sent because an earlier mutation was already indeterminate; global write halt remained active",
      critical: true,
      evidence: [admission.sequence],
    });
    return rpc;
  }
  rpc.close();
  const replacement = new RpcClient(endpoint, record);
  await replacement.connect();
  await replacement.waitForEvent("gateway.ready", 5_000);
  const sessions = await replacement.request("session.list", {});
  targetResults.push({
    id: "ambiguous-mutation",
    area: "ambiguous mutations",
    safety: "live",
    status: "indeterminate",
    summary:
      "connection closed immediately after prompt send; harness halted writes, performed session.list only, and did not replay or resume",
    critical: true,
    evidence: [admission.sequence, sessions.sequence],
  });
  return replacement;
}

async function runOptionalLiveScenarios(
  rpc: RpcClient,
  targetResults: ProbeResult[],
  sessionId: string | undefined,
): Promise<void> {
  await runReviewedLiveEventScenario(rpc, targetResults, sessionId, {
    id: "tool-events",
    area: "tools",
    promptVariable: "HERMES_CONFORMANCE_TOOL_PROMPT",
    requiredTypes: ["tool.start", "tool.complete"],
  });
  await runReviewedLiveEventScenario(rpc, targetResults, sessionId, {
    id: "approval-event",
    area: "approvals",
    promptVariable: "HERMES_CONFORMANCE_APPROVAL_PROMPT",
    requiredTypes: ["approval.request"],
    interruptAfterObservation: true,
  });
  await runReviewedLiveEventScenario(rpc, targetResults, sessionId, {
    id: "clarification-event",
    area: "clarification",
    promptVariable: "HERMES_CONFORMANCE_CLARIFICATION_PROMPT",
    requiredTypes: ["clarify.request"],
    interruptAfterObservation: true,
  });
}

async function runReviewedLiveEventScenario(
  rpc: RpcClient,
  targetResults: ProbeResult[],
  sessionId: string | undefined,
  scenario: {
    readonly id: string;
    readonly area: string;
    readonly promptVariable:
      | "HERMES_CONFORMANCE_TOOL_PROMPT"
      | "HERMES_CONFORMANCE_APPROVAL_PROMPT"
      | "HERMES_CONFORMANCE_CLARIFICATION_PROMPT";
    readonly requiredTypes: ReadonlyArray<string>;
    readonly interruptAfterObservation?: boolean;
  },
): Promise<void> {
  const gate = probeGate("live");
  const prompt = process.env[scenario.promptVariable];
  if (!gate.allowed || !prompt || !sessionId) {
    targetResults.push(
      blocked(
        scenario.id,
        scenario.area,
        "live",
        !prompt
          ? `set ${scenario.promptVariable} with one explicitly reviewed scenario`
          : !sessionId
            ? "no disposable session"
            : gate.reason,
        true,
      ),
    );
    return;
  }

  const start = records.length;
  const startSequence = sequence;
  const response = await rpc.request(
    "prompt.submit",
    { session_id: sessionId, text: prompt },
    120_000,
  );
  const toolScenario = scenario.id === "tool-events";
  const observed = isIndeterminate(response)
    ? undefined
    : toolScenario
      ? await rpc.waitForEvent("message.complete", 120_000, startSequence, sessionId)
      : await rpc.waitForAnyEvent(
          [...scenario.requiredTypes, "message.complete"],
          120_000,
          startSequence,
          sessionId,
        );
  let interrupt: (RpcResponse & { readonly sequence: number }) | undefined;
  if (
    scenario.interruptAfterObservation &&
    observed &&
    scenario.requiredTypes.includes(observed.type)
  ) {
    interrupt = await rpc.request("session.interrupt", { session_id: sessionId });
  }
  const observedEvents = eventsSince(start, sessionId);
  const observedTypes = observedEvents.map((event) => event.type);
  const toolLifecycleMatched = observedEvents
    .filter((event) => event.type === "tool.start" && event.toolId)
    .some((started) =>
      observedEvents.some(
        (completed) =>
          completed.type === "tool.complete" &&
          completed.toolId === started.toolId &&
          completed.sequence > started.sequence,
      ),
    );
  let previousIndex = -1;
  const ordered =
    toolScenario && scenario.requiredTypes.includes("tool.start")
      ? toolLifecycleMatched
      : scenario.requiredTypes.every((type) => {
          const index = observedTypes.indexOf(type, previousIndex + 1);
          if (index < 0) return false;
          previousIndex = index;
          return true;
        });
  const completionSucceeded = !toolScenario || observed?.status === "complete";
  targetResults.push({
    id: scenario.id,
    area: scenario.area,
    safety: "live",
    status:
      isIndeterminate(response) || (interrupt && isIndeterminate(interrupt))
        ? "indeterminate"
        : isOk(response) && ordered && completionSucceeded && (!interrupt || isOk(interrupt))
          ? "passed"
          : "failed",
    summary: `session-correlated event order: ${observedTypes.join(" → ") || "none"}`,
    critical: true,
    evidence: [
      response.sequence,
      ...observedEvents.map((event) => event.sequence),
      ...(interrupt ? [interrupt.sequence] : []),
    ].sort((left, right) => left - right),
  });
}

function runKnownGapResults(targetResults: ProbeResult[]): void {
  targetResults.push(
    {
      id: "stable-mutation-event-ids",
      area: "ambiguous mutations",
      safety: "read",
      status: "blocked",
      summary: "no stable mutation, event, message, or run IDs; lost-response writes must halt",
      critical: true,
    },
    {
      id: "unknown-server-event-preservation",
      area: "unknown notifications",
      safety: "read",
      status: "blocked",
      summary:
        "pinned gateway exposes no safe probe that emits a deliberately unknown server event",
      critical: true,
    },
    {
      id: "approval-correlation",
      area: "approvals/clarification",
      safety: "read",
      status: "blocked",
      summary:
        "approval.respond has no request ID and cannot safely bind a stale response after reconnect",
      critical: true,
    },
    {
      id: "session-mcp-fencing",
      area: "security",
      safety: "read",
      status: "blocked",
      summary: "no per-session MCP registration/revocation or writer-fencing primitive",
      critical: true,
    },
    {
      id: "cron-global-cursor",
      area: "cron",
      safety: "read",
      status: "blocked",
      summary: "no durable global cron/background event cursor for disconnected delivery",
      critical: true,
    },
  );
}

async function runCronMutationProbe(rpc: RpcClient, targetResults: ProbeResult[]): Promise<void> {
  const gate = probeGate("destructive");
  if (!gate.allowed) {
    targetResults.push(blocked("cron-mutation", "cron", "destructive", gate.reason));
    return;
  }
  const name = `t3-h0-${NodeCrypto.randomBytes(4).toString("hex")}`;
  const add = await rpc.request("cron.manage", {
    action: "add",
    name,
    schedule: "0 0 1 1 *",
    prompt: "H0 disposable cron probe",
  });
  const addResult = asRecord(add.result);
  const jobId = asString(addResult?.job_id);
  const remove =
    addResult?.success === true
      ? await rpc.request("cron.manage", { action: "remove", name: jobId || name })
      : undefined;
  const finalList = await rpc.request("cron.manage", { action: "list" });
  const finalListResult = asRecord(finalList.result);
  const finalJobs = Array.isArray(finalListResult?.jobs) ? finalListResult.jobs : [];
  const absent = finalJobs.every((job) => {
    const row = asRecord(job);
    return row?.id !== jobId && row?.name !== name;
  });
  targetResults.push({
    id: "cron-mutation",
    area: "cron",
    safety: "destructive",
    status:
      isIndeterminate(add) || (remove && isIndeterminate(remove))
        ? "indeterminate"
        : isOk(add) &&
            addResult?.success === true &&
            Boolean(jobId) &&
            remove &&
            isOk(remove) &&
            asRecord(remove.result)?.success === true &&
            isOk(finalList) &&
            finalListResult?.success === true &&
            absent
          ? "passed"
          : "failed",
    summary:
      "required semantic success, canonical job ID removal, and verified absence from the final list",
    evidence: [add.sequence, ...(remove ? [remove.sequence] : []), finalList.sequence],
  });
}

async function runReadProbe(
  rpc: RpcClient,
  targetResults: ProbeResult[],
  id: string,
  area: string,
  method: string,
  params: Record<string, unknown>,
): Promise<void> {
  const response = await rpc.request(method, params);
  targetResults.push(
    responseResult({
      id,
      area,
      safety: "read",
      response,
      require: isOk(response),
      summary: isOk(response)
        ? `${method} returned successfully`
        : `${method} returned ${response.error?.code ?? "an error"}: ${response.error?.message ?? ""}`,
    }),
  );
}

class RpcClient {
  private readonly endpoint: string;
  private readonly capture: (direction: CaptureRecord["direction"], frame: unknown) => number;
  private socket: WebSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<
    string,
    {
      readonly resolve: (response: RpcResponse & { sequence: number }) => void;
      readonly reject: (error: Error) => void;
      readonly timer: NodeJS.Timeout;
      readonly method: string;
      readonly mutation: boolean;
    }
  >();
  private readonly events: CapturedEvent[] = [];

  constructor(
    endpoint: string,
    capture: (direction: CaptureRecord["direction"], frame: unknown) => number,
  ) {
    this.endpoint = endpoint;
    this.capture = capture;
  }

  async connect(): Promise<void> {
    const socket = new WebSocket(this.endpoint);
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as RpcResponse & {
        readonly method?: string;
        readonly params?: unknown;
      };
      const capturedSequence = this.capture("server", frame);
      const params = asRecord(frame.params);
      const eventType = asString(params?.type);
      if (frame.method === "event" && eventType) {
        const payload = asRecord(params?.payload);
        this.events.push({
          type: eventType,
          sequence: capturedSequence,
          sessionId: asString(params?.session_id),
          status: asString(payload?.status),
          toolId: asString(payload?.tool_id),
        });
      }
      if (frame.id !== undefined && frame.id !== null) {
        const key = String(frame.id);
        const waiter = this.pending.get(key);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.pending.delete(key);
          waiter.resolve({ ...frame, sequence: capturedSequence });
        }
      }
    });
    socket.addEventListener("close", () => {
      this.settlePendingOnClose("WebSocket closed before a response was observed");
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), {
        once: true,
      });
    });
  }

  async request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 15_000,
  ): Promise<RpcResponse & { readonly sequence: number }> {
    const id = String(this.nextId++);
    const mutation = isMutation(method, params);
    if (mutation && automaticWritesHalted) {
      const haltedSequence = this.capture("harness", {
        type: "mutation-blocked",
        method,
        reason: "an earlier mutation is indeterminate",
      });
      return {
        error: {
          code: -32098,
          message: "automatic writes halted after an indeterminate mutation",
        },
        conformanceDisposition: "indeterminate",
        sequence: haltedSequence,
      };
    }
    const frame = { jsonrpc: "2.0", id, method, params };
    this.capture("client", frame);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (mutation) {
          automaticWritesHalted = true;
          const timeoutSequence = this.capture("harness", {
            type: "mutation-indeterminate",
            method,
            reason: "response timeout after send",
            replayed: false,
          });
          resolve({
            error: { code: -32097, message: `lost response for ${method}` },
            conformanceDisposition: "indeterminate",
            sequence: timeoutSequence,
          });
        } else {
          reject(new Error(`Timed out waiting for ${method}`));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method, mutation });
      try {
        this.requireOpen().send(JSON.stringify(frame));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    const frame = { jsonrpc: "2.0", method, params };
    this.capture("client", frame);
    this.requireOpen().send(JSON.stringify(frame));
  }

  sendWithoutWaiting(
    method: string,
    params: Record<string, unknown>,
  ): { readonly sequence: number; readonly sent: boolean } {
    if (automaticWritesHalted) {
      return {
        sequence: this.capture("harness", {
          type: "mutation-blocked",
          method,
          reason: "an earlier mutation is indeterminate",
        }),
        sent: false,
      };
    }
    const id = String(this.nextId++);
    const frame = { jsonrpc: "2.0", id, method, params };
    const sentSequence = this.capture("client", {
      ...frame,
      conformance_disposition: "indeterminate-no-replay",
    });
    this.requireOpen().send(JSON.stringify(frame));
    automaticWritesHalted = true;
    return { sequence: sentSequence, sent: true };
  }

  async waitForEvent(
    type: string,
    timeoutMs: number,
    afterSequence = 0,
    sessionId?: string,
  ): Promise<CapturedEvent | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const event = this.events.find(
        (candidate) =>
          candidate.type === type &&
          candidate.sequence > afterSequence &&
          (!sessionId || candidate.sessionId === sessionId),
      );
      if (event) return event;
      await delay(20);
    }
    return undefined;
  }

  async waitForAnyEvent(
    types: ReadonlyArray<string>,
    timeoutMs: number,
    afterSequence = 0,
    sessionId?: string,
  ): Promise<CapturedEvent | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const event = this.events.find(
        (candidate) =>
          types.includes(candidate.type) &&
          candidate.sequence > afterSequence &&
          (!sessionId || candidate.sessionId === sessionId),
      );
      if (event) return event;
      await delay(20);
    }
    return undefined;
  }

  close(): void {
    this.settlePendingOnClose("WebSocket closed by the harness");
    this.socket?.close();
    this.socket = undefined;
  }

  private settlePendingOnClose(reason: string): void {
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      this.pending.delete(id);
      if (waiter.mutation) {
        automaticWritesHalted = true;
        const capturedSequence = this.capture("harness", {
          type: "mutation-indeterminate",
          method: waiter.method,
          reason,
          replayed: false,
        });
        waiter.resolve({
          error: { code: -32097, message: `lost response for ${waiter.method}` },
          conformanceDisposition: "indeterminate",
          sequence: capturedSequence,
        });
      } else {
        waiter.reject(new Error(`${reason}: ${waiter.method}`));
      }
    }
  }

  private requireOpen(): WebSocket {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }
    return this.socket;
  }
}

function record(direction: CaptureRecord["direction"], frame: unknown): number {
  const capturedSequence = ++sequence;
  records.push({ sequence: capturedSequence, direction, frame });
  return capturedSequence;
}

function responseResult(options: {
  readonly id: string;
  readonly area: string;
  readonly safety: ProbeSafety;
  readonly response: RpcResponse & { readonly sequence: number };
  readonly summary: string;
  readonly require: boolean;
  readonly critical?: boolean;
  readonly evidence?: ReadonlyArray<number>;
}): ProbeResult {
  return {
    id: options.id,
    area: options.area,
    safety: options.safety,
    status: isIndeterminate(options.response)
      ? "indeterminate"
      : options.require && isOk(options.response)
        ? "passed"
        : "failed",
    summary: options.summary,
    ...(options.critical === undefined ? {} : { critical: options.critical }),
    evidence: options.evidence ?? [options.response.sequence],
  };
}

function blocked(
  id: string,
  area: string,
  safety: ProbeSafety,
  summary: string,
  critical = false,
): ProbeResult {
  return { id, area, safety, status: "blocked", summary, critical };
}

function probeGate(safety: ProbeSafety): { readonly allowed: boolean; readonly reason: string } {
  return canRunModeProbe(options.mode, safety, process.env);
}

function eventsSince(start: number, sessionId: string): ReadonlyArray<CapturedEvent> {
  return records.slice(start).flatMap((entry) => {
    const frame = asRecord(entry.frame);
    const params = asRecord(frame?.params);
    const payload = asRecord(params?.payload);
    const type = frame?.method === "event" ? asString(params?.type) : undefined;
    return type && asString(params?.session_id) === sessionId
      ? [
          {
            type,
            sequence: entry.sequence,
            sessionId,
            status: asString(payload?.status),
            toolId: asString(payload?.tool_id),
          },
        ]
      : [];
  });
}

function parseOptions(args: ReadonlyArray<string>): Options {
  const values = NodeUtil.parseArgs({
    args,
    options: {
      mode: { type: "string", default: "launch" },
      source: { type: "string" },
      output: { type: "string" },
      url: { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  }).values;
  if (values.help) {
    console.log(`Usage:
  node scripts/hermes-conformance.ts --mode launch --source /path/to/pinned/hermes --output /path/to/evidence
  node scripts/hermes-conformance.ts --mode attach --url 'ws://127.0.0.1:9119/api/ws?token=...' --output /path/to/evidence

The output directory receives sanitized fixtures only. Raw capture remains in a private temporary
directory printed after the run. Launch requires exact clean revision ${HERMES_PINNED_REVISION}.`);
    process.exit(0);
  }
  if (values.mode !== "launch" && values.mode !== "attach") {
    throw new Error("--mode must be launch or attach");
  }
  if (!values.output) throw new Error("--output is required");
  return {
    mode: values.mode,
    source: values.source,
    outputDirectory: values.output,
    url: values.url,
  };
}

function requireAttachUrl(runOptions: Options): string {
  if (!runOptions.url) throw new Error("--url is required in attach mode");
  const url = new URL(runOptions.url);
  if (url.protocol !== "ws:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("H0 attach mode is loopback ws:// only");
  }
  if (!url.searchParams.get("token")) {
    throw new Error("Attach URL must include the caller-chosen /api/ws?token=... token");
  }
  return url.toString();
}

function verifyPythonImport(
  python: string,
  sourcePath: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): PythonRuntimeEvidence {
  const probe = NodeChildProcess.spawnSync(
    python,
    [
      "-c",
      [
        "import hashlib, importlib, importlib.metadata, json, os, pathlib, sys",
        "names = ['hermes_cli', 'tui_gateway.ws', 'tui_gateway.synthetic_turn']",
        "paths = {name: str(pathlib.Path(importlib.import_module(name).__file__).resolve()) for name in names}",
        "packages = sorted((d.metadata.get('Name') or '', d.version) for d in importlib.metadata.distributions())",
        "fingerprint = hashlib.sha256(json.dumps(packages, separators=(',', ':')).encode()).hexdigest()",
        "payload = json.dumps({'executable': str(pathlib.Path(sys.executable).resolve()), 'version': sys.version, 'sysPath': sys.path, 'modulePaths': paths, 'dependencyFingerprint': fingerprint}) + '\\n'",
        "os.write(1, payload.encode())",
      ].join("; "),
    ],
    {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const probeOutput = typeof probe.stdout === "string" ? probe.stdout.trim() : "";
  if (probe.status !== 0 || !probeOutput) {
    throw new Error(
      `Selected Python runtime probe failed (status ${probe.status ?? "none"}): ${(
        probe.stderr ||
        probe.error?.message ||
        "no stdout"
      ).trim()}`,
    );
  }
  const runtime = JSON.parse(probeOutput) as PythonRuntimeEvidence;
  const canonicalSource = NodeFS.realpathSync(sourcePath);
  for (const [moduleName, modulePath] of Object.entries(runtime.modulePaths)) {
    const canonicalModule = NodeFS.realpathSync(modulePath);
    const relative = NodePath.relative(canonicalSource, canonicalModule);
    if (relative.startsWith("..") || NodePath.isAbsolute(relative)) {
      throw new Error(
        `Selected Python imported ${moduleName} outside the pinned checkout: ${canonicalModule}`,
      );
    }
  }
  return runtime;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = NodeNet.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!port) throw new Error("Failed to reserve a loopback port");
  return port;
}

async function waitForBackendSentinel(
  expectedPort: number,
  processHandle: NodeChildProcess.ChildProcess,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  const sentinel = `HERMES_BACKEND_READY port=${expectedPort}`;
  let spawnError: Error | undefined;
  processHandle.once("error", (error) => {
    spawnError = error;
  });
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`Unable to start hermes serve: ${spawnError.message}`);
    if (!childRunning(processHandle)) {
      throw new Error(
        `hermes serve exited early with code ${processHandle.exitCode ?? processHandle.signalCode}; see ${processLogPath}`,
      );
    }
    try {
      if (NodeFS.readFileSync(processLogPath, "utf8").includes(sentinel)) return;
    } catch {
      // The process has not created or flushed its log yet.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for "${sentinel}"; see ${processLogPath}`);
}

function writeJsonLines(path: string, values: ReadonlyArray<unknown>, mode?: number): void {
  const body = values.map((value) => JSON.stringify(value)).join("\n") + "\n";
  NodeFS.writeFileSync(path, body, mode === undefined ? undefined : { mode });
}

function isOk(response: RpcResponse): boolean {
  if (response.error !== undefined) return false;
  return asRecord(response.result)?.success !== false;
}

function isIndeterminate(response: RpcResponse): boolean {
  return response.conformanceDisposition === "indeterminate";
}

function isMutation(method: string, params: Readonly<Record<string, unknown>>): boolean {
  if (
    [
      "session.list",
      "session.active_list",
      "session.history",
      "session.status",
      "session.usage",
      "commands.catalog",
      "model.options",
    ].includes(method)
  ) {
    return false;
  }
  if (method === "cron.manage" && (params.action === undefined || params.action === "list")) {
    return false;
  }
  if (method === "session.title" && params.title === undefined) return false;
  return true;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function redactEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.searchParams.has("token")) url.searchParams.set("token", "<redacted>");
  return url.toString();
}

function computeHarnessFingerprint(): string {
  const hash = NodeCrypto.createHash("sha256");
  const harnessFiles = [
    NodePath.join(import.meta.dirname, "hermes-conformance.ts"),
    NodePath.join(import.meta.dirname, "lib", "hermes-conformance.ts"),
  ];
  for (const path of harnessFiles) {
    hash.update(NodePath.relative(import.meta.dirname, path));
    hash.update("\0");
    hash.update(NodeFS.readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function renderInvocation(): string {
  return [
    `\`mode=${options.mode}\``,
    `source=${options.source ? "supplied" : "omitted"}`,
    `mutations=${process.env.HERMES_CONFORMANCE_ALLOW_MUTATIONS === "1" ? "enabled" : "disabled"}`,
    `live=${process.env.HERMES_CONFORMANCE_ALLOW_LIVE === "1" ? "enabled" : "disabled"}`,
    `destructive=${process.env.HERMES_CONFORMANCE_ALLOW_DESTRUCTIVE === "1" ? "enabled" : "disabled"}`,
  ].join(", ");
}

function minimalPdf(): string {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, "utf8"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, "utf8");
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  body += `startxref\n${xrefOffset}\n%%EOF\n`;
  return body;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForChildExit(
  processHandle: NodeChildProcess.ChildProcess,
  timeoutMs: number,
): Promise<void> {
  if (!childRunning(processHandle)) return;
  await Promise.race([
    new Promise<void>((resolve) => processHandle.once("exit", () => resolve())),
    delay(timeoutMs),
  ]);
}

await main();
