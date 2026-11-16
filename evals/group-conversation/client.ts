// @effect-diagnostics nodeBuiltinImport:off
import * as NodePerfHooks from "node:perf_hooks";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { morphConfig, proxyConfig } from "../shared/proxy.ts";

export interface ApiTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
}
export interface Message {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly calls?: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly input: Readonly<Record<string, unknown>>;
  }>;
  readonly results?: ReadonlyArray<{ readonly id: string; readonly text: string }>;
  readonly raw?: ReadonlyArray<unknown>;
}
const Usage = Schema.Struct({
  input_tokens: Schema.Number,
  output_tokens: Schema.Number,
  cache_creation_input_tokens: Schema.optional(Schema.Number),
  cache_read_input_tokens: Schema.optional(Schema.Number),
  input_tokens_details: Schema.optional(Schema.Struct({ cached_tokens: Schema.Number })),
  output_tokens_details: Schema.optional(Schema.Struct({ reasoning_tokens: Schema.Number })),
});
const ToolInput = Schema.Record(Schema.String, Schema.Unknown);
const Block = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
  content: Schema.optional(
    Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
  ),
  id: Schema.optional(Schema.String),
  call_id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  arguments: Schema.optional(Schema.String),
  input: Schema.optional(ToolInput),
});
const Response = Schema.Struct({
  content: Schema.optional(Schema.Array(Block)),
  output: Schema.optional(Schema.Array(Block)),
  usage: Usage,
  status: Schema.optional(Schema.String),
  stop_reason: Schema.optional(Schema.String),
});
const decodeResponse = Schema.decodeUnknownSync(Response);
const decodeEvent = Schema.decodeUnknownSync(
  Schema.Struct({ type: Schema.String, response: Schema.optional(Schema.Unknown) }),
);
const decodeToolInput = Schema.decodeSync(Schema.fromJsonString(ToolInput));
const decodePreserved = Schema.decodeUnknownSync(
  Schema.Struct({
    content: Schema.optional(Schema.Array(Schema.Unknown)),
    output: Schema.optional(Schema.Array(Schema.Unknown)),
  }),
);

const MAX_ATTEMPTS = 3;

