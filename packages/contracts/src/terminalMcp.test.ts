import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  TERMINAL_MCP_MAX_LIST_LIMIT,
  TERMINAL_MCP_MAX_OUTPUT_CHARS,
  TerminalMcpListInput,
  TerminalMcpReadInput,
  TerminalMcpWriteInput,
} from "./terminalMcp.ts";

const decodeListInput = Schema.decodeUnknownEffect(TerminalMcpListInput);
const decodeReadInput = Schema.decodeUnknownEffect(TerminalMcpReadInput);
const decodeWriteInput = Schema.decodeUnknownEffect(TerminalMcpWriteInput);

describe("terminal MCP contracts", () => {
  it.effect("keeps list and output requests bounded", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* decodeListInput({}), {});
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            decodeListInput({
              limit: TERMINAL_MCP_MAX_LIST_LIMIT + 1,
            }),
          ),
        ),
      );
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            decodeReadInput({
              terminalId: "term-1",
              maxChars: TERMINAL_MCP_MAX_OUTPUT_CHARS + 1,
            }),
          ),
        ),
      );
    }),
  );

  it.effect("requires explicit terminal ids and bounded non-empty PTY input", () =>
    Effect.gen(function* () {
      for (const input of [
        { data: "pwd\r" },
        { terminalId: "term-1", data: "" },
        { terminalId: "term-1", data: "x".repeat(65_537) },
      ]) {
        assert.isTrue(Exit.isFailure(yield* Effect.exit(decodeWriteInput(input))));
      }
      assert.deepEqual(
        yield* decodeWriteInput({
          terminalId: "term-1",
          data: "pwd\r",
        }),
        { terminalId: "term-1", data: "pwd\r" },
      );
    }),
  );
});
