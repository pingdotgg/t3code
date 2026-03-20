import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { query, type SpawnOptions, type SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";

async function* emptyPrompt(): AsyncGenerator<never, void, void> {}

class FakeClaudeCodeProcess implements SpawnedProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  killed = false;
  exitCode: number | null = null;

  private readonly events = new EventEmitter();
  private bufferedInput = "";

  constructor(
    private readonly onMessage: (
      message: Record<string, unknown>,
      process: FakeClaudeCodeProcess,
    ) => void,
  ) {
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => {
      this.bufferedInput += chunk;
      this.drainInput();
    });
  }

  emitJson(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  kill(_signal: NodeJS.Signals): boolean {
    this.killed = true;
    this.exitCode = 0;
    this.stdout.end();
    this.events.emit("exit", 0, null);
    return true;
  }

  on(
    event: "exit" | "error",
    listener:
      | ((code: number | null, signal: NodeJS.Signals | null) => void)
      | ((error: Error) => void),
  ): void {
    this.events.on(event, listener);
  }

  once(
    event: "exit" | "error",
    listener:
      | ((code: number | null, signal: NodeJS.Signals | null) => void)
      | ((error: Error) => void),
  ): void {
    this.events.once(event, listener);
  }

  off(
    event: "exit" | "error",
    listener:
      | ((code: number | null, signal: NodeJS.Signals | null) => void)
      | ((error: Error) => void),
  ): void {
    this.events.off(event, listener);
  }

  private drainInput(): void {
    while (true) {
      const newlineIndex = this.bufferedInput.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      const line = this.bufferedInput.slice(0, newlineIndex).trim();
      this.bufferedInput = this.bufferedInput.slice(newlineIndex + 1);
      if (line.length === 0) {
        continue;
      }
      this.onMessage(JSON.parse(line) as Record<string, unknown>, this);
    }
  }
}

describe("Claude SDK fast mode probe", () => {
  let activeQuery: ReturnType<typeof query> | null = null;

  afterEach(() => {
    activeQuery?.close();
    activeQuery = null;
  });

  it("passes fast mode through the SDK settings flag", async () => {
    let spawnOptions: SpawnOptions | undefined;

    activeQuery = query({
      prompt: emptyPrompt(),
      options: {
        persistSession: false,
        settings: {
          fastMode: true,
        },
        spawnClaudeCodeProcess: (options): SpawnedProcess => {
          spawnOptions = options;
          return new FakeClaudeCodeProcess((message, process) => {
            if (
              message.type !== "control_request" ||
              typeof message.request_id !== "string" ||
              !message.request ||
              typeof message.request !== "object" ||
              (message.request as { subtype?: unknown }).subtype !== "initialize"
            ) {
              return;
            }

            process.emitJson({
              type: "control_response",
              response: {
                subtype: "success",
                request_id: message.request_id,
                response: {
                  commands: [],
                  agents: [],
                  output_style: "default",
                  available_output_styles: ["default"],
                  models: [],
                  account: {
                    subscriptionType: "max",
                  },
                  fast_mode_state: "on",
                },
              },
            });
          });
        },
      },
    });

    const initialization = await activeQuery.initializationResult();
    expect(initialization.fast_mode_state).toBe("on");

    expect(spawnOptions).toBeDefined();
    const settingsFlagIndex = spawnOptions?.args.indexOf("--settings") ?? -1;
    expect(settingsFlagIndex).toBeGreaterThan(-1);
    expect(JSON.parse(spawnOptions?.args[settingsFlagIndex + 1] ?? "")).toEqual({
      fastMode: true,
    });
  });
});
