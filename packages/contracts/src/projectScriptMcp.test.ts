import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  PROJECT_SCRIPT_MCP_MAX_LIST_LIMIT,
  PROJECT_SCRIPT_MCP_MAX_PREVIEW_CHARS,
  ProjectScriptMcpListInput,
  ProjectScriptMcpRunInput,
  ProjectScriptMcpStopInput,
} from "./projectScriptMcp.ts";

const decodeList = Schema.decodeUnknownEffect(ProjectScriptMcpListInput);
const decodeRun = Schema.decodeUnknownEffect(ProjectScriptMcpRunInput);
const decodeStop = Schema.decodeUnknownEffect(ProjectScriptMcpStopInput);

describe("project script MCP contracts", () => {
  it.effect("bounds pages and command previews", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* decodeList({}), {});
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(decodeList({ limit: PROJECT_SCRIPT_MCP_MAX_LIST_LIMIT + 1 })),
        ),
      );
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            decodeList({ commandPreviewChars: PROJECT_SCRIPT_MCP_MAX_PREVIEW_CHARS + 1 }),
          ),
        ),
      );
    }),
  );

  it.effect("requires saved script and returned terminal handles", () =>
    Effect.gen(function* () {
      assert.isTrue(Exit.isFailure(yield* Effect.exit(decodeRun({}))));
      assert.isTrue(Exit.isFailure(yield* Effect.exit(decodeStop({ scriptId: "dev" }))));
      assert.isTrue(Exit.isFailure(yield* Effect.exit(decodeRun({ scriptId: "dev" }))));
      assert.deepEqual(yield* decodeRun({ scriptId: "dev", terminalId: "script-run:1" }), {
        scriptId: "dev",
        terminalId: "script-run:1",
      });
      assert.deepEqual(yield* decodeStop({ scriptId: "dev", terminalId: "script-run:1" }), {
        scriptId: "dev",
        terminalId: "script-run:1",
      });
      const persistedScriptId = "saved-script:".padEnd(1_024, "x");
      assert.deepEqual(
        yield* decodeRun({ scriptId: persistedScriptId, terminalId: "script-run:long-id" }),
        { scriptId: persistedScriptId, terminalId: "script-run:long-id" },
      );
    }),
  );
});
