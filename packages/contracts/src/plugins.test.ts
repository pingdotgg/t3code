import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { PluginManifest } from "./plugins.ts";

const decodePluginManifest = Schema.decodeUnknownEffect(PluginManifest);

it.effect("PluginManifest validates stable plugin ids, routes, UI placements, and commands", () =>
  Effect.gen(function* () {
    const manifest = yield* decodePluginManifest({
      id: "t3.automations",
      name: "Automations",
      version: "0.1.0",
      routes: [{ id: "main", label: "Automations", surface: "app" }],
      ui: {
        placements: [
          {
            id: "main-sidebar",
            position: "sidebar.primary",
            label: "Automations",
            routeId: "main",
            badgeCount: 1,
          },
        ],
        composerActions: [
          {
            id: "voice-input",
            position: "composer.footer.left",
            label: "Voice input",
            order: 100,
          },
        ],
      },
      commands: [{ name: "automations.rules.list", target: "server", label: "List rules" }],
    });

    assert.equal(manifest.id, "t3.automations");
    assert.equal(manifest.ui.placements[0]?.badgeCount, 1);
    assert.equal(manifest.ui.composerActions?.[0]?.position, "composer.footer.left");
    assert.equal(manifest.commands[0]?.target, "server");

    const invalid = yield* Effect.flip(
      decodePluginManifest({
        id: "not allowed",
        name: "Broken",
        version: "0.1.0",
        routes: [],
        ui: { placements: [] },
        commands: [],
      }),
    );
    assert.include(String(invalid), "not allowed");
  }),
);

it.effect("PluginManifest rejects invalid composer action positions", () =>
  Effect.gen(function* () {
    const invalidPosition = yield* Effect.flip(
      decodePluginManifest({
        id: "t3.invalid-composer-action",
        name: "Invalid Composer Action",
        version: "0.1.0",
        routes: [],
        ui: {
          placements: [],
          composerActions: [
            {
              id: "voice-input",
              position: "thread.toolbar",
              label: "Voice input",
            },
          ],
        },
        commands: [],
      }),
    );
    assert.include(String(invalidPosition), "thread.toolbar");
  }),
);

it.effect("PluginManifest rejects dotted client keybinding command names", () =>
  Effect.gen(function* () {
    const invalidCommand = yield* Effect.flip(
      decodePluginManifest({
        id: "t3.invalid-keybinding-command",
        name: "Invalid Keybinding Command",
        version: "0.1.0",
        routes: [],
        ui: { placements: [] },
        commands: [
          {
            name: "voice.toggle",
            target: "client",
            label: "Toggle voice input",
            keybinding: true,
          },
        ],
      }),
    );
    assert.include(String(invalidCommand), "^[^.]+$");
  }),
);

it.effect("PluginManifest rejects legacy nav and invalid placement positions", () =>
  Effect.gen(function* () {
    const legacyNav = yield* Effect.flip(
      decodePluginManifest({
        id: "t3.legacy",
        name: "Legacy",
        version: "0.1.0",
        routes: [{ id: "main", label: "Legacy", surface: "app" }],
        nav: [{ id: "main", label: "Legacy", routeId: "main" }],
        commands: [],
      }),
    );
    assert.include(String(legacyNav), "ui");

    const invalidPosition = yield* Effect.flip(
      decodePluginManifest({
        id: "t3.invalid-position",
        name: "Invalid Position",
        version: "0.1.0",
        routes: [{ id: "main", label: "Invalid Position", surface: "app" }],
        ui: {
          placements: [
            {
              id: "bad-placement",
              position: "thread.toolbar",
              label: "Invalid Position",
              routeId: "main",
            },
          ],
        },
        commands: [],
      }),
    );
    assert.include(String(invalidPosition), "thread.toolbar");
  }),
);
