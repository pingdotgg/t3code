import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { AetherSettings } from "@t3tools/contracts";

import {
  AETHER_API_KEY_ENV_VAR,
  aetherModels,
  checkAetherProviderStatus,
  makePendingAetherProvider,
} from "./AetherProvider.ts";

const decodeAetherSettings = Schema.decodeSync(AetherSettings);

const enabledSettings = decodeAetherSettings({});
const keyedEnvironment: NodeJS.ProcessEnv = { [AETHER_API_KEY_ENV_VAR]: "test-key" };

const respondingClient = (handler: (request: HttpClientRequest.HttpClientRequest) => Response) =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))),
  );

const failingClient = () =>
  HttpClient.make((request) =>
    Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({
          request,
          cause: new Error("connection refused"),
        }),
      }),
    ),
  );

describe("aetherModels", () => {
  it("appends custom models to the vendored catalog with empty capabilities", () => {
    const models = aetherModels(decodeAetherSettings({ customModels: ["codex/gpt-6-preview"] }));
    const custom = models.find((model) => model.slug === "codex/gpt-6-preview");
    expect(custom).toEqual({
      slug: "codex/gpt-6-preview",
      name: "codex/gpt-6-preview",
      isCustom: true,
      capabilities: { optionDescriptors: [] },
    });
    // The vendored catalog still leads the list, with its default intact.
    expect(models.filter((model) => model.isDefault)).toHaveLength(1);
  });

  it("offers no reasoning-effort descriptor for claude-haiku-4-5 (in no effort group)", () => {
    const haiku = aetherModels(enabledSettings).find(
      (model) => model.slug === "claude-code/claude-haiku-4-5",
    );
    expect(haiku).toBeDefined();
    expect(haiku?.capabilities).toEqual({ optionDescriptors: [] });
  });
});

describe("makePendingAetherProvider", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* makePendingAetherProvider(decodeAetherSettings({ enabled: false }));
      expect(snapshot.enabled).toBe(false);
      // Cloud API: no binary, installed is unconditionally true.
      expect(snapshot.installed).toBe(true);
      expect(snapshot.message).toContain("disabled");
      expect(snapshot.availability).toBeUndefined();
    }),
  );

  it.effect("returns a pending snapshot carrying the vendored catalog by default", () =>
    Effect.gen(function* () {
      const snapshot = yield* makePendingAetherProvider(enabledSettings);
      // T6 flipped the preview gate: the turn protocol is real, so a healthy
      // instance is selectable end to end (no availability stamp).
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.availability).toBeUndefined();
      expect(snapshot.unavailableReason).toBeUndefined();
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("not been checked");
      expect(snapshot.models.length).toBeGreaterThan(0);
    }),
  );
});

describe("checkAetherProviderStatus", () => {
  it.effect("reports disabled without touching the network", () =>
    Effect.gen(function* () {
      // A failing client proves the disabled branch never issues a request.
      const snapshot = yield* checkAetherProviderStatus(
        decodeAetherSettings({ enabled: false }),
        keyedEnvironment,
      ).pipe(Effect.provideService(HttpClient.HttpClient, failingClient()));
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("reports unauthenticated with a clear reason when no key is configured", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAetherProviderStatus(enabledSettings, {}).pipe(
        Effect.provideService(HttpClient.HttpClient, failingClient()),
      );
      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toContain(AETHER_API_KEY_ENV_VAR);
    }),
  );

  it.effect("treats a blank key as missing", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAetherProviderStatus(enabledSettings, {
        [AETHER_API_KEY_ENV_VAR]: "   ",
      }).pipe(Effect.provideService(HttpClient.HttpClient, failingClient()));
      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unauthenticated");
    }),
  );

  it.effect("reports an invalid key on 401", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAetherProviderStatus(enabledSettings, keyedEnvironment).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          respondingClient(() => new Response(null, { status: 401 })),
        ),
      );
      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toContain("Invalid Aether API key");
    }),
  );

  it.effect("reports the HTTP status on any other non-2xx response", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAetherProviderStatus(enabledSettings, keyedEnvironment).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          respondingClient(() => new Response(null, { status: 503 })),
        ),
      );
      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unknown");
      expect(snapshot.message).toContain("HTTP 503");
    }),
  );

  it.effect("reports unreachable on transport failure", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAetherProviderStatus(enabledSettings, keyedEnvironment).pipe(
        Effect.provideService(HttpClient.HttpClient, failingClient()),
      );
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("Couldn't reach the Aether API");
    }),
  );

  it.effect("reports an unexpected payload when /profile is not JSON", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAetherProviderStatus(enabledSettings, keyedEnvironment).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          respondingClient(() => new Response("not json", { status: 200 })),
        ),
      );
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("unexpected /profile payload");
    }),
  );

  it.effect("times out a 2xx response whose BODY never arrives", () =>
    Effect.gen(function* () {
      // The probe deadline covered only `client.execute`, so a /profile that
      // answered with 2xx headers and then stalled mid-body hung forever and
      // never produced the error draft it promises.
      const probe = yield* Effect.forkChild(
        checkAetherProviderStatus(enabledSettings, keyedEnvironment).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            respondingClient(
              () =>
                new Response(new ReadableStream({ start: () => {} }), {
                  status: 200,
                  headers: { "content-type": "application/json" },
                }),
            ),
          ),
        ),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");
      const snapshot = yield* Fiber.join(probe);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("Couldn't reach the Aether API");
    }),
  );

  it.effect("reports ready with the account email on a healthy probe", () =>
    Effect.gen(function* () {
      let seen: HttpClientRequest.HttpClientRequest | undefined;
      const snapshot = yield* checkAetherProviderStatus(
        decodeAetherSettings({ apiBaseUrl: "https://api.example.test/" }),
        keyedEnvironment,
      ).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          respondingClient((request) => {
            seen = request;
            return Response.json({ email: "dev@example.test" });
          }),
        ),
      );
      expect(seen?.url).toBe("https://api.example.test/profile");
      expect(seen?.headers["authorization"]).toBe("Bearer test-key");
      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "aether",
        email: "dev@example.test",
      });
      expect(snapshot.message).toBe("Connected to Aether as dev@example.test.");
      // UN-gated shape (T6): a healthy probe is ready, authenticated and
      // picker-eligible — no availability stamp, enabled+installed true.
      expect(snapshot.status).toBe("ready");
      expect(snapshot.availability).toBeUndefined();
      expect(snapshot.unavailableReason).toBeUndefined();
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
    }),
  );

  it.effect("reports ready without an email when the profile omits it", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAetherProviderStatus(enabledSettings, keyedEnvironment).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          respondingClient(() => Response.json({})),
        ),
      );
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth).toEqual({ status: "authenticated", type: "aether" });
      expect(snapshot.message).toBe("Connected to Aether.");
    }),
  );
});
