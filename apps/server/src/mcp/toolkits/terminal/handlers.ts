import * as Effect from "effect/Effect";

import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { TerminalMcpService } from "../../TerminalMcpService.ts";
import { TerminalToolkit } from "./tools.ts";

const handlers = {
  t3_terminal_list: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* TerminalMcpService;
      return yield* service.list(scope, input);
    }),
  t3_terminal_read: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* TerminalMcpService;
      return yield* service.read(scope, input);
    }),
  t3_terminal_open: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* TerminalMcpService;
      return yield* service.open(scope, input);
    }),
  t3_terminal_write: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* TerminalMcpService;
      return yield* service.write(scope, input);
    }),
  t3_terminal_resize: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* TerminalMcpService;
      return yield* service.resize(scope, input);
    }),
  t3_terminal_clear: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* TerminalMcpService;
      return yield* service.clear(scope, input);
    }),
  t3_terminal_restart: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* TerminalMcpService;
      return yield* service.restart(scope, input);
    }),
  t3_terminal_close: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* TerminalMcpService;
      return yield* service.close(scope, input);
    }),
} satisfies Parameters<typeof TerminalToolkit.toLayer>[0];

export const TerminalToolkitHandlersLive = TerminalToolkit.toLayer(handlers);
