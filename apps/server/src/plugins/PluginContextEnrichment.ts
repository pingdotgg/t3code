// Pin each run’s enrichment to enabled, consented registrations; revocation must never redirect an in-flight call.
// Convert failures into recorded skipped outcomes so provider startup can continue.
import {
  type EnvironmentId,
  PLUGIN_ENRICH_HANDLER,
  PLUGIN_ENRICH_LIMITS,
  PLUGIN_TRANSFORMS_CAPABILITY,
  PluginEnrichInput,
  PluginEnrichResult,
  type PluginInstallationId,
  pluginInstallationStatus,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import {
  RunContextEnricherV2,
  type RunContextOutcome,
} from "../orchestration-v2/RunContextEnrichment.ts";
import { PluginCatalog } from "./PluginCatalog.ts";
import { jsonBytes } from "./pluginToolDeclarations.ts";

const encodeInput = Schema.encodeSync(PluginEnrichInput);
const decodeResult = Schema.decodeUnknownExit(PluginEnrichResult);

// Reasons travel with the thread's snapshots, like the context itself.
const MAX_REASON_LENGTH = 300;

const errorMessage = (cause: Cause.Cause<{ readonly message: string }>) =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => "unknown error",
    onSome: (error) => error.message,
  });

const skipped = (reason: string): RunContextOutcome => ({
  _tag: "skipped",
  reason: reason.length > MAX_REASON_LENGTH ? `${reason.slice(0, MAX_REASON_LENGTH - 1)}…` : reason,
});

export const make = Effect.gen(function* () {
  const catalog = yield* PluginCatalog;
  const environmentId: EnvironmentId = yield* (yield* ServerEnvironment).getEnvironmentId;

  const enrich: RunContextEnricherV2["Service"]["enrich"] = Effect.fn("PluginContextEnrichment.enrich")(
(source, input) => {
      const timeout = `${source.timeoutSeconds} seconds` as const;
      return catalog
        .invoke(
          source.installationId as PluginInstallationId,
          PLUGIN_ENRICH_HANDLER,
          encodeInput({ ...input, environmentId }),
          { timeout, generation: source.generation },
        )
        .pipe(
          // Also bounds a cold start, which the call's own deadline does not cover.
          Effect.timeoutOption(timeout),
          Effect.map(
            Option.match({
              onNone: () =>
                skipped(`${source.name} did not answer within ${source.timeoutSeconds} seconds.`),
              onSome: (value): RunContextOutcome => {
                if (jsonBytes(value) > PLUGIN_ENRICH_LIMITS.maxResultBytes)
                  return skipped(
                    `${source.name} answered with more than ${PLUGIN_ENRICH_LIMITS.maxResultBytes / 1024} KiB of context.`,
                  );
                const decoded = decodeResult(value);
                if (decoded._tag === "Failure")
                  return skipped(
                    `${source.name} answered with context outside the allowed shape: ${errorMessage(decoded.cause)}`,
                  );
                return { _tag: "added", context: decoded.value?.context ?? [] };
              },
            }),
          ),
          Effect.catch((error) =>
            Effect.succeed(
              skipped(
                error._tag === "PluginCatalogError" && error.reason === "unavailable"
                  ? `${source.name} was disabled or replaced before it answered.`
                  : error.message,
              ),
            ),
          ),
          Effect.catchDefect(() => Effect.succeed(skipped(`${source.name} failed unexpectedly.`))),
        );
    }
  );

  return RunContextEnricherV2.of({
    sources: catalog.ready.pipe(
      Effect.andThen(catalog.list),
      Effect.map(({ installations }) =>
        installations.flatMap((installation) => {
          const { manifest, consent } = installation;
          const enrich = manifest?.transforms?.enrich;
          if (
            manifest === null ||
            enrich === undefined ||
            pluginInstallationStatus(installation) !== "enabled" ||
            !manifest.capabilities.includes(PLUGIN_TRANSFORMS_CAPABILITY) ||
            consent?.capabilities.includes(PLUGIN_TRANSFORMS_CAPABILITY) !== true
          )
            return [];
          return [
            {
              installationId: installation.installationId,
              generation: installation.generation,
              pluginId: manifest.id,
              name: manifest.name,
              timeoutSeconds: enrich.timeoutSeconds ?? PLUGIN_ENRICH_LIMITS.defaultTimeoutSeconds,
            },
          ];
        }),
      ),
    ),
    enrich,
  });
});

export const layer = Layer.effect(RunContextEnricherV2, make);
