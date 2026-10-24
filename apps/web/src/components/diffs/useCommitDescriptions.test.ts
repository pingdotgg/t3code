import { describe, expect, it } from "vite-plus/test";

import { nextCommitDescriptionBatch } from "./useCommitDescriptions";

const shas = Array.from({ length: 25 }, (_, index) => `sha${index}`);

describe("nextCommitDescriptionBatch", () => {
  it("requests only the visible window, ten at a time, skipping requested commits", () => {
    expect(nextCommitDescriptionBatch(shas, 10, new Set())).toEqual(shas.slice(0, 10));
    expect(nextCommitDescriptionBatch(shas, 10, new Set(shas.slice(0, 10)))).toEqual([]);
    expect(nextCommitDescriptionBatch(shas, 20, new Set(shas.slice(0, 10)))).toEqual(
      shas.slice(10, 20),
    );
    expect(nextCommitDescriptionBatch(shas, 30, new Set(shas.slice(0, 20)))).toEqual(
      shas.slice(20),
    );
  });
});
