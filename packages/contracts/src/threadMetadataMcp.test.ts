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
});
