import * as NodeEvents from "node:events";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The test runs a loopback OTLP receiver.
import * as NodeHttp from "node:http";
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";

import { runPromise, test, WEB } from "./t3.ts";

test(
  "The corrected traces endpoint can be tested while the previous URL is still checking",
  WEB,
  async ({ t3, app, browser }) => {
    const firstProbe = Promise.withResolvers<void>();
    const collector = NodeHttp.createServer((request, response) => {
      request.resume();
      if (request.url === "/slow/v1/traces") {
        firstProbe.resolve();
        return;
      }
      response.writeHead(200).end();
    });
    collector.listen(0, "127.0.0.1");
    try {
      await NodeEvents.once(collector, "listening");
      const address = collector.address();
      if (address === null || typeof address === "string") throw new Error("No collector port");
      const origin = `http://127.0.0.1:${address.port}`;

      await t3.project("demo");
      const { environmentId } = await runPromise(
        HttpClient.get(`${app.baseUrl}/.well-known/t3/environment`).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(
            HttpClientResponse.schemaBodyJson(Schema.Struct({ environmentId: Schema.String })),
          ),
          Effect.provide(FetchHttpClient.layer),
        ),
      );
      await t3.open(
        `/settings/diagnostics?machine=${encodeURIComponent(environmentId)}#telemetry-export`,
      );

      const traces = browser.locator("#otlpTracesUrl");
      const exportSection = browser.locator("#telemetry-export");
      const testTraces = exportSection.getByRole("button", "Test").first();
      await traces.fill(`${origin}/slow/v1/traces`);
      await testTraces.tap();
      await firstProbe.promise;
      await traces.fill(`${origin}/v1/traces`);
      await exportSection.getByText("Not checked", { exact: true }).waitFor();

      // Sample the screen before the old request reaches its server timeout.
      const canTestCorrectedUrl = await testTraces.isEnabled();
      await app.screenshot("corrected-traces-url");
      expect(canTestCorrectedUrl, "The corrected traces URL can be tested immediately").toBe(true);
    } finally {
      collector.close();
      collector.closeAllConnections();
    }
  },
);
