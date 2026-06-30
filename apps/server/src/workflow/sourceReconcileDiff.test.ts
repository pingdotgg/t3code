import { assert, describe, it } from "@effect/vitest";

import type { ExternalWorkItem } from "./Services/WorkSourceProvider.ts";
import {
  buildNewSourceDelta,
  classifyDeltas,
  hashContent,
  serializeSourceMetadata,
  type MappingRow,
} from "./sourceReconcileDiff.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeItem = (over: Partial<ExternalWorkItem> = {}): ExternalWorkItem => ({
  provider: "github",
  externalId: "issue-1",
  url: "https://github.com/owner/repo/issues/1",
  lifecycle: "open",
  version: { updatedAt: "2026-01-01T00:00:00Z" },
  fields: {
    title: "Fix the bug",
    description: "It is broken",
    assignees: ["alice"],
    labels: ["bug"],
  },
  ...over,
});

// Default metadata matches the default makeItem() metadata so a mapping built
// for the default item reports NO metadata change (only content/lifecycle drive
// deltas) unless a test overrides sourceMetadataJson.
const DEFAULT_ITEM_METADATA_JSON = serializeSourceMetadata({
  provider: "github",
  url: "https://github.com/owner/repo/issues/1",
  assignees: ["alice"],
  labels: ["bug"],
  lifecycle: "open",
});

const makeMapping = (over: Partial<MappingRow> = {}): MappingRow => ({
  externalId: "issue-1",
  ticketId: "ticket-abc",
  contentHash: hashContent({ title: "Fix the bug", description: "It is broken" }),
  providerVersion: "2026-01-01T00:00:00Z",
  lifecycle: "open",
  syncStatus: "active",
  sourceMetadataJson: DEFAULT_ITEM_METADATA_JSON,
  ...over,
});

const defaultInput = {
  sourceId: "src-1",
  provider: "github",
} as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("hashContent", () => {
  it("produces the same hash for identical title+description", () => {
    const h1 = hashContent({ title: "Fix the bug", description: "It is broken" });
    const h2 = hashContent({ title: "Fix the bug", description: "It is broken" });
    assert.equal(h1, h2);
  });

  it("produces a different hash when title changes", () => {
    const h1 = hashContent({ title: "Fix the bug", description: "It is broken" });
    const h2 = hashContent({ title: "Fix another bug", description: "It is broken" });
    assert.notEqual(h1, h2);
  });

  it("produces a different hash when description changes", () => {
    const h1 = hashContent({ title: "Fix the bug", description: "It is broken" });
    const h2 = hashContent({ title: "Fix the bug", description: "It is very broken" });
    assert.notEqual(h1, h2);
  });

  it("treats absent description consistently (undefined vs omitted)", () => {
    const h1 = hashContent({ title: "Title" });
    const h2 = hashContent({ title: "Title", description: undefined });
    assert.equal(h1, h2);
  });
});

