#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - A dependency-free stub so the fixture runs against any checkout, including the pre-fix base.
/**
 * Credential-free OpenRouter stand-in for reproducing OpenCode context usage
 * (issue 8388) through a real OpenCode CLI and a real T3 dev server.
 *
 * Every chat completion streams one reply and a final usage chunk of
 * prompt 12000 (1000 cached) and completion 32, so OpenCode reports input
 * 11000 + cache read 1000 + output 32 and the composer meter should read
 * 12032 of the 128000 context limit set in the generated config.
 *
 *   node apps/server/scripts/opencode-openrouter-usage-fixture.ts prepare <dir> [--port 18988]
 *     Writes <dir>/project/opencode.json, isolated XDG dirs, and <dir>/opencode,
 *     a wrapper that runs `opencode` (or $OPENCODE_BIN) with that config.
 *   node apps/server/scripts/opencode-openrouter-usage-fixture.ts serve [--port 18988]
 *     Serves the stub on 127.0.0.1 and logs one JSON line per request.
 *
 * Reproduce, from a worktree seeded with `vp run migrate-dev-db`:
 *   1. `prepare` then `serve`, and `vp run dev`.
 *   2. Settings > Providers > OpenCode: enable, set binary path to <dir>/opencode.
 *      Settings > General > Legacy features: enable Context window indicator.
 *   3. Add project <dir>/project, start an OpenCode thread on model
 *      openrouter/z-ai/glm-5.3-flash, and send any message.
 *   4. Extract the thread's provider turns:
 *      node apps/server/scripts/t3-sqlite-state.ts query --base-dir .t3 --sql \
 *        "select status, json_extract(payload_json,'$.tokenUsage') as tokenUsage, \
 *         json_extract(payload_json,'$.turnTokenUsage') as turnTokenUsage \
 *         from orchestration_v2_projection_provider_turns where thread_id='<threadId>' order by ordinal"
 *
 * Quick check without T3: `<dir>/opencode run --model openrouter/z-ai/glm-5.3-flash --format json hi`
 * run inside <dir>/project prints a step-finish part with the tokens above.
 */
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

const MODEL_ID = "z-ai/glm-5.3-flash";
const CONTEXT_LIMIT = 128_000;
const usage = {
  prompt_tokens: 12_000,
  completion_tokens: 32,
  total_tokens: 12_032,
  prompt_tokens_details: { cached_tokens: 1_000 },
  completion_tokens_details: { reasoning_tokens: 0 },
  cost: 0.001,
  is_byok: false,
};
const replyText = "Local stub reply.";

const [command, ...rest] = process.argv.slice(2);
const portFlag = rest.indexOf("--port");
const port = portFlag === -1 ? 18_988 : Number(rest[portFlag + 1]);
const dirArgument = rest.find(
  (_, index) => portFlag === -1 || (index !== portFlag && index !== portFlag + 1),
);

function shellQuote(value: string) {
  return "'" + value.split("'").join("'\\''") + "'";
}

function prepare(rawDir: string) {
  const dir = NodePath.resolve(rawDir);
  const providerOptions = { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "stub-local-only" };
  const config = {
    $schema: "https://opencode.ai/config.json",
    enabled_providers: ["openrouter"],
    provider: {
      openrouter: {
        options: providerOptions,
        models: {
          [MODEL_ID]: { name: "openrouter stub", limit: { context: CONTEXT_LIMIT, output: 4096 } },
        },
      },
    },
  };
  NodeFS.mkdirSync(NodePath.join(dir, "project"), { recursive: true });
  for (const xdg of ["data", "config", "cache"]) {
    NodeFS.mkdirSync(NodePath.join(dir, "xdg", xdg), { recursive: true });
  }
  const configPath = NodePath.join(dir, "project", "opencode.json");
  NodeFS.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const wrapperPath = NodePath.join(dir, "opencode");
  NodeFS.writeFileSync(
    wrapperPath,
    [
      "#!/bin/sh",
      `export OPENCODE_CONFIG=${shellQuote(configPath)}`,
      `export XDG_DATA_HOME=${shellQuote(NodePath.join(dir, "xdg", "data"))}`,
      `export XDG_CONFIG_HOME=${shellQuote(NodePath.join(dir, "xdg", "config"))}`,
      `export XDG_CACHE_HOME=${shellQuote(NodePath.join(dir, "xdg", "cache"))}`,
      `exec "\${OPENCODE_BIN:-opencode}" "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  console.log(JSON.stringify({ project: NodePath.dirname(configPath), binaryPath: wrapperPath }));
}

function serve() {
  const server = NodeHttp.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      console.log(
        JSON.stringify({
          method: request.method,
          path: request.url,
          model: body.model,
          stream: body.stream,
          messages: body.messages?.length ?? 0,
        }),
      );
      const base = {
        id: "gen-local-8388",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
      };
      if (!body.stream) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            ...base,
            object: "chat.completion",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: replyText },
                finish_reason: "stop",
              },
            ],
            usage,
          }),
        );
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunks = [
        {
          choices: [
            { index: 0, delta: { role: "assistant", content: replyText }, finish_reason: null },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        // OpenRouter sends usage in a trailing chunk with no choices.
        { choices: [], usage },
      ];
      for (const chunk of chunks) {
        response.write(
          `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", ...chunk })}\n\n`,
        );
      }
      response.end("data: [DONE]\n\n");
    });
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(JSON.stringify({ listening: `http://127.0.0.1:${port}/v1`, pid: process.pid }));
  });
}

if (command === "prepare" && dirArgument) {
  prepare(dirArgument);
} else if (command === "serve") {
  serve();
} else {
  console.error("usage: opencode-openrouter-usage-fixture.ts prepare <dir> | serve [--port N]");
  process.exit(1);
}
