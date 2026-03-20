import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

type ProbeMode = "off" | "on";

async function* emptyPrompt(): AsyncGenerator<never, void, void> {}

function parseArgs(argv: ReadonlyArray<string>): {
  readonly mode: ProbeMode | "both";
  readonly model?: string;
  readonly cwd?: string;
  readonly prompt?: string;
} {
  let mode: ProbeMode | "both" = "both";
  let model: string | undefined;
  let cwd: string | undefined;
  let prompt: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value) {
      continue;
    }
    if (value === "--mode") {
      const next = argv[index + 1];
      if (next === "off" || next === "on" || next === "both") {
        mode = next;
        index += 1;
      }
      continue;
    }
    if (value === "--model") {
      model = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--cwd") {
      cwd = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--prompt") {
      prompt = argv[index + 1] ?? prompt;
      index += 1;
    }
  }

  return {
    mode,
    ...(model ? { model } : {}),
    ...(cwd ? { cwd } : {}),
    ...(prompt ? { prompt } : {}),
  };
}

async function runProbe(input: {
  readonly mode: ProbeMode;
  readonly model?: string;
  readonly cwd?: string;
  readonly prompt?: string;
}): Promise<void> {
  const messages = query({
    prompt: input.prompt ?? emptyPrompt(),
    options: {
      ...(input.model ? { model: input.model } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      persistSession: false,
      tools: [],
      permissionMode: "plan",
      includePartialMessages: true,
      ...(input.mode === "on" ? { settings: { fastMode: true } } : {}),
    },
  });

  const summary = {
    mode: input.mode,
    initFastModeState: null as string | null,
    resultFastModeState: null as string | null,
    resultSubtype: null as string | null,
    resultText: null as string | null,
  };

  const initialization = await messages.initializationResult();
  summary.initFastModeState = initialization.fast_mode_state ?? null;

  if (!input.prompt) {
    messages.close();
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  for await (const message of messages) {
    handleProbeMessage(message, summary);
  }
  console.log(JSON.stringify(summary, null, 2));
}

function handleProbeMessage(
  message: SDKMessage,
  summary: {
    mode: ProbeMode;
    initFastModeState: string | null;
    resultFastModeState: string | null;
    resultSubtype: string | null;
    resultText: string | null;
  },
): void {
  if (message.type !== "result") {
    return;
  }
  summary.resultSubtype = message.subtype;
  summary.resultFastModeState = message.fast_mode_state ?? null;
  summary.resultText = message.subtype === "success" ? message.result : message.errors.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const modes = args.mode === "both" ? (["off", "on"] as const) : [args.mode];

  for (const mode of modes) {
    await runProbe({
      mode,
      ...(args.model ? { model: args.model } : {}),
      ...(args.cwd ? { cwd: args.cwd } : {}),
      ...(args.prompt ? { prompt: args.prompt } : {}),
    });
  }
}

await main();
