import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ContributorBundle } from "./contributorBundle.ts";

const decode = Schema.decodeUnknownSync(ContributorBundle);

describe("ContributorBundle", () => {
  it("decodes a Workshop-like repo bundle with orientation", () => {
    const decoded = decode({
      name: "T3 Code Workshop",
      orientation: {
        summary: "A GUI for coding agents.",
        map: [{ path: "apps/server", purpose: "Orchestration" }],
        guidance: "Run check:changed before push.",
      },
      seats: [
        { id: "lead", title: "Workshop · Lead", roleBrief: "Coordinate." },
        { id: "builder", title: "Workshop · Builder", roleBrief: "Implement." },
      ],
    });

    expect(decoded.name).toBe("T3 Code Workshop");
    expect(decoded.orientation.map?.[0]?.path).toBe("apps/server");
    expect(decoded.seats).toHaveLength(2);
  });
});
