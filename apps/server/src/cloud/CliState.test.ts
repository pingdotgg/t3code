import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import * as CliState from "./CliState.ts";
import {
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  CLOUD_LINKED_USER_ID,
  CLOUD_MINT_PUBLIC_KEY,
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "./config.ts";

const persistedCloudLinkSecrets = [
  CLOUD_LINKED_USER_ID,
  RELAY_URL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  CLOUD_MINT_PUBLIC_KEY,
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  PUBLISH_AGENT_ACTIVITY_SECRET,
] as const;

const makeTestLayer = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-cloud-cli-state-test-",
      }),
    ),
  );

it.layer(NodeServices.layer)("CliState", (it) => {
  it.effect("persists desired exposure and clears provisioned relay state", () =>
    Effect.gen(function* () {
      const secrets = yield* ServerSecretStore.ServerSecretStore;

      expect(yield* CliState.readCliDesiredCloudLink).toBe(false);
      yield* CliState.setCliDesiredCloudLink(true);
      expect(yield* CliState.readCliDesiredCloudLink).toBe(true);

      for (const name of persistedCloudLinkSecrets) {
        yield* secrets.set(name, new TextEncoder().encode(name));
      }
      yield* CliState.clearPersistedCloudLink;

      expect(yield* CliState.readCliDesiredCloudLink).toBe(false);
      for (const name of persistedCloudLinkSecrets) {
        expect(yield* secrets.get(name)).toBe(null);
      }
    }).pipe(Effect.provide(makeTestLayer())),
  );
});
