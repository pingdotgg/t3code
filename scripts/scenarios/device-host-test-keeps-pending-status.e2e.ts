/// <reference lib="dom" />
import { WS_METHODS } from "@t3tools/contracts";
import { expect } from "e2e";
import * as Effect from "effect/Effect";

import { T3_HOME } from "../e2e.config.ts";
import { SECOND_HOME, startSecondServer } from "./second-server.ts";
import { rpcClient, runPromise, test, WEB } from "./t3.ts";

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
    await t3.project("demo");
    const saveHost = (home: string, url: string, id: string) =>
      runPromise(
        Effect.gen(function* () {
          const client = yield* rpcClient(home, url);
          yield* client[WS_METHODS.serverUpdateSettings]({
            patch: {
              enableDeviceSupport: true,
              deviceHosts: [{ kind: "ssh", id, label: "Slow host", target: "127.0.0.1", port: 1 }],
            },
          });
        }).pipe(Effect.scoped),
      );
    await saveHost(T3_HOME, origin, "slow-host");

    // Delay just the explicit probe at the transport boundary until after the UI sample.
    await browser.addInitScript((probeMethod) => {
      const held: Array<() => void> = [];
      const started = Promise.withResolvers<void>();
      let delaying = true;
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (this: WebSocket, data) {
        if (!delaying || typeof data !== "string") return send.call(this, data);
        const parsed = JSON.parse(data);
        const messages = [parsed].flat();
        const isProbe = (message: { _tag?: string; tag?: string }) =>
          message?._tag === "Request" && message.tag === probeMethod;
        if (!messages.some(isProbe)) return send.call(this, data);
        const probes = messages.filter(isProbe);
        const other = messages.filter((message) => !isProbe(message));
        if (other.length) send.call(this, JSON.stringify(other));
        held.push(() => {
          if (this.readyState === WebSocket.OPEN) {
            send.call(this, Array.isArray(parsed) ? JSON.stringify(probes) : data);
          }
        });
        started.resolve();
      };
      window.deviceHostProbeGate = {
        started: started.promise,
        release: () => {
          delaying = false;
          for (const release of held.splice(0)) release();
        },
      };
    }, WS_METHODS.deviceTestHost);

    const server = startSecondServer(origin);
    try {
      const { host, token } = await server.ready;
      await saveHost(SECOND_HOME, host, "linked-slow-host");
      await t3.open("/settings/connections");
      await screen.getByRole("button", "Add environment").tap();
      const dialog = screen.getByRole("dialog");
      await dialog.getByPlaceholder("backend.example.com").fill(host);
      await dialog.getByPlaceholder("PAIRCODE").fill(token);
      await dialog.getByRole("button", "Add environment").tap();
      await screen.getByRole("button", "More actions for Scenario").waitFor();

      await app.open("/settings/devices#device-sources");
      await screen
        .getByText("Simulators and emulators installed on each environment's own machine.")
        .waitFor();
      const more = browser.locator("#device-sources").getByRole("button", "More", { exact: true });
      const testConnection = screen.getByRole("menuitem", "Test connection", { exact: true });
      const pending = screen.getByText("Testing connection", { exact: true });
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

      await server.stop();
      await screen
        .getByText("Simulators and emulators installed on this environment's machine.")
        .waitFor();
      expect(await pending.isVisible(), "The surviving SSH row still shows the pending check").toBe(
        true,
      );
    } finally {
      await server.stop();
      await browser.evaluate(() => {
        window.deviceHostProbeGate?.release();
        return null;
      });
    }
  },
);
