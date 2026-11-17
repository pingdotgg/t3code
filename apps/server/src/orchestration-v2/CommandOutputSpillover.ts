import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { terminalOutputTail } from "@t3tools/shared/terminalOutput";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";

export const MAX_INLINE_COMMAND_OUTPUT_CHARS = 100_000;
export const MAX_INLINE_COMMAND_OUTPUT_LINES = 1_000;
const COMMAND_OUTPUT_PREVIEW_CHARS = 20_000;

export interface CommandSpilloverOptions {
  readonly logsDir?: string;
  readonly commandLogsDir?: string;
  readonly maxChars?: number;
  readonly maxLines?: number;
  readonly previewChars?: number;
}

function exceedsLineLimit(text: string, maxLines: number): boolean {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      count++;
      if (count >= maxLines) return true;
    }
  }
  return false;
}

export function shouldSpilloverCommandOutput(
  output: string,
  limits?: { readonly maxChars?: number; readonly maxLines?: number },
): boolean {
  const maxChars = limits?.maxChars ?? MAX_INLINE_COMMAND_OUTPUT_CHARS;
  const maxLines = limits?.maxLines ?? MAX_INLINE_COMMAND_OUTPUT_LINES;
  return output.length > maxChars || exceedsLineLimit(output, maxLines);
}

function sanitizeTurnItemIdForFilename(itemId: string): string {
  return itemId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function resolveCommandLogFilePath(
  path: Path.Path,
  itemId: string,
  commandLogsDir: string,
): string {
  const filename = `${sanitizeTurnItemIdForFilename(itemId)}.log`;
  return path.join(commandLogsDir, filename);
}

function formatSpilloverOutputPreview(
  rawOutput: string,
  logFilePath: string,
  previewChars: number = COMMAND_OUTPUT_PREVIEW_CHARS,
): string {
  const tail = terminalOutputTail(rawOutput, previewChars);
  return `[Earlier output written to log file: ${logFilePath}]\n\n${tail.text}`;
}

export const spilloverCommandOutputTurnItem = Effect.fnUntraced(function* (
  item: OrchestrationV2TurnItem,
  options?: CommandSpilloverOptions,
) {
  if (item.type !== "command_execution") return item;
  if (item.output === undefined || item.outputFilePath !== undefined) return item;
  if (!shouldSpilloverCommandOutput(item.output, options)) return item;

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfigOption = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const homeDir = yield* Config.String("HOME").pipe(Config.withDefault("/tmp"));
  const commandLogsDir =
    options?.commandLogsDir ??
    (options?.logsDir ? path.join(options.logsDir, "commands") : undefined) ??
    (Option.isSome(serverConfigOption) ? serverConfigOption.value.commandLogsDir : undefined) ??
    path.join(homeDir, ".t3", "userdata", "logs", "commands");

  const logFilePath = resolveCommandLogFilePath(path, item.id, commandLogsDir);

  const writeResult = yield* fs.makeDirectory(path.dirname(logFilePath), { recursive: true }).pipe(
    Effect.andThen(fs.writeFileString(logFilePath, item.output)),
    Effect.as(true),
    Effect.catch((cause) =>
      Effect.logWarning("Could not write command output log file", { cause }).pipe(
        Effect.as(false),
      ),
    ),
  );

  if (!writeResult) {
    return item;
  }

  const boundedOutput = formatSpilloverOutputPreview(
    item.output,
    logFilePath,
    options?.previewChars ?? COMMAND_OUTPUT_PREVIEW_CHARS,
  );

  return {
    ...item,
    output: boundedOutput,
    outputFilePath: logFilePath,
  };
});
