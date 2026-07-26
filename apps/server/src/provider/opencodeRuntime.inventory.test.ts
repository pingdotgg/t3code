import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import type { OpencodeClient, ProviderListResponse } from "@opencode-ai/sdk/v2";
import * as Effect from "effect/Effect";

import { loadOpenCodeInventoryFromClient } from "./opencodeRuntime.ts";

const providerList: ProviderListResponse = {
  all: [],
  connected: [],
  default: {},
};

it.effect("keeps core inventory when optional command and skill discovery fail", () =>
  Effect.gen(function* () {
    const client = {
      provider: {
        list: async () => ({ data: providerList }),
      },
      app: {
        agents: async () => ({ data: [] }),
        skills: async () => {
          throw new Error("skills unavailable");
        },
      },
      command: {
        list: async () => {
          throw new Error("commands unavailable");
        },
      },
    } as unknown as OpencodeClient;

    const inventory = yield* loadOpenCodeInventoryFromClient(client);

    NodeAssert.deepEqual(inventory.providerList, providerList);
    NodeAssert.deepEqual(inventory.agents, []);
    NodeAssert.deepEqual(inventory.commands, []);
    NodeAssert.deepEqual(inventory.skills, []);
  }),
);
