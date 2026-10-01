import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  BROWSER_CLEAR_CACHE,
  BROWSER_CLEAR_COOKIES,
  BROWSER_IMPORT_COOKIES,
  BROWSER_PROFILES,
  browserProfilesApi,
} from "@t3tools/extension-sdk/catalogue";

import {
  DEFAULT_PROFILE_ID,
  PROFILE_ACTION_GRANT,
  clearResultMessage,
  importableSources,
  importResultMessage,
  isGrantDenial,
  profileFailureMessage,
  profileLabel,
  reopenRequest,
  sessionProfileId,
} from "./profiles.ts";

function session(overrides = {}) {
  return {
    tabId: "tab-1",
    requestedUrl: "http://localhost:5173/",
    navigation: { kind: "failed", url: "http://localhost:5173/", title: "", failureCode: "crash" },
    canGoBack: false,
    canGoForward: false,
    viewport: { _tag: "fill" },
    engine: { state: "crashed", generation: "41", reason: "recovery-exhausted" },
    zoomFactor: 1,
    appearance: "system",
    audioMuted: false,
    audible: false,
    ...overrides,
  };
}

const list = {
  profiles: [
    { id: "default", name: "Default" },
    { id: "incognito", name: "Incognito" },
    { id: "work", name: "Work" },
  ],
  defaultProfileId: "default",
};

NodeTest.describe("profile grants", () => {
  NodeTest.it("each action names the grant the contract enforces for it", () => {
    const declared = Object.fromEntries(
      browserProfilesApi.definition.methods.map((method) => [method.name, method.requiredGrants]),
    );
    for (const [action, grant] of Object.entries(PROFILE_ACTION_GRANT)) {
      NodeAssert.ok(declared[action].includes(grant), action);
    }
    // Four capabilities, four distinct grants.
    NodeAssert.deepEqual(
      new Set(Object.values(PROFILE_ACTION_GRANT)),
      new Set([
        BROWSER_PROFILES,
        BROWSER_CLEAR_COOKIES,
        BROWSER_CLEAR_CACHE,
        BROWSER_IMPORT_COOKIES,
      ]),
    );
  });

  NodeTest.it("a broker denial names exactly the missing grant", () => {
    const denial = new Error(`API capability denied: ${BROWSER_CLEAR_CACHE}`);
    NodeAssert.equal(isGrantDenial(denial), true);
    NodeAssert.equal(
      profileFailureMessage("clearCache", denial),
      `Clearing the cache — Needs permission ${BROWSER_CLEAR_CACHE}. Grant it in Settings → Extensions.`,
    );
    // open needs sessions + operate + profiles; the message names whichever is missing.
    NodeAssert.match(
      profileFailureMessage("open", new Error("API capability denied: t3.browser/operate")),
      /Needs permission t3\.browser\/operate\./,
    );
  });

  NodeTest.it("desktop-required, engine-unsupported and a gone profile are named failures", () => {
    NodeAssert.match(
      profileFailureMessage(
        "clearCookies",
        new Error(
          "BrowserProfilesUnsupported: 'clearCookies' requires the T3 Code desktop app's browser engine; none is connected to this environment (desktop-required).",
        ),
      ),
      /needs the T3 Code desktop app .*\(desktop-required\)\.$/,
    );
    NodeAssert.match(
      profileFailureMessage(
        "importCookies",
        new Error("BrowserProfilesUnsupported: … (engine-unsupported)."),
      ),
      /not supported by this desktop's browser engine \(engine-unsupported\)/,
    );
    NodeAssert.match(
      profileFailureMessage("clearCookies", new Error("BrowserProfileNotFound: gone")),
      /\(profile-not-found\)/,
    );
    NodeAssert.equal(isGrantDenial(new Error("BrowserProfileNotFound: gone")), false);
  });
});

