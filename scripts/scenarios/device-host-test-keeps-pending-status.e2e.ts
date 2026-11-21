/// <reference lib="dom" />
import { expect } from "e2e";
import * as Effect from "effect/Effect";

import { T3_HOME } from "../e2e.config.ts";
import { environmentId, rpcClient, runPromise, test, WEB } from "./t3.ts";

declare global {
  interface Window {
    deviceHostProbeGate?: { readonly started: Promise<void>; readonly release: () => void };
  }
}

test(
  "A second SSH connection check keeps the pending status visible",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const origin = app.baseUrl ?? "";
    const environment = await runPromise(environmentId(origin));
    await t3.project("demo");
    await runPromise(
      Effect.gen(function* () {
        const client = yield* rpcClient(T3_HOME, origin);
        yield* client["server.updateSettings"]({
          patch: {
            enableDeviceSupport: true,
            deviceHosts: [
              { kind: "ssh", id: "slow-host", label: "Slow host", target: "127.0.0.1", port: 1 },
            ],
          },
        });
      }).pipe(Effect.scoped),
    );

    // Delay just the explicit probe at the transport boundary until after the UI sample.
    await browser.addInitScript(() => {
      const held: Array<() => void> = [];
      const started = Promise.withResolvers<void>();
      let delaying = true;
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (this: WebSocket, data) {
        if (!delaying || typeof data !== "string") return send.call(this, data);
        const parsed = JSON.parse(data);
        const messages = [parsed].flat();
        const isProbe = (message: { _tag?: string; tag?: string }) =>
          message?._tag === "Request" && message.tag === "device.testHost";
        if (!messages.some(isProbe)) return send.call(this, data);
        const probes = messages.filter(isProbe);
        const other = messages.filter((message) => !isProbe(message));
        if (other.length) send.call(this, JSON.stringify(other));
        held.push(() => send.call(this, Array.isArray(parsed) ? JSON.stringify(probes) : data));
        started.resolve();
      };
      window.deviceHostProbeGate = {
        started: started.promise,
        release: () => {
          delaying = false;
          for (const release of held.splice(0)) release();
        },
      };
    });

    await t3.open(`/settings/devices?machine=${encodeURIComponent(environment)}#device-sources`);
    const more = browser.locator("#device-sources").getByRole("button", "More", { exact: true });
    const testConnection = screen.getByRole("menuitem", "Test connection", { exact: true });
    const pending = screen.getByText("Testing connection", { exact: true });
    try {
      await more.tap();
      await testConnection.tap();
      await pending.waitFor();
      await browser.evaluate(async () => {
        await window.deviceHostProbeGate!.started;
        return null;
      });
      if (await more.isEnabled()) {
        await more.tap();
        await screen.getByRole("menu").waitFor();
        if ((await testConnection.isVisible()) && (await testConnection.isEnabled())) {
          await testConnection.tap();
          await testConnection.waitFor({ state: "hidden" });
        } else {
          await browser.keyboard.press("Escape");
        }
      }

      await app.screenshot("second-connection-check");
      expect(await pending.isVisible(), "The SSH connection check still shows as pending").toBe(
        true,
      );
    } finally {
      await browser.evaluate(() => {
        window.deviceHostProbeGate?.release();
        return null;
      });
    }
  },
);
