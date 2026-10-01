import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import {
  BROWSER_HISTORY_MAX_BYTES,
  BROWSER_HISTORY_MAX_ENTRIES,
  BROWSER_READ_HISTORY,
  BROWSER_RECORD_HISTORY,
  GENERIC_API_CATALOGUE,
  browserHistoryApi,
  fitBrowserHistoryList,
} from "../dist/catalogue.js";
import { CLIENT_PROVIDER_APIS } from "../dist/clientProviders.js";
import { MAX_PAYLOAD_BYTES, copyJson } from "../dist/contracts.js";

NodeTest.test("t3.browser/history reads and writes behind separate grants", () => {
  NodeAssert.ok(GENERIC_API_CATALOGUE.includes(browserHistoryApi.definition));
  const methods = Object.fromEntries(
    browserHistoryApi.definition.methods.map((method) => [method.name, method]),
  );
  NodeAssert.deepEqual(Object.keys(methods).sort(), ["list", "record", "remove", "setTitle"]);
  NodeAssert.deepEqual(methods.list.requiredGrants, [BROWSER_READ_HISTORY]);
  NodeAssert.equal(methods.list.effect, "read");
  for (const name of ["record", "setTitle", "remove"]) {
    NodeAssert.deepEqual(
      methods[name].requiredGrants,
      [BROWSER_READ_HISTORY, BROWSER_RECORD_HISTORY],
      name,
    );
    NodeAssert.equal(methods[name].effect, "write", name);
  }
  // No op names a project or thread: scope comes only from the view context.
  for (const method of browserHistoryApi.definition.methods)
    for (const key of Object.keys(method.inputSchema.properties ?? {}))
      NodeAssert.ok(!/project|thread/i.test(key), `${method.name}.${key}`);
  NodeAssert.equal(
    methods.list.outputSchema.properties.entries.maxItems,
    BROWSER_HISTORY_MAX_ENTRIES,
  );
  NodeAssert.ok(CLIENT_PROVIDER_APIS.has("t3.client/browser-history"));
});

NodeTest.test("history answers fit the envelope and say when they dropped entries", () => {
  NodeAssert.equal(browserHistoryApi.definition.version, "1.1.0");
  NodeAssert.ok(BROWSER_HISTORY_MAX_BYTES < MAX_PAYLOAD_BYTES);
  // 50 distinct native-maximum (2048-char) URLs, titled with multi-byte text.
  const full = Array.from({ length: BROWSER_HISTORY_MAX_ENTRIES }, (_, index) => {
    const prefix = `https://site.test/${String(index).padStart(2, "0")}/`;
    return {
      url: prefix + "a".repeat(2048 - prefix.length),
      lastVisitedAt: 1_700_000_000_000 + index,
      title: "é".repeat(512),
    };
  });
  NodeAssert.throws(() => copyJson({ entries: full }), /exceeds byte limit/);
  const fitted = fitBrowserHistoryList(full);
  NodeAssert.equal(fitted.truncated, true);
  NodeAssert.ok(fitted.entries.length > 0 && fitted.entries.length < full.length);
  // The most recent entries are kept, in order, and the next one would not fit.
  NodeAssert.deepEqual(fitted.entries, full.slice(0, fitted.entries.length));
  const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
  NodeAssert.ok(bytes(fitted) <= BROWSER_HISTORY_MAX_BYTES);
  NodeAssert.ok(
    bytes({ ...fitted, entries: full.slice(0, fitted.entries.length + 1) }) >
      BROWSER_HISTORY_MAX_BYTES,
  );
  copyJson(fitted);
  // A list that fits is returned whole, without the flag.
  const small = full.slice(0, 3).map(({ url, lastVisitedAt }) => ({ url, lastVisitedAt }));
  NodeAssert.deepEqual(fitBrowserHistoryList(small), { entries: small });
});
