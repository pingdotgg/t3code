import { stripVTControlCharacters } from "node:util";
import * as Effect from "effect/Effect";
import { makeLineBuffer } from "./LineBuffer.ts";
import { logChildLine } from "./LogRecord.ts";
import { ANSI_RESET, ansiFg, colorsEnabled } from "./Terminal.ts";
import { theme } from "./Theme.ts";

export type OutputChannel = "stdout" | "stderr";

/** Sigil-themed resource attribution shared by every append-only log path. */
export const formatResourceTag = (id: string, colors = colorsEnabled()): string =>
  colors ? `${ansiFg(theme.color.info)}[${id}]${ANSI_RESET}` : `[${id}]`;

const EFFECT_LOG_PREFIX =
  /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] (?:ALL|TRACE|DEBUG|INFO|WARN|ERROR|FATAL|NONE) \(#\d+\)(?: [^:]+)?: /;

/** Remove a pretty Effect prefix already rendered by a child process. */
export const stripChildEffectPrefix = (line: string): string => {
  const match = stripVTControlCharacters(line).match(EFFECT_LOG_PREFIX);
  if (match === null) return line;

  // The match is measured against visible text. Walk the original line so
  // ANSI embedded in the child message survives while the prefix's ANSI is
  // discarded with the prefix itself.
  let visible = 0;
  let offset = 0;
  while (offset < line.length && visible < match[0].length) {
    if (line[offset] === "\x1b") {
      // oxlint-disable-next-line no-control-regex
      const ansi = line.slice(offset).match(/^\x1b\[[0-?]*[ -/]*[@-~]/);
      if (ansi !== null) {
        offset += ansi[0].length;
        continue;
      }
    }
    offset++;
    visible++;
  }
  return line.slice(offset);
};

/**
 * Log one line a resource-owned process wrote, as a structured record: the
 * child's text (with any pretty Effect prefix removed) plus the resource and
 * stream it came from. The record keeps the text as written; the renderer
 * draws the resource tag and strips styling when colors are off. A JSON line from an alchemy child is replayed as-is.
 *
 * stderr is a process transport, not a semantic failure: Vite and many other
 * tools write warnings, progress, and ordinary diagnostics there, so both
 * streams log at Info and carry the stream as data.
 */
export const logResourceLine = (id: string, channel: OutputChannel, line: string) =>
  logChildLine(stripChildEffectPrefix(line), { stream: channel, resource: id });

/**
 * Line-buffered output for resource-owned child processes whose streams
 * arrive as chunks outside an Effect (workerd output pumps, stream mirrors).
 * Captures the caller's services so each line goes through its loggers.
 */
export const makeResourceOutput = Effect.fn(function* (id: string) {
  const context = yield* Effect.context<never>();
  const writer = (channel: OutputChannel) =>
    makeLineBuffer((line) => Effect.runSyncWith(context)(logResourceLine(id, channel, line)));
  return { stdout: writer("stdout"), stderr: writer("stderr") };
});

/**
 * Effect-native output for resource-owned child processes whose streams are
 * already consumed inside an Effect.
 */
export const makeResourceLogger = (id: string) => (channel: OutputChannel, line: string) =>
  logResourceLine(id, channel, line);
