import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  AutoReviewFindings,
  AutoReviewSettings,
  DEFAULT_AUTO_REVIEW_SETTINGS,
} from "./autoReview.ts";
import { ServerSettings } from "./settings.ts";

const decodeAutoReview = Schema.decodeUnknownSync(AutoReviewSettings);
const decodeServer = Schema.decodeUnknownSync(ServerSettings);
const decodeFindings = Schema.decodeUnknownSync(AutoReviewFindings);

describe("AutoReviewSettings", () => {
  it("defaults to disabled auto mode with surgecode mention handle", () => {
    const settings = decodeAutoReview({});
    expect(settings.enabled).toBe(false);
    expect(settings.mode).toBe("auto");
    expect(settings.mentionHandle).toBe("surgecode");
    expect(settings.autoFixOriginThread).toBe(true);
    expect(settings.concurrency).toBe(1);
    expect(settings.projects).toEqual({});
    expect(settings).toEqual(DEFAULT_AUTO_REVIEW_SETTINGS);
  });

  it("is nested on ServerSettings by default", () => {
    expect(decodeServer({}).autoReview.enabled).toBe(false);
    expect(decodeServer({}).autoReview.mode).toBe("auto");
  });
});

describe("AutoReviewFindings", () => {
  it("decodes a minimal valid findings payload", () => {
    const findings = decodeFindings({
      summary: "Looks good overall.",
      decision: "comment",
      comments: [
        {
          path: "apps/server/src/foo.ts",
          line: 12,
          side: "RIGHT",
          severity: "important",
          body: "Null check missing.",
        },
      ],
    });
    expect(findings.comments[0]?.severity).toBe("important");
  });
});
