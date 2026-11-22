/// <reference lib="dom" />
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { T3_HOME } from "../e2e.config.ts";
import { SECOND_HOME, startSecondServer } from "./second-server.ts";
import { environmentId, makeState, rpcClient, runPromise, test, WEB } from "./t3.ts";

const decodeCredential = Schema.decodeUnknownSync(Schema.Struct({ credential: Schema.String }));

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
      const issued = await runPromise(second.cli(["auth", "session", "issue", "--token-only"]));
      // @effect-diagnostics-next-line globalFetch:off -- Seeds the real peer link from the scenario's Node fixture.
      const pairing = await fetch(`${host}/api/auth/pairing-token`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${issued.stdout.trim()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ purpose: "peer-link", access: "full-access" }),
      });
      if (!pairing.ok) throw new Error(`Could not mint a peer-link code: ${pairing.status}`);
      const { credential } = decodeCredential(await pairing.json());
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
            access: "full-access",
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
      const via = await runPromise(environmentId(origin));
      const linked = await runPromise(environmentId(host));
      await browser.setViewport({ width: 1440, height: 900 });

      // Restore the same saved tab that opening the delegated thread in the panel would leave.
      await browser.addInitScript(
        ({ via, linked, parentId, childId, title }) => {
          if (location.pathname !== `/${via}/${parentId}`) return;
          const id = `linked-thread:${encodeURIComponent(via)}:${encodeURIComponent(linked)}:${encodeURIComponent(childId)}`;
          localStorage.setItem(
            "t3code:right-panel-state:v2",
            JSON.stringify({
              version: 16,
              state: {
                byThreadKey: {
                  [`${via}:${parentId}`]: {
                    isOpen: true,
                    activeSurfaceId: id,
                    surfaces: [
                      {
                        kind: "linked-thread",
                        id,
                        viaEnvironmentId: via,
                        environmentId: linked,
                        threadId: childId,
                        label: "Scenario",
                        title,
                      },
                    ],
                  },
                },
                threadPanelVisibilityByThreadKey: {},
              },
            }),
          );
        },
        {
          via,
          linked,
          parentId: parent.threadId,
          childId: remoteThread.threadId,
          title: linkedTitle,
        },
      );

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
