import { query, type SDKMessage, type ThinkingConfig } from "@anthropic-ai/claude-agent-sdk";

type ProbeCase =
  | "default"
  | "effort-low"
  | "effort-high"
  | "settings-off"
  | "settings-on"
  | "thinking-disabled"
  | "thinking-enabled";

function parseArgs(argv: ReadonlyArray<string>): {
  readonly model: string;
  readonly cwd?: string;
  readonly prompt: string;
  readonly cases: ReadonlyArray<ProbeCase>;
} {
  let model = "claude-haiku-4-5";
  let cwd: string | undefined;
  let prompt =
    "Think step by step about this before answering: what is 27 multiplied by 43? Return the final number only.";
  let cases: ReadonlyArray<ProbeCase> = [
    "default",
    "effort-low",
    "effort-high",
    "settings-off",
    "settings-on",
    "thinking-disabled",
    "thinking-enabled",
  ];

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value) {
      continue;
    }
    if (value === "--model") {
      model = argv[index + 1] ?? model;
      index += 1;
      continue;
    }
    if (value === "--cwd") {
      cwd = argv[index + 1] ?? cwd;
      index += 1;
      continue;
    }
    if (value === "--prompt") {
      prompt = argv[index + 1] ?? prompt;
      index += 1;
      continue;
    }
    if (value === "--cases") {
      const next = argv[index + 1];
      if (next) {
        const requested = next
          .split(",")
          .map((entry) => entry.trim())
          .filter(
            (entry): entry is ProbeCase =>
              entry === "default" ||
              entry === "effort-low" ||
              entry === "effort-high" ||
              entry === "settings-off" ||
              entry === "settings-on" ||
              entry === "thinking-disabled" ||
              entry === "thinking-enabled",
          );
        if (requested.length > 0) {
          cases = requested;
        }
      }
      index += 1;
    }
  }

  return {
    model,
    prompt,
    ...(cwd ? { cwd } : {}),
    cases,
  };
}

function caseOptions(caseName: ProbeCase): {
  readonly label: ProbeCase;
  readonly effort?: "low" | "high";
  readonly settings?: { alwaysThinkingEnabled: boolean };
  readonly thinking?: ThinkingConfig;
} {
  switch (caseName) {
    case "effort-low":
      return {
        label: caseName,
        effort: "low",
      };
    case "effort-high":
      return {
        label: caseName,
        effort: "high",
      };
    case "settings-off":
      return {
        label: caseName,
        settings: {
          alwaysThinkingEnabled: false,
        },
      };
    case "settings-on":
      return {
        label: caseName,
        settings: {
          alwaysThinkingEnabled: true,
        },
      };
    case "thinking-disabled":
      return {
        label: caseName,
        thinking: {
          type: "disabled",
        },
      };
    case "thinking-enabled":
      return {
        label: caseName,
        thinking: {
          type: "enabled",
          budgetTokens: 1024,
        },
      };
    default:
      return {
        label: caseName,
      };
  }
}

type ProbeSummary = {
  readonly case: ProbeCase;
  readonly model: string;
  initModelInfo: {
    value: string | null;
    supportsEffort: boolean | null;
    supportsAdaptiveThinking: boolean | null;
    supportedEffortLevels: ReadonlyArray<string> | null;
  } | null;
  resultSubtype: string | null;
  resultText: string | null;
  assistantThinkingBlockCount: number;
  streamThinkingEventTypes: Record<string, number>;
  error: string | null;
};

async function runCase(input: {
  readonly caseName: ProbeCase;
  readonly model: string;
  readonly cwd?: string;
  readonly prompt: string;
}): Promise<ProbeSummary> {
  const caseConfig = caseOptions(input.caseName);
  const summary: ProbeSummary = {
    case: input.caseName,
    model: input.model,
    initModelInfo: null,
    resultSubtype: null,
    resultText: null,
    assistantThinkingBlockCount: 0,
    streamThinkingEventTypes: {},
    error: null,
  };

  try {
    const messages = query({
      prompt: input.prompt,
      options: {
        model: input.model,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        persistSession: false,
        tools: [],
        permissionMode: "bypassPermissions",
        includePartialMessages: true,
        maxTurns: 1,
        ...(caseConfig.effort ? { effort: caseConfig.effort } : {}),
        ...(caseConfig.settings ? { settings: caseConfig.settings } : {}),
        ...(caseConfig.thinking ? { thinking: caseConfig.thinking } : {}),
      },
    });

    const initialization = await messages.initializationResult();
    const initModel =
      initialization.models.find((candidate) => candidate.value === input.model) ??
      initialization.models.find((candidate) => candidate.value.includes("haiku")) ??
      null;
    summary.initModelInfo = initModel
      ? {
          value: initModel.value,
          supportsEffort: initModel.supportsEffort ?? null,
          supportsAdaptiveThinking: initModel.supportsAdaptiveThinking ?? null,
          supportedEffortLevels: initModel.supportedEffortLevels ?? null,
        }
      : null;

    for await (const message of messages) {
      handleMessage(summary, message);
    }
  } catch (error) {
    summary.error = error instanceof Error ? error.message : String(error);
  }

  return summary;
}

function handleMessage(summary: ProbeSummary, message: SDKMessage): void {
  if (message.type === "stream_event") {
    const event = message.event as {
      type?: string;
      delta?: {
        type?: string;
      };
    };
    const eventType = event.delta?.type ?? event.type;
    if (typeof eventType === "string" && eventType.includes("thinking")) {
      summary.streamThinkingEventTypes[eventType] =
        (summary.streamThinkingEventTypes[eventType] ?? 0) + 1;
    }
    return;
  }

  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (typeof block?.type === "string" && block.type.includes("thinking")) {
        summary.assistantThinkingBlockCount += 1;
      }
    }
    return;
  }

  if (message.type === "result") {
    summary.resultSubtype = message.subtype;
    summary.resultText = message.subtype === "success" ? message.result : message.errors.join("\n");
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const results: ProbeSummary[] = [];

  for (const caseName of args.cases) {
    results.push(
      await runCase({
        caseName,
        model: args.model,
        ...(args.cwd ? { cwd: args.cwd } : {}),
        prompt: args.prompt,
      }),
    );
  }

  console.log(JSON.stringify(results, null, 2));
}

await main();