export function makeClient(options: { readonly proxy: boolean; readonly effort: string }) {
  const attempts: Array<{ model: string; purpose: string; completed: boolean }> = [];
  const ledger: Array<{
    model: string;
    elapsedMs: number;
    usage: typeof Usage.Type;
    usd: number | null;
    truncated: boolean;
    purpose: string;
    request: unknown;
    response: unknown;
  }> = [];
  // Read once per run: each read spawns python, and a mid-run config edit must not split the run.
  let morph: ReturnType<typeof morphConfig> | undefined;
  const unavailable = (model: string) => {
    if (model.startsWith("claude-"))
      return process.env.ANTHROPIC_API_KEY
        ? null
        : "ANTHROPIC_API_KEY missing from repo-root .env and process environment.";
    if (model.startsWith("morph-")) {
      try {
        morph ??= morphConfig();
        return null;
      } catch {
        return "Morph unavailable; set MORPH_API_KEY or add a morph provider to ~/.config/opencode/opencode.json. No substitution.";
      }
    }
    if (!model.startsWith("gpt-")) return `Unsupported model family for ${model}. No substitution.`;
    if (!options.proxy)
      return process.env.OPENAI_API_KEY
        ? null
        : "OPENAI_API_KEY missing from repo-root .env and process environment.";
    try {
      proxyConfig();
      return null;
    } catch {
      return "Codex proxy unavailable; configure vibeproxy in ~/.codex/config.toml and Python 3.11+. No substitution.";
    }
  };

  const call = async (
    model: string,
    system: string,
    messages: ReadonlyArray<Message>,
    tools: ReadonlyArray<ApiTool>,
    purpose: string,
  ) => {
    const missing = unavailable(model);
    if (missing) throw new Error(missing);
    const claude = model.startsWith("claude-");
    const isMorph = model.startsWith("morph-");
    const proxy = isMorph ? undefined : !claude && options.proxy ? proxyConfig() : undefined;
    const responsesEndpoint = isMorph ? morph : proxy;
    const request = claude
      ? {
          model,
          system,
          max_tokens: 8_000,
          thinking: { type: "adaptive" },
          output_config: { effort: options.effort },
          messages: messages.map((message) => ({
            role: message.role,
            content: message.raw ?? [
              ...(message.text ? [{ type: "text", text: message.text }] : []),
              ...(message.calls ?? []).map((call) => ({
                type: "tool_use",
                id: call.id,
                name: call.name,
                input: call.input,
              })),
              ...(message.results ?? []).map((result) => ({
                type: "tool_result",
                tool_use_id: result.id,
                content: result.text,
              })),
            ],
          })),
          ...(tools.length
            ? {
                tools: tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  input_schema: tool.parameters,
                })),
              }
            : {}),
        }
      : {
          model,
          instructions: system,
          reasoning: { effort: options.effort },
          store: false,
          include: ["reasoning.encrypted_content"],
          stream: Boolean(proxy),
          max_output_tokens: 12_000,
          input: messages.flatMap(
            (message): ReadonlyArray<unknown> =>
              message.raw ?? [
                ...(message.text
                  ? [
                      {
                        role: message.role,
                        content: [
                          {
                            type: message.role === "user" ? "input_text" : "output_text",
                            text: message.text,
                          },
                        ],
                      },
                    ]
                  : []),
                ...(message.calls ?? []).map((call) => ({
                  type: "function_call",
                  call_id: call.id,
                  name: call.name,
                  arguments: JSON.stringify(call.input),
                })),
                ...(message.results ?? []).map((result) => ({
                  type: "function_call_output",
                  call_id: result.id,
                  output: result.text,
                })),
              ],
          ),
          ...(tools.length
            ? { tools: tools.map((tool) => ({ type: "function", ...tool, strict: false })) }
            : {}),
        };
    const start = NodePerfHooks.performance.now();
    const attempt = { model, purpose, completed: false };
    attempts.push(attempt);
    const headers = claude
      ? { "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" }
      : (responsesEndpoint?.headers ?? { Authorization: `Bearer ${process.env.OPENAI_API_KEY!}` });
    const body = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        for (let attempt = 1; ; attempt++) {
          const response = yield* HttpClientRequest.post(
            claude
              ? "https://api.anthropic.com/v1/messages"
              : `${responsesEndpoint?.url ?? "https://api.openai.com/v1"}/responses`,
          ).pipe(
            HttpClientRequest.setHeaders(headers),
            HttpClientRequest.bodyJson(request),
            Effect.flatMap(client.execute),
          );
          // Rate limits and server errors are transport, not model behaviour, so they get retries.
          if ((response.status === 429 || response.status >= 500) && attempt < MAX_ATTEMPTS) {
            const retryAfter = Number(response.headers["retry-after"]);
            yield* Effect.sleep(
              `${retryAfter > 0 ? Math.min(retryAfter, 60) : 2 ** attempt} seconds`,
            );
            continue;
          }
          if (response.status !== 200)
            return yield* Effect.die(
              new Error(
                `Model API HTTP ${response.status}. Response body omitted to avoid leaking credentials.`,
              ),
            );
          return yield* response.text;
        }
      }).pipe(Effect.timeout("120 seconds"), Effect.provide(FetchHttpClient.layer)),
    );
    const raw: unknown = proxy
      ? body
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => decodeEvent(JSON.parse(line.slice(6))))
          .find((event) => event.type === "response.completed")?.response
      : JSON.parse(body);
    const parsed = decodeResponse(raw);
    const elapsedMs = NodePerfHooks.performance.now() - start;
    const usage = parsed.usage;
    const truncated = parsed.status === "incomplete" || parsed.stop_reason === "max_tokens";
    const rates =
      model === "claude-opus-5-5"
        ? { input: 4, output: 20, write: 5, read: 0.2 }
        : model === "claude-sonnet-5-5"
          ? { input: 2, output: 10, write: 2.5, read: 0.2 }
          : null;
    const usd = rates
      ? (usage.input_tokens * rates.input +
          usage.output_tokens * rates.output +
          (usage.cache_creation_input_tokens ?? 0) * rates.write +
          (usage.cache_read_input_tokens ?? 0) * rates.read) /
        1e6
      : null;
    ledger.push({ model, elapsedMs, usage, usd, truncated, purpose, request, response: raw });
    attempt.completed = true;
    if (truncated) throw new Error("Model response hit its output limit; not a valid sample.");
    if (!claude && parsed.status !== "completed")
      throw new Error("Responses API did not complete.");
    const blocks = parsed.content ?? parsed.output;
    if (!blocks) throw new Error("Model response has no content or output.");
    const text = blocks
      .flatMap((block) =>
        block.type === "text"
          ? [block.text ?? ""]
          : block.type === "message"
            ? (block.content ?? [])
                .filter((part) => part.type === "output_text")
                .map((part) => part.text ?? "")
            : [],
      )
      .join("\n");
    const calls = blocks
      .filter((block) => block.type === "function_call" || block.type === "tool_use")
      .map((block) => {
        const input = block.input ?? decodeToolInput(block.arguments ?? "{}");
        if (!block.name || !(block.call_id ?? block.id))
          throw new Error("Model tool call lacks its name or ID.");
        return { id: (block.call_id ?? block.id)!, name: block.name, input };
      });
    if (!text.trim() && !calls.length) throw new Error("Model returned no answer or tool call.");
    const preserved = decodePreserved(raw);
    return {
      role: "assistant" as const,
      text,
      calls,
      raw: (claude ? preserved.content : preserved.output) ?? [],
    };
  };
  return { call, ledger, attempts, unavailable };
}
