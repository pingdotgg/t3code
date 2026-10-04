// @effect-diagnostics nodeBuiltinImport:off - exercises customer HTTP semantics over real sockets.
import * as NodeHttp from "node:http";
import * as NodeEvents from "node:events";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Redacted from "effect/Redacted";
import * as Cloud from "./KiloCloudWebClient.ts";
import { KiloCloudError } from "./KiloCloudClient.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const binding: Cloud.CloudBinding = {
  accountId: "customer-a",
  cloudAgentSessionId: "workspace_12345678-1234-1234-1234-123456789abc",
  worktreeId: "worktree_12345678-1234-1234-1234-123456789abc",
  kiloSessionId: "ses_synthetic",
  repository: "fixture/project",
  branch: "main",
};
const messageId = "msg_0123456789ab0123456789ABCD";
const start = {
  operationKey: "12345678-1234-4234-9234-123456789abc",
  initialMessageId: messageId,
  prompt: "Read README only",
  repository: binding.repository,
  branch: "main",
  model: "fixture/model",
};
const session = {
  sessionId: binding.cloudAgentSessionId,
  kiloSessionId: binding.kiloSessionId,
  worktreeId: binding.worktreeId,
  userId: binding.accountId,
  githubRepo: binding.repository,
  upstreamBranch: "main",
  autoCommit: false,
  initialMessageId: messageId,
  execution: null,
};
const run = Effect.runPromise;
async function server(
  handler: (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => void,
  profiles: unknown = [],
  bindings: unknown = [],
) {
  const server = NodeHttp.createServer((request, response) => {
    if (request.url?.startsWith("/api/trpc/agentProfiles.listRepoBindings"))
      return json(response, bindings);
    if (request.url?.startsWith("/api/trpc/agentProfiles.list")) return json(response, profiles);
    handler(request, response);
  });
  server.listen(0, "127.0.0.1");
  await NodeEvents.EventEmitter.once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const options = {
    accountId: binding.accountId,
    token: Redacted.make("fixture-token"),
    origin: `http://127.0.0.1:${address.port}`,
  };
  return { options, client: Cloud.make(options), httpServer: server };
}
function json(response: NodeHttp.ServerResponse, data: unknown) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ result: { data } }));
}
describe("Kilo personal Cloud control-plane customer API", () => {
  it("never binds a partial match after bounded candidate failures and drops failed scan state", async () => {
    let unavailable = true;
    let lists = 0;
    let badReads = 0;
    const missing = "workspace_00000000-0000-0000-0000-000000000000";
    const { client } = await server((req, res) => {
      expect(req.method).toBe("GET");
      const url = new URL(req.url!, "http://localhost");
      const input = JSON.parse(url.searchParams.get("input")!) as Record<string, string>;
      if (url.pathname.endsWith("cliSessionsV2.list")) {
        lists++;
        return json(res, {
          cliSessions: [
            { session_id: "ses_unavailable", cloud_agent_session_id: missing },
            { session_id: session.kiloSessionId, cloud_agent_session_id: session.sessionId },
          ],
          nextCursor: null,
        });
      }
      if (input.cloudAgentSessionId === missing) {
        badReads++;
        res.writeHead(unavailable ? 503 : 404);
        res.end();
        return;
      }
      return json(res, session);
    });
    expect(await run(client.findAdmission(binding.repository, messageId))).toBeNull();
    expect(await run(client.findAdmission(binding.repository, messageId))).toBeNull();
    expect(
      (await run(client.findAdmission(binding.repository, messageId).pipe(Effect.flip))).reason,
    ).toBe("recovery_incomplete");
    expect(badReads).toBe(3);
    expect(lists).toBe(1);
    unavailable = false;
    expect(await run(client.findAdmission(binding.repository, messageId))).toEqual({
      cloudAgentSessionId: session.sessionId,
      kiloSessionId: session.kiloSessionId,
    });
    expect(lists).toBe(2);
  });
  it("clears abandoned scans and repeated cursors without treating partial reads as absence", async () => {
    let repeated = true;
    const cursors: Array<string | undefined> = [];
    const { client } = await server((req, res) => {
      const url = new URL(req.url!, "http://localhost");
      const input = JSON.parse(url.searchParams.get("input")!) as Record<string, string>;
      cursors.push(input.cursor);
      return json(res, { cliSessions: [], nextCursor: repeated ? "cycle" : null });
    });
    expect(
      (await run(client.findAdmission(binding.repository, messageId).pipe(Effect.flip))).reason,
    ).toBe("recovery_incomplete");
    repeated = false;
    expect(await run(client.findAdmission(binding.repository, messageId))).toBeNull();
    expect(cursors).toEqual([undefined, "cycle", undefined]);
    await run(client.forgetAdmission(binding.repository, messageId));
  });
  it("continues an uncertain-admission scan across read budgets and cursor pages without resubmitting", async () => {
    const reads: string[] = [];
    const cursors: Array<string | null> = [];
    const candidates = Array.from({ length: 101 }, (_, index) => ({
      session_id: `ses_candidate${index}`,
      cloud_agent_session_id: `workspace_12345678-1234-1234-1234-${String(index).padStart(12, "0")}`,
    }));
    const { client } = await server((req, res) => {
      expect(req.method).toBe("GET");
      const url = new URL(req.url!, "http://localhost");
      const input = JSON.parse(url.searchParams.get("input")!) as Record<string, string>;
      if (url.pathname.endsWith("cliSessionsV2.list")) {
        cursors.push(input.cursor ?? null);
        expect(input.organizationId).toBeNull();
        return json(res, {
          cliSessions: input.cursor ? candidates.slice(100) : candidates.slice(0, 100),
          nextCursor: input.cursor ? null : "2026-10-01T00:00:00.000Z",
        });
      }
      const candidate = candidates.find(
        (item) => item.cloud_agent_session_id === input.cloudAgentSessionId,
      )!;
      reads.push(candidate.session_id);
      return json(res, {
        ...session,
        sessionId: candidate.cloud_agent_session_id,
        kiloSessionId: candidate.session_id,
        initialMessageId:
          candidate === candidates[100] ? messageId : "msg_00000000000000000000000000",
      });
    });
    for (let index = 0; index < 4; index++)
      expect(await run(client.findAdmission(binding.repository, messageId))).toBeNull();
    expect(await run(client.findAdmission(binding.repository, messageId))).toEqual({
      cloudAgentSessionId: candidates[100]!.cloud_agent_session_id,
      kiloSessionId: candidates[100]!.session_id,
    });
    expect(reads).toHaveLength(101);
    expect(new Set(reads).size).toBe(101);
    expect(cursors).toEqual([null, "2026-10-01T00:00:00.000Z"]);
  });
  it("does not let a transient or deleted candidate starve a later personal session", async () => {
    const reads: string[] = [];
    const missing = "workspace_00000000-0000-0000-0000-000000000000";
    let first = true;
    const { client } = await server((req, res) => {
      const url = new URL(req.url!, "http://localhost");
      const input = JSON.parse(url.searchParams.get("input")!) as Record<string, string>;
      if (url.pathname.endsWith("cliSessionsV2.list"))
        return json(res, {
          cliSessions: [
            { session_id: "ses_deleted", cloud_agent_session_id: missing },
            { session_id: session.kiloSessionId, cloud_agent_session_id: session.sessionId },
          ],
          nextCursor: null,
        });
      reads.push(input.cloudAgentSessionId!);
      if (input.cloudAgentSessionId === missing) {
        res.writeHead(first ? 503 : 404);
        first = false;
        res.end();
        return;
      }
      return json(res, session);
    });
    expect(await run(client.findAdmission(binding.repository, messageId))).toBeNull();
    expect(await run(client.findAdmission(binding.repository, messageId))).toEqual({
      cloudAgentSessionId: session.sessionId,
      kiloSessionId: session.kiloSessionId,
    });
    expect(reads).toEqual([missing, session.sessionId, missing]);
  });
  it("searches later pages despite a persistently unavailable candidate and waits before binding", async () => {
    let unavailable = true;
    let pageTwoRead = false;
    const missing = "workspace_00000000-0000-0000-0000-000000000000";
    const { client } = await server((req, res) => {
      const url = new URL(req.url!, "http://localhost");
      const input = JSON.parse(url.searchParams.get("input")!) as Record<string, string>;
      if (url.pathname.endsWith("cliSessionsV2.list")) {
        if (input.cursor) pageTwoRead = true;
        return json(
          res,
          input.cursor
            ? {
                cliSessions: [
                  { session_id: session.kiloSessionId, cloud_agent_session_id: session.sessionId },
                ],
                nextCursor: null,
              }
            : {
                cliSessions: [{ session_id: "ses_unavailable", cloud_agent_session_id: missing }],
                nextCursor: "2026-10-01T00:00:00.000Z",
              },
        );
      }
      if (input.cloudAgentSessionId === missing) {
        res.writeHead(unavailable ? 503 : 404);
        res.end();
        return;
      }
      return json(res, session);
    });
    expect(await run(client.findAdmission(binding.repository, messageId))).toBeNull();
    expect(pageTwoRead).toBe(true);
    expect(await run(client.findAdmission(binding.repository, messageId))).toBeNull();
    unavailable = false;
    expect(await run(client.findAdmission(binding.repository, messageId))).toEqual({
      cloudAgentSessionId: session.sessionId,
      kiloSessionId: session.kiloSessionId,
    });
  });
  it("rejects ambiguous admission identities and repeating cursors without a mutation", async () => {
    let repeated = false;
    const { client } = await server((req, res) => {
      expect(req.method).toBe("GET");
      const url = new URL(req.url!, "http://localhost");
      if (url.pathname.endsWith("cliSessionsV2.list"))
        return json(res, {
          cliSessions: repeated
            ? []
            : [
                { session_id: session.kiloSessionId, cloud_agent_session_id: session.sessionId },
                {
                  session_id: "ses_second",
                  cloud_agent_session_id: "workspace_00000000-0000-0000-0000-000000000000",
                },
              ],
          nextCursor: repeated ? "2026-10-01T00:00:00.000Z" : null,
        });
      const input = JSON.parse(url.searchParams.get("input")!) as Record<string, string>;
      return json(res, {
        ...session,
        sessionId: input.cloudAgentSessionId,
        kiloSessionId:
          input.cloudAgentSessionId === session.sessionId ? session.kiloSessionId : "ses_second",
      });
    });
    expect(
      (await run(client.findAdmission(binding.repository, messageId).pipe(Effect.flip))).reason,
    ).toBe("wrong_owner");
    repeated = true;
    expect(
      (await run(client.findAdmission(binding.repository, messageId).pipe(Effect.flip))).reason,
    ).toBe("recovery_incomplete");
  });
  it("authenticates a customer WebSocket, resumes its cursor and rejects a foreign session event", async () => {
    const expiresAt = await run(Clock.currentTimeMillis);
    const { client, httpServer } = await server((req, res) => {
      expect(req.url).toBe("/api/cloud-agent-next/sessions/stream-ticket");
      expect(req.headers.authorization).toBe("Bearer fixture-token");
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ticket: "single-use-fixture", expiresAt: expiresAt + 60000 }));
      });
    });
    const sockets = new NodeWS.WebSocketServer({ noServer: true });
    cleanups.unshift(async () => {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
    });
    httpServer.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url!, "http://localhost");
      expect(url.searchParams.get("fromId")).toBe("37");
      expect(url.searchParams.get("ticket")).toBe("single-use-fixture");
      expect(url.searchParams.get("cloudAgentSessionId")).toBe(binding.cloudAgentSessionId);
      sockets.handleUpgrade(req, socket, head, (connection) => {
        connection.send(
          JSON.stringify({
            eventId: 38,
            sessionId: binding.cloudAgentSessionId,
            streamEventType: "cloud.message.completed",
            data: { messageId },
          }),
        );
        connection.send(
          JSON.stringify({
            eventId: 39,
            sessionId: "workspace_00000000-0000-0000-0000-000000000000",
            streamEventType: "cloud.message.failed",
            data: { messageId },
          }),
        );
      });
    });
    const received: number[] = [];
    const error = await run(
      client.events(binding, 37).pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            received.push(event.eventId);
          }),
        ),
        Stream.runDrain,
        Effect.flip,
      ),
    );
    expect(received).toEqual([38]);
    expect(error.operation).toBe("events");
    expect(error.reason).toBe("wrong_owner");
  });
  it.each([
    "varCount",
    "commandCount",
    "mcpServerCount",
    "skillCount",
    "agentCount",
    "kiloCommandCount",
  ])("does not admit a paid task when an inherited profile has %s", async (counter) => {
    let mutations = 0;
    const profile = {
      id: "profile",
      isDefault: true,
      varCount: 0,
      commandCount: 0,
      mcpServerCount: 0,
      skillCount: 0,
      agentCount: 0,
      kiloCommandCount: 0,
      [counter]: 1,
    };
    const { client } = await server(
      (_request, response) => {
        mutations++;
        response.end();
      },
      [profile],
    );
    expect((await run(client.prepare(start, Effect.void).pipe(Effect.flip))).reason).toBe(
      "rejected",
    );
    expect(mutations).toBe(0);
  });
  it("fails closed when the repository binding references an unavailable profile", async () => {
    let mutations = 0;
    const { client } = await server(
      (_request, response) => {
        mutations++;
        response.end();
      },
      [],
      [{ repoFullName: "FIXTURE/PROJECT", platform: "github", profileId: "unavailable" }],
    );
    expect((await run(client.prepare(start, Effect.void).pipe(Effect.flip))).reason).toBe(
      "rejected",
    );
    expect(mutations).toBe(0);
  });
  it("uses customer authentication and fixed admission identities, no commits, setup or local data", async () => {
    const bodies: Record<string, unknown>[] = [];
    const { client } = await server((req, res) => {
      expect(req.headers.authorization).toBe("Bearer fixture-token");
      expect(req.url).toBe("/api/trpc/cloudAgentNext.prepareSession");
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        bodies.push(JSON.parse(body));
        json(res, {
          cloudAgentSessionId: binding.cloudAgentSessionId,
          kiloSessionId: binding.kiloSessionId,
        });
      });
    });
    await run(client.prepare(start, Effect.void));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      operationKey: start.operationKey,
      initialMessageId: messageId,
      githubRepo: binding.repository,
      upstreamBranch: "main",
      autoCommit: false,
      autoInitiate: true,
      envVars: {},
      setupCommands: [],
      mcpServers: {},
      runtimeSkills: [],
      runtimeAgents: [],
      mode: "code",
    });
    expect(bodies[0]).not.toHaveProperty("attachments");
  });
  it("leaves acceptance uncertain and never retries a socket lost after paid admission", async () => {
    let accepted = 0;
    const { client } = await server((req, res) => {
      req.resume();
      req.on("end", () => {
        accepted++;
        res.destroy();
      });
    });
    const error = await run(client.prepare(start, Effect.void).pipe(Effect.flip));
    expect(error.reason).toBe("admission_unknown");
    expect(error.messageId).toBe(messageId);
    expect(accepted).toBe(1);
  });
  it.each(["userId", "githubRepo", "kiloSessionId", "worktreeId", "autoCommit"])(
    "prevents a follow-up on changed %s",
    async (field) => {
      let sends = 0;
      const changed = {
        ...session,
        [field]:
          field === "autoCommit"
            ? true
            : field === "worktreeId"
              ? "worktree_aaaaaaaa-1234-1234-1234-123456789abc"
              : field === "kiloSessionId"
                ? "ses_other"
                : "other",
      };
      const { client } = await server((req, res) => {
        if (req.method === "POST") sends++;
        json(res, changed);
      });
      expect(
        (
          await run(
            client
              .send(binding, { messageId, prompt: "Continue", model: "fixture/model" }, Effect.void)
              .pipe(Effect.flip),
          )
        ).reason,
      ).toBe("wrong_owner");
      expect(sends).toBe(0);
    },
  );
  it("rejects an account switch before any HTTP request, while allowing same-account token refresh", async () => {
    let requests = 0;
    const { options } = await server((req, res) => {
      requests++;
      expect(req.headers.authorization).toBe("Bearer refreshed");
      json(res, session);
    });
    const refreshed = Cloud.make({
      ...options,
      credentials: Effect.succeed({
        accountId: binding.accountId,
        token: Redacted.make("refreshed"),
      }),
    });
    await run(refreshed.getSession(binding.cloudAgentSessionId));
    const changed = Cloud.make({
      ...options,
      credentials: Effect.succeed({ accountId: "customer-b", token: Redacted.make("other") }),
    });
    expect(
      (await run(changed.getSession(binding.cloudAgentSessionId).pipe(Effect.flip))).reason,
    ).toBe("wrong_owner");
    expect(requests).toBe(1);
  });
  it("rejects a transcript with a part from another session", async () => {
    const { client } = await server((_req, res) =>
      json(res, {
        kiloSessionId: binding.kiloSessionId,
        watermarkEventId: 84,
        history: {
          nextCursor: null,
          omittedItemCount: 0,
          messages: [
            {
              info: {
                id: "assistant",
                sessionID: binding.kiloSessionId,
                role: "assistant",
                parentID: messageId,
                time: { created: 1, completed: 2 },
              },
              parts: [
                {
                  id: "part",
                  messageID: "assistant",
                  sessionID: "ses_other",
                  type: "text",
                  text: "Not this account",
                },
              ],
            },
          ],
        },
      }),
    );
    expect((await run(client.history(binding).pipe(Effect.flip))).reason).toBe("wrong_owner");
  });
  it("keeps interruption acceptance, task terminality, sandbox sleep and shared-payer billing separate", async () => {
    const { client } = await server((req, res) => {
      if (req.url?.includes("getSession?")) json(res, session);
      else if (req.url?.includes("interruptSession")) json(res, { success: true });
      else if (req.url?.includes("getMessageResult")) {
        const input = JSON.parse(new URL(req.url, "http://localhost").searchParams.get("input")!);
        expect(input.expectedWorktreeId).toBe(binding.worktreeId);
        json(res, {
          cloudAgentSessionId: binding.cloudAgentSessionId,
          messageId,
          status: "interrupted",
        });
      } else if (req.url?.includes("getSandboxStatus"))
        json(res, {
          status: "active",
          observedAt: 1,
          inactivityTimeoutMs: 600000,
          estimatedSleepAt: null,
        });
      else
        json(res, {
          phase: "active",
          attribution: "payer_shared",
          estimatedHourlyRateMicrodollars: 1203120,
          estimatedIntervalAmountMicrodollars: null,
        });
    });
    expect(await run(client.interrupt(binding))).toEqual({ success: true });
    expect((await run(client.result(binding, messageId)))?.status).toBe("interrupted");
    expect((await run(client.sandbox(binding))).status).toBe("active");
    expect((await run(client.billing(binding))).phase).toBe("active");
  });
});

