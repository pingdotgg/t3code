import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { DevinCloudSettings } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  buildInitialDevinCloudProviderSnapshot,
  checkDevinCloudProviderStatus,
  devinCloudModeFromModel,
} from "./DevinCloudProvider.ts";

const decodeSettings = Schema.decodeSync(DevinCloudSettings);

const selfClient = HttpClient.make((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      Response.json({ principal_type: "service_user", org_id: "org-from-self" }),
    ),
  ),
);

const withEmptyCliDataDir = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "devin-cli-data-" });
      return yield* effect.pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ XDG_DATA_HOME: dir }))),
      );
    }),
  );

describe("DevinCloudProvider", () => {
  it.effect("reports pending credentials before the first check", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDevinCloudProviderSnapshot(
        decodeSettings({ enabled: true }),
      );
      expect(snapshot.status).toBe("warning");
      expect(snapshot.auth.status).toBe("unknown");
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "devin-normal",
        "devin-fast",
        "devin-lite",
        "devin-ultra",
        "devin-fusion",
      ]);
      expect(snapshot.models.find((model) => model.isDefault)?.slug).toBe("devin-normal");
    }),
  );

  it.effect("maps model slugs to devin_mode values", () =>
    Effect.sync(() => {
      expect(devinCloudModeFromModel("devin-normal")).toBe("normal");
      expect(devinCloudModeFromModel("devin-fast")).toBe("fast");
      expect(devinCloudModeFromModel("devin-fusion")).toBe("fusion");
      // Legacy and unknown slugs fall back to the organization default.
      expect(devinCloudModeFromModel("devin-cloud")).toBeUndefined();
      expect(devinCloudModeFromModel(undefined)).toBeUndefined();
      expect(devinCloudModeFromModel("gpt-4o")).toBeUndefined();
    }),
  );

  it.effect("asks for credentials when nothing is configured or signed in", () =>
    withEmptyCliDataDir(checkDevinCloudProviderStatus(decodeSettings({ enabled: true }))).pipe(
      Effect.provideService(HttpClient.HttpClient, selfClient),
      Effect.provide(NodeServices.layer),
      Effect.tap((snapshot) =>
        Effect.sync(() => {
          expect(snapshot.status).toBe("warning");
          expect(snapshot.auth.status).toBe("unauthenticated");
          expect(snapshot.message).toContain("sign in with the Devin CLI");
        }),
      ),
    ),
  );

  it.effect("reports a valid service-user token as connected", () =>
    checkDevinCloudProviderStatus(
      decodeSettings({ enabled: true, apiKey: "cog_test", organizationId: "org-test" }),
    ).pipe(
      Effect.provideService(HttpClient.HttpClient, selfClient),
      Effect.provide(NodeServices.layer),
      Effect.tap((snapshot) =>
        Effect.sync(() => {
          expect(snapshot.status).toBe("ready");
          expect(snapshot.auth.status).toBe("authenticated");
          expect(snapshot.message).toBe("Connected to Devin Cloud.");
        }),
      ),
    ),
  );

  it.effect("connects through the Devin CLI sign-in when settings are empty", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "devin-cli-data-" });
        yield* fs.makeDirectory(path.join(dir, "devin"), { recursive: true });
        yield* fs.writeFileString(
          path.join(dir, "devin", "credentials.toml"),
          'windsurf_api_key = "cli-key"\n',
        );
        const snapshot = yield* checkDevinCloudProviderStatus(
          decodeSettings({ enabled: true }),
        ).pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ XDG_DATA_HOME: dir }))),
        );
        expect(snapshot.status).toBe("ready");
        expect(snapshot.auth.status).toBe("authenticated");
        expect(snapshot.message).toBe("Connected to Devin Cloud using the Devin CLI sign-in.");
      }),
    ).pipe(
      Effect.provideService(HttpClient.HttpClient, selfClient),
      Effect.provide(NodeServices.layer),
    ),
  );
});
