import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  CODEX_TRANSCRIBE_URL,
  readCodexVoiceCredentials,
  transcribeCodexAudio,
} from "./VoiceTranscription.ts";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

it.layer(NodeServices.layer)("VoiceTranscription credentials", (it) => {
  it.effect("reads ChatGPT OAuth credentials from the selected shadow home", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sharedHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "voice-shared-" });
      const shadowHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "voice-shadow-" });
      yield* fileSystem.writeFileString(
        path.join(shadowHome, "auth.json"),
        '{"auth_mode":"chatgpt","tokens":{"access_token":"oauth-token","account_id":"account-123"}}',
      );

      const credentials = yield* readCodexVoiceCredentials(
        decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
      );

      expect(credentials).toEqual({ accessToken: "oauth-token", accountId: "account-123" });
    }),
  );

  it.effect("rejects Codex API-key auth", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "voice-api-key-" });
      yield* fileSystem.writeFileString(
        path.join(homePath, "auth.json"),
        '{"auth_mode":"apikey","OPENAI_API_KEY":"secret"}',
      );

      const error = yield* readCodexVoiceCredentials(decodeCodexSettings({ homePath })).pipe(
        Effect.flip,
      );
      expect(error._tag).toBe("EnvironmentHttpForbiddenError");
    }),
  );
});

it.effect("posts audio to the Codex app transcription endpoint with OAuth headers", () =>
  Effect.gen(function* () {
    let observed = false;
    const clientLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          observed = true;
          expect(request.url).toBe(CODEX_TRANSCRIBE_URL);
          expect(request.method).toBe("POST");
          expect(request.headers.authorization).toBe("Bearer oauth-token");
          expect(request.headers["chatgpt-account-id"]).toBe("account-123");
          expect(request.headers["x-openai-attach-auth"]).toBe("1");
          expect(request.headers["x-openai-attach-integrity-state"]).toBe("1");
          expect(request.headers["x-codex-base64"]).toBe("1");
          expect(request.headers.originator).toBe("Codex Desktop");
          expect(request.headers["user-agent"]).toContain("Chrome/136.0.0.0");
          expect(request.headers["oai-did"]).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
          );
          expect(request.headers.origin).toBe("https://chatgpt.com");
          expect(request.body._tag).toBe("FormData");
          if (request.body._tag === "FormData") {
            const file = request.body.formData.get("file");
            expect(file).toBeInstanceOf(Blob);
            expect((file as Blob).type).toBe("audio/webm");
          }
          return HttpClientResponse.fromWeb(request, Response.json({ text: "hello from voice" }));
        }),
      ),
    );

    const result = yield* transcribeCodexAudio({
      credentials: { accessToken: "oauth-token", accountId: "account-123" },
      audio: new Uint8Array([1, 2, 3]),
      mimeType: "audio/webm",
    }).pipe(Effect.provide(clientLayer));

    expect(observed).toBe(true);
    expect(result).toEqual({ text: "hello from voice" });
  }),
);
