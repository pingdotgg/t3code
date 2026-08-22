import { expect, it } from "@effect/vitest";

import { bunWebSocketOptions } from "./httpServerOptions.ts";

it("reaps Bun websocket connections after six missed client ping windows", () => {
  expect(bunWebSocketOptions).toEqual({
    perMessageDeflate: {
      compress: "dedicated",
      decompress: "shared",
    },
    idleTimeout: 30,
  });
});
