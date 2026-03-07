import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const DEFAULT_PROMPT_TIMEOUT_MS = 120_000;
const CANCEL_AFTER_MS = 1_500;

function parseArgv(argv) {
  const parsed = {
    outputDir: "",
    workspace: process.cwd(),
    model: "",
    permissionOption: "allow-once",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if ((token === "--output-dir" || token === "-o") && next) {
      parsed.outputDir = next;
      i += 1;
      continue;
    }
    if ((token === "--workspace" || token === "-w") && next) {
      parsed.workspace = path.resolve(next);
      i += 1;
      continue;
    }
    if ((token === "--model" || token === "-m") && next) {
      parsed.model = next;
      i += 1;
      continue;
    }
    if (token === "--permission-option" && next) {
      parsed.permissionOption = next;
      i += 1;
    }
  }

  return parsed;
}

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(line) {
  try {
    return { ok: true, value: JSON.parse(line) };
  } catch (error) {
    return { ok: false, error };
  }
}

class AcpProbeClient {
  #child;
  #stdoutRl;
  #stderrRl;
  #nextId = 1;
  #closed = false;
  #pending = new Map();
  #onMessage;
  #onServerRequest;

  constructor({ onMessage, onServerRequest }) {
    this.#onMessage = onMessage;
    this.#onServerRequest = onServerRequest;

    this.#child = spawn("agent", ["acp"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        NO_COLOR: "1",
      },
    });

    this.#stdoutRl = readline.createInterface({ input: this.#child.stdout });
    this.#stderrRl = readline.createInterface({ input: this.#child.stderr });

    this.#stdoutRl.on("line", (line) => this.#handleStdoutLine(line));
    this.#stderrRl.on("line", (line) => {
      this.#onMessage({
        ts: nowIso(),
        channel: "stderr",
        line,
      });
    });

    this.#child.once("exit", (code, signal) => {
      this.#closed = true;
      const reason = `ACP process exited (code=${String(code)}, signal=${String(signal)})`;
      for (const [id, pending] of this.#pending.entries()) {
        this.#pending.delete(id);
        pending.reject(new Error(reason));
      }
      this.#onMessage({
        ts: nowIso(),
        channel: "lifecycle",
        event: "exit",
        code,
        signal,
      });
    });
  }

  async close() {
    if (this.#closed) return;
    try {
      this.#child.stdin.end();
    } catch {
      // ignored
    }
    this.#child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!this.#closed) {
      this.#child.kill("SIGKILL");
    }
  }

  async send(method, params, { timeoutMs = DEFAULT_PROMPT_TIMEOUT_MS } = {}) {
    if (this.#closed) {
      throw new Error("Cannot send: ACP process is already closed.");
    }
    const id = this.#nextId;
    this.#nextId += 1;

    const message = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    this.#onMessage({
      ts: nowIso(),
      channel: "client->server",
      message,
    });
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Timed out waiting for response to '${method}' (id=${id}).`));
      }, timeoutMs);

      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
  }

  #respond(id, result) {
    if (this.#closed) return;
    const message = {
      jsonrpc: "2.0",
      id,
      result,
    };
    this.#onMessage({
      ts: nowIso(),
      channel: "client->server",
      message,
    });
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleStdoutLine(line) {
    const parsed = safeJsonParse(line);
    if (!parsed.ok) {
      this.#onMessage({
        ts: nowIso(),
        channel: "stdout-non-json",
        line,
      });
      return;
    }

    const message = parsed.value;
    this.#onMessage({
      ts: nowIso(),
      channel: "server->client",
      message,
    });

    if (
      Object.prototype.hasOwnProperty.call(message, "id") &&
      (Object.prototype.hasOwnProperty.call(message, "result") ||
        Object.prototype.hasOwnProperty.call(message, "error")) &&
      !Object.prototype.hasOwnProperty.call(message, "method")
    ) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (Object.prototype.hasOwnProperty.call(message, "error")) {
        pending.reject(message.error);
        return;
      }
      pending.resolve(message.result);
      return;
    }

    if (
      Object.prototype.hasOwnProperty.call(message, "id") &&
      Object.prototype.hasOwnProperty.call(message, "method")
    ) {
      this.#onServerRequest?.(message, (result) => this.#respond(message.id, result));
    }
  }
}

function summarizeTranscript(entries) {
  const summary = {
    counts: {
      notificationsByMethod: {},
      sessionUpdateByType: {},
      serverRequestsByMethod: {},
      permissionDecisions: {},
    },
    samples: {
      initializeResult: null,
      authenticateResult: null,
      sessionNewResult: null,
      sessionPromptResultByScenario: {},
      sessionUpdateByType: {},
      serverRequestByMethod: {},
    },
    stderr: [],
  };

  for (const entry of entries) {
    if (entry.channel === "stderr") {
      summary.stderr.push(entry.line);
      continue;
    }
    if (entry.channel !== "server->client") continue;

    const message = entry.message;
    if (!message || typeof message !== "object") continue;

    if (typeof message.method === "string" && !Object.prototype.hasOwnProperty.call(message, "id")) {
      summary.counts.notificationsByMethod[message.method] =
        (summary.counts.notificationsByMethod[message.method] ?? 0) + 1;
      if (message.method === "session/update") {
        const updateType = message.params?.update?.sessionUpdate;
        if (typeof updateType === "string") {
          summary.counts.sessionUpdateByType[updateType] =
            (summary.counts.sessionUpdateByType[updateType] ?? 0) + 1;
          if (!summary.samples.sessionUpdateByType[updateType]) {
            summary.samples.sessionUpdateByType[updateType] = message;
          }
        }
      }
      continue;
    }

    if (typeof message.method === "string" && Object.prototype.hasOwnProperty.call(message, "id")) {
      summary.counts.serverRequestsByMethod[message.method] =
        (summary.counts.serverRequestsByMethod[message.method] ?? 0) + 1;
      if (!summary.samples.serverRequestByMethod[message.method]) {
        summary.samples.serverRequestByMethod[message.method] = message;
      }
      continue;
    }
  }

  for (const entry of entries) {
    if (entry.channel !== "scenario-result") continue;
    if (entry.scenario === "initialize" && !summary.samples.initializeResult) {
      summary.samples.initializeResult = entry.result;
      continue;
    }
    if (entry.scenario === "authenticate" && !summary.samples.authenticateResult) {
      summary.samples.authenticateResult = entry.result;
      continue;
    }
    if (entry.scenario === "session/new" && !summary.samples.sessionNewResult) {
      summary.samples.sessionNewResult = entry.result;
      continue;
    }
    if (entry.scenarioName) {
      summary.samples.sessionPromptResultByScenario[entry.scenarioName] = entry.result;
    }
  }

  for (const entry of entries) {
    if (entry.channel !== "permission-decision") continue;
    const optionId = entry.optionId;
    summary.counts.permissionDecisions[optionId] =
      (summary.counts.permissionDecisions[optionId] ?? 0) + 1;
  }

  return summary;
}

async function run() {
  const args = parseArgv(process.argv.slice(2));
  const allowedPermissionOptions = new Set(["allow-once", "allow-always", "reject-once"]);
  if (!allowedPermissionOptions.has(args.permissionOption)) {
    throw new Error(
      `Invalid --permission-option '${args.permissionOption}'. Expected one of: ${Array.from(allowedPermissionOptions).join(", ")}`,
    );
  }
  const stamp = nowIso().replaceAll(":", "-");
  const outputDir = args.outputDir
    ? path.resolve(args.outputDir)
    : path.join(process.cwd(), ".tmp", "acp-probe", stamp);
  await fs.mkdir(outputDir, { recursive: true });

  const transcript = [];
  const pushEntry = (entry) => transcript.push(entry);

  let activeScenarioName = null;

  const client = new AcpProbeClient({
    onMessage: (entry) => {
      if (
        activeScenarioName &&
        entry.channel === "server->client" &&
        entry.message?.method === "session/update"
      ) {
        transcript.push({ ...entry, scenarioName: activeScenarioName });
        return;
      }
      transcript.push(entry);
    },
    onServerRequest: (message, respond) => {
      if (message.method === "session/request_permission") {
        const defaultChoice = args.permissionOption;
        pushEntry({
          ts: nowIso(),
          channel: "permission-decision",
          requestId: message.id,
          optionId: defaultChoice,
          params: message.params,
        });
        respond({
          outcome: {
            outcome: "selected",
            optionId: defaultChoice,
          },
        });
        return;
      }

      respond({
        outcome: {
          outcome: "selected",
          optionId: "deny",
        },
      });
      pushEntry({
        ts: nowIso(),
        channel: "server-request-unhandled",
        method: message.method,
        requestId: message.id,
        params: message.params,
      });
    },
  });

  try {
    const initializeResult = await client.send("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: {
        name: "t3-cursor-acp-probe",
        version: "0.1.0",
      },
    });
    pushEntry({
      ts: nowIso(),
      channel: "scenario-result",
      scenario: "initialize",
      result: initializeResult,
    });

    const authenticateResult = await client.send("authenticate", {
      methodId: "cursor_login",
    });
    pushEntry({
      ts: nowIso(),
      channel: "scenario-result",
      scenario: "authenticate",
      result: authenticateResult,
    });

    const sessionParams = {
      cwd: args.workspace,
      mcpServers: [],
      ...(args.model ? { model: args.model } : {}),
    };
    const sessionResult = await client.send("session/new", sessionParams);
    pushEntry({
      ts: nowIso(),
      channel: "scenario-result",
      scenario: "session/new",
      result: sessionResult,
    });

    const sessionId = sessionResult?.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error(`Missing sessionId from session/new response: ${JSON.stringify(sessionResult)}`);
    }

    const scenarios = [
      {
        name: "hello",
        prompt: "Say hello in one sentence.",
      },
      {
        name: "tooling",
        prompt:
          "Use tools to run `pwd` and then `ls -1 | head -n 8`, and summarize what you found in one paragraph.",
      },
      {
        name: "cancel",
        prompt:
          "Think for a while and draft a long detailed migration plan with at least 20 bullet points before answering.",
        cancelAfterMs: CANCEL_AFTER_MS,
      },
    ];

    for (const scenario of scenarios) {
      activeScenarioName = scenario.name;
      const promptParams = {
        sessionId,
        prompt: [{ type: "text", text: scenario.prompt }],
      };

      const promptPromise = client.send("session/prompt", promptParams, {
        timeoutMs: DEFAULT_PROMPT_TIMEOUT_MS,
      });

      if (scenario.cancelAfterMs) {
        setTimeout(() => {
          client
            .send("session/cancel", { sessionId }, { timeoutMs: 15_000 })
            .then((cancelResult) => {
              pushEntry({
                ts: nowIso(),
                channel: "scenario-result",
                scenario: "session/cancel",
                scenarioName: scenario.name,
                result: cancelResult,
              });
            })
            .catch((error) => {
              pushEntry({
                ts: nowIso(),
                channel: "scenario-error",
                scenario: "session/cancel",
                scenarioName: scenario.name,
                error:
                  error instanceof Error
                    ? error.message
                    : typeof error === "string"
                      ? error
                      : JSON.stringify(error),
              });
            });
        }, scenario.cancelAfterMs);
      }

      const promptResult = await promptPromise;
      pushEntry({
        ts: nowIso(),
        channel: "scenario-result",
        scenario: "session/prompt",
        scenarioName: scenario.name,
        result: promptResult,
      });
      activeScenarioName = null;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } finally {
    await client.close();
  }

  const summary = summarizeTranscript(transcript);
  const transcriptPath = path.join(outputDir, "transcript.ndjson");
  const summaryPath = path.join(outputDir, "summary.json");

  await fs.writeFile(
    transcriptPath,
    `${transcript.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  process.stdout.write(`ACP probe complete.\n`);
  process.stdout.write(`  outputDir: ${outputDir}\n`);
  process.stdout.write(`  transcript: ${transcriptPath}\n`);
  process.stdout.write(`  summary: ${summaryPath}\n`);
}

run().catch((error) => {
  process.stderr.write(`ACP probe failed: ${String(error)}\n`);
  process.exitCode = 1;
});
