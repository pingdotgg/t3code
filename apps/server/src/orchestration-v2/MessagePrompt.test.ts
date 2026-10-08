import { ComposerContextId } from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { expect, it } from "vite-plus/test";

import { locationContextRecord, serializeSharedLocation } from "@t3tools/shared/sharedLocation";
import { projectUserMessageForProvider } from "./MessagePrompt.ts";

const location = {
  name: "North entrance",
  address: "12 Example Street, Boston, MA",
  latitude: 42.3521,
  longitude: -71.0552,
  accuracy: 18,
  capturedAt: "2026-10-07T13:00:00Z",
} as const;

const locationRecord = locationContextRecord(location, ComposerContextId.make("location-1"));
const typedContext = { version: 1, records: [locationRecord] } as const;

it("projects typed locations with coordinates and one-shot guidance", () => {
  const text = projectUserMessageForProvider({
    text: `Find a nearby cafe. ${formatComposerContextReference({
      kind: "location",
      contextId: locationRecord.contextId,
      label: locationRecord.label,
    })}`,
    context: typedContext,
  });

  expect(text).toContain("42.3521, -71.0552");
  expect(text).toContain("Snapshot: user/device-reported one-shot location");
  expect(text).toContain("Do not infer present location in later turns.");
  expect(text.match(/<context kind="location"/gu)).toHaveLength(1);
});

it("normalizes canonical legacy blocks once before provider projection", () => {
  const block = serializeSharedLocation(location);
  const text = projectUserMessageForProvider({ text: `Find a cafe.\n\n${block}` });

  expect(text).toContain("Find a cafe.");
  expect(text).toContain("Snapshot: user/device-reported one-shot location");
  expect(text).toContain("42.3521, -71.0552");
  expect(text).not.toContain("\n\n<shared-location>");
  expect(text.match(/<context kind="location"/gu)).toHaveLength(1);
});

it("keeps plain user text unchanged and malformed location blocks intact", () => {
  expect(projectUserMessageForProvider({ text: "Please keep this short." })).toBe(
    "Please keep this short.",
  );
  const malformed = "<shared-location>\nnot canonical\n</shared-location>";
  expect(projectUserMessageForProvider({ text: malformed })).toBe(malformed);
});
