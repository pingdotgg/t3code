import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import Agent from "./Agent.ts";
import { Gateway } from "./AiGateway.ts";
import { Bucket } from "./Bucket.ts";
import { KV } from "./KV.ts";
import NotifyWorkflow from "./NotifyWorkflow.ts";
import { Queue } from "./Queue.ts";
import { Repos } from "./Repos.ts";
import Room from "./Room.ts";

interface QueueMessageBody {
  id: string;
  text: string;
  sentAt: number;
}

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.filename,
    observability: {
      enabled: true,
    },
    assets: "./assets",
    build: {
      bundleAnalyzer: true,
    },
  },
  Effect.gen(function* () {
    // const betterAuth = yield* BetterAuth.BetterAuth;
    const agents = yield* Agent;
    const rooms = yield* Room;
    const notifier = yield* NotifyWorkflow;
    const loader = yield* Cloudflare.DynamicWorkerLoader("Loader");
    const bucket = yield* Cloudflare.R2Bucket.bind(Bucket);
    const kv = yield* Cloudflare.KVNamespace.bind(KV);
    const queueResource = yield* Queue;
    const queue = yield* Cloudflare.QueueBinding.bind(queueResource);
    const repos = yield* Cloudflare.Artifacts.bind(Repos);
    const aiGateway = yield* Cloudflare.AiGateway.bind(Gateway);

    // Effect-style queue consumer. Each batch is piped through the
    // handler; success ack()s every message in the batch, failure
    // retry()s. The persisted JSON at /queue/<id> on R2 lets the
    // integ test verify the producer→consumer round-trip.
    yield* Cloudflare.messages<QueueMessageBody>(queueResource).subscribe(
      (stream) =>
        Stream.runForEach(stream, (msg) =>
          bucket
            .put(`/queue/${msg.body.id}`, JSON.stringify(msg.body), {
              httpMetadata: { contentType: "application/json" },
            })
            .pipe(Effect.asVoid),
        ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;

        if (request.url.startsWith("/auth/")) {
          // return yield* betterAuth.fetch;
        } else if (request.url.startsWith("/kv/")) {
          if (request.method === "GET") {
            const key = request.url.split("/").pop()!;
            return yield* kv.get(key).pipe(
              Effect.map((value) =>
                value
                  ? HttpServerResponse.text(value)
                  : HttpServerResponse.empty({ status: 404 }),
              ),
              Effect.catch(() =>
                Effect.succeed(HttpServerResponse.empty({ status: 404 })),
              ),
            );
          } else if (request.method === "POST") {
            const key = request.url.split("/").pop()!;
            const value = yield* request.text;
            return yield* kv.put(key, value).pipe(
              Effect.map(() => HttpServerResponse.empty({ status: 200 })),
              Effect.catch(() =>
                Effect.succeed(HttpServerResponse.empty({ status: 500 })),
              ),
            );
          }
        } else if (request.url.startsWith("/object/")) {
          if (request.method === "GET") {
            return yield* bucket.get(request.url.split("/").pop()!).pipe(
              Effect.flatMap((object) =>
                object === null
                  ? Effect.succeed(
                      HttpServerResponse.text("Object not found", {
                        status: 404,
                      }),
                    )
                  : object.text().pipe(
                      Effect.map((text) =>
                        HttpServerResponse.text(text, {
                          headers: { "content-type": "application/json" },
                        }),
                      ),
                    ),
              ),
              Effect.catchTag("R2Error", (error) =>
                Effect.succeed(
                  HttpServerResponse.text(error.message, {
                    status: 500,
                    statusText: error.message,
                  }),
                ),
              ),
            );
          } else if (request.method === "POST" || request.method === "PUT") {
            // const request = yield* Cloudflare.Request
            const key = request.url.split("/").pop()!;
            return yield* bucket
              .put(key, request.stream, {
                contentLength: Number(request.headers["content-length"] ?? 0),
              })
              .pipe(
                Effect.map(() => HttpServerResponse.empty({ status: 201 })),
                Effect.catch((err) =>
                  HttpServerResponse.json(
                    {
                      error: err.message,
                      headers: request.headers,
                    },
                    { status: 500 },
                  ),
                ),
              );
          } else {
            return HttpServerResponse.text("Method not allowed", {
              status: 405,
            });
          }
        } else if (request.url === "/sandbox/increment") {
          const agent = agents.getByName("sandbox-test");
          const body = yield* agent.increment().pipe(Effect.orDie);
          const room = rooms.getByName("default");
          yield* room.broadcast(`[container] ${body}`);
          return HttpServerResponse.text(body, {
            headers: { "content-type": "application/json" },
          });
        } else if (request.url.startsWith("/sandbox")) {
          const agent = agents.getByName("sandbox-test");
          const body = yield* agent.hello().pipe(Effect.orDie);
          return HttpServerResponse.text(body);
        } else if (request.url.startsWith("/workflow/start/")) {
          const roomId = request.url.split("/workflow/start/")[1];
          if (!roomId) {
            return yield* HttpServerResponse.json(
              { error: "roomId is required" },
              { status: 400 },
            );
          }
          const instance = yield* notifier.create({
            roomId,
            message: "hello from workflow",
          });
          return yield* HttpServerResponse.json({ instanceId: instance.id });
        } else if (request.url.startsWith("/workflow/status/")) {
          const instanceId = request.url.split("/workflow/status/")[1];
          if (!instanceId) {
            return yield* HttpServerResponse.json(
              { error: "instanceId is required" },
              { status: 400 },
            );
          }
          const instance = yield* notifier.get(instanceId);
          const status = yield* instance.status();
          return yield* HttpServerResponse.json(status);
        } else if (request.url.startsWith("/eval")) {
          if (request.method === "POST") {
            const code = yield* request.text;
            const worker = loader.load({
              compatibilityDate: "2026-01-28",
              mainModule: "worker.js",
              modules: {
                "worker.js": `
                  export default {
                    async fetch(request) {
                      try {
                        const result = (0, eval)(${"`${await request.text()}`"});
                        return new Response(String(result), { status: 200 });
                      } catch (e) {
                        return new Response(e.message, { status: 500 });
                      }
                    }
                  }
                `,
              },
              globalOutbound: null,
            });
            return yield* worker
              .fetch(
                HttpClientRequest.post("https://worker/").pipe(
                  HttpClientRequest.setBody(HttpBody.text(code)),
                ),
              )
              .pipe(
                Effect.map(HttpServerResponse.fromClientResponse),
                Effect.orDie,
              );
          }
        } else if (request.url.startsWith("/connect/")) {
          const agentId = request.url.split("/").pop()!;
          const agent = agents.getByName(agentId);
          const response = yield* agent.fetch(request);
          return response;
        } else if (request.url.startsWith("/room/")) {
          const upgradeHeader = request.headers.upgrade;
          const roomId = request.url.split("/").pop()!;
          if (!upgradeHeader || upgradeHeader !== "websocket") {
            return HttpServerResponse.text(
              "Worker expected Upgrade: websocket",
              { status: 426 },
            );
          } else if (request.method !== "GET") {
            return HttpServerResponse.text("Method not allowed", {
              status: 405,
            });
          }
          const room = rooms.getByName(roomId);
          const response = yield* room.fetch(request);
          return response;
        }
        // Cloudflare Artifacts — Git-compatible versioned repos.
        // Exercises Cloudflare.ArtifactsConnection by creating a repo,
        // looking it up, and minting short-lived clone tokens.
        if (
          request.url.startsWith("/repos/create") &&
          request.method === "POST"
        ) {
          const text = yield* request.text;
          const body = JSON.parse(text || "{}") as {
            name?: string;
            description?: string;
          };
          const name = body.name?.trim();
          if (!name) {
            return yield* HttpServerResponse.json(
              { error: "name is required" },
              { status: 400 },
            );
          }
          return yield* repos
            .create(name, {
              description: body.description,
              setDefaultBranch: "main",
            })
            .pipe(
              Effect.flatMap((created) =>
                HttpServerResponse.json({
                  id: created.id,
                  name: created.name,
                  remote: created.remote,
                  token: created.token,
                  tokenExpiresAt: created.tokenExpiresAt,
                  defaultBranch: created.defaultBranch,
                }),
              ),
              Effect.catchTag("ArtifactsError", (err) =>
                HttpServerResponse.json(
                  { error: err.message },
                  { status: 409 },
                ),
              ),
            );
        }
        if (request.url.startsWith("/repos/list") && request.method === "GET") {
          return yield* repos.list({ limit: 50 }).pipe(
            Effect.flatMap((res) => HttpServerResponse.json(res)),
            Effect.catchTag("ArtifactsError", (err) =>
              HttpServerResponse.json({ error: err.message }, { status: 500 }),
            ),
          );
        }
        if (request.url.startsWith("/repos/info") && request.method === "GET") {
          const name = new URL(request.url, "http://x").searchParams.get(
            "name",
          );
          if (!name) {
            return yield* HttpServerResponse.json(
              { error: "name is required" },
              { status: 400 },
            );
          }
          return yield* repos.get(name).pipe(
            Effect.flatMap((repo) =>
              HttpServerResponse.json({
                id: repo.raw.id,
                name: repo.raw.name,
                description: repo.raw.description,
                defaultBranch: repo.raw.defaultBranch,
                remote: repo.raw.remote,
                createdAt: repo.raw.createdAt,
                updatedAt: repo.raw.updatedAt,
                lastPushAt: repo.raw.lastPushAt,
                readOnly: repo.raw.readOnly,
              }),
            ),
            Effect.catchTag("ArtifactsError", (err) =>
              HttpServerResponse.json(
                { name, error: err.message },
                { status: 404 },
              ),
            ),
          );
        }
        if (
          request.url.startsWith("/repos/token") &&
          request.method === "POST"
        ) {
          const text = yield* request.text;
          const body = JSON.parse(text || "{}") as {
            name?: string;
            scope?: "read" | "write";
            ttl?: number;
          };
          const name = body.name?.trim();
          if (!name) {
            return yield* HttpServerResponse.json(
              { error: "name is required" },
              { status: 400 },
            );
          }
          return yield* repos.get(name).pipe(
            Effect.flatMap((repo) =>
              repo.createToken(body.scope ?? "read", body.ttl ?? 3600),
            ),
            Effect.flatMap((token) =>
              HttpServerResponse.json({ name, ...token }),
            ),
            Effect.catchTag("ArtifactsError", (err) =>
              HttpServerResponse.json(
                { name, error: err.message },
                { status: 404 },
              ),
            ),
          );
        }
        // Queue producer + consumer smoke test.
        //
        // POST /queue/send       sends a message with a generated id.
        // GET  /queue/result/:id reads the bucket entry the consumer
        //                        wrote when it processed that message.
        //
        // Producer side: `Cloudflare.QueueBinding`. Consumer side:
        // `Cloudflare.messages(Queue).subscribe(...)` registered in
        // the init phase (above), with `QueueEventSourceLive` on the
        // worker layer.
        // AI Gateway smoke test — POST /ai with { prompt }.
        //
        // Routes a Workers AI inference call through the gateway resource so
        // every request is observable in the Cloudflare AI Gateway UI and
        // benefits from caching/rate limiting configured on the resource.
        if (request.url.startsWith("/ai") && request.method === "POST") {
          const text = yield* request.text;
          const body = (() => {
            try {
              return JSON.parse(text || "{}") as { prompt?: string };
            } catch {
              return {} as { prompt?: string };
            }
          })();
          const prompt =
            body.prompt?.trim() || "Say hello in one short sentence.";
          const response = yield* aiGateway.run({
            provider: "workers-ai",
            endpoint: "@cf/meta/llama-3.1-8b-instruct",
            headers: { "content-type": "application/json" },
            query: { prompt },
          });
          return HttpServerResponse.fromWeb(response);
        }
        if (request.url === "/queue/send" && request.method === "POST") {
          const text = yield* request.text;
          const msg: QueueMessageBody = {
            id: crypto.randomUUID(),
            text,
            sentAt: Date.now(),
          };
          yield* queue.send(msg).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ sent: msg }, { status: 202 });
        }
        if (request.url.startsWith("/queue/result/")) {
          const id = request.url.split("/queue/result/")[1];
          if (!id) {
            return HttpServerResponse.text("missing id", { status: 400 });
          }
          if (request.method === "GET") {
            return yield* bucket.get(`/queue/${id}`).pipe(
              Effect.flatMap((object) =>
                object === null
                  ? Effect.succeed(
                      HttpServerResponse.text("not yet", { status: 404 }),
                    )
                  : object.text().pipe(
                      Effect.map((body) =>
                        HttpServerResponse.text(body, {
                          headers: { "content-type": "application/json" },
                        }),
                      ),
                    ),
              ),
              Effect.catchTag("R2Error", (error) =>
                Effect.succeed(
                  HttpServerResponse.text(error.message, { status: 500 }),
                ),
              ),
            );
          }
          // DELETE — used by the integ test to clear consumed
          // entries before stack.destroy(), so R2Bucket delete
          // doesn't fail with "bucket not empty".
          if (request.method === "DELETE") {
            return yield* bucket.delete(`/queue/${id}`).pipe(
              Effect.map(() => HttpServerResponse.empty({ status: 204 })),
              Effect.catchTag("R2Error", (error) =>
                Effect.succeed(
                  HttpServerResponse.text(error.message, { status: 500 }),
                ),
              ),
            );
          }
        }
        return HttpServerResponse.text("Not Found", { status: 404 });
      }).pipe(
        Effect.catch(() =>
          Effect.succeed(
            HttpServerResponse.text("Internal Server Error", {
              status: 500,
            }),
          ),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.R2BucketBindingLive,
        Cloudflare.KVNamespaceBindingLive,
        Cloudflare.QueueBindingLive,
        Cloudflare.QueueEventSourceLive,
        Cloudflare.ArtifactsBindingLive,
        Cloudflare.AiGatewayBindingLive,
      ),
    ),
  ),
) {}
