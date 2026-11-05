import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { directThreadWaits, mentionedThreadRefs } from "./threadReferenceRelationships.ts";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const ref = (environmentId: EnvironmentId, threadId: string) => ({
  environmentId,
  threadId: ThreadId.make(threadId),
});

describe("mentioned thread references", () => {
  it("resolves links like the UI, ignores code, and deduplicates", () => {
    const target = ref(remote, "thread:one");
    const localThread = ref(local, "thread:one");
    expect(
      mentionedThreadRefs(
        "[old](t3-thread://v2/remote/thread%3Aone) <t3-thread://v2/remote/thread:one> ` [ignored](t3-thread://v1/thread:one) `",
        local,
        [target, localThread],
      ),
    ).toEqual([target]);
  });

  it("uses the local match first and does not guess an ambiguous legacy link", () => {
    const a = ref(remote, "one");
    const b = ref(EnvironmentId.make("other"), "one");
    expect(mentionedThreadRefs("[one](t3-thread://v1/one)", local, [a, b])).toEqual([]);
    const here = ref(local, "one");
    expect(mentionedThreadRefs("[one](t3-thread://v1/one)", local, [a, b, here])).toEqual([here]);
  });
});

describe("direct thread waits", () => {
  it("includes only live waits from the active run and preserves their environment", () => {
    const item = {
      runId: "run",
      type: "dynamic_tool",
      status: "running",
      toolName: "mcp__t3_code__t3_thread_wait",
      input: { threadId: "one", environmentId: remote },
    };
    expect(
      directThreadWaits({
        environmentId: local,
        activeRunId: "run",
        items: [
          item,
          item,
          { ...item, status: "completed" },
          { ...item, runId: "old", input: { threadId: "old" } },
          { ...item, toolName: "weather.t3_thread_wait", input: { threadId: "foreign" } },
        ],
      }),
    ).toEqual([ref(remote, "one")]);
    expect(directThreadWaits({ environmentId: local, activeRunId: null, items: [item] })).toEqual(
      [],
    );
  });
});
