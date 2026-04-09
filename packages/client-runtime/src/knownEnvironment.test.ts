import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { createKnownEnvironmentFromWsUrl } from "./knownEnvironment";
import {
  parseScopedProjectKey,
  parseScopedThreadKey,
  scopedProjectKey,
  scopedRefKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "./scoped";

describe("known environment bootstrap helpers", () => {
  it("creates known environments from explicit ws urls", () => {
    expect(
      createKnownEnvironmentFromWsUrl({
        label: "Remote environment",
        wsUrl: "wss://remote.example.com/ws",
      }),
    ).toEqual({
      id: "ws:Remote environment",
      label: "Remote environment",
      source: "manual",
      target: {
        type: "ws",
        wsUrl: "wss://remote.example.com/ws",
      },
    });
  });
});

describe("scoped refs", () => {
  const environmentId = EnvironmentId.makeUnsafe("environment-test");
  const projectRef = scopeProjectRef(environmentId, ProjectId.makeUnsafe("project-1"));
  const threadRef = scopeThreadRef(environmentId, ThreadId.makeUnsafe("thread-1"));

  it("builds stable scoped project and thread keys", () => {
    expect(scopedRefKey(projectRef)).toBe("environment-test:project-1");
    expect(scopedRefKey(threadRef)).toBe("environment-test:thread-1");
    expect(scopedProjectKey(projectRef)).toBe("environment-test:project-1");
    expect(scopedThreadKey(threadRef)).toBe("environment-test:thread-1");
  });

  it("returns typed scoped refs", () => {
    expect(projectRef).toEqual({
      environmentId,
      projectId: ProjectId.makeUnsafe("project-1"),
    });
    expect(threadRef).toEqual({
      environmentId,
      threadId: ThreadId.makeUnsafe("thread-1"),
    });
  });

  it("parses scoped project and thread keys back into refs", () => {
    expect(parseScopedProjectKey("environment-test:project-1")).toEqual(projectRef);
    expect(parseScopedThreadKey("environment-test:thread-1")).toEqual(threadRef);
    expect(parseScopedProjectKey("bad-key")).toBeNull();
    expect(parseScopedThreadKey("bad-key")).toBeNull();
  });
});
