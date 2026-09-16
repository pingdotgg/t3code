import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  OpenCode2Runtime,
  OpenCode2RuntimeLive,
  OPENCODE2_MCP_NAMESPACE,
  openCode2McpServerBase,
  openCode2McpServerName,
  openCode2ServiceCommand,
  parseOpenCode2ModelSlug,
  withOpenCode2Variant,
} from "./opencode2Runtime.ts";

const HEALTH_BODY = { healthy: true, version: "2.0.3", pid: 1234 };

/**
 * Records every request URL while answering the health probe. Recording the
 * request is the point: the external-server path used to normalize the
 * configured URL with `url.parse(...).toString()`, which evaluates to the
 * string "[object Object]" — the probe then requested "[object Object]/api/health"
 * and every external server looked unreachable. Asserting on the runtime's own
 * arguments would not have caught that.
 */
const makeTestLayer = (requestedUrls: Ref.Ref<ReadonlyArray<string>>) =>
  OpenCode2RuntimeLive.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Ref.update(requestedUrls, (urls) => [...urls, String(request.url)]).pipe(
            Effect.as(HttpClientResponse.fromWeb(request, Response.json(HEALTH_BODY))),
          ),
        ),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const connectWithRequestLog = (serverUrl: string) =>
  Effect.gen(function* () {
    const requestedUrls = yield* Ref.make<ReadonlyArray<string>>([]);
    const exit = yield* OpenCode2Runtime.pipe(
      Effect.flatMap((runtime) => Effect.exit(runtime.connect({ serverUrl }))),
      Effect.provide(makeTestLayer(requestedUrls)),
    );
    return { exit, requestedUrls: yield* Ref.get(requestedUrls) };
  });

it.effect("probes an external server at its configured URL", () =>
  Effect.gen(function* () {
    const { exit, requestedUrls } = yield* connectWithRequestLog("http://127.0.0.1:49374");

    NodeAssert.equal(exit._tag, "Success");
    if (exit._tag !== "Success") return;
    NodeAssert.equal(exit.value.url, "http://127.0.0.1:49374");
    NodeAssert.equal(exit.value.version, "2.0.3");
    NodeAssert.deepEqual(requestedUrls, ["http://127.0.0.1:49374/api/health"]);
  }),
);

it.effect("keeps a trailing slash from corrupting the probe URL", () =>
  Effect.gen(function* () {
    const { requestedUrls } = yield* connectWithRequestLog("http://127.0.0.1:49374/");

    NodeAssert.equal(requestedUrls.length, 1);
    NodeAssert.ok(requestedUrls[0]?.includes("127.0.0.1:49374/api/health"));
    NodeAssert.ok(!requestedUrls[0]?.includes("[object Object]"));
  }),
);

it("folds the composer variant selection into the model ref", () => {
  // v2's `session.prompt` has no variant field, so the Reasoning selection
  // must ride inside the model ref (`provider/model#variant`); without this
  // the choice was silently dropped.
  const base = parseOpenCode2ModelSlug("openai/gpt-6-astra");
  NodeAssert.equal(base?.variant, undefined);

  const withHigh = withOpenCode2Variant(base, "high");
  NodeAssert.equal(withHigh?.providerID, "openai");
  NodeAssert.equal(withHigh?.id, "gpt-6-astra");
  NodeAssert.equal(withHigh?.variant, "high");
});

it("ignores an absent or blank variant, and degrades a bad one to no variant", () => {
  const base = parseOpenCode2ModelSlug("openai/gpt-6-astra");

  NodeAssert.equal(withOpenCode2Variant(base, undefined)?.variant, undefined);
  NodeAssert.equal(withOpenCode2Variant(base, "")?.variant, undefined);
  NodeAssert.equal(withOpenCode2Variant(base, "   ")?.variant, undefined);
  // A variant containing the ref separator cannot be encoded, so the model
  // must survive while only the variant is dropped.
  const bad = withOpenCode2Variant(base, "hi#gh");
  NodeAssert.equal(bad?.providerID, "openai");
  NodeAssert.equal(bad?.id, "gpt-6-astra");
  NodeAssert.equal(bad?.variant, undefined);
});

it("leaves an unparseable model selection alone", () => {
  NodeAssert.equal(withOpenCode2Variant(undefined, "high"), undefined);
});

it("starts the background service with the configured binary path", () => {
  // The SDK default is `opencode serve --service`, but the v2 binary is
  // `opencode2`; a machine with only v2 installed could never pass the 2.x
  // version gate through the default.
  NodeAssert.deepEqual(openCode2ServiceCommand("/opt/opencode2"), [
    "/opt/opencode2",
    "serve",
    "--service",
  ]);
});

it("defers to the SDK default command when no binary path is configured", () => {
  NodeAssert.equal(openCode2ServiceCommand(undefined), undefined);
  NodeAssert.equal(openCode2ServiceCommand(""), undefined);
  NodeAssert.equal(openCode2ServiceCommand("   "), undefined);
});

it("nests every configured MCP name inside the reserved namespace", () => {
  // Isolation rules match the namespace prefix, so a configured name must not
  // replace it — otherwise a second instance could escape the deny.
  NodeAssert.equal(openCode2McpServerBase(undefined), OPENCODE2_MCP_NAMESPACE);
  NodeAssert.equal(openCode2McpServerBase("  "), OPENCODE2_MCP_NAMESPACE);
  NodeAssert.equal(openCode2McpServerBase("corp"), `${OPENCODE2_MCP_NAMESPACE}-corp`);
  // The sanitizer rewrites the configured name too, and both the registration
  // and the rules must agree on the result.
  NodeAssert.equal(openCode2McpServerBase("corp.io"), `${OPENCODE2_MCP_NAMESPACE}-corp_io`);
});

it("keeps per-thread names valid and predictable, including the hashed path", () => {
  const threadId = "1df144f5-a78f-433d-a7d2-6c58ef966196";
  const name = openCode2McpServerName("corp.io", threadId);
  NodeAssert.equal(name, `${OPENCODE2_MCP_NAMESPACE}-corp_io-${threadId}`);
  NodeAssert.ok(/^[a-zA-Z0-9_-]+$/.test(name));
  NodeAssert.ok(name.startsWith(`${openCode2McpServerBase("corp.io")}-`));

  // Beyond the length cap the name is hashed; the sanitized namespace prefix
  // must still keep the result a valid MCP name in the reserved namespace
  // (regression: the hashed path kept `corp.io` and emitted an invalid name).
  const long = openCode2McpServerName("corp.io", "x".repeat(200));
  NodeAssert.ok(long.length <= 96, `expected <= 96 chars, got ${long.length}`);
  NodeAssert.ok(/^[a-zA-Z0-9_-]+$/.test(long), `invalid MCP name: ${long}`);
  NodeAssert.ok(
    long.startsWith(`${OPENCODE2_MCP_NAMESPACE}-corp_io-`),
    `expected reserved namespace, got: ${long}`,
  );
});
