import * as Bedrock from "@/AWS/Bedrock";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// Nova Micro via the us cross-region inference profile: the cheapest
// on-demand conversational model in the testing account (bare
// amazon.nova-micro-v1:0 rejects on-demand invocation).
const MODEL = "us.amazon.nova-micro-v1:0";

// Amazon's reranker — enabled in the testing account (us-west-2).
const RERANK_MODEL = "amazon.rerank-v1:0";

// CountTokens only supports a subset of models addressed by their BARE
// foundation-model id — Nova rejects it with "The provided model doesn't
// support counting tokens", as do cross-region inference-profile ids.
const COUNT_TOKENS_MODEL = "anthropic.claude-haiku-4-5-20251001-v1:0";

export class BedrockTestFunction extends Lambda.Function<Lambda.Function>()(
  "BedrockTestFunction",
) {}

export default BedrockTestFunction.make(
  {
    main,
    url: true,
    // Model inference (and agent orchestration especially) regularly
    // exceeds Lambda's 3s default timeout.
    timeout: Duration.seconds(60),
  },
  Effect.gen(function* () {
    // An agent + alias to exercise InvokeAgent end-to-end. The alias
    // snapshots the prepared DRAFT into version 1 on create.
    const agent = yield* Bedrock.Agent("BindingsTestAgent", {
      foundationModel: MODEL,
      instruction:
        "You are a helpful assistant. Answer every question with one short sentence.",
      // Long-term memory so GetAgentMemory / DeleteAgentMemory are callable.
      memoryConfiguration: {
        enabledMemoryTypes: ["SESSION_SUMMARY"],
        storage: "30 days",
      },
    });
    const alias = yield* Bedrock.AgentAlias("BindingsTestAlias", {
      agentId: agent.agentId,
    });

    const converse = yield* Bedrock.Converse(MODEL);
    const converseStream = yield* Bedrock.ConverseStream(MODEL);
    const countTokens = yield* Bedrock.CountTokens(COUNT_TOKENS_MODEL);
    const invokeAgent = yield* Bedrock.InvokeAgent(alias);
    const getAgentMemory = yield* Bedrock.GetAgentMemory(alias);
    const deleteAgentMemory = yield* Bedrock.DeleteAgentMemory(alias);
    const invokeModel = yield* Bedrock.InvokeModel(MODEL);
    const rerank = yield* Bedrock.Rerank(RERANK_MODEL);
    const invokeModelStream =
      yield* Bedrock.InvokeModelWithResponseStream(MODEL);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        // Cheap readiness route — no Bedrock call.
        if (request.method === "GET" && pathname === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/count-tokens") {
          const result = yield* countTokens({
            input: {
              converse: {
                messages: [{ role: "user", content: [{ text: "Say hello." }] }],
              },
            },
          });
          return yield* HttpServerResponse.json({
            inputTokens: result.inputTokens,
          });
        }

        if (request.method === "GET" && pathname === "/rerank") {
          const region = yield* Effect.sync(() => process.env.AWS_REGION);
          const result = yield* rerank({
            queries: [
              { type: "TEXT", textQuery: { text: "What is alchemy?" } },
            ],
            sources: [
              "alchemy is an infrastructure-as-effects framework",
              "bananas are yellow",
            ].map((text) => ({
              type: "INLINE",
              inlineDocumentSource: {
                type: "TEXT",
                textDocument: { text },
              },
            })),
            rerankingConfiguration: {
              type: "BEDROCK_RERANKING_MODEL",
              bedrockRerankingConfiguration: {
                modelConfiguration: {
                  modelArn: `arn:aws:bedrock:${region}::foundation-model/${RERANK_MODEL}`,
                },
              },
            },
          });
          return yield* HttpServerResponse.json({
            results: result.results.map(({ index, relevanceScore }) => ({
              index,
              relevanceScore,
            })),
          });
        }

        if (request.method === "GET" && pathname === "/invoke-agent") {
          const sessionId = yield* Effect.sync(() => crypto.randomUUID());
          const result = yield* invokeAgent({
            sessionId,
            inputText: "What is the capital of France?",
          });
          const events = yield* Stream.runCollect(result.completion);
          const decoder = new TextDecoder();
          let chunkEvents = 0;
          let text = "";
          for (const event of events) {
            const bytes = event.chunk?.bytes;
            if (bytes !== undefined) {
              chunkEvents += 1;
              text += decoder.decode(
                Redacted.isRedacted(bytes) ? Redacted.value(bytes) : bytes,
                { stream: true },
              );
            }
          }
          return yield* HttpServerResponse.json({
            sessionId: result.sessionId,
            chunkEvents,
            text,
          });
        }

        if (request.method === "GET" && pathname === "/agent-memory") {
          // Read then clear memory for a fixed memory id. Summaries are
          // generated asynchronously after a session ends, so on a fresh
          // agent the read returns no contents — the route validates the
          // IAM grants and wiring, not summary generation.
          const memoryId = "alchemy-bindings-test-memory";
          const memory = yield* getAgentMemory({
            memoryType: "SESSION_SUMMARY",
            memoryId,
            maxItems: 10,
          });
          yield* deleteAgentMemory({ memoryId });
          return yield* HttpServerResponse.json({
            memoryContents: memory.memoryContents?.length ?? 0,
            deleted: true,
          });
        }

        if (request.method === "GET" && pathname === "/converse") {
          const result = yield* converse({
            system: [{ text: "You reply with exactly one word." }],
            messages: [{ role: "user", content: [{ text: "Say hello." }] }],
            inferenceConfig: { maxTokens: 64, temperature: 0 },
          });
          return yield* HttpServerResponse.json({
            text: result.output.message.content
              .map((block) => block.text ?? "")
              .join(""),
            stopReason: result.stopReason,
            outputTokens: result.usage.outputTokens,
          });
        }

        if (request.method === "GET" && pathname === "/converse-stream") {
          const result = yield* converseStream({
            system: [{ text: "You reply with exactly one word." }],
            messages: [{ role: "user", content: [{ text: "Say hello." }] }],
            inferenceConfig: { maxTokens: 64, temperature: 0 },
          });
          const events = yield* Stream.runCollect(
            result.stream ?? Stream.empty,
          );
          let text = "";
          let deltaEvents = 0;
          let stopReason: string | undefined;
          for (const event of events) {
            if (event.contentBlockDelta?.delta.text !== undefined) {
              text += event.contentBlockDelta.delta.text;
              deltaEvents += 1;
            }
            if (event.messageStop !== undefined) {
              stopReason = event.messageStop.stopReason;
            }
          }
          return yield* HttpServerResponse.json({
            text,
            deltaEvents,
            totalEvents: events.length,
            stopReason,
          });
        }

        if (request.method === "GET" && pathname === "/invoke-model-stream") {
          const result = yield* invokeModelStream({
            contentType: "application/json",
            accept: "application/json",
            // Raw Nova messages-v1 payload — no marshalling.
            body: JSON.stringify({
              system: [{ text: "You reply with exactly one word." }],
              messages: [{ role: "user", content: [{ text: "Say hello." }] }],
              inferenceConfig: { maxTokens: 64, temperature: 0 },
            }),
          });
          const events = yield* Stream.runCollect(result.body);
          const decoder = new TextDecoder();
          let chunkEvents = 0;
          let raw = "";
          for (const event of events) {
            const bytes = event.chunk?.bytes;
            if (bytes !== undefined) {
              chunkEvents += 1;
              raw += decoder.decode(
                Redacted.isRedacted(bytes) ? Redacted.value(bytes) : bytes,
                { stream: true },
              );
            }
          }
          // Each chunk is one JSON event (Nova emits messageStart,
          // contentBlockDelta, ... as separate chunks); aggregate the text
          // deltas out of the raw concatenated JSON events.
          const text = [...raw.matchAll(/"text"\s*:\s*"([^"]*)"/g)]
            .map((m) => m[1])
            .join("");
          return yield* HttpServerResponse.json({
            contentType: result.contentType,
            chunkEvents,
            text,
          });
        }

        if (request.method === "GET" && pathname === "/invoke-model") {
          const result = yield* invokeModel({
            contentType: "application/json",
            accept: "application/json",
            // Raw Nova messages-v1 payload — InvokeModel does no marshalling.
            body: JSON.stringify({
              system: [{ text: "You reply with exactly one word." }],
              messages: [{ role: "user", content: [{ text: "Say hello." }] }],
              inferenceConfig: { maxTokens: 64, temperature: 0 },
            }),
          });
          const raw = yield* Stream.mkString(Stream.decodeText(result.body));
          const parsed = yield* Effect.try(
            () =>
              JSON.parse(raw) as {
                output?: { message?: { content?: Array<{ text?: string }> } };
                stopReason?: string;
              },
          );
          return yield* HttpServerResponse.json({
            contentType: result.contentType,
            text: (parsed.output?.message?.content ?? [])
              .map((block) => block.text ?? "")
              .join(""),
            stopReason: parsed.stopReason,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Bedrock.ConverseHttp,
        Bedrock.ConverseStreamHttp,
        Bedrock.CountTokensHttp,
        Bedrock.DeleteAgentMemoryHttp,
        Bedrock.GetAgentMemoryHttp,
        Bedrock.InvokeAgentHttp,
        Bedrock.InvokeModelHttp,
        Bedrock.InvokeModelWithResponseStreamHttp,
        Bedrock.RerankHttp,
      ),
    ),
  ),
);
