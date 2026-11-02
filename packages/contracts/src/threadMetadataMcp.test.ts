import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ThreadMetadataMcpUpdateInput,
  ThreadMetadataMcpUpdateResult,
} from "./threadMetadataMcp.ts";

const decodeUpdate = Schema.decodeUnknownSync(ThreadMetadataMcpUpdateInput);
const decodeResult = Schema.decodeSync(ThreadMetadataMcpUpdateResult);

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

  it("reads an update result from an older linked server that sends no tags", () => {
    const result = decodeResult({
      threadId: "thread-1",
      action: "rename",
      commandId: "command-1",
      sequence: 1,
      title: "Renamed",
      titleRegeneration: null,
      linkedPullRequest: null,
      updatedAt: "2026-11-01T00:00:00.000Z",
    });
    assert.deepEqual(result.tags, []);
  });
});
