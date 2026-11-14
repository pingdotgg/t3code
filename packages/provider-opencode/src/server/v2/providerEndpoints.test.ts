import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type * as OpenCode2Server from "./OpenCode2Server.ts";
import { readProviderEndpoints } from "./providerEndpoints.ts";

interface ProviderEntry {
  readonly id: string;
  readonly integrationID?: string;
  readonly baseURL?: string;
}

interface ModelEntry {
  readonly providerID: string;
  readonly baseURL?: string;
}

/** The provider list OpenCode answers with, with its resolved settings. */
const providerEntry = ({ id, integrationID, baseURL }: ProviderEntry) => ({
  id,
  ...(integrationID === undefined ? {} : { integrationID }),
  ...(baseURL === undefined ? {} : { settings: { baseURL } }),
});

/** The model list OpenCode answers with, with its resolved settings. */
const modelEntry = ({ providerID, baseURL }: ModelEntry) => ({
  providerID,
  ...(baseURL === undefined ? {} : { settings: { baseURL } }),
});

const connectionWith = (providers: readonly ProviderEntry[], models: readonly ModelEntry[] = []) =>
  ({
    client: {
      provider: {
        list: () => Effect.succeed({ data: providers.map(providerEntry) }),
      },
      model: {
        list: () => Effect.succeed({ data: models.map(modelEntry) }),
      },
    },
  }) as unknown as OpenCode2Server.OpenCode2Connection;

describe("readProviderEndpoints", () => {
  it.effect("names the endpoint of every provider and of its integration", () =>
    Effect.gen(function* () {
      const endpoints = yield* readProviderEndpoints(
        connectionWith([
          { id: "minimax-coding-plan", integrationID: "minimax-coding-plan" },
          { id: "opencode", integrationID: "opencode", baseURL: "https://opencode.ai/console" },
        ]),
        "/work",
      );
      assert.strictEqual(endpoints.get("minimax-coding-plan"), undefined);
      assert.strictEqual(endpoints.get("opencode"), "https://opencode.ai/console");
    }),
  );

  it.effect("leaves an integration unknown when its providers disagree", () =>
    Effect.gen(function* () {
      const endpoints = yield* readProviderEndpoints(
        connectionWith([
          {
            id: "minimax-coding-plan",
            integrationID: "minimax-coding-plan",
            baseURL: "https://api.minimax.io/anthropic/v1",
          },
          {
            id: "minimax-gateway",
            integrationID: "minimax-coding-plan",
            baseURL: "https://gateway.example/v1",
          },
        ]),
        "/work",
      );
      // The probe must not pick one of the two endpoints.
      assert.strictEqual(endpoints.get("minimax-coding-plan"), undefined);
      assert.strictEqual(endpoints.get("minimax-gateway"), "https://gateway.example/v1");
    }),
  );

  it.effect("leaves an integration unknown when one of its providers has no endpoint", () =>
    Effect.gen(function* () {
      const endpoints = yield* readProviderEndpoints(
        connectionWith([
          {
            id: "minimax-coding-plan",
            integrationID: "minimax-coding-plan",
            baseURL: "https://api.minimax.io/anthropic/v1",
          },
          { id: "minimax-gateway", integrationID: "minimax-coding-plan" },
        ]),
        "/work",
      );
      assert.strictEqual(endpoints.get("minimax-coding-plan"), undefined);
    }),
  );

  it.effect("leaves a provider unknown when one of its models resolves elsewhere", () =>
    Effect.gen(function* () {
      const endpoints = yield* readProviderEndpoints(
        connectionWith(
          [
            {
              id: "minimax-coding-plan",
              integrationID: "minimax-coding-plan",
              baseURL: "https://api.minimax.io/anthropic/v1",
            },
          ],
          [{ providerID: "minimax-coding-plan", baseURL: "https://gateway.example/v1" }],
        ),
        "/work",
      );
      assert.strictEqual(endpoints.get("minimax-coding-plan"), undefined);
    }),
  );

  it.effect("keeps an endpoint when its providers and models agree", () =>
    Effect.gen(function* () {
      const endpoints = yield* readProviderEndpoints(
        connectionWith(
          [
            {
              id: "minimax-coding-plan",
              integrationID: "minimax-coding-plan",
              baseURL: "https://api.minimax.io/anthropic/v1",
            },
            {
              id: "minimax-coding-plan-eu",
              integrationID: "minimax-coding-plan",
              baseURL: "https://api.minimax.io/anthropic/v1",
            },
          ],
          [{ providerID: "minimax-coding-plan", baseURL: "https://api.minimax.io/anthropic/v1" }],
        ),
        "/work",
      );
      assert.strictEqual(
        endpoints.get("minimax-coding-plan"),
        "https://api.minimax.io/anthropic/v1",
      );
    }),
  );

  it.effect("returns no endpoints when the provider list cannot be read", () =>
    Effect.gen(function* () {
      const endpoints = yield* readProviderEndpoints(
        {
          client: {
            provider: {
              list: () => Effect.die("no server"),
            },
            model: {
              list: () => Effect.succeed({ data: [] }),
            },
          },
        } as unknown as OpenCode2Server.OpenCode2Connection,
        "/work",
      );
      assert.strictEqual(endpoints.size, 0);
    }),
  );
});
