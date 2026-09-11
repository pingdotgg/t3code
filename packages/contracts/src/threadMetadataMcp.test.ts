import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ThreadMetadataMcpUpdateInput } from "./threadMetadataMcp.ts";

const decodeUpdate = Schema.decodeUnknownSync(ThreadMetadataMcpUpdateInput);

describe("ThreadMetadataMcpUpdateInput", () => {
  it("decodes each metadata action with only its required fields", () => {
    assert.deepEqual(decodeUpdate({ action: "rename", title: "Release follow-up" }), {
      action: "rename",
      title: "Release follow-up",
    });
    assert.deepEqual(decodeUpdate({ action: "regenerate_title" }), {
      action: "regenerate_title",
    });
    assert.deepEqual(
      decodeUpdate({
        action: "link_pull_request",
        pullRequest: {
          repository: "pingdotgg/t3code",
          number: 8689,
          url: "https://github.com/pingdotgg/t3code/pull/8689",
        },
      }),
      {
        action: "link_pull_request",
        pullRequest: {
          repository: "pingdotgg/t3code",
          number: 8689,
          url: "https://github.com/pingdotgg/t3code/pull/8689",
        },
      },
    );
    assert.deepEqual(decodeUpdate({ action: "unlink_pull_request" }), {
      action: "unlink_pull_request",
    });
  });

  it("rejects missing action data and fields from another action", () => {
    assert.throws(() => decodeUpdate({ action: "rename" }));
    assert.throws(() => decodeUpdate({ action: "regenerate_title", title: "Not allowed" }));
    assert.throws(() => decodeUpdate({ action: "link_pull_request" }));
    assert.throws(() =>
      decodeUpdate({
        action: "unlink_pull_request",
        pullRequest: {
          repository: "pingdotgg/t3code",
          number: 8689,
          url: "https://github.com/pingdotgg/t3code/pull/8689",
        },
      }),
    );
  });

  it("rejects unknown actions", () => {
    assert.throws(() => decodeUpdate({ action: "move_workspace" }));
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

  it("accepts HTTP(S) pull request URLs and rejects other or malformed URLs", () => {
    assert.deepEqual(
      decodeUpdate({
        action: "link_pull_request",
        pullRequest: {
          repository: "engineering/t3code",
          number: 42,
          url: "https://git.corp.example/engineering/t3code/pulls/42",
        },
      }).pullRequest,
      {
        repository: "engineering/t3code",
        number: 42,
        url: "https://git.corp.example/engineering/t3code/pulls/42",
      },
    );

    for (const url of ["not a URL", "javascript:alert(1)", "file:///tmp/pull-request"]) {
      assert.throws(() =>
        decodeUpdate({
          action: "link_pull_request",
          pullRequest: { repository: "pingdotgg/t3code", number: 8690, url },
        }),
      );
    }
  });
});