describe("cloud recovery budgets and paid dispatch boundary", () => {
  it("preserves a recently touched scan's candidate budget when the cache fills", async () => {
    let lists = 0;
    const { client } = await server((request, response) => {
      if (request.url?.startsWith("/api/trpc/cliSessionsV2.list")) {
        lists++;
        return json(response, {
          cliSessions: [
            {
              session_id: binding.kiloSessionId,
              cloud_agent_session_id: binding.cloudAgentSessionId,
            },
          ],
          nextCursor: null,
        });
      }
      response.writeHead(503);
      response.end();
    });
    await run(client.findAdmission(binding.repository, "hot"));
    for (let i = 0; i < 63; i++) await run(client.findAdmission(binding.repository, `cold-${i}`));
    await run(client.findAdmission(binding.repository, "hot"));
    await run(client.findAdmission(binding.repository, "new"));
    const before = lists;
    expect(
      (await run(client.findAdmission(binding.repository, "hot").pipe(Effect.flip))).reason,
    ).toBe("recovery_incomplete");
    expect(lists).toBe(before); // Kept its original scan, including failed-candidate rounds.
  });
  it("distinguishes a finite page limit from transient recovery failures", async () => {
    let pages = 0;
    const { client } = await server((req, res) => {
      expect(req.method).toBe("GET");
      pages++;
      json(res, { cliSessions: [], nextCursor: String(pages) });
    });
    for (let i = 0; i < 4; i++)
      expect(await run(client.findAdmission(binding.repository, messageId))).toBeNull();
    expect(
      (await run(client.findAdmission(binding.repository, messageId).pipe(Effect.flip))).reason,
    ).toBe("recovery_limit");
    expect(pages).toBe(101);
  });
  it("retains a typed rejection reason when repeated recovery reads are paused", async () => {
    const { client } = await server((_req, res) => {
      res.writeHead(403);
      res.end();
    });
    await run(client.findAdmission(binding.repository, messageId).pipe(Effect.flip));
    await run(client.findAdmission(binding.repository, messageId).pipe(Effect.flip));
    const failure = await run(
      client.findAdmission(binding.repository, messageId).pipe(Effect.flip),
    );
    expect(failure.reason).toBe("recovery_incomplete");
    expect(failure.recoveryCause).toBe("rejected");
  });
  it("does not execute a paid POST until its caller's durable marker succeeds", async () => {
    let posts = 0;
    let marked = false;
    const { client } = await server((req, res) => {
      expect(req.method).toBe("POST");
      expect(marked).toBe(true);
      posts++;
      json(res, {
        cloudAgentSessionId: binding.cloudAgentSessionId,
        kiloSessionId: binding.kiloSessionId,
      });
    });
    await run(
      client
        .prepare(
          start,
          Effect.fail(new KiloCloudError({ operation: "fixture-journal", reason: "rejected" })),
        )
        .pipe(Effect.flip),
    );
    expect(posts).toBe(0);
    await run(
      client.prepare(
        start,
        Effect.sync(() => {
          marked = true;
        }),
      ),
    );
    expect(posts).toBe(1);
  });
});
