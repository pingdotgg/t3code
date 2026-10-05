// @effect-diagnostics nodeBuiltinImport:off - exercises the real SDK over Node HTTP and native CLI processes.
import * as NodeHttp from "node:http";
import * as NodeEvents from "node:events";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import { it as effectIt } from "@effect/vitest";

import * as KiloSessionClient from "./KiloSessionClient.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function server(
  handler: (req: NodeHttp.IncomingMessage, res: NodeHttp.ServerResponse) => void,
) {
  const http = NodeHttp.createServer(handler);
  http.listen(0, "127.0.0.1");
  await NodeEvents.EventEmitter.once(http, "listening");
  cleanups.push(async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const address = http.address();
  if (address === null || typeof address === "string") throw new Error("No test listener");
  return `http://127.0.0.1:${address.port}`;
}
function json(res: NodeHttp.ServerResponse, value: unknown) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}
const directory = "/work/space #λ";
const ref = { instanceId: "instance-a", directory, sessionId: "ses_one" };
const run = Effect.runPromise;

async function withClient(
  handler: (req: NodeHttp.IncomingMessage, res: NodeHttp.ServerResponse) => void,
) {
  const baseUrl = await server((req, res) => {
    if (req.url?.startsWith("/global/health")) {
      json(res, { healthy: true, version: "7.8.3" });
      return;
    }
    handler(req, res);
  });
  return run(
    KiloSessionClient.make({
      instanceId: "instance-a",
      directory,
      baseUrl,
      serverPassword: "test-password",
    }),
  );
}

