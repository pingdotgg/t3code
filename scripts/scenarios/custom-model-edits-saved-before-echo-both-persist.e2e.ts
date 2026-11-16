/// <reference lib="dom" />
// The DOM lib types the functions this scenario runs in the page.
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { T3_HOME } from "../e2e.config.ts";
import { runPromise, test, WEB } from "./t3.ts";

const SettingsJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeSettings = Schema.decodeEffect(SettingsJson);
const encodeSettings = Schema.encodeEffect(SettingsJson);
interface CodexInstance {
  readonly config?: Readonly<Record<string, unknown>>;
}

interface ConfigHold {
  active: boolean;
  readonly held: Array<() => void>;
  readonly saveReplies: Set<string>;
}

declare global {
  interface Window {
    configHold?: ConfigHold;
  }
}

const settingsFile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const settingsPath = (yield* Path.Path).join(T3_HOME, "userdata/settings.json");
  const original = yield* fs.readFileString(settingsPath);
  const settings = yield* decodeSettings(original);
  const instances = settings.providerInstances as Record<string, CodexInstance>;
  const codex = instances.codex!;
  const customModels = [
    { slug: "model-a", name: "Original A" },
    { slug: "model-b", name: "Original B" },
  ];
  return {
    seed: fs.writeFileString(
      settingsPath,
      yield* encodeSettings({
        ...settings,
        providerInstances: {
          ...instances,
          codex: { ...codex, config: { ...codex.config, customModels } },
        },
      }),
    ),
    savedNames: fs.readFileString(settingsPath).pipe(
      Effect.flatMap(decodeSettings),
      Effect.map((saved) => {
        const config = (saved.providerInstances as Record<string, CodexInstance>).codex?.config;
        const models = (config?.customModels ?? []) as ReadonlyArray<{ readonly name: string }>;
        return models.map((model) => model.name);
      }),
    ),
    restore: fs.writeFileString(settingsPath, original),
  };
});

test(
  "Two custom model edits saved before the first one's settings echo both persist",
  WEB,
  async ({ t3, app, browser, screen }) => {
    // Holds the server config stream while active, so a save's reply arrives before its settings
    // echo, and records settings save replies by request id.
    await browser.addInitScript(() => {
      const hold: ConfigHold = { active: false, held: [], saveReplies: new Set() };
      window.configHold = hold;
      const tags = new Map<string, string>();
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data === "string") {
          for (const message of [JSON.parse(data)].flat()) {
            if (message?._tag === "Request") tags.set(String(message.id), message.tag);
          }
        }
        return send.call(this, data);
      };
      const addEventListener = WebSocket.prototype.addEventListener;
      WebSocket.prototype.addEventListener = function (
        this: WebSocket,
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) {
        if (type !== "message" || typeof listener !== "function") {
          return addEventListener.call(this, type, listener, options);
        }
        const wrapped = (event: Event) => {
          const data = (event as MessageEvent).data;
          if (typeof data !== "string") return listener.call(this, event);
          const parsed = JSON.parse(data);
          const messages = [parsed].flat();
          const isConfig = (message: { requestId?: unknown }) =>
            tags.get(String(message.requestId)) === "subscribeServerConfig";
          for (const message of messages) {
            if (
              message?._tag === "Exit" &&
              tags.get(String(message.requestId)) === "server.updateSettings"
            ) {
              hold.saveReplies.add(String(message.requestId));
            }
          }
          const deliver = (part: ReadonlyArray<unknown>) =>
            listener.call(
              this,
              new MessageEvent("message", {
                data: JSON.stringify(Array.isArray(parsed) ? part : part[0]),
              }),
            );
          const held = hold.active ? messages.filter(isConfig) : [];
          const passed = messages.filter((message) => !held.includes(message));
          if (held.length > 0) hold.held.push(() => deliver(held));
          if (passed.length > 0) deliver(passed);
        };
        return addEventListener.call(this, type, wrapped, options);
      } as typeof WebSocket.prototype.addEventListener;
    });
    const hold = (active: boolean) =>
      browser.evaluate((active) => {
        const hold = window.configHold!;
        hold.active = active;
        if (!active) for (const deliver of hold.held.splice(0)) deliver();
        return null;
      }, active);
    const saveReplies = () => browser.evaluate(() => window.configHold!.saveReplies.size);
    const rename = async (slug: string, name: string) => {
      await screen.getByRole("button", `Edit ${slug}`, { exact: true }).tap();
      await screen.getByRole("textbox", "Display name", { exact: true }).fill(name);
      await screen.getByRole("button", "Save", { exact: true }).tap();
    };

    const settings = await runPromise(settingsFile);
    try {
      await runPromise(settings.seed);
      await t3.open("/settings/providers?instanceId=codex");
      await expect(screen.getByRole("button", "Edit model-a", { exact: true })).toBeVisible();

      const before = await saveReplies();
      await hold(true);
      await rename("model-a", "Entered A");
      await expect.poll(saveReplies).toBe(before + 1);
      await rename("model-b", "Entered B");
      await expect.poll(saveReplies).toBe(before + 2);
      await hold(false);

      await expect.poll(() => runPromise(settings.savedNames)).toContain("Entered B");
      await app.screenshot("after-both-saves");
      expect(await runPromise(settings.savedNames)).toEqual(["Entered A", "Entered B"]);
    } finally {
      await runPromise(settings.restore);
    }
  },
);
