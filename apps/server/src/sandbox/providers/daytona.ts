import { type SandboxProviderInfo, SandboxProviderError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { HttpClientRequest } from "effect/http";
import * as Schema from "effect/Schema";

import {
  authorize,
  type CreatedSandbox,
  jsonBody,
  requestJson,
  type SandboxProviderDriver,
} from "../SandboxProvider.ts";

const DAYTONA_API_BASE = "https://app.daytona.io/api";
const POLL_INTERVAL = "2 seconds";
const POLL_ATTEMPTS = 90;

const DaytonaSandbox = Schema.Struct({
  id: Schema.String,
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  state: Schema.String,
  errorReason: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const DaytonaToolboxProxy = Schema.Struct({ url: Schema.String });

const DaytonaPreviewUrl = Schema.Struct({ url: Schema.String });

const DaytonaExecResult = Schema.Struct({
  exitCode: Schema.optionalKey(Schema.Number),
  result: Schema.String,
});

const info = {
  kind: "daytona",
  label: "Daytona",
  detail: "Fast Linux sandboxes with preview URLs for every port.",
  apiKeyLabel: "Daytona API key",
  apiKeyPlaceholder: "dtn_...",
  docsUrl: "https://www.daytona.io/docs/en/api-keys",
  sizes: [
    { id: "daytona-small", label: "Small", detail: "1 vCPU · 1 GB · 3 GB" },
    { id: "daytona-medium", label: "Medium", detail: "2 vCPU · 4 GB · 8 GB" },
    { id: "daytona-large", label: "Large", detail: "4 vCPU · 8 GB · 10 GB" },
  ],
} satisfies Omit<SandboxProviderInfo, "configured">;

const getSandbox = (apiKey: string, sandboxId: string) =>
  requestJson({
    provider: "daytona",
    stage: "start",
    schema: DaytonaSandbox,
    request: authorize(
      HttpClientRequest.get(`${DAYTONA_API_BASE}/sandbox/${encodeURIComponent(sandboxId)}`),
      apiKey,
    ),
  });

const waitUntilStarted = Effect.fn("Daytona.waitUntilStarted")(function* (
  apiKey: string,
  sandboxId: string,
) {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    const sandbox = yield* getSandbox(apiKey, sandboxId);
    if (sandbox.state === "started") return sandbox;
    if (sandbox.state === "error" || sandbox.state === "build_failed") {
      return yield* new SandboxProviderError({
        provider: "daytona",
        stage: "start",
        detail: `The sandbox entered the ${sandbox.state} state while starting.`,
        ...(sandbox.errorReason === undefined || sandbox.errorReason === null
          ? {}
          : { cause: new Error(sandbox.errorReason) }),
      });
    }
    if (attempt < POLL_ATTEMPTS - 1) yield* Effect.sleep(POLL_INTERVAL);
  }
  return yield* new SandboxProviderError({
    provider: "daytona",
    stage: "start",
    detail: "Timed out waiting for the sandbox to start.",
  });
});

const toolboxBaseUrl = (apiKey: string, sandboxId: string) =>
  requestJson({
    provider: "daytona",
    stage: "install",
    schema: DaytonaToolboxProxy,
    request: authorize(
      HttpClientRequest.get(
        `${DAYTONA_API_BASE}/sandbox/${encodeURIComponent(sandboxId)}/toolbox-proxy-url`,
      ),
      apiKey,
    ),
  }).pipe(Effect.map((proxy) => `${proxy.url.replace(/\/+$/, "")}/${sandboxId}`));

export const daytonaDriver: SandboxProviderDriver = {
  info,
  defaultSize: "daytona-medium",
  serverPort: 3773,
  create: (input) =>
    requestJson({
      provider: "daytona",
      stage: "create",
      schema: DaytonaSandbox,
      request: jsonBody(
        authorize(HttpClientRequest.post(`${DAYTONA_API_BASE}/sandbox`), input.config.apiKey),
        {
          name: input.name,
          snapshot: input.size,
          public: true,
          autoStopInterval: 0,
          autoDeleteInterval: -1,
          ...(input.ttlMinutes === undefined ? {} : { ttlMinutes: input.ttlMinutes }),
          labels: { "t3.code/role": "environment" },
        },
      ),
    }).pipe(
      Effect.flatMap((sandbox) =>
        // Daytona is created with auto-stop and auto-delete disabled, so a machine that never
        // finishes starting would bill forever if the provisioner never learned its id.
        waitUntilStarted(input.config.apiKey, sandbox.id).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : daytonaDriver
                  .destroy({ config: input.config, sandboxId: sandbox.id })
                  .pipe(Effect.ignore),
          ),
        ),
      ),
      Effect.map((sandbox): CreatedSandbox => ({
        id: sandbox.id,
        name: sandbox.name ?? input.name,
      })),
    ),
  execute: Effect.fn("Daytona.execute")(function* (input) {
    const baseUrl = yield* toolboxBaseUrl(input.config.apiKey, input.sandboxId);
    const result = yield* requestJson({
      provider: "daytona",
      stage: "install",
      schema: DaytonaExecResult,
      request: jsonBody(
        authorize(HttpClientRequest.post(`${baseUrl}/process/execute`), input.config.apiKey),
        {
          command: input.command,
          timeout: Math.min(Math.max(input.timeoutSeconds, 1), 600),
        },
      ),
    });
    const exitCode = result.exitCode ?? 0;
    if (exitCode !== 0) {
      return yield* new SandboxProviderError({
        provider: "daytona",
        stage: "install",
        // Only the exit status is an attribute; command output can contain secrets.
        detail: `The command exited with ${exitCode}.`,
        cause: new Error(result.result.trim().slice(-4000)),
      });
    }
    return { exitCode, stdout: result.result, stderr: "" };
  }),
  exposePort: (input) =>
    requestJson({
      provider: "daytona",
      stage: "expose",
      schema: DaytonaPreviewUrl,
      request: authorize(
        HttpClientRequest.get(
          `${DAYTONA_API_BASE}/sandbox/${encodeURIComponent(input.sandboxId)}/ports/${input.port}/preview-url`,
        ),
        input.config.apiKey,
      ),
    }).pipe(Effect.map((preview) => preview.url)),
  destroy: (input) =>
    requestJson({
      provider: "daytona",
      stage: "delete",
      schema: Schema.Struct({ id: Schema.optionalKey(Schema.String) }),
      request: authorize(
        HttpClientRequest.delete(
          `${DAYTONA_API_BASE}/sandbox/${encodeURIComponent(input.sandboxId)}`,
        ),
        input.config.apiKey,
      ),
    }).pipe(Effect.asVoid),
};
