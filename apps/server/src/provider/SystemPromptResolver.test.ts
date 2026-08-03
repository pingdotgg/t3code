import {
  ProviderDriverKind,
  ProviderInstanceId,
  type SystemPromptInjectionSettings,
  type SystemPromptRule,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettingsModule from "../serverSettings.ts";
import {
  SystemPromptResolver,
  layer as systemPromptResolverLayer,
} from "./SystemPromptResolver.ts";

const CODEX = ProviderDriverKind.make("codex");
const CODEX_INSTANCE = ProviderInstanceId.make("codex");
const CLAUDE_INSTANCE = ProviderInstanceId.make("claudeAgent");

const TARGET = { driverKind: CODEX, instanceId: CODEX_INSTANCE };

const rule = (
  id: string,
  text: string,
  match: SystemPromptRule["match"] = {},
): SystemPromptRule => ({ id, enabled: true, match, text });

const injection = (
  rules: ReadonlyArray<SystemPromptRule>,
  enabled = true,
): SystemPromptInjectionSettings => ({ schemaVersion: 1, enabled, rules });

const makeLayer = (systemPromptInjection: SystemPromptInjectionSettings) =>
  systemPromptResolverLayer.pipe(
    Layer.provideMerge(ServerSettingsModule.layerTest({ systemPromptInjection })),
  );

it.effect("composes the matching rules for a target", () =>
  Effect.gen(function* () {
    const resolver = yield* SystemPromptResolver;
    assert.equal(yield* resolver.resolve(TARGET), "Be concise.\n\nPrefer rg.");
  }).pipe(
    Effect.provide(
      makeLayer(
        injection([
          rule("global", "Be concise."),
          rule("codex", "Prefer rg.", { instanceId: CODEX_INSTANCE }),
          rule("claude", "Never used.", { instanceId: CLAUDE_INSTANCE }),
        ]),
      ),
    ),
  ),
);

it.effect("returns undefined when the master switch is off, leaving the rules intact", () =>
  Effect.gen(function* () {
    const resolver = yield* SystemPromptResolver;
    assert.equal(yield* resolver.resolve(TARGET), undefined);

    const settings = yield* ServerSettingsModule.ServerSettingsService;
    const current = yield* settings.getSettings;
    assert.equal(current.systemPromptInjection.rules.length, 1);
  }).pipe(Effect.provide(makeLayer(injection([rule("global", "Be concise.")], false)))),
);

it.effect("scopes a per-instance rule to that instance only", () =>
  Effect.gen(function* () {
    const resolver = yield* SystemPromptResolver;
    assert.equal(yield* resolver.resolve(TARGET), "Codex only.");
    assert.equal(
      yield* resolver.resolve({ driverKind: CODEX, instanceId: CLAUDE_INSTANCE }),
      undefined,
    );
  }).pipe(
    Effect.provide(
      makeLayer(injection([rule("codex", "Codex only.", { instanceId: CODEX_INSTANCE })])),
    ),
  ),
);

it.effect("re-reads settings on every call, so an edit needs no restart", () =>
  Effect.gen(function* () {
    const resolver = yield* SystemPromptResolver;
    const settings = yield* ServerSettingsModule.ServerSettingsService;

    assert.equal(yield* resolver.resolve(TARGET), "First.");

    yield* settings.updateSettings({
      systemPromptInjection: injection([rule("global", "Second.")]),
    });

    assert.equal(yield* resolver.resolve(TARGET), "Second.");
  }).pipe(Effect.provide(makeLayer(injection([rule("global", "First.")])))),
);
