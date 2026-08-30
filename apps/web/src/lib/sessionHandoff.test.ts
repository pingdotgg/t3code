import { describe, expect, it } from "vite-plus/test";

import { buildSessionHandoffPrompt, parseSessionHandoff } from "./sessionHandoff";

const packet = `Before
<!-- t3-handoff:1 -->
# Handoff

## Outcome
The first task is complete.

## Next task
Implement the follow-up and verify it in the app.

## References
apps/web/src/App.tsx
<!-- /t3-handoff -->
After`;

describe("parseSessionHandoff", () => {
  it("extracts the packet and next task from a marked assistant response", () => {
    expect(parseSessionHandoff(packet)).toEqual({
      packet: `# Handoff

## Outcome
The first task is complete.

## Next task
Implement the follow-up and verify it in the app.

## References
apps/web/src/App.tsx`,
      nextTask: "Implement the follow-up and verify it in the app.",
      title: "Implement the follow-up and verify it in the app.",
    });
  });

  it("rejects incomplete or unmarked responses", () => {
    expect(parseSessionHandoff("## Next task\nDo the thing.")).toBeNull();
    expect(parseSessionHandoff("<!-- t3-handoff:1 -->\n# Handoff")).toBeNull();
    expect(
      parseSessionHandoff("<!-- t3-handoff:1 -->\n# Handoff\n<!-- /t3-handoff -->"),
    ).toBeNull();
  });
});

describe("buildSessionHandoffPrompt", () => {
  it("adds a source-thread link and the transfer instruction", () => {
    const handoff = parseSessionHandoff(packet)!;
    expect(
      buildSessionHandoffPrompt({
        handoff,
        sourceEnvironmentId: "local env",
        sourceThreadId: "thread/1",
      }),
    ).toContain("[previous thread](/local%20env/thread%2F1)");
  });
});
