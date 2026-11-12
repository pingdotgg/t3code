import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { rejectSpecialistStdioMcpBelowFullAccess } from "./specialistRoleMcpAccess.ts";

it.effect("rejects stdio role MCP unless the caller ceiling is full-access", () =>
  Effect.gen(function* () {
    const error = yield* rejectSpecialistStdioMcpBelowFullAccess(
      { runtimeMode: "approval-required" },
      {
        tools: { type: "stdio", command: "vault-mcp" },
      },
    ).pipe(Effect.flip);
    expect(error.code).toBe("runtime_mode_escalation_denied");
    yield* rejectSpecialistStdioMcpBelowFullAccess(
      { runtimeMode: "full-access" },
      {
        tools: { type: "stdio", command: "vault-mcp" },
      },
    );
    yield* rejectSpecialistStdioMcpBelowFullAccess(
      { runtimeMode: "approval-required" },
      {
        tools: { type: "http", url: "https://example.test/mcp" },
      },
    );
  }),
);
