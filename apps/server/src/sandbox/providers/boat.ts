import { type SandboxProviderInfo, SandboxProviderError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClientRequest } from "effect/http";
import * as Schema from "effect/Schema";

import {
  authorize,
  type CreatedSandbox,
  jsonBody,
  requestJson,
  type SandboxProviderDriver,
} from "../SandboxProvider.ts";

const BOAT_API_BASE = "https://boat.dev/api/v1";

const BoatSandbox = Schema.Struct({
  sandbox: Schema.Struct({
    id: Schema.String,
    name: Schema.optionalKey(Schema.String),
  }),
  hostedPorts: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        port: Schema.Number,
        url: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});

const BoatCommand = Schema.Struct({
  exitCode: Schema.NullOr(Schema.Number),
  stdout: Schema.String,
  stderr: Schema.String,
});

const BoatHostedPort = Schema.Struct({ url: Schema.String });

// Only flags, never `envContents` or `secretFiles`: those hold real credential values and must
// not leave the server that owns the provider key.
const BoatEnvironment = Schema.Struct({
  name: Schema.String,
  isDefault: Schema.Boolean,
  safeForThirdParties: Schema.Boolean,
  passGithub: Schema.Boolean,
  passSecrets: Schema.Boolean,
  passSandboxCredentials: Schema.Boolean,
  passAgentsCredentials: Schema.Boolean,
  proxyAiCredentials: Schema.Boolean,
});

const BoatEnvironments = Schema.Struct({
  environments: Schema.Array(BoatEnvironment),
});

const info = {
  kind: "boat",
  label: "Boat",
  detail: "Full Ubuntu VMs with a public HTTPS URL per port.",
  apiKeyLabel: "Boat API key",
  apiKeyPlaceholder: "boat_...",
  docsUrl: "https://docs.boat.dev/api-keys",
  sizes: [
    { id: "small", label: "Small", detail: "2 vCPU · 4 GB · 51 GB" },
    { id: "default", label: "Default", detail: "4 vCPU · 8 GB · 51 GB" },
    { id: "large", label: "Large", detail: "8 vCPU · 16 GB · 111 GB" },
    { id: "xlarge", label: "Extra large", detail: "16 vCPU · 32 GB · 251 GB" },
  ],
} satisfies Omit<SandboxProviderInfo, "configured">;

export const boatDriver: SandboxProviderDriver = {
  info,
  defaultSize: "default",
  serverPort: 3773,
  create: Effect.fn("Boat.create")(function* (input) {
    const created = yield* requestJson({
      provider: "boat",
      stage: "create",
      schema: BoatSandbox,
      request: jsonBody(
        authorize(HttpClientRequest.post(`${BOAT_API_BASE}/sandboxes`), input.config.apiKey),
        {
          name: input.name,
          type: input.size,
          // A sandbox created by T3 must never inherit the account's GitHub token,
          // secrets, or agent logins by default. Credentials are opt-in per environment.
          ...(input.environment === undefined
            ? { noEnv: true }
            : { environment: input.environment }),
          ttlSeconds: input.ttlMinutes === undefined ? 3600 : input.ttlMinutes * 60,
          hostedPorts: [{ port: 3773, public: true, title: "T3 Code" }],
        },
      ),
    });
    const url = created.hostedPorts?.find((port) => port.port === 3773)?.url;
    return {
      id: created.sandbox.id,
      name: created.sandbox.name ?? input.name,
      ...(url === undefined ? {} : { publicUrl: url }),
    } satisfies CreatedSandbox;
  }),
  listEnvironments: Effect.fn("Boat.listEnvironments")(function* (input) {
    const listed = yield* requestJson({
      provider: "boat",
      stage: "config",
      schema: BoatEnvironments,
      request: authorize(
        HttpClientRequest.get(`${BOAT_API_BASE}/environments`),
        input.config.apiKey,
      ),
    });
    return listed.environments;
  }),
  execute: (input) =>
    requestJson({
      provider: "boat",
      stage: "install",
      schema: BoatCommand,
      request: jsonBody(
        authorize(
          HttpClientRequest.post(
            `${BOAT_API_BASE}/sandboxes/${encodeURIComponent(input.sandboxId)}/commands`,
          ),
          input.config.apiKey,
        ),
        {
          command: input.command,
          timeoutSeconds: Math.min(Math.max(input.timeoutSeconds, 1), 600),
        },
      ),
    }).pipe(
      Effect.filterOrFail(
        (result) => result.exitCode === 0,
        (result) =>
          new SandboxProviderError({
            provider: "boat",
            stage: "install",
            detail:
              [result.stderr, result.stdout]
                .map((part) => part.trim())
                .filter((part) => part !== "")
                .join("\n")
                .slice(-1200) || `The command exited with ${result.exitCode}.`,
          }),
      ),
      Effect.map((result) => ({ ...result, exitCode: result.exitCode ?? 0 })),
    ),
  exposePort: (input) =>
    requestJson({
      provider: "boat",
      stage: "expose",
      schema: BoatHostedPort,
      request: jsonBody(
        authorize(
          HttpClientRequest.post(
            `${BOAT_API_BASE}/sandboxes/${encodeURIComponent(input.sandboxId)}/host`,
          ),
          input.config.apiKey,
        ),
        { port: input.port, public: true },
      ),
    }).pipe(Effect.map((result) => result.url)),
  destroy: (input) => {
    const request = HttpClientRequest.delete(
      `${BOAT_API_BASE}/sandboxes/${encodeURIComponent(input.sandboxId)}`,
    );
    return requestJson({
      provider: "boat",
      stage: "delete",
      schema: Schema.Struct({ ok: Schema.optionalKey(Schema.Boolean) }),
      request: HttpClientRequest.setHeaders(authorize(request, input.config.apiKey), {
        "X-Ascii-Confirm-Delete": input.sandboxId,
      }),
    }).pipe(Effect.asVoid);
  },
};
