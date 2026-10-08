import { ComposerContextId } from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { locationContextRecord, serializeSharedLocation } from "@t3tools/shared/sharedLocation";
import { expect, it } from "vite-plus/test";

import { separateComposerLocationContext } from "./composerLocationContext";
import { serializeComposerMessageForServer } from "./composerContext";

const location = {
  name: "Main Library",
  address: "100 Larkin St, San Francisco, CA",
  latitude: 37.7793,
  longitude: -122.4192,
  accuracy: 12,
  capturedAt: "2026-10-07T18:00:00.000Z",
};
const record = locationContextRecord(location, ComposerContextId.make("shared-location"));

it("restores a removable location from typed message context without leaking a context chip into prose", () => {
  const separated = separateComposerLocationContext({
    text: `Meet here.\n\n${formatComposerContextReference(record)}`,
    context: { version: 1, records: [record] },
  });
  expect(separated.text).toBe("Meet here.");
  expect(separated.locations).toEqual([{ ...location, id: record.contextId, type: "location" }]);
  expect(separated.context).toBeUndefined();
});

it("keeps a mixed message's other context while upgrading its legacy location", () => {
  const mention = {
    version: 1 as const,
    kind: "mention" as const,
    contextId: ComposerContextId.make("path"),
    label: "src",
    path: "/repo/src",
  };
  const separated = separateComposerLocationContext({
    text: `${formatComposerContextReference(mention)}\n\n${serializeSharedLocation(location)}`,
    context: { version: 1, records: [mention] },
  });
  expect(separated.text).toBe(formatComposerContextReference(mention));
  expect(separated.context?.records).toEqual([mention]);
  expect(separated.locations).toHaveLength(1);
});

it("does not display unreferenced location records", () => {
  expect(
    separateComposerLocationContext({ text: "Hello", context: { version: 1, records: [record] } })
      .locations,
  ).toEqual([]);
});

it.each([false, true])("sends complete text to an older host with inline support=%s", (inline) => {
  const message = serializeComposerMessageForServer(
    formatComposerContextReference(record),
    { version: 1, records: [record] },
    inline,
    { locations: [], supportsSharedLocationContext: false },
  );
  expect(message.text).toContain(serializeSharedLocation(location));
  expect(message.context).toBeUndefined();
  expect(message.text).not.toContain("t3-context://v1/location/");
});

it("sends structured locations to a capable host with one canonical reference", () => {
  const message = serializeComposerMessageForServer("Meet here", undefined, true, {
    locations: [location],
    supportsSharedLocationContext: true,
  });
  expect(message.text.match(/t3-context:\/\/v1\/location\//g)).toHaveLength(1);
  expect(message.context?.records).toEqual([
    expect.objectContaining({ kind: "location", payload: location }),
  ]);
});
