import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as TailnetAccess from "./tailnetAccess.ts";

it.effect("resolves waiters and readers once the tailnet base URL is recorded", () =>
  Effect.gen(function* () {
    const tailnetAccess = yield* TailnetAccess.make;

    assert.isNull(yield* tailnetAccess.getTailnetHttpsBaseUrl);

    yield* tailnetAccess.recordTailnetHttpsBaseUrl("https://machine.tailnet.ts.net/");

    assert.equal(yield* tailnetAccess.getTailnetHttpsBaseUrl, "https://machine.tailnet.ts.net/");
    assert.equal(yield* tailnetAccess.awaitTailnetHttpsBaseUrl, "https://machine.tailnet.ts.net/");
  }),
);

it.effect("resolves waiters with null when serve is disabled or unavailable", () =>
  Effect.gen(function* () {
    const tailnetAccess = yield* TailnetAccess.make;

    yield* tailnetAccess.recordTailnetHttpsBaseUrl(null);

    assert.isNull(yield* tailnetAccess.getTailnetHttpsBaseUrl);
    assert.isNull(yield* tailnetAccess.awaitTailnetHttpsBaseUrl);
  }),
);
