/// <reference lib="dom" />
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { T3_HOME } from "../e2e.config.ts";
import { SECOND_HOME, startSecondServer } from "./second-server.ts";
import { environmentId, makeState, rpcClient, runPromise, test, WEB } from "./t3.ts";

const decodePairing = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ credential: Schema.String })),
);

test(
  "Try again immediately reads a linked thread once it is reachable",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await t3.project("primary");
    const origin = app.baseUrl ?? "";
    const server = startSecondServer(origin);
    try {
      const { host } = await server.ready;
      await runPromise(
        Effect.gen(function* () {
          const primary = yield* rpcClient(T3_HOME, origin);
          const remote = yield* rpcClient(SECOND_HOME, host);
          for (const client of [primary, remote]) {
            yield* client["server.updateSettings"]({ patch: { linkedEnvironmentsEnabled: true } });
          }
          const pairing = yield* makeState(SECOND_HOME).cli([
            "auth",
            "pairing",
            "create",
            "--json",
          ]);
          const { credential } = yield* decodePairing(pairing.stdout);
          yield* primary["peerLinks.link"]({
            url: host,
            pairingCode: credential,
            access: "approval-required",
          });
        }).pipe(Effect.scoped),
      );

      const remote = makeState(SECOND_HOME).state;
      const project = await remote.project("linked");
      const prompt = "Read the linked design notes";
      const thread = await remote.thread({ project, title: "Design notes", messages: [prompt] });
      const via = await runPromise(environmentId(origin));
      const linked = await runPromise(environmentId(host));

      // Drop only the first subscription, as if the linked machine were briefly unreachable.
      // Every later request goes to the real server and reads the seeded thread.
      await browser.addInitScript(() => {
        let failed = false;
        const send = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data) {
          if (failed || typeof data !== "string") return send.call(this, data);
          const parsed = JSON.parse(data);
          const messages = Array.isArray(parsed) ? parsed : [parsed];
          const request = messages.find(
            (message) => message?._tag === "Request" && message.tag === "peerLinks.subscribeThread",
          );
          if (!request) return send.call(this, data);
          failed = true;
          const others = messages.filter((message) => message !== request);
          if (others.length > 0) send.call(this, JSON.stringify(others));
          // @effect-diagnostics-next-line globalTimers:off - This callback is injected into the browser.
          setTimeout(() => {
            this.dispatchEvent(
              new MessageEvent("message", {
                data: JSON.stringify({
                  _tag: "Exit",
                  requestId: request.id,
                  exit: {
                    _tag: "Failure",
                    cause: [
                      {
                        _tag: "Fail",
                        error: {
                          _tag: "PeerLinkThreadReadError",
                          reason: "unreachable",
                          label: "Scenario",
                          message: "The linked machine is temporarily unreachable.",
                        },
                      },
                    ],
                  },
                }),
              }),
            );
          }, 0);
        };
      });

      await t3.open(`/linked/${via}/${linked}/${thread.threadId}`);
      await screen.getByRole("button", "Try again", { exact: true }).tap();
      await app.screenshot("after-trying-again");
      // The automatic retry waits 15 seconds. This checks the user's explicit retry.
      await expect(screen.getByText(prompt, { exact: true })).toBeVisible({ timeout: 4_000 });
    } finally {
      await server.stop();
    }
  },
);
