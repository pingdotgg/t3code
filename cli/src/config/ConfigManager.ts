import Conf from "conf";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

interface CliConfig {
  apiKey: string;
  model: string;
}

export class ConfigManager {
  private conf: Conf<CliConfig>;

  constructor() {
    this.conf = new Conf<CliConfig>({ projectName: "t3code-cli" });
  }

  getApiKey(): string | null {
    return (this.conf.get("apiKey") as string | undefined) ?? null;
  }

  setApiKey(apiKey: string): void {
    this.conf.set("apiKey", apiKey);
  }

  getModel(): string {
    return (this.conf.get("model") as string | undefined) ?? "claude-opus-4-6";
  }

  setModel(model: string): void {
    this.conf.set("model", model);
  }

  /** Interactive setup — prompts for API key using Node.js readline. */
  async runSetup(): Promise<void> {
    const rl = readline.createInterface({ input, output });

    console.log("\nT3 Code CLI — Configuration\n");

    const existing = this.getApiKey();
    if (existing) {
      const masked =
        existing.length > 8
          ? `${existing.slice(0, 8)}${"*".repeat(existing.length - 8)}`
          : existing;
      console.log(`Current API key: ${masked}`);
    }

    let apiKey: string;
    try {
      apiKey = await rl.question("Anthropic API key (sk-ant-...): ");
    } catch {
      rl.close();
      console.log("\nCancelled.");
      process.exit(0);
    } finally {
      rl.close();
    }

    const trimmed = apiKey!.trim();
    if (!trimmed) {
      console.error("\nNo API key entered. Configuration unchanged.");
      process.exit(1);
    }

    this.setApiKey(trimmed);
    console.log("\n✓ API key saved.");
    console.log("Start coding: t3code start\n");
  }

  get configPath(): string {
    return this.conf.path;
  }
}
