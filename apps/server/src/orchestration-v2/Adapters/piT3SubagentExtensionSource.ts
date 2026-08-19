/**
 * T3-owned override of the official Pi `subagent` tool.
 *
 * Official spawn is `pi --mode json -p --no-session`, so there is no session
 * file to bind as a T3 child thread. This copy persists `--session <path>` and
 * reports `sessionFile` on each result so the adapter can resume it.
 *
 * Loaded via CLI `--extension`. Pi aborts if two extensions register
 * `subagent`, so the launcher omits the official tool.
 */
export const PI_T3_SUBAGENT_EXTENSION_FILENAME = "pi-t3-subagent-extension.ts";

export const T3_PI_CHILD_SESSION_ROOT_ENV = "T3_PI_CHILD_SESSION_ROOT";

export const PI_T3_SUBAGENT_EXTENSION_SOURCE = `\
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  getAgentDir,
  parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SESSION_ROOT_ENV = ${JSON.stringify(T3_PI_CHILD_SESSION_ROOT_ENV)};
const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;

type AgentScope = "user" | "project" | "both";

type AgentConfig = {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: "user" | "project";
};

type SingleResult = {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  finished: boolean;
  exitCode: number;
  messages: unknown[];
  stderr: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
  sessionFile?: string;
};

function parseToolList(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const tools = raw
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return tools.length > 0 ? tools : undefined;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
  if (!fs.existsSync(dir)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const agents: AgentConfig[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    const { frontmatter, body } = parseFrontmatter<{
      name?: unknown;
      description?: unknown;
      tools?: unknown;
      model?: unknown;
    }>(content);
    if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
      continue;
    }
    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: parseToolList(frontmatter.tools),
      model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
      systemPrompt: body,
      source,
    });
  }
  return agents;
}

function discoverAgents(cwd: string, scope: AgentScope) {
  const userDir = path.join(getAgentDir(), "agents");
  let projectAgentsDir: string | null = null;
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
    try {
      if (fs.statSync(candidate).isDirectory()) {
        projectAgentsDir = candidate;
        break;
      }
    } catch {
      /* keep walking */
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }
  const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
  const projectAgents =
    scope === "user" || projectAgentsDir === null
      ? []
      : loadAgentsFromDir(projectAgentsDir, "project");
  const agentMap = new Map<string, AgentConfig>();
  if (scope === "both") {
    for (const agent of userAgents) agentMap.set(agent.name, agent);
    for (const agent of projectAgents) agentMap.set(agent.name, agent);
  } else if (scope === "user") {
    for (const agent of userAgents) agentMap.set(agent.name, agent);
  } else {
    for (const agent of projectAgents) agentMap.set(agent.name, agent);
  }
  return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

function getFinalOutput(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: string; content?: unknown };
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const record = part as { type?: string; text?: string };
      if (record.type === "text" && typeof record.text === "string" && record.text.length > 0) {
        return record.text;
      }
    }
  }
  return "";
}

function isFailedResult(result: SingleResult): boolean {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
  if (isFailedResult(result)) {
    return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
  }
  return getFinalOutput(result.messages) || "(no output)";
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  if (/^(node|bun)(\\.exe)?$/.test(execName)) return { command: "pi", args };
  return { command: process.execPath, args };
}

function childSessionFile(): string {
  const root =
    process.env[SESSION_ROOT_ENV] && process.env[SESSION_ROOT_ENV]!.length > 0
      ? process.env[SESSION_ROOT_ENV]!
      : path.join(getAgentDir(), "sessions");
  fs.mkdirSync(root, { recursive: true });
  const id = randomBytes(6).toString("hex");
  return path.join(root, \`t3-subagent-\${Date.now()}-\${id}.jsonl\`);
}

async function runSingleAgent(
  defaultCwd: string,
  defaults: { model?: string; thinkingLevel?: string },
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: { content: { type: "text"; text: string }[]; details: { results: SingleResult[] } }) => void) | undefined,
): Promise<SingleResult> {
  const agent = agents.find((entry) => entry.name === agentName);
  if (!agent) {
    const available = agents.map((entry) => \`"\${entry.name}"\`).join(", ") || "none";
    return {
      agent: agentName,
      agentSource: "unknown",
      task,
      finished: true,
      exitCode: 1,
      messages: [],
      stderr: \`Unknown agent: "\${agentName}". Available agents: \${available}.\`,
      step,
    };
  }

  const sessionFile = childSessionFile();
  const args: string[] = [
    "--mode",
    "json",
    "-p",
    "--session",
    sessionFile,
    "--name",
    \`t3-subagent \${agentName}\`,
  ];
  // Children inherit T3_MCP_URL / T3_MCP_BEARER_TOKEN from this process, so
  // loading the same T3 MCP extension gives them delegate_task / t3_thread_*.
  const t3McpExtension = process.env["T3_PI_MCP_EXTENSION_PATH"];
  if (t3McpExtension) args.push("--extension", t3McpExtension);
  const model = agent.model ?? defaults.model;
  if (model) args.push("--model", model);
  if (!agent.model && defaults.thinkingLevel) args.push("--thinking", defaults.thinkingLevel);
  if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

  let tmpPromptDir: string | null = null;
  const currentResult: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    finished: false,
    exitCode: 0,
    messages: [],
    stderr: "",
    model,
    step,
    sessionFile,
  };

  const emitUpdate = () => {
    onUpdate?.({
      content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
      details: { results: [currentResult] },
    });
  };
  emitUpdate();

  try {
    if (agent.systemPrompt.trim()) {
      tmpPromptDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-t3-subagent-"));
      const promptPath = path.join(tmpPromptDir, "prompt.md");
      await fs.promises.writeFile(promptPath, agent.systemPrompt, { encoding: "utf-8", mode: 0o600 });
      args.push("--append-system-prompt", promptPath);
    }
    args.push(\`Task: \${task}\`);

    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd: cwd ?? defaultCwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let buffer = "";
      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: { type?: string; message?: unknown };
        try {
          event = JSON.parse(line) as { type?: string; message?: unknown };
        } catch {
          return;
        }
        if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
          currentResult.messages.push(event.message);
          const message = event.message as {
            role?: string;
            model?: string;
            stopReason?: string;
            errorMessage?: string;
          };
          if (message.role === "assistant") {
            if (!currentResult.model && message.model) currentResult.model = message.model;
            if (message.stopReason) currentResult.stopReason = message.stopReason;
            if (message.errorMessage) currentResult.errorMessage = message.errorMessage;
          }
          emitUpdate();
        }
      };
      proc.stdout?.setEncoding("utf8");
      proc.stdout?.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });
      proc.stderr?.setEncoding("utf8");
      proc.stderr?.on("data", (chunk: string) => {
        currentResult.stderr += chunk;
      });
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const settle = (code: number) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        if (killTimer !== undefined) clearTimeout(killTimer);
        if (buffer.trim()) processLine(buffer);
        resolve(code);
      };
      const onAbort = () => {
        currentResult.stopReason = "aborted";
        if (proc.kill("SIGTERM")) {
          killTimer = setTimeout(() => proc.kill("SIGKILL"), 1_000);
          killTimer.unref();
        }
      };
      proc.on("close", (code) => settle(code ?? 1));
      proc.on("error", (error) => {
        currentResult.stderr += error.message;
        settle(1);
      });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
    currentResult.exitCode = exitCode;
    currentResult.finished = true;
    return currentResult;
  } finally {
    if (tmpPromptDir) {
      await fs.promises.rm(tmpPromptDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

const TaskItem = Type.Object({
  agent: Type.String(),
  task: Type.String(),
  cwd: Type.Optional(Type.String()),
});

export default function t3SubagentExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate tasks to specialized Pi subagents with isolated context. Each child persists a Pi session that T3 can open and continue.",
    parameters: Type.Object({
      agent: Type.Optional(Type.String()),
      task: Type.Optional(Type.String()),
      tasks: Type.Optional(Type.Array(TaskItem)),
      chain: Type.Optional(Type.Array(TaskItem)),
      agentScope: Type.Optional(StringEnum(["user", "project", "both"] as const)),
      confirmProjectAgents: Type.Optional(Type.Boolean()),
      cwd: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const agentScope: AgentScope = params.agentScope ?? "user";
      const discovery = discoverAgents(ctx.cwd, agentScope);
      const agents = discovery.agents;
      const defaults = {
        model: ctx.model ? \`\${ctx.model.provider}/\${ctx.model.id}\` : undefined,
        thinkingLevel: ctx.thinkingLevel,
      };
      const confirmProjectAgents = params.confirmProjectAgents ?? true;
      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const makeDetails = (results: SingleResult[]) => ({
        mode: hasChain ? "chain" : hasTasks ? "parallel" : "single",
        agentScope,
        projectAgentsDir: discovery.projectAgentsDir,
        results,
      });

      if (Number(hasChain) + Number(hasTasks) + Number(hasSingle) !== 1) {
        const available = agents.map((agent) => agent.name).join(", ") || "none";
        return {
          content: [{ type: "text", text: \`Invalid parameters. Available agents: \${available}\` }],
          details: makeDetails([]),
        };
      }

      if (
        (agentScope === "project" || agentScope === "both") &&
        confirmProjectAgents &&
        ctx.hasUI
      ) {
        const names = new Set<string>();
        if (params.chain) for (const step of params.chain) names.add(step.agent);
        if (params.tasks) for (const item of params.tasks) names.add(item.agent);
        if (params.agent) names.add(params.agent);
        const projectRequested = agents.filter(
          (agent) => agent.source === "project" && names.has(agent.name),
        );
        if (projectRequested.length > 0) {
          const ok = await ctx.ui.confirm(
            "Run project-local agents?",
            \`Agents: \${projectRequested.map((agent) => agent.name).join(", ")}\\nSource: \${discovery.projectAgentsDir ?? "(unknown)"}\`,
          );
          if (!ok) {
            return {
              content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
              details: makeDetails([]),
            };
          }
        }
      }

      if (params.chain && params.chain.length > 0) {
        const results: SingleResult[] = [];
        let previousOutput = "";
        for (let index = 0; index < params.chain.length; index += 1) {
          const step = params.chain[index];
          const result = await runSingleAgent(
            ctx.cwd,
            defaults,
            agents,
            step.agent,
            step.task.replace(/\\{previous\\}/g, previousOutput),
            step.cwd,
            index + 1,
            signal,
            onUpdate
              ? (partial) => {
                  const current = partial.details?.results[0];
                  if (current) onUpdate({ ...partial, details: makeDetails([...results, current]) });
                }
              : undefined,
          );
          results.push(result);
          if (isFailedResult(result)) {
            return {
              content: [
                {
                  type: "text",
                  text: \`Chain stopped at step \${index + 1} (\${step.agent}): \${getResultOutput(result)}\`,
                },
              ],
              details: makeDetails(results),
              isError: true,
            };
          }
          previousOutput = getFinalOutput(result.messages);
        }
        return {
          content: [
            {
              type: "text",
              text: getFinalOutput(results[results.length - 1]?.messages ?? []) || "(no output)",
            },
          ],
          details: makeDetails(results),
        };
      }

      if (params.tasks && params.tasks.length > 0) {
        if (params.tasks.length > MAX_PARALLEL_TASKS) {
          return {
            content: [{ type: "text", text: \`Too many parallel tasks (\${params.tasks.length}).\` }],
            details: makeDetails([]),
          };
        }
        const allResults: SingleResult[] = params.tasks.map((item) => ({
          agent: item.agent,
          agentSource: "unknown",
          task: item.task,
          finished: false,
          exitCode: -1,
          messages: [],
          stderr: "",
        }));
        const emitParallel = () => {
          onUpdate?.({
            content: [{ type: "text", text: "Parallel tasks running..." }],
            details: makeDetails([...allResults]),
          });
        };
        let nextIndex = 0;
        const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, params.tasks.length) }, async () => {
          while (true) {
            const index = nextIndex;
            nextIndex += 1;
            if (index >= params.tasks.length) return;
            const item = params.tasks[index];
            const result = await runSingleAgent(
              ctx.cwd,
              defaults,
              agents,
              item.agent,
              item.task,
              item.cwd,
              undefined,
              signal,
              (partial) => {
                if (partial.details?.results[0]) {
                  allResults[index] = partial.details.results[0];
                  emitParallel();
                }
              },
            );
            allResults[index] = result;
            emitParallel();
          }
        });
        await Promise.all(workers);
        const successCount = allResults.filter((result) => !isFailedResult(result)).length;
        return {
          content: [
            {
              type: "text",
              text: \`Parallel: \${successCount}/\${allResults.length} succeeded\`,
            },
          ],
          details: makeDetails(allResults),
        };
      }

      const result = await runSingleAgent(
        ctx.cwd,
        defaults,
        agents,
        params.agent as string,
        params.task as string,
        params.cwd,
        undefined,
        signal,
        onUpdate
          ? (partial) => onUpdate({ ...partial, details: makeDetails(partial.details.results) })
          : undefined,
      );
      const failed = isFailedResult(result);
      return {
        content: [
          {
            type: "text",
            text: failed
              ? \`Agent \${result.stopReason || "failed"}: \${getResultOutput(result)}\`
              : getFinalOutput(result.messages) || "(no output)",
          },
        ],
        details: makeDetails([result]),
        ...(failed ? { isError: true } : {}),
      };
    },
  });
}
`;
