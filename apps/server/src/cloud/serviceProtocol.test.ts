import { expect, it } from "@effect/vitest";

import { parseLegacyServiceState } from "./serviceProtocol.ts";

it("parses only the exact protocol-2 install state", () => {
  expect(parseLegacyServiceState('{"protocol":2,"activeVersion":"1.2.3"}')).toEqual({
    protocol: 2,
    activeVersion: "1.2.3",
  });
});

it.each([
  '{"protocol":2,"activeVersion":"1.2.3","update":{}}',
  '{"protocol":2,"activeVersion":"1.2.3","extra":true}',
  '{"protocol":3,"activeVersion":"1.2.3"}',
  '{"protocol":4,"activeVersion":"1.2.3"}',
  '{"protocol":2,"activeVersion":"latest"}',
  "null",
  "[]",
  "{ malformed",
])("rejects non-migratable service state %s", (contents) => {
  expect(parseLegacyServiceState(contents)).toBeUndefined();
});
