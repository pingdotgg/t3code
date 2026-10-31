import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveDictationEnvironment } from "./dictation.ts";

const laptop = EnvironmentId.make("laptop");
const server = EnvironmentId.make("server");
const studio = EnvironmentId.make("studio");

describe("resolveDictationEnvironment", () => {
  it("uses the chosen environment while it is ready", () => {
    expect(
      resolveDictationEnvironment({
        chosen: studio,
        draftEnvironmentId: server,
        primaryEnvironmentId: laptop,
        ready: [laptop, server, studio],
      }),
    ).toBe(studio);
  });

  it("falls back to the draft's environment, then the primary, then any ready one", () => {
    const resolve = (ready: ReadonlyArray<EnvironmentId>) =>
      resolveDictationEnvironment({
        chosen: studio,
        draftEnvironmentId: server,
        primaryEnvironmentId: laptop,
        ready,
      });
    expect(resolve([laptop, server])).toBe(server);
    expect(resolve([laptop])).toBe(laptop);
    expect(
      resolveDictationEnvironment({
        chosen: null,
        draftEnvironmentId: server,
        primaryEnvironmentId: null,
        ready: [studio],
      }),
    ).toBe(studio);
  });

  it("returns null when no environment is ready", () => {
    expect(
      resolveDictationEnvironment({
        chosen: laptop,
        draftEnvironmentId: server,
        primaryEnvironmentId: laptop,
        ready: [],
      }),
    ).toBeNull();
  });
});
