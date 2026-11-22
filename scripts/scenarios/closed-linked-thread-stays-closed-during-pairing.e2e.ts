/// <reference lib="dom" />
import { EnvironmentId, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { expect } from "e2e";
import * as Effect from "effect/Effect";

import { T3_HOME } from "../e2e.config.ts";
import { SECOND_HOME, startSecondServer } from "./second-server.ts";
import { environmentId, makeState, rpcClient, runPromise, test, WEB } from "./t3.ts";

test(
  "A closed linked-thread tab does not take over the conversation when pairing finishes",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("primary");
    const parent = await t3.thread({
      project,
      title: "Current work",
      messages: ["Keep this conversation open"],
    });
    const origin = app.baseUrl ?? "";
    const server = startSecondServer(origin);
    try {
      const { host } = await server.ready;
      const second = makeState(SECOND_HOME);
      const access = "full-access";
      const credential = await second.peerLinkCredential(access);
      await runPromise(
        Effect.gen(function* () {
          const primary = yield* rpcClient(T3_HOME, origin);
          const remote = yield* rpcClient(SECOND_HOME, host);
          for (const client of [primary, remote]) {
            yield* client["server.updateSettings"]({ patch: { linkedEnvironmentsEnabled: true } });
          }
          yield* primary["peerLinks.link"]({
            url: host,
            pairingCode: credential,
            access,
          });
        }).pipe(Effect.scoped),
      );

      const linkedProject = await second.state.project("linked");
      const linkedTitle = "Remote design notes";
      const linkedPrompt = "Read the remote design notes";
      const remoteThread = await second.state.thread({
        project: linkedProject,
        title: linkedTitle,
        messages: [linkedPrompt],
      });
      const via = EnvironmentId.make(await runPromise(environmentId(origin)));
      const linked = EnvironmentId.make(await runPromise(environmentId(host)));
      await browser.setViewport({ width: 1440, height: 900 });

      const tokenUrl = `${host}/oauth/token`;
      const requested = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      await browser.route(tokenUrl, async (route) => {
        if (route.request.method !== "POST") return route.fallback();
        requested.resolve();
        await release.promise;
        await route.continue();
      });
      try {
        await t3.open(parent);
        await browser.evaluate(
          async ({ ref, target }) => {
            const storeModule = "/src/rightPanelStore.ts";
            const { useRightPanelStore } = (await import(storeModule)) as {
              useRightPanelStore: {
                getState(): {
                  openLinkedThread(panel: ScopedThreadRef, linkedThread: typeof target): void;
                };
              };
            };
            useRightPanelStore.getState().openLinkedThread(ref, target);
            return null;
          },
          {
            ref: { environmentId: via, threadId: ThreadId.make(parent.threadId) },
            target: {
              viaEnvironmentId: via,
              environmentId: linked,
              threadId: ThreadId.make(remoteThread.threadId),
              label: "Scenario",
              title: linkedTitle,
            },
          },
        );
        await screen.getByText(linkedPrompt, { exact: true }).waitFor();
        const originalUrl = await browser.url();
        await screen.getByRole("button", "Connect to interact", { exact: true }).tap();
        await requested.promise;
        await screen.getByRole("button", `Close ${linkedTitle}`, { exact: true }).tap();

        release.resolve();
        await screen
          .getByText("This device is paired with it and can use its threads.", { exact: true })
          .waitFor();

        await app.screenshot("after-pairing-finishes");
        await expect(browser).toHaveURL(originalUrl);
      } finally {
        release.resolve();
        await browser.unroute(tokenUrl);
      }
    } finally {
      await server.stop();
    }
  },
);