describe("classifyDeltas", () => {
  it("new: an item with no mapping row produces a new delta", () => {
    const item = makeItem();
    const result = classifyDeltas({
      ...defaultInput,
      items: [item],
      mappings: [],
      scanCompleted: true,
    });

    assert.lengthOf(result, 1);
    const delta = result[0]!;
    assert.equal(delta._tag, "new");
    if (delta._tag === "new") {
      assert.equal(delta.item.externalId, "issue-1");
      assert.equal(delta.item.title, "Fix the bug");
      assert.equal(delta.item.description, "It is broken");
      assert.equal(
        delta.item.contentHash,
        hashContent({ title: "Fix the bug", description: "It is broken" }),
      );
    }
  });

  it("changed: a mapped item with a different content hash produces a changed delta", () => {
    const item = makeItem({ fields: { title: "Renamed issue", description: "New body" } });
    // Mapping has the OLD hash (computed from the old title/description).
    const mapping = makeMapping({
      contentHash: hashContent({ title: "Fix the bug", description: "It is broken" }),
    });

    const result = classifyDeltas({
      ...defaultInput,
      items: [item],
      mappings: [mapping],
      scanCompleted: true,
    });

    assert.lengthOf(result, 1);
    const delta = result[0]!;
    assert.equal(delta._tag, "changed");
    if (delta._tag === "changed") {
      assert.equal(delta.ticketId, "ticket-abc");
      assert.equal(delta.item.title, "Renamed issue");
      assert.equal(delta.item.description, "New body");
      assert.equal(
        delta.item.contentHash,
        hashContent({ title: "Renamed issue", description: "New body" }),
      );
    }
  });

  it('Fix 1: an upstream description cleared (non-empty → empty) produces a changed delta that CLEARS the description to ""', () => {
    // Upstream item used to have a description; now it's cleared (absent → undefined
    // on the ExternalWorkItem). The mapping carries the OLD hash (with the body).
    const item = makeItem({
      fields: { title: "Fix the bug" }, // description omitted → cleared upstream
    });
    const mapping = makeMapping({
      contentHash: hashContent({ title: "Fix the bug", description: "It is broken" }),
    });

    const result = classifyDeltas({
      ...defaultInput,
      items: [item],
      mappings: [mapping],
      scanCompleted: true,
    });

    assert.lengthOf(result, 1);
    const delta = result[0]!;
    assert.equal(delta._tag, "changed");
    if (delta._tag === "changed") {
      // The delta CARRIES an empty-string description (authoritative clear),
      // never undefined — so the committer WRITES the clear.
      assert.equal(delta.item.description, "");
      // hash is computed over the SAME normalized {title, description:""} so the
      // carried value and the stored hash agree → next cycle is a no-op.
      assert.equal(delta.item.contentHash, hashContent({ title: "Fix the bug", description: "" }));
    }

    // Next cycle: the mapping now stores the cleared hash AND the item's metadata
    // (no assignees/labels, since this item omitted them) → no further delta.
    const noop = classifyDeltas({
      ...defaultInput,
      items: [item],
      mappings: [
        makeMapping({
          contentHash: hashContent({ title: "Fix the bug", description: "" }),
          sourceMetadataJson: serializeSourceMetadata({
            provider: "github",
            url: "https://github.com/owner/repo/issues/1",
            assignees: [],
            labels: [],
            lifecycle: "open",
          }),
        }),
      ],
      scanCompleted: true,
    });
    assert.lengthOf(noop, 0);
  });

  it("no-op: a mapped item whose hash matches produces NO delta", () => {
    const item = makeItem();
    // Mapping hash matches the item exactly.
    const mapping = makeMapping({
      contentHash: hashContent({ title: "Fix the bug", description: "It is broken" }),
    });

    const result = classifyDeltas({
      ...defaultInput,
      items: [item],
      mappings: [mapping],
      scanCompleted: true,
    });

    assert.lengthOf(result, 0);
  });

  it("closed: lifecycle closed with open mapping produces a closed delta (takes precedence over changed)", () => {
    // Title is also different → content changed AND lifecycle closed.
    const item = makeItem({
      lifecycle: "closed",
      fields: { title: "Renamed AND closed", description: "Different body" },
    });
    const mapping = makeMapping({
      contentHash: hashContent({ title: "Fix the bug", description: "It is broken" }),
      lifecycle: "open",
    });

    const result = classifyDeltas({
      ...defaultInput,
      items: [item],
      mappings: [mapping],
      scanCompleted: true,
    });

    // Only ONE delta: closed wins over changed.
    assert.lengthOf(result, 1);
    const delta = result[0]!;
    assert.equal(delta._tag, "closed");
    if (delta._tag === "closed") {
      assert.equal(delta.ticketId, "ticket-abc");
    }
  });

  it("already-closed mapping + closed item → no redundant closed delta", () => {
    const item = makeItem({ lifecycle: "closed" });
    // Mapping already has lifecycle 'closed' → nothing to emit.
    const mapping = makeMapping({
      lifecycle: "closed",
      contentHash: hashContent({ title: "Fix the bug", description: "It is broken" }),
    });

    const result = classifyDeltas({
      ...defaultInput,
      items: [item],
      mappings: [mapping],
      scanCompleted: true,
    });

    assert.lengthOf(result, 0);
  });

  it("missing-when-complete: active mapping absent from items when scanCompleted:true → missing delta", () => {
    // No items in the fetch, but there IS an active mapping.
    const mapping = makeMapping({ syncStatus: "active", lifecycle: "open" });

    const result = classifyDeltas({
      ...defaultInput,
      items: [],
      mappings: [mapping],
      scanCompleted: true,
    });

    assert.lengthOf(result, 1);
    const delta = result[0]!;
    assert.equal(delta._tag, "missing");
    if (delta._tag === "missing") {
      assert.equal(delta.ticketId, "ticket-abc");
      assert.equal(delta.confirmedDeleted, false);
    }
  });

  it("missing-suppressed: active mapping absent from items when scanCompleted:false → NO missing delta", () => {
    const mapping = makeMapping({ syncStatus: "active" });

    const result = classifyDeltas({
      ...defaultInput,
      items: [],
      mappings: [mapping],
      scanCompleted: false,
    });

    assert.lengthOf(result, 0);
  });

  it("orphaned mapping not re-emitted as missing (only active rows)", () => {
    const mapping = makeMapping({ syncStatus: "orphaned" });

    const result = classifyDeltas({
      ...defaultInput,
      items: [],
      mappings: [mapping],
      scanCompleted: true,
    });

    assert.lengthOf(result, 0);
  });

  it("multiple items: correct classification for each", () => {
    const itemNew = makeItem({ externalId: "issue-100" });
    const itemChanged = makeItem({
      externalId: "issue-200",
      fields: { title: "Changed title", description: "Changed body" },
    });
    const itemNoop = makeItem({ externalId: "issue-300" });
    const itemClosed = makeItem({ externalId: "issue-400", lifecycle: "closed" });

    const mappingChanged = makeMapping({
      externalId: "issue-200",
      ticketId: "ticket-200",
      contentHash: hashContent({ title: "Old title", description: "Old body" }),
    });
    const mappingNoop = makeMapping({
      externalId: "issue-300",
      ticketId: "ticket-300",
      contentHash: hashContent({ title: "Fix the bug", description: "It is broken" }),
    });
    const mappingClosed = makeMapping({
      externalId: "issue-400",
      ticketId: "ticket-400",
      lifecycle: "open",
      contentHash: hashContent({ title: "Fix the bug", description: "It is broken" }),
    });
    const mappingMissing = makeMapping({
      externalId: "issue-999",
      ticketId: "ticket-999",
      syncStatus: "active",
    });

    const result = classifyDeltas({
      ...defaultInput,
      items: [itemNew, itemChanged, itemNoop, itemClosed],
      mappings: [mappingChanged, mappingNoop, mappingClosed, mappingMissing],
      scanCompleted: true,
    });

    // new (issue-100) + changed (issue-200) + closed (issue-400) + missing (issue-999)
    // issue-300 is a no-op.
    assert.lengthOf(result, 4);
    assert.equal(result[0]!._tag, "new");
    assert.equal(result[1]!._tag, "changed");
    assert.equal(result[2]!._tag, "closed");
    assert.equal(result[3]!._tag, "missing");
  });

  it("output ordering is deterministic: items in input order, then missing in mapping order", () => {
    const item1 = makeItem({ externalId: "issue-1" });
    const item2 = makeItem({ externalId: "issue-2" });
    const mappingMissing1 = makeMapping({ externalId: "issue-99", ticketId: "ticket-99" });
    const mappingMissing2 = makeMapping({ externalId: "issue-98", ticketId: "ticket-98" });

    const result = classifyDeltas({
      ...defaultInput,
      items: [item1, item2],
      mappings: [mappingMissing1, mappingMissing2],
      scanCompleted: true,
    });

    // Both items are new (unmapped), then two missing in mapping-array order.
    assert.equal(result[0]!._tag, "new");
    if (result[0]!._tag === "new") assert.equal(result[0]!.item.externalId, "issue-1");
    assert.equal(result[1]!._tag, "new");
    if (result[1]!._tag === "new") assert.equal(result[1]!.item.externalId, "issue-2");
    assert.equal(result[2]!._tag, "missing");
    if (result[2]!._tag === "missing") assert.equal(result[2]!.item.externalId, "issue-99");
    assert.equal(result[3]!._tag, "missing");
    if (result[3]!._tag === "missing") assert.equal(result[3]!.item.externalId, "issue-98");
  });

  it("deleted: lifecycle=deleted with open mapping and differing hash → closed delta (not changed)", () => {
    // An item with lifecycle "deleted" should be treated like "closed" —
    // emitting a "closed" delta even when the content hash differs.
    const item = makeItem({
      lifecycle: "deleted",
      fields: { title: "Deleted title", description: "Deleted body" },
    });
    const mapping = makeMapping({
      contentHash: hashContent({ title: "Fix the bug", description: "It is broken" }),
      lifecycle: "open",
    });

    const result = classifyDeltas({
      ...defaultInput,
      items: [item],
      mappings: [mapping],
      scanCompleted: true,
    });

    assert.lengthOf(result, 1);
    assert.equal(result[0]!._tag, "closed");
  });

  it("deleted: lifecycle=deleted with already-closed mapping → no delta (already terminal)", () => {
    const item = makeItem({ lifecycle: "deleted" });
    const mapping = makeMapping({ lifecycle: "closed" });

    const result = classifyDeltas({
      ...defaultInput,
      items: [item],
      mappings: [mapping],
      scanCompleted: true,
    });

    assert.lengthOf(result, 0);
  });
});

describe("buildNewSourceDelta", () => {
  it("produces a 'new' delta whose contentHash + metadata match classifyDeltas exactly", () => {
    const item = {
      provider: "github" as const,
      externalId: "issue-500",
      url: "https://github.com/acme/app/issues/500",
      lifecycle: "open" as const,
      version: { updatedAt: "2026-06-16T00:00:00Z" },
      fields: { title: "Fix it", description: "body", assignees: ["alice"], labels: ["bug"] },
    };
    const delta = buildNewSourceDelta("src-1", item);
    assert.equal(delta._tag, "new");
    if (delta._tag === "new") {
      assert.equal(delta.item.sourceId, "src-1");
      assert.equal(delta.item.externalId, "issue-500");
      assert.equal(delta.item.title, "Fix it");
      assert.equal(delta.item.contentHash, hashContent(item.fields));
      assert.equal(
        serializeSourceMetadata(delta.item.metadata),
        serializeSourceMetadata({
          provider: "github",
          url: item.url,
          assignees: item.fields.assignees,
          labels: item.fields.labels,
          lifecycle: item.lifecycle,
        }),
      );
    }
  });
});
