import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ThreadMetadataMcpUpdateInput } from "./threadMetadataMcp.ts";

const decodeUpdate = Schema.decodeUnknownSync(ThreadMetadataMcpUpdateInput);

describe("ThreadMetadataMcpUpdateInput", () => {
  it("accepts workspace moves and requires a destination", () => {
    assert.deepEqual(
      decodeUpdate({ action: "change_workspace", projectId: "destination", worktreePath: null }),
      {
        action: "change_workspace",
        projectId: "destination",
        worktreePath: null,
      },
    );
    assert.throws(() => decodeUpdate({ action: "change_workspace" }));
    assert.throws(() =>
      decodeUpdate({ action: "rename", title: "Name", projectId: "destination" }),
    );
  });

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
});
