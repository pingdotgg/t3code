import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ExecutionEnvironmentDescriptor,
  supportsLessonSideChats,
  supportsSideChats,
} from "./environment.ts";

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

const descriptor = {
  environmentId: "environment-1",
  label: "Local",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.32",
  capabilities: { repositoryIdentity: true },
} as const;

describe("ExecutionEnvironmentDescriptor", () => {
  it("decodes old, recognized and future manual installation descriptors", () => {
    expect(decodeDescriptor(descriptor).capabilities.serverInstallation).toBeUndefined();
    for (const installation of [{ kind: "npx" }, { kind: "npm-global", prefix: "/opt/node" }]) {
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, serverInstallation: installation },
        }).capabilities.serverInstallation,
      ).toEqual(installation);
    }
    for (const installation of [{ kind: "future-manager" }, { kind: "npm-global" }]) {
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, serverInstallation: installation },
        }).capabilities.serverInstallation,
      ).toBeUndefined();
    }
  });
});

describe("side-chat capabilities", () => {
  it("tells T3 Learn side chats from upstream side chats across server versions", () => {
    const cases = [
      { serverVersion: "0.1.6", capabilities: {}, lesson: false, upstream: false },
      { serverVersion: "0.1.6", capabilities: { sideChats: true }, lesson: false, upstream: true },
      // A released T3 Learn server from before `lessonSideChats` meant its own side chats.
      {
        serverVersion: "0.1.3-learn.8",
        capabilities: { sideChats: true },
        lesson: true,
        upstream: false,
      },
      {
        serverVersion: "0.1.6-learn.1",
        capabilities: { sideChats: true, lessonSideChats: true },
        lesson: true,
        upstream: true,
      },
    ] as const;
    for (const { serverVersion, capabilities: advertised, lesson, upstream } of cases) {
      const capabilities = { repositoryIdentity: true, ...advertised };
      expect(supportsLessonSideChats({ serverVersion, capabilities })).toBe(lesson);
      expect(supportsSideChats({ serverVersion, capabilities })).toBe(upstream);
    }
  });
});
