#!/usr/bin/env node
import { Command } from "commander";
import { startCodeSession } from "./commands/start.ts";
import { continueSession } from "./commands/continue.ts";
import { configureAPI } from "./commands/config.ts";
import { handleFatalError } from "./utils/error-handler.ts";

const program = new Command();

program
  .name("t3code")
  .description("AI pair programmer powered by Claude (T3 Code CLI)")
  .version("0.0.1")
  .option("-m, --model <model>", "Claude model to use", undefined);

program
  .command("start")
  .description("Start a coding session in the current directory")
  .option("-d, --directory <path>", "Working directory", process.cwd())
  .option("-m, --model <model>", "Claude model to use", undefined)
  .action((options: { directory: string; model?: string }) =>
    startCodeSession(options).catch(handleFatalError),
  );

program
  .command("continue")
  .description("Resume the previous session in this directory")
  .option("-m, --model <model>", "Claude model to use", undefined)
  .action((options: { model?: string }) =>
    continueSession(options).catch(handleFatalError),
  );

program
  .command("config")
  .description("Configure API key and settings")
  .action(() => configureAPI().catch(handleFatalError));

// Default (no subcommand): start in cwd
program.action((options: { model?: string }) => {
  const opts: { directory: string; model?: string } = {
    directory: process.cwd(),
  };
  if (options.model) opts.model = options.model;
  startCodeSession(opts).catch(handleFatalError);
});

program.parse();
