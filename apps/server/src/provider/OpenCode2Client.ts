import { OpenCode, type OpenCodeClient, type PermissionRuleset } from "@opencode/client";
import type { RuntimeMode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Native OpenCode 2 requests never pass through the OpenCode 1 SDK. */
export class OpenCode2RequestError extends Schema.TaggedError<OpenCode2RequestError>()(
  "OpenCode2RequestError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `OpenCode 2 request failed during ${this.operation}.`;
  }
}

export const request = <A>(operation: string, run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new OpenCode2RequestError({ operation, cause }),
  }).pipe(
    Effect.timeout("30 seconds"),
    Effect.mapError((cause) =>
      cause._tag === "OpenCode2RequestError"
        ? cause
        : new OpenCode2RequestError({ operation, cause }),
    ),
  );

export function make(input: {
  readonly url: string;
  readonly serverPassword?: string;
  readonly fetch?: typeof globalThis.fetch;
}): OpenCodeClient {
  return OpenCode.make({
    baseUrl: input.url,
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.serverPassword
      ? {
          headers: {
            Authorization: `Basic ${Buffer.from(`opencode:${input.serverPassword}`, "utf8").toString("base64")}`,
          },
        }
      : {}),
  });
}

/** Apply these on the native session, after global and agent permissions. */
export function sessionRules(mode: RuntimeMode, ownMcpName?: string): PermissionRuleset {
  return [
    ...(mode === "full-access"
      ? []
      : [
          { action: "*", resource: "*", effect: "ask" as const },
          ...["read", "glob", "grep", "question", "skill"].map((action) => ({
            action,
            resource: "*",
            effect: "allow" as const,
          })),
          { action: "read", resource: "*.env", effect: "ask" as const },
          { action: "read", resource: "*.env.*", effect: "ask" as const },
          { action: "read", resource: "*.env.example", effect: "allow" as const },
          {
            action: "edit",
            resource: "*",
            effect: mode === "auto-accept-edits" ? ("allow" as const) : ("ask" as const),
          },
        ]),
    // This adapter does not advertise provider-native child-thread lifecycles.
    { action: "subagent", resource: "*", effect: "deny" },
    { action: "t3-code-*", resource: "*", effect: "deny" },
    ...(ownMcpName ? [{ action: `${ownMcpName}_*`, resource: "*", effect: "allow" as const }] : []),
  ];
}

/** Cursors carry their ordering; sending order again is rejected by the server. */
export const messages = Effect.fn("OpenCode2Client.messages")(function* (
  client: OpenCodeClient,
  sessionID: string,
) {
  const result: Awaited<ReturnType<OpenCodeClient["message"]["list"]>>["data"] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = yield* request("message.list", (signal) =>
      client.message.list(
        { sessionID, limit: 200, ...(cursor ? { cursor } : { order: "asc" as const }) },
        { signal },
      ),
    );
    result.push(...page.data);
    cursor = page.cursor.next ?? undefined;
    if (page.data.length === 0 || cursor === undefined) break;
    if (cursors.has(cursor))
      return yield* new OpenCode2RequestError({ operation: "message.list.cursor" });
    cursors.add(cursor);
  } while (cursor);
  return result;
});
