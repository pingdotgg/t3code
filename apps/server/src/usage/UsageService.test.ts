import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  ProviderInstanceEnvironmentVariableName,
  ProviderInstanceId,
  type UsageDay,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageService from "./UsageService.ts";

const summaryInput = {
  sinceDay: "2026-08-01" as UsageDay,
  untilDay: "2026-08-20" as UsageDay,
  timeZone: "UTC",
} as const;

it.layer(NodeServices.layer)("UsageService", (it) => {
  it.effect("omits disabled providers from usage summaries", () =>
    Effect.gen(function* () {
      const usage = yield* UsageService.UsageService;
      const summary = yield* usage.readSummary(summaryInput);

      const providers = summary.sources.map((source) => source.fingerprint.provider);
      expect(providers).toEqual(["codex"]);
    }).pipe(
      Effect.provide(
        UsageService.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              ServerSettings.ServerSettingsService.layerTest({
                providerInstances: {
                  [ProviderInstanceId.make("claudeAgent")]: {
                    driver: ProviderDriverKind.make("claudeAgent"),
                    enabled: false,
                    config: {},
                  },
                },
              }),
              ServerConfig.layerTest(process.cwd(), { prefix: "t3-usage-test-" }),
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make(() => Effect.die("unexpected usage pricing request")),
              ),
            ),
          ),
        ),
      ),
    ),
  );

  it.effect("scans the homes of enabled provider instances", () =>
    Effect.gen(function* () {
      const usage = yield* UsageService.UsageService;
      const summary = yield* usage.readSummary(summaryInput);

      expect(
        summary.sources.map((source) => ({
          provider: source.fingerprint.provider,
          resolvedHomePath: source.fingerprint.resolvedHomePath,
        })),
      ).toEqual([
        {
          provider: "codex",
          resolvedHomePath: "/virtual/codex-work/sessions",
        },
      ]);
    }).pipe(
      Effect.provide(
        UsageService.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              ServerSettings.ServerSettingsService.layerTest({
                providerInstances: {
                  [ProviderInstanceId.make("claudeAgent")]: {
                    driver: ProviderDriverKind.make("claudeAgent"),
                    enabled: false,
                    config: {},
                  },
                  [ProviderInstanceId.make("codex")]: {
                    driver: ProviderDriverKind.make("codex"),
                    enabled: false,
                    config: {},
                  },
                  [ProviderInstanceId.make("codex-work")]: {
                    driver: ProviderDriverKind.make("codex"),
                    enabled: true,
                    config: {},
                    environment: [
                      {
                        name: ProviderInstanceEnvironmentVariableName.make("CODEX_HOME"),
                        value: "/virtual/codex-work",
                        sensitive: false,
                      },
                    ],
                  },
                  [ProviderInstanceId.make("codex-work-copy")]: {
                    driver: ProviderDriverKind.make("codex"),
                    enabled: true,
                    config: {},
                    environment: [
                      {
                        name: ProviderInstanceEnvironmentVariableName.make("CODEX_HOME"),
                        value: "/virtual/codex-work",
                        sensitive: false,
                      },
                    ],
                  },
                },
              }),
              ServerConfig.layerTest(process.cwd(), { prefix: "t3-usage-test-" }),
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make(() => Effect.die("unexpected usage pricing request")),
              ),
            ),
          ),
        ),
      ),
    ),
  );

  it.effect("uses driver defaults when an enabled instance omits config", () =>
    Effect.gen(function* () {
      const usage = yield* UsageService.UsageService;
      const summary = yield* usage.readSummary(summaryInput);

      expect(summary.sources.map((source) => source.fingerprint.provider)).toEqual(["codex"]);
    }).pipe(
      Effect.provide(
        UsageService.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              ServerSettings.ServerSettingsService.layerTest({
                providerInstances: {
                  [ProviderInstanceId.make("claudeAgent")]: {
                    driver: ProviderDriverKind.make("claudeAgent"),
                    enabled: false,
                    config: {},
                  },
                  [ProviderInstanceId.make("codex")]: {
                    driver: ProviderDriverKind.make("codex"),
                    enabled: false,
                    config: {},
                  },
                  [ProviderInstanceId.make("codex-work")]: {
                    driver: ProviderDriverKind.make("codex"),
                    enabled: true,
                  },
                },
              }),
              ServerConfig.layerTest(process.cwd(), { prefix: "t3-usage-test-" }),
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make(() => Effect.die("unexpected usage pricing request")),
              ),
            ),
          ),
        ),
      ),
    ),
  );
});
