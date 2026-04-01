import { Effect, Layer } from "effect";
import { makeTerminalManagerWithOptions } from "./Manager.shared";
import { ServerConfig } from "../../config";
import { TerminalManager } from "../Services/Manager";
import { PtyAdapter } from "../Services/PTY";

const makeTerminalManager = Effect.fn("makeTerminalManager")(function* () {
  const { terminalLogsDir } = yield* ServerConfig;
  const ptyAdapter = yield* PtyAdapter;
  return yield* makeTerminalManagerWithOptions({
    logsDir: terminalLogsDir,
    ptyAdapter,
  });
});

export const TerminalManagerLive = Layer.effect(TerminalManager, makeTerminalManager());
