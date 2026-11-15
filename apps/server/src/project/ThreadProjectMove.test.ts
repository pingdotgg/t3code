import { type ModelSelection, ProviderInstanceId, type ThreadMoveBundle } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { movedModelSelection, threadMoveBundleFits } from "./ThreadProjectMove.ts";

const source = { instanceId: ProviderInstanceId.make("source-only"), model: "s" };
const fallback = { instanceId: ProviderInstanceId.make("codex"), model: "d" };

describe("movedModelSelection", () => {
  it.each<{
    readonly case: string;
    readonly usable: ReadonlyArray<string>;
    readonly projectDefault: ModelSelection | null;
    readonly expected: ModelSelection | null;
  }>([
    {
      case: "the source instance exists here",
      usable: ["source-only"],
      projectDefault: fallback,
      expected: source,
    },
    {
      case: "only the default is usable",
      usable: ["codex"],
      projectDefault: fallback,
      expected: fallback,
    },
    { case: "no default is set", usable: ["codex"], projectDefault: null, expected: null },
    {
      case: "the default's instance is missing or disabled",
      usable: [],
      projectDefault: fallback,
      expected: null,
    },
  ])("$case", ({ usable, projectDefault, expected }) => {
    expect(
      movedModelSelection({
        source,
        projectDefault,
        usable: (instanceId) => usable.includes(instanceId),
      }),
    ).toEqual(expected);
  });
});

describe("threadMoveBundleFits", () => {
  const bundle: ThreadMoveBundle = {
    title: "Port the parser",
    modelSelection: source,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-01-01T00:00:00.000Z",
    messages: [{ role: "user", text: "Port it.", createdAt: "2026-01-01T00:00:00.000Z" }],
  };
  const bytes = Buffer.byteLength(JSON.stringify(bundle), "utf8");

  it("accepts a bundle at the limit and refuses one byte over", () => {
    expect(threadMoveBundleFits(bundle, bytes)).toBe(true);
    expect(threadMoveBundleFits(bundle, bytes - 1)).toBe(false);
  });
});
