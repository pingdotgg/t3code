import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ThreadMetadataMcpUpdateInput } from "./threadMetadataMcp.ts";

const decodeUpdate = Schema.decodeUnknownSync(ThreadMetadataMcpUpdateInput);

describe("ThreadMetadataMcpUpdateInput", () => {
  it("rejects malformed client request ids without normalizing valid keys", () => {
    const validKey = "metadata-\ud83d\ude80-1";
    assert.equal(
      decodeUpdate({ action: "regenerate_title", clientRequestId: validKey }).clientRequestId,
      validKey,
    );
    assert.throws(() =>
      decodeUpdate({ action: "regenerate_title", clientRequestId: "metadata-\ud800" }),
    );
    assert.throws(() =>
      decodeUpdate({ action: "regenerate_title", clientRequestId: "metadata-\udc00" }),
    );
  });

  it("advertises its parameter descriptions in the encoded JSON schema", () => {
    const { properties } = Schema.toJsonSchemaDocument(ThreadMetadataMcpUpdateInput).schema as {
      properties: Record<string, { description?: string }>;
    };
    assert.equal(
      properties.title?.description,
      "New concise display title. Required only when action is rename.",
    );
    assert.equal(
      properties.clientRequestId?.description,
      "Stable idempotency key to reuse when retrying this mutation.",
    );
  });
});
