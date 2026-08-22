import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import { ServerConfig } from "../config.ts";
import * as OpenCodeRuntime from "../provider/opencodeRuntime.ts";
import { makeOpenCodeTextGeneration } from "./OpenCodeTextGeneration.ts";

interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: unknown;
  readonly body: unknown;
}

type RuntimeResponse = unknown | ((request: CapturedRequest) => unknown);

const configLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-opencode-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function runtimeLayer(response: RuntimeResponse, requests: Array<CapturedRequest>) {
  const connection: OpenCodeRuntime.OpenCodeConnection = {
    url: "http://127.0.0.1:49374/",
    protocol: { promptShape: "flat" },
    request: ((
      method: string,
      path: string,
      input: { readonly query?: unknown; readonly body?: unknown },
    ) => {
      const request = { method, path, query: input.query, body: input.body };
      requests.push(request);
      return Effect.succeed(typeof response === "function" ? response(request) : response);
    }) as OpenCodeRuntime.OpenCodeConnection["request"],
    globalEvents: Stream.empty,
  };
  return Layer.succeed(
    OpenCodeRuntime.OpenCodeRuntime,
    OpenCodeRuntime.OpenCodeRuntime.of({ attach: () => Effect.succeed(connection) }),
  );
}

function testLayer(response: RuntimeResponse, requests: Array<CapturedRequest>) {
  return Layer.merge(runtimeLayer(response, requests), configLayer);
}

it.effect("generates structured text through the attached OpenCode 2 service", () => {
  const requests: Array<CapturedRequest> = [];
  return Effect.gen(function* () {
    const textGeneration = yield* makeOpenCodeTextGeneration({ binaryPath: "opencode2" });
    const generated = yield* textGeneration.generateCommitMessage({
      cwd: "/work/project",
      branch: "feat/opencode2",
      stagedSummary: "M apps/server/src/provider/opencodeRuntime.ts",
      stagedPatch: "diff --git a/runtime.ts b/runtime.ts",
      modelSelection: createModelSelection(ProviderInstanceId.make("opencode"), "openai/gpt-5.6", [
        { id: "variant", value: "high" },
      ]),
    });

    NodeAssert.deepEqual(generated, {
      subject: "Add OpenCode 2 runtime",
      body: "Attach to the shared service.",
    });
    NodeAssert.equal(requests.length, 1);
    const request = requests[0];
    NodeAssert.ok(request);
    NodeAssert.equal(request.method, "POST");
    NodeAssert.equal(request.path, "/api/generate");
    NodeAssert.deepEqual(request.query, {
      "location[directory]": "/work/project",
    });
    NodeAssert.deepEqual(request.body, {
      prompt: (request.body as { readonly prompt: string }).prompt,
      model: { providerID: "openai", id: "gpt-5.6", variant: "high" },
    });
    NodeAssert.match((request.body as { readonly prompt: string }).prompt, /commit message/i);
  }).pipe(
    Effect.provide(
      testLayer(
        {
          text: JSON.stringify({
            subject: "Add OpenCode 2 runtime",
            body: "Attach to the shared service.",
          }),
        },
        requests,
      ),
    ),
  );
});

it.effect("rejects model selections that do not identify an upstream provider", () => {
  const requests: Array<CapturedRequest> = [];
  return Effect.gen(function* () {
    const textGeneration = yield* makeOpenCodeTextGeneration({ binaryPath: "opencode2" });
    const error = yield* Effect.flip(
      textGeneration.generateBranchName({
        cwd: "/work/project",
        message: "add opencode 2",
        modelSelection: createModelSelection(ProviderInstanceId.make("opencode"), "gpt-5.6"),
      }),
    );

    NodeAssert.equal(error._tag, "TextGenerationError");
    NodeAssert.match(error.detail, /provider\/model/);
    NodeAssert.equal(requests.length, 0);
  }).pipe(Effect.provide(testLayer({ text: JSON.stringify({ branch: "unused" }) }, requests)));
});

it.effect("passes image attachments through a temporary native session", () => {
  const requests: Array<CapturedRequest> = [];
  const response = (request: CapturedRequest) => {
    if (request.method === "POST" && request.path === "/api/session") {
      return { data: { id: "ses_generated" } };
    }
    if (request.path.endsWith("/prompt")) return { data: { id: "msg_user" } };
    if (request.path.endsWith("/wait") || request.method === "DELETE") return undefined;
    if (request.path.endsWith("/message")) {
      return {
        data: [
          {
            type: "assistant",
            content: [{ type: "text", text: JSON.stringify({ branch: "native-images" }) }],
          },
        ],
      };
    }
    NodeAssert.fail(`Unexpected request: ${request.method} ${request.path}`);
  };

  return Effect.gen(function* () {
    const textGeneration = yield* makeOpenCodeTextGeneration({ binaryPath: "opencode2" });
    const generated = yield* textGeneration.generateBranchName({
      cwd: "/work/project",
      message: "fix the layout shown here",
      attachments: [
        {
          type: "image",
          id: "thread-native-images-9a30ddad-3b87-463b-a306-2aa270f089d2",
          name: "layout.png",
          mimeType: "image/png",
          sizeBytes: 128,
        },
      ],
      modelSelection: createModelSelection(ProviderInstanceId.make("opencode"), "openai/gpt-5.6"),
    });

    NodeAssert.deepEqual(generated, { branch: "native-images" });
    NodeAssert.deepEqual(
      requests.map((request) => `${request.method} ${request.path}`),
      [
        "POST /api/session",
        "POST /api/session/ses_generated/prompt",
        "POST /api/session/ses_generated/wait",
        "GET /api/session/ses_generated/message",
        "DELETE /api/session/ses_generated",
      ],
    );
    const prompt = requests[1]?.body as {
      readonly text: string;
      readonly files: ReadonlyArray<{ readonly uri: string; readonly name: string }>;
      readonly delivery: string;
    };
    NodeAssert.equal(prompt.delivery, "steer");
    NodeAssert.equal(prompt.files[0]?.name, "layout.png");
    NodeAssert.match(prompt.files[0]?.uri ?? "", /thread-native-images-.*\.png$/u);
  }).pipe(Effect.provide(testLayer(response, requests)));
});
