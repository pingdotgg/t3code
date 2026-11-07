import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Sessions from "@t3tools/provider-core/server/McpProviderSessions";
import { EXTERNAL_TOOL_HOST_CHALLENGE_PREFIX } from "@t3tools/provider-core/server/mcpSession";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  handleHostElicitation,
  type HostTurn,
  permitsOrdinaryElicitation,
  withHostElicitation,
} from "./codexHostElicitation.ts";

const decodeElicitation = Schema.decodeUnknownEffect(CodexSchema.McpServerElicitationRequestParams);

it("enables host verification while keeping every execution approval at its original setting", () => {
  expect(withHostElicitation("never", false)).toBe("never");
  expect(withHostElicitation("never", true)).toEqual({
    granular: {
      mcp_elicitations: true,
      rules: false,
      sandbox_approval: false,
      request_permissions: false,
      skill_approval: false,
    },
  });
  expect(withHostElicitation("untrusted", true)).toBe("untrusted");
  expect(
    withHostElicitation(
      { granular: { mcp_elicitations: false, rules: true, sandbox_approval: true } },
      true,
    ),
  ).toEqual({ granular: { mcp_elicitations: true, rules: true, sandbox_approval: true } });
  expect(permitsOrdinaryElicitation("never", false)).toBe(false);
  expect(permitsOrdinaryElicitation(undefined, true)).toBe(false);
  expect(permitsOrdinaryElicitation(undefined, false)).toBe(true);
  expect(permitsOrdinaryElicitation({ granular: { mcp_elicitations: false } }, false)).toBe(false);
});

it.effect(
  "attests only matching active native turns, consumes challenges once, and preserves ordinary policy",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions.McpProviderSessions;
      yield* sessions.set({
        environmentId: EnvironmentId.make("test"),
        threadId: ThreadId.make("work"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerSessionId: "launch",
        endpoint: "http://localhost/mcp",
        authorizationHeader: "Bearer test",
        browserToolsAvailable: false,
      });
      const root: HostTurn = {
        nativeThreadId: "native-root",
        providerSessionId: "launch",
        nativeChild: false,
        enabled: true,
        approvalPolicy: "never",
        fullAccess: true,
      };
      const lookup = (id: string) =>
        Effect.succeed(
          id === "active"
            ? root
            : id === "child"
              ? { ...root, nativeThreadId: "native-child", nativeChild: true }
              : undefined,
        );
      const payload = {
        serverName: "t3-code",
        mode: "form",
        turnId: "active",
        threadId: "native-root",
        message: "",
      };
      for (const variant of [
        {},
        { mode: "openai/form" },
        { mode: "openaiForm" },
        { turnId: "child", threadId: "native-child" },
      ]) {
        const challenge = (yield* sessions.beginHostInvocation("launch"))!;
        const input = {
          ...payload,
          ...variant,
          message: EXTERNAL_TOOL_HOST_CHALLENGE_PREFIX + challenge,
        };
        expect(
          (yield* handleHostElicitation(input, lookup, sessions.attestHostInvocation))?.action,
        ).toBe("accept");
        expect(
          (yield* handleHostElicitation(input, lookup, sessions.attestHostInvocation))?.action,
        ).toBe("decline");
        expect(yield* sessions.takeHostInvocation(challenge, "launch")).toBe(
          variant.turnId === "child",
        );
        expect(
          (yield* handleHostElicitation(input, lookup, sessions.attestHostInvocation))?.action,
        ).toBe("decline");
      }
      for (const variant of [
        { threadId: "other" },
        { turnId: null },
        { turnId: "missing" },
        { serverName: "other" },
        { mode: "url" },
      ]) {
        const challenge = (yield* sessions.beginHostInvocation("launch"))!;
        expect(
          (yield* handleHostElicitation(
            { ...payload, ...variant, message: EXTERNAL_TOOL_HOST_CHALLENGE_PREFIX + challenge },
            lookup,
            sessions.attestHostInvocation,
          ))?.action,
        ).toBe("decline");
        expect(yield* sessions.takeHostInvocation(challenge, "launch")).toBeUndefined();
      }
      for (const approvalPolicy of ["never", { granular: { mcp_elicitations: false } }])
        expect(
          (yield* handleHostElicitation(
            { ...payload, message: "ordinary" },
            () => Effect.succeed({ ...root, approvalPolicy }),
            sessions.attestHostInvocation,
          ))?.action,
        ).toBe("decline");
      expect(
        yield* handleHostElicitation(
          { ...payload, message: "ordinary" },
          () => Effect.succeed({ ...root, enabled: false }),
          sessions.attestHostInvocation,
        ),
      ).toBeUndefined();
    }).pipe(Effect.provide(Sessions.layer)),
);

it.effect(
  "restores only full-access never-policy tool approvals while preserving ordinary form refusal",
  () =>
    Effect.gen(function* () {
      const context: HostTurn = {
        nativeThreadId: "native",
        providerSessionId: "session",
        nativeChild: false,
        enabled: true,
        approvalPolicy: "never",
        fullAccess: true,
      };
      const payload = {
        serverName: "third-party",
        mode: "form",
        threadId: "native",
        turnId: "active",
        message: "tool approval",
        _meta: { codex_approval_kind: "mcp_tool_call" },
        requestedSchema: { type: "object", properties: {} },
      };
      const handle = (
        input: Parameters<typeof handleHostElicitation>[0] = payload,
        scope = context,
      ) =>
        handleHostElicitation(
          input,
          () => Effect.succeed(scope),
          () => Effect.succeed(false),
        );
      // The shape Codex 0.166.0 sent, through the schema the adapter's request handler decodes with.
      expect((yield* handle(yield* decodeElicitation(payload)))?.action).toBe("accept");
      expect((yield* handle(payload, { ...context, approvalPolicy: undefined }))?.action).toBe(
        "accept",
      );
      expect((yield* handle(payload, { ...context, nativeChild: true }))?.action).toBe("accept");
      for (const mode of ["form", "openai/form", "openaiForm"])
        expect((yield* handle({ ...payload, mode }))?.action).toBe("accept");
      for (const input of [
        {
          ...payload,
          requestedSchema: { type: "object", properties: { input: { type: "string" } } },
        },
        { ...payload, requestedSchema: { type: "string", properties: {} } },
        { ...payload, requestedSchema: { type: "object" } },
        { ...payload, _meta: null },
        { ...payload, _meta: {} },
        { ...payload, _meta: { codex_approval_kind: "other" } },
        { ...payload, threadId: "other" },
        { ...payload, mode: "url" },
      ])
        expect((yield* handle(input))?.action).toBe("decline");
      expect(
        (yield* handle(payload, {
          ...context,
          approvalPolicy: { granular: { mcp_elicitations: false } },
        }))?.action,
      ).toBe("decline");
      expect(
        yield* handle(payload, {
          ...context,
          approvalPolicy: "on-request",
        }),
      ).toBeUndefined();
      expect((yield* handle(payload, { ...context, fullAccess: false }))?.action).toBe("decline");
      expect(yield* handle(payload, { ...context, enabled: false })).toBeUndefined();
      let attested = false;
      expect(
        (yield* handleHostElicitation(
          {
            ...payload,
            serverName: "t3-code",
            message: EXTERNAL_TOOL_HOST_CHALLENGE_PREFIX + "test",
          },
          () => Effect.succeed({ ...context, enabled: false }),
          () =>
            Effect.sync(() => {
              attested = true;
              return true;
            }),
        ))?.action,
      ).toBe("decline");
      expect(attested).toBe(false);
    }),
);
