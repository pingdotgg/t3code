import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { DevinCloudSettings } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { parseDevinCliApiKey, resolveDevinCloudCredentials } from "./DevinCloudCredentials.ts";

const decodeSettings = Schema.decodeSync(DevinCloudSettings);

const deadClient = HttpClient.make(() =>
  Effect.die("Credential resolution should not call the Devin API in this test"),
);

const makeCliDataDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "devin-cli-data-" });
  return { fs, path, dir };
});

describe("DevinCloudCredentials", () => {
  it("parses the CLI credential file", () => {
    expect(
      Option.getOrNull(
        parseDevinCliApiKey('windsurf_api_key = "cli-key-123"\napi_server_url = "https://x"\n'),
      ),
    ).toBe("cli-key-123");
    expect(Option.isNone(parseDevinCliApiKey('api_server_url = "https://x"\n'))).toBe(true);
  });

  it.effect("prefers explicit settings without touching the CLI or the network", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveDevinCloudCredentials(
        decodeSettings({ apiKey: "cog_explicit", organizationId: "org-explicit" }),
      ).pipe(Effect.provideService(HttpClient.HttpClient, deadClient));
      expect(Option.isSome(resolved)).toBe(true);
      if (Option.isSome(resolved)) {
        expect(resolved.value.source).toBe("settings");
        expect(resolved.value.settings.apiKey).toBe("cog_explicit");
        expect(resolved.value.settings.organizationId).toBe("org-explicit");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("falls back to the Devin CLI sign-in and resolves the organization", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, path, dir } = yield* makeCliDataDir;
        yield* fs.makeDirectory(path.join(dir, "devin"), { recursive: true });
        yield* fs.writeFileString(
          path.join(dir, "devin", "credentials.toml"),
          'windsurf_api_key = "cli-key"\ndevin_api_url = "https://api.devin.ai"\n',
        );
        const requests: HttpClientRequest.HttpClientRequest[] = [];
        const client = HttpClient.make((request) => {
          requests.push(request);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ principal_type: "user", org_id: "org-from-self" }),
            ),
          );
        });
        const resolved = yield* resolveDevinCloudCredentials(decodeSettings({})).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ XDG_DATA_HOME: dir }))),
        );
        expect(Option.isSome(resolved)).toBe(true);
        if (Option.isSome(resolved)) {
          expect(resolved.value.source).toBe("devin-cli");
          expect(resolved.value.settings.apiKey).toBe("cli-key");
          expect(resolved.value.settings.organizationId).toBe("org-from-self");
        }
        expect(requests.map((request) => request.url)).toEqual(["https://api.devin.ai/v3/self"]);
        expect(requests[0]?.headers.authorization).toBe("Bearer cli-key");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("returns none when nothing is configured or signed in", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { dir } = yield* makeCliDataDir;
        const resolved = yield* resolveDevinCloudCredentials(decodeSettings({})).pipe(
          Effect.provideService(HttpClient.HttpClient, deadClient),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ XDG_DATA_HOME: dir }))),
        );
        expect(Option.isNone(resolved)).toBe(true);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