NodeTest.describe("profile identity", () => {
  NodeTest.it("an unset session profile is the default partition", () => {
    NodeAssert.equal(sessionProfileId(session()), DEFAULT_PROFILE_ID);
    NodeAssert.equal(sessionProfileId(session({ profileId: "work" })), "work");
    NodeAssert.equal(sessionProfileId(null), DEFAULT_PROFILE_ID);
  });

  NodeTest.it("labels a deleted profile the way the native heading does", () => {
    NodeAssert.equal(profileLabel(list, "work"), "Work");
    NodeAssert.equal(profileLabel(list, "gone"), "Removed profile");
    // Before (or without) the list grant the raw id is all there is.
    NodeAssert.equal(profileLabel(null, "default"), "Default");
    NodeAssert.equal(profileLabel(null, "work"), "work");
  });

  NodeTest.it("a dead session's page reopens in its own profile, never the default", () => {
    NodeAssert.deepEqual(reopenRequest(session({ profileId: "work" }), "http://localhost:5173/"), {
      api: "profiles",
      input: { profileId: "work", url: "http://localhost:5173/" },
    });
    NodeAssert.deepEqual(reopenRequest(session({ profileId: "default" }), "http://a.test/"), {
      api: "sessions",
      input: { url: "http://a.test/" },
    });
    NodeAssert.deepEqual(reopenRequest(session(), "http://a.test/"), {
      api: "sessions",
      input: { url: "http://a.test/" },
    });
    NodeAssert.deepEqual(reopenRequest(null, "http://a.test/"), {
      api: "sessions",
      input: { url: "http://a.test/" },
    });
  });
});

NodeTest.describe("clear and import results", () => {
  NodeTest.it("a cleared profile says so; an unanswered clear never claims success", () => {
    NodeAssert.equal(
      clearResultMessage({ outcome: "cleared", profileId: "work" }, "clearCookies", "Work"),
      'Cookies cleared for "Work" — every page in that profile is signed out.',
    );
    NodeAssert.equal(
      clearResultMessage({ outcome: "cleared", profileId: "work" }, "clearCache", "Work"),
      'Cache cleared for "Work".',
    );
    const unknown = clearResultMessage(
      { outcome: "unknown", profileId: "work" },
      "clearCache",
      "Work",
    );
    NodeAssert.match(unknown, /\(unknown\)/);
    NodeAssert.doesNotMatch(unknown, /cleared for/);
  });

  NodeTest.it("import results report counts, refusals and closed failure reasons", () => {
    NodeAssert.equal(
      importResultMessage(
        { outcome: "imported", profileId: "work", imported: 38, skipped: 2 },
        "Work",
      ),
      'Imported 38 cookies into "Work" (2 skipped).',
    );
    NodeAssert.equal(
      importResultMessage(
        { outcome: "imported", profileId: "work", imported: 1, skipped: 0 },
        "Work",
      ),
      'Imported 1 cookie into "Work".',
    );
    NodeAssert.equal(
      importResultMessage({ outcome: "declined", profileId: "work" }, "Work"),
      "Cookie import was declined on the desktop.",
    );
    NodeAssert.match(
      importResultMessage(
        { outcome: "failed", profileId: "work", reason: "browserRunning" },
        "Work",
      ),
      /^Cookie import failed \(browserRunning\) — quit that browser/,
    );
    NodeAssert.match(
      importResultMessage({ outcome: "unknown", profileId: "work" }, "Work"),
      /\(unknown\)/,
    );
  });

  NodeTest.it("hides sources nothing can fix, keeps the ones a step can unblock", () => {
    const sources = [
      { id: "chrome", name: "Google Chrome", profiles: [{ handle: "p0", name: "Person 1" }] },
      { id: "edge", name: "Microsoft Edge", unavailable: "notInstalled", profiles: [] },
      { id: "safari", name: "Safari", unavailable: "needsFullDiskAccess", profiles: [] },
      { id: "arc", name: "Arc", unavailable: "unsupportedPlatform", profiles: [] },
    ];
    NodeAssert.deepEqual(
      importableSources(sources).map((source) => source.id),
      ["chrome", "safari"],
    );
  });
});