describe("Kilo native SDK boundary", () => {
  it("recovers pending interactions only from the verified session family", async () => {
    const client = await withClient((req, res) => {
      if (req.url?.startsWith("/permission"))
        return json(res, [
          { id: "per_root", sessionID: ref.sessionId },
          { id: "per_child", sessionID: "ses_child" },
          { id: "per_foreign", sessionID: "ses_foreign" },
          { id: "per_other_dir", sessionID: "ses_other_dir" },
        ]);
      if (req.url?.startsWith("/question"))
        return json(res, [{ id: "q_child", sessionID: "ses_grandchild" }]);
      const id = req.url?.split("/").at(-1)?.split("?")[0];
      json(res, {
        id,
        directory: id === "ses_other_dir" ? "/another-workspace" : directory,
        ...(id === "ses_child" || id === "ses_other_dir"
          ? { parentID: ref.sessionId }
          : id === "ses_grandchild"
            ? { parentID: "ses_child" }
            : {}),
      });
    });
    expect((await run(client.pending(ref))).map((item) => item.id)).toEqual(["per_root"]);
    expect((await run(client.pending(ref, true))).map((item) => item.id)).toEqual([
      "per_root",
      "per_child",
      "q_child",
    ]);
  });
  it.each([null, [], { ses_one: null }, { ses_one: { type: "completed" } }])(
    "never treats a malformed native status as idle: %j",
    async (payload) => {
      const client = await withClient((req, res) =>
        json(
          res,
          req.url?.startsWith("/session/status") ? payload : { id: ref.sessionId, directory },
        ),
      );
      const failure = await run(client.status(ref).pipe(Effect.flip));
      expect(failure.reason).toBe("invalid_response");
    },
  );
  it.each([{}, { info: {}, parts: null }, { info: {}, parts: [{ type: "text" }] }, null])(
    "rejects malformed native generation without a defect: %j",
    async (payload) => {
      const client = await withClient((req, res) =>
        json(res, req.method === "GET" ? { id: ref.sessionId, directory } : payload),
      );
      const failure = await run(
        client.generate(ref, { parts: [{ type: "text", text: "test" }] }).pipe(Effect.flip),
      );
      expect(failure.reason).toBe("invalid_response");
    },
  );
  it("classifies a rejected prompt as definitive without resubmitting", async () => {
    let submitted = 0;
    const client = await withClient((req, res) => {
      if (req.method === "GET") return json(res, { id: ref.sessionId, directory });
      submitted++;
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid prompt" }));
    });
    const failure = await run(client.prompt(ref, { parts: [] }).pipe(Effect.flip));
    expect(failure.reason).toBe("request_failed");
    expect(submitted).toBe(1);
  });
  it("uses Kilo auth and lossless directory routing with the real SDK", async () => {
    const requests: Array<{
      url: string;
      authorization: string | undefined;
      legacyHeader: string | undefined;
    }> = [];
    const client = await withClient((req, res) => {
      requests.push({
        url: req.url!,
        authorization: req.headers.authorization,
        legacyHeader: req.headers["x-opencode-directory"] as string | undefined,
      });
      json(res, { id: ref.sessionId, directory });
    });
    await run(client.read(ref));
    expect(requests).toEqual([
      {
        url: `/session/ses_one?directory=${encodeURIComponent(directory).replace(/%20/g, "+")}`,
        authorization: `Basic ${Buffer.from("kilo:test-password").toString("base64")}`,
        legacyHeader: undefined,
      },
    ]);
  });

  it("rejects an unsupported server version through its health response", async () => {
    const baseUrl = await server((_req, res) => json(res, { healthy: true, version: "7.9.0" }));
    const error = await run(
      KiloSessionClient.make({ instanceId: ref.instanceId, directory, baseUrl }).pipe(Effect.flip),
    );
    expect(error.reason).toBe("unsupported_version");
  });

  it("rejects cross-instance refs before sending any request", async () => {
    let requests = 0;
    const client = await withClient((_req, res) => {
      requests++;
      json(res, {});
    });
    const error = await run(client.abort({ ...ref, instanceId: "instance-b" }).pipe(Effect.flip));
    expect(error.reason).toBe("wrong_owner");
    expect(requests).toBe(0);
  });

  it("does not treat a directory header as proof that a native session belongs to it", async () => {
    const paths: string[] = [];
    const client = await withClient((req, res) => {
      paths.push(req.url!);
      json(res, { id: ref.sessionId, directory: "/other-checkout" });
    });
    const error = await run(client.abort(ref).pipe(Effect.flip));
    expect(error.reason).toBe("wrong_owner");
    expect(paths).toHaveLength(1);
    expect(paths[0]).not.toContain("abort");
  });

  it("accepts native 204 prompt admission and sends a mutation only once", async () => {
    const prompts: unknown[] = [];
    const client = await withClient((req, res) => {
      if (req.method === "GET") {
        json(res, { id: ref.sessionId, directory });
        return;
      }
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        prompts.push(JSON.parse(body));
        res.writeHead(204);
        res.end();
      });
    });
    await run(
      client.prompt(ref, {
        parts: [{ type: "text", text: "one prompt" }],
        model: { providerID: "local", modelID: "test" },
      }),
    );
    expect(prompts).toEqual([
      {
        parts: [{ type: "text", text: "one prompt" }],
        model: { providerID: "local", modelID: "test" },
      },
    ]);
  });

  it("does not retry a prompt after the server accepts it but loses the response", async () => {
    let admissions = 0;
    const client = await withClient((req, res) => {
      if (req.method === "GET") {
        json(res, { id: ref.sessionId, directory });
        return;
      }
      admissions++;
      req.resume();
      req.on("end", () => res.destroy());
    });
    const error = await run(
      client.prompt(ref, { parts: [{ type: "text", text: "one prompt" }] }).pipe(Effect.flip),
    );
    expect(error.reason).toBe("admission_unknown");
    expect(admissions).toBe(1);
  });

  it.each(["permission", "question"] as const)(
    "does not answer another session's %s even when its request id is known",
    async (kind) => {
      let replies = 0;
      const client = await withClient((req, res) => {
        if (req.method === "POST") replies++;
        json(
          res,
          req.url!.startsWith(`/${kind}`)
            ? [{ id: "request", sessionID: "ses_other" }]
            : { id: ref.sessionId, directory },
        );
      });
      const reply =
        kind === "permission"
          ? client.replyPermission(ref, "request", "once")
          : client.replyQuestion(ref, "request", [["yes"]]);
      expect((await run(reply.pipe(Effect.flip))).reason).toBe("wrong_owner");
      expect(replies).toBe(0);
    },
  );

  it("filters interleaved events and reports EOF without reconnecting or claiming completion", async () => {
    let subscriptions = 0;
    const events: string[] = [];
    const client = await withClient((req, res) => {
      if (!req.url!.startsWith("/event")) {
        json(res, { id: ref.sessionId, directory });
        return;
      }
      subscriptions++;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ type: "sync", syncEvent: { type: "session.updated.v1", id: "sync_one", data: {} } })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ type: "pty.created", properties: { info: { id: "pty_one", title: "shell", command: "bash", args: [], cwd: directory, status: "running", pid: 42 } } })}\n\n`,
      );
      for (const sessionID of ["ses_other", ref.sessionId, "ses_other", ref.sessionId]) {
        res.write(
          `data: ${JSON.stringify({ type: "message.part.delta", properties: { sessionID, messageID: "same-message", partID: "same-part", field: "text", delta: sessionID } })}\n\n`,
        );
      }
      res.end();
    });
    const error = await run(
      client.events(ref).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.type === "message.part.delta") events.push(event.properties.delta);
          }),
        ),
        Effect.scoped,
        Effect.flip,
      ),
    );
    expect(events).toEqual([ref.sessionId, ref.sessionId]);
    expect(error.reason).toBe("request_failed");
    expect(subscriptions).toBe(1);
  });

  it("refuses HTTP redirects before forwarding a prompt or credentials", async () => {
    let foreignRequests = 0;
    const other = await server((_req, res) => {
      foreignRequests++;
      json(res, {});
    });
    const client = await withClient((_req, res) => {
      res.writeHead(307, { Location: other });
      res.end();
    });
    const error = await run(client.read(ref).pipe(Effect.flip));
    expect(error.reason).toBe("request_failed");
    expect(foreignRequests).toBe(0);
  });

  it("does not turn a rejected abort into a confirmed stop", async () => {
    const client = await withClient((req, res) =>
      json(res, req.method === "POST" ? false : { id: ref.sessionId, directory }),
    );
    expect((await run(client.abort(ref).pipe(Effect.flip))).reason).toBe("invalid_response");
  });
  it.each([null, {}, { success: false }, "true"])(
    "rejects a malformed abort acknowledgement %j",
    async (value) => {
      const client = await withClient((req, res) =>
        json(res, req.method === "POST" ? value : { id: ref.sessionId, directory }),
      );
      expect((await run(client.abort(ref).pipe(Effect.flip))).reason).toBe("invalid_response");
    },
  );

  it("rejects an empty abort acknowledgement", async () => {
    const client = await withClient((req, res) => {
      if (req.method === "POST") {
        res.writeHead(204, { "Content-Type": "application/json" });
        res.end();
      } else json(res, { id: ref.sessionId, directory });
    });
    expect((await run(client.abort(ref).pipe(Effect.flip))).reason).toBe("invalid_response");
  });

  it.each([
    null,
    { type: "message.part.delta", properties: null },
    { type: "message.part.updated", properties: { part: null } },
  ])("turns malformed SSE into a typed failure %j", async (event) => {
    const client = await withClient((req, res) => {
      if (!req.url!.startsWith("/event")) {
        json(res, { id: ref.sessionId, directory });
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`data: ${JSON.stringify(event)}\n\n`);
    });
    expect(
      (await run(client.events(ref).pipe(Stream.runDrain, Effect.scoped, Effect.flip))).reason,
    ).toBe("invalid_response");
  });

  it("closes the actual SSE socket when its consumer is cancelled", async () => {
    let close!: () => void;
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });
    const client = await withClient((req, res) => {
      if (!req.url!.startsWith("/event")) {
        json(res, { id: ref.sessionId, directory });
        return;
      }
      res.on("close", close);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ type: "session.idle", properties: { sessionID: ref.sessionId } })}\n\n`,
      );
    });
    await run(client.events(ref).pipe(Stream.take(1), Stream.runDrain, Effect.scoped));
    await closed;
  });

  effectIt.effect("interrupts a blocked SSE read before waiting for iterator cleanup", () =>
    Effect.gen(function* () {
      const opened = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<void>();
      const client = yield* Effect.promise(() =>
        withClient((req, res) => {
          if (!req.url!.startsWith("/event")) {
            json(res, { id: ref.sessionId, directory });
            return;
          }
          res.on("close", closed.resolve);
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.flushHeaders();
          opened.resolve();
        }),
      );
      const consumer = yield* client
        .events(ref)
        .pipe(Stream.runDrain, Effect.scoped, Effect.forkScoped);
      yield* Effect.promise(() => opened.promise);
      yield* Fiber.interrupt(consumer);
      yield* Effect.promise(() => closed.promise);
    }).pipe(Effect.scoped),
  );

  it("refuses a mutation redirect after a successful ownership read", async () => {
    let forwarded = 0;
    const foreign = await server((_req, res) => {
      forwarded++;
      json(res, {});
    });
    const client = await withClient((req, res) => {
      if (req.method === "GET") {
        json(res, { id: ref.sessionId, directory });
        return;
      }
      res.writeHead(307, { Location: foreign });
      res.end();
    });
    expect((await run(client.prompt(ref, { parts: [] }).pipe(Effect.flip))).reason).toBe(
      "admission_unknown",
    );
    expect(forwarded).toBe(0);
  });
  it("keeps simultaneous client streams separate even with identical native item ids", async () => {
    const streams: Array<{ res: NodeHttp.ServerResponse; sessionId: string }> = [];
    const baseUrl = await server((req, res) => {
      const url = new URL(req.url!, "http://localhost");
      if (url.pathname === "/global/health") {
        json(res, { healthy: true, version: "7.8.3" });
        return;
      }
      const dir = url.searchParams.get("directory")!;
      const sessionId = dir === "/a" ? "ses_a" : "ses_b";
      if (url.pathname !== "/event") {
        json(res, { id: sessionId, directory: dir });
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      streams.push({ res, sessionId });
      if (streams.length === 2)
        for (const stream of streams) {
          for (const id of ["ses_a", "ses_b"])
            stream.res.write(
              `data: ${JSON.stringify({ type: "message.part.delta", properties: { sessionID: id, messageID: "same", partID: "same", field: "text", delta: id } })}\n\n`,
            );
        }
    });
    const [a, b] = await Promise.all(
      ["a", "b"].map((id) =>
        run(KiloSessionClient.make({ instanceId: id, directory: `/${id}`, baseUrl })),
      ),
    );
    const received = await Promise.all(
      [a!, b!].map((client, index) =>
        run(
          client
            .events({
              instanceId: index === 0 ? "a" : "b",
              directory: index === 0 ? "/a" : "/b",
              sessionId: index === 0 ? "ses_a" : "ses_b",
            })
            .pipe(Stream.take(1), Stream.runCollect, Effect.scoped),
        ),
      ),
    );
    expect(
      received.map((events) =>
        events.map((e) => (e.type === "message.part.delta" ? e.properties.delta : "unexpected")),
      ),
    ).toEqual([["ses_a"], ["ses_b"]]);
  });

  it.each(["permission", "question"] as const)(
    "answers an owned %s once and rejects stale answers",
    async (kind) => {
      let pending = true;
      const replies: unknown[] = [];
      const client = await withClient((req, res) => {
        if (req.method === "GET") {
          json(
            res,
            req.url!.startsWith(`/${kind}`)
              ? pending
                ? [{ id: "request", sessionID: ref.sessionId }]
                : []
              : { id: ref.sessionId, directory },
          );
          return;
        }
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          replies.push(JSON.parse(body));
          pending = false;
          json(res, true);
        });
      });
      const reply = () =>
        kind === "permission"
          ? client.replyPermission(ref, "request", "once")
          : client.replyQuestion(ref, "request", [["yes"]]);
      await run(reply());
      expect((await run(reply().pipe(Effect.flip))).reason).toBe("wrong_owner");
      expect(replies).toEqual([kind === "permission" ? { reply: "once" } : { answers: [["yes"]] }]);
    },
  );
});
