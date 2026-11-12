import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as k2 from "@distilled.cloud/cloudflare/k2";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { waitForStreamGone } from "./k2-test-utils.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

test.provider(
  "create, update in place, and delete a stream",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Defaults: worker binding on, HTTP off, seven-day retention.
      const created = yield* stack.deploy(Cloudflare.K2.Stream("UpdateStream"));
      expect(created.streamName).toMatch(/^[a-z0-9_]+$/);
      expect(created.endpoint).toEqual(`https://${created.streamId}.k2.cloudflarestorage.com`);
      expect(created.retentionSeconds).toEqual(604_800);
      expect(created.httpEnabled).toBe(false);
      expect(created.workerBindingEnabled).toBe(true);

      const observed = yield* k2.getStream({ accountId, streamId: created.streamId });
      expect(observed.name).toEqual(created.streamName);
      expect(observed.http.enabled).toBe(false);
      expect(observed.workerBinding.enabled).toBe(true);

      // Retention, HTTP input, and worker binding are patched in place.
      const updated = yield* stack.deploy(
        Cloudflare.K2.Stream("UpdateStream", {
          retention: "1 day",
          http: { authentication: false, cors: ["https://example.com"] },
          workerBinding: false,
        }),
      );
      expect(updated.streamId).toEqual(created.streamId);
      expect(updated.retentionSeconds).toEqual(86_400);
      expect(updated.httpEnabled).toBe(true);
      expect(updated.httpAuthentication).toBe(false);
      expect(updated.corsOrigins).toEqual(["https://example.com"]);
      expect(updated.workerBindingEnabled).toBe(false);

      const patched = yield* k2.getStream({ accountId, streamId: created.streamId });
      expect(patched.retentionSeconds).toEqual(86_400);
      expect(patched.http.enabled).toBe(true);
      expect(patched.http.authentication ?? false).toBe(false);
      expect(patched.http.cors?.origins).toEqual(["https://example.com"]);
      expect(patched.workerBinding.enabled).toBe(false);

      // `http: true` turns authentication on; dropping cors clears it.
      const authenticated = yield* stack.deploy(
        Cloudflare.K2.Stream("UpdateStream", { retention: "1 day", http: true }),
      );
      expect(authenticated.streamId).toEqual(created.streamId);
      expect(authenticated.httpAuthentication).toBe(true);
      expect(authenticated.corsOrigins ?? []).toEqual([]);
      expect(authenticated.workerBindingEnabled).toBe(true);

      // The provider lists the deployed stream in the read Attributes shape.
      const provider = yield* Provider.findProvider(Cloudflare.K2.Stream);
      const all = yield* provider.list();
      const listed = all.find((s) => s.streamId === created.streamId);
      expect(listed?.streamName).toEqual(created.streamName);
      expect(listed?.httpAuthentication).toBe(true);

      yield* stack.destroy();
      yield* waitForStreamGone(accountId, created.streamId);
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:k2", "live"], timeout: 120_000 },
);

test.provider(
  "renaming a stream replaces it",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const first = yield* stack.deploy(
        Cloudflare.K2.Stream("RenamedStream", { name: "alchemy_k2_test_rename_a" }),
      );
      expect(first.streamName).toEqual("alchemy_k2_test_rename_a");

      const second = yield* stack.deploy(
        Cloudflare.K2.Stream("RenamedStream", { name: "alchemy_k2_test_rename_b" }),
      );
      expect(second.streamName).toEqual("alchemy_k2_test_rename_b");
      expect(second.streamId).not.toEqual(first.streamId);

      // The old generation is deleted after the replacement.
      yield* waitForStreamGone(accountId, first.streamId);
      const observed = yield* k2.getStream({ accountId, streamId: second.streamId });
      expect(observed.name).toEqual("alchemy_k2_test_rename_b");

      yield* stack.destroy();
      yield* waitForStreamGone(accountId, second.streamId);
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:k2", "live"], timeout: 120_000 },
);
