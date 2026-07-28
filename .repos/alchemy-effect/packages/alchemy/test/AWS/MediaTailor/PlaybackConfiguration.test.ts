import * as AWS from "@/AWS";
import { PlaybackConfiguration } from "@/AWS/MediaTailor";
import * as Test from "@/Test/Alchemy";
import * as mediatailor from "@distilled.cloud/aws/mediatailor";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const findConfiguration = (name: string) =>
  mediatailor.getPlaybackConfiguration({ Name: name }).pipe(
    Effect.map(
      (config): mediatailor.GetPlaybackConfigurationResponse | undefined =>
        config,
    ),
    Effect.catchTag("PlaybackConfigurationNotFound", () =>
      Effect.succeed(undefined),
    ),
  );

class ConfigurationStillExists extends Data.TaggedError(
  "ConfigurationStillExists",
)<{ readonly name: string }> {}

const assertConfigurationDeleted = (name: string) =>
  findConfiguration(name).pipe(
    Effect.flatMap((config) =>
      config === undefined
        ? Effect.void
        : Effect.fail(new ConfigurationStillExists({ name })),
    ),
    Effect.retry({
      while: (e) => e._tag === "ConfigurationStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

// Ungated typed-error probe: prove the distilled synthetic tag
// (patches/mediatailor.json) carves PlaybackConfigurationNotFound out of the
// unmodeled wire NotFoundException. Runs in every CI pass at near-zero cost.
test.provider(
  "getPlaybackConfiguration on a nonexistent name fails with PlaybackConfigurationNotFound",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        mediatailor.getPlaybackConfiguration({
          Name: "alchemy-nonexistent-playback-config-probe",
        }),
      );
      expect(error._tag).toBe("PlaybackConfigurationNotFound");
    }),
);

test.provider(
  "create, update, and delete a playback configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const config = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* PlaybackConfiguration("TestConfig", {
            adDecisionServerUrl: "https://ads.example.com/vast?ip=[client_ip]",
            videoContentSourceUrl: "https://origin.example.com/live",
            slateAdUrl: "https://origin.example.com/slate.mp4",
            tags: { Environment: "test" },
          });
        }),
      );

      expect(config.name).toBeDefined();
      expect(config.playbackConfigurationArn).toContain(
        ":playbackConfiguration/",
      );
      expect(config.playbackEndpointPrefix).toContain("mediatailor");
      expect(config.sessionInitializationEndpointPrefix).toContain(
        "mediatailor",
      );

      // out-of-band verification via distilled
      const created = yield* findConfiguration(config.name);
      expect(created?.AdDecisionServerUrl).toBe(
        "https://ads.example.com/vast?ip=[client_ip]",
      );
      expect(created?.VideoContentSourceUrl).toBe(
        "https://origin.example.com/live",
      );
      expect(created?.SlateAdUrl).toBe("https://origin.example.com/slate.mp4");
      expect(created?.Tags?.Environment).toBe("test");
      expect(created?.Tags?.["alchemy::id"]).toBe("TestConfig");

      // update: change the ADS URL, drop the slate, add manifest rules and
      // avail suppression, swap the user tag
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* PlaybackConfiguration("TestConfig", {
            adDecisionServerUrl: "https://ads.example.com/vast/v2",
            videoContentSourceUrl: "https://origin.example.com/live",
            personalizationThreshold: "2 seconds",
            manifestProcessingRules: { adMarkerPassthroughEnabled: true },
            availSuppression: { mode: "BEHIND_LIVE_EDGE", value: "00:00:30" },
            logConfiguration: { percentEnabled: 10 },
            tags: { Purpose: "alchemy-live-test" },
          });
        }),
      );
      expect(updated.name).toBe(config.name);
      expect(updated.playbackConfigurationArn).toBe(
        config.playbackConfigurationArn,
      );

      const afterUpdate = yield* findConfiguration(config.name);
      expect(afterUpdate?.AdDecisionServerUrl).toBe(
        "https://ads.example.com/vast/v2",
      );
      // the put is a full replace — the removed slate URL must be cleared
      expect(afterUpdate?.SlateAdUrl ?? undefined).toBeUndefined();
      expect(afterUpdate?.PersonalizationThresholdSeconds).toBe(2);
      expect(
        afterUpdate?.ManifestProcessingRules?.AdMarkerPassthrough?.Enabled,
      ).toBe(true);
      expect(afterUpdate?.AvailSuppression?.Mode).toBe("BEHIND_LIVE_EDGE");
      expect(afterUpdate?.AvailSuppression?.Value).toBe("00:00:30");
      // log sync: ConfigureLogsForPlaybackConfiguration applied the percent
      expect(afterUpdate?.LogConfiguration?.PercentEnabled).toBe(10);
      // tag sync: new tag present, old user tag removed, branding intact
      expect(afterUpdate?.Tags?.Purpose).toBe("alchemy-live-test");
      expect(afterUpdate?.Tags?.Environment ?? undefined).toBeUndefined();
      expect(afterUpdate?.Tags?.["alchemy::id"]).toBe("TestConfig");

      yield* stack.destroy();
      yield* assertConfigurationDeleted(config.name);
    }),
  { timeout: 120_000 },
);

test.provider(
  "custom name and replacement on rename",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* PlaybackConfiguration("NamedConfig", {
            name: "alchemy-test-playback-config-a",
            adDecisionServerUrl: "https://ads.example.com/vast",
            videoContentSourceUrl: "https://origin.example.com/vod",
          });
        }),
      );
      expect(first.name).toBe("alchemy-test-playback-config-a");

      // renaming replaces the configuration
      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* PlaybackConfiguration("NamedConfig", {
            name: "alchemy-test-playback-config-b",
            adDecisionServerUrl: "https://ads.example.com/vast",
            videoContentSourceUrl: "https://origin.example.com/vod",
          });
        }),
      );
      expect(second.name).toBe("alchemy-test-playback-config-b");
      expect(second.playbackConfigurationArn).not.toBe(
        first.playbackConfigurationArn,
      );

      // the replaced configuration is deleted after the new one is live
      yield* assertConfigurationDeleted("alchemy-test-playback-config-a");
      const replacement = yield* findConfiguration(
        "alchemy-test-playback-config-b",
      );
      expect(replacement?.PlaybackConfigurationArn).toBe(
        second.playbackConfigurationArn,
      );

      yield* stack.destroy();
      yield* assertConfigurationDeleted("alchemy-test-playback-config-b");
    }),
  { timeout: 120_000 },
);
