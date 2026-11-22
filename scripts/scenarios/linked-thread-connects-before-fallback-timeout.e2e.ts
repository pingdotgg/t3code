/// <reference lib="dom" />
import { EnvironmentHttpApi } from "@t3tools/contracts";
import { expect } from "e2e";

import { linkEnvironments, SECOND_HOME, startSecondServer } from "./second-server.ts";
import { environmentId, makeState, runPromise, test, WEB } from "./t3.ts";

test(
  "Connect to interact opens the editable thread before a silent fallback times out",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await t3.project("primary");
    const primary = app.baseUrl ?? "";
    const secondServer = startSecondServer(primary);
    try {
      const { host } = await secondServer.ready;
      const alternate = new URL(host);
      alternate.hostname = "127.0.0.2";
      await runPromise(
        linkEnvironments(primary, host, {
          access: "full-access",
          alternateUrls: [alternate.origin],
        }),
      );

      const second = makeState(SECOND_HOME).state;
      const project = await second.project("linked");
      const thread = await second.thread({
        project,
        title: "Linked handoff",
        messages: ["first"],
      });
      const via = await runPromise(environmentId(primary));
      const target = await runPromise(environmentId(host));

      await browser.addInitScript(
        ({ fallback, descriptorPath }) => {
          const fetchActual = globalThis.fetch;
          globalThis.fetch = (input, init) => {
            const url = new URL(
              input instanceof Request ? input.url : String(input),
              location.href,
            );
            if (url.origin !== fallback || url.pathname !== descriptorPath) {
              // @effect-diagnostics-next-line globalFetch:off - This interception runs inside the browser.
              return fetchActual(input, init);
            }
            // The browser's network silently drops this route. The preferred address is still real.
            return new Promise((_, reject) => {
              const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
              signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          };
        },
        {
          fallback: alternate.origin,
          descriptorPath: EnvironmentHttpApi.groups.metadata.endpoints.descriptor.path,
        },
      );

      await t3.open(`/linked/${via}/${target}/${thread.threadId}`);
      await screen.getByRole("heading", "Linked handoff").waitFor();
      await screen.getByRole("button", "Connect to interact").tap();

      try {
        await expect
          .poll(() => browser.evaluate(() => location.pathname), { timeout: 4_000 })
          .toBe(`/${target}/${encodeURIComponent(thread.threadId)}`);
      } finally {
        await app.screenshot("linked-thread-after-connect");
      }
    } finally {
      await secondServer.stop();
    }
  },
);
