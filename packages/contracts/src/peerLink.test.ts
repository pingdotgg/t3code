import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { PeerLinkRequestError } from "./peerLink.ts";

const decodeError = Schema.decodeUnknownSync(PeerLinkRequestError);
const encodeError = Schema.encodeSync(PeerLinkRequestError);

describe("PeerLinkRequestError", () => {
  it("decodes a reason from a newer server as unknown, and known reasons as themselves", () => {
    const known = decodeError({ _tag: "PeerLinkRequestError", reason: "link_gone" });
    expect(known.reason).toBe("link_gone");
    expect(known.message).toBe("That link was removed or expired. Link the machine again.");
    expect(encodeError(known)).toMatchObject({ reason: "link_gone" });

    const newer = decodeError({ _tag: "PeerLinkRequestError", reason: "link_frozen" });
    expect(newer.reason).toBe("unknown");
    expect(newer.message).toBe("Could not answer the request. Try again.");
  });
});
