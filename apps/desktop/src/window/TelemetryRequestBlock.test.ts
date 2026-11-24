import { assert, describe, it } from "@effect/vitest";

import { installTelemetryRequestBlock } from "./TelemetryRequestBlock.ts";

describe("installTelemetryRequestBlock", () => {
  it("cancels requests to upstream analytics hosts until detached", () => {
    const installed: Array<unknown> = [];
    const session = {
      webRequest: {
        onBeforeRequest: (...args: Array<unknown>) => void installed.push(args),
      },
    } as unknown as Pick<Electron.Session, "webRequest">;

    const detach = installTelemetryRequestBlock(session);
    const [filter, listener] = installed[0] as [
      { urls: Array<string> },
      (details: unknown, callback: (response: { cancel: boolean }) => void) => void,
    ];
    assert.include(filter.urls, "https://ingest.t3.codes/*");
    assert.include(filter.urls, "https://*.posthog.com/*");
    let response: { cancel: boolean } | undefined;
    listener({}, (value) => (response = value));
    assert.deepStrictEqual(response, { cancel: true });

    detach();
    assert.deepStrictEqual(installed[1], [null]);
  });
});
