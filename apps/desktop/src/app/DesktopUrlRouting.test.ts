import { assert, describe, it } from "@effect/vitest";

import {
  NAVIGATE_ACTION_PREFIX,
  navigateAction,
  parseThreadDeepLink,
  threadRoutePath,
} from "./DesktopUrlRouting.ts";

const SCHEME = "t3code";
const ENV = "11111111-2222-3333-4444-555555555555";
const THREAD = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("parseThreadDeepLink", () => {
  it("parses the shape the relay and the mobile router already use", () => {
    assert.deepEqual(parseThreadDeepLink(`${SCHEME}://threads/${ENV}/${THREAD}`, SCHEME), {
      environmentId: ENV,
      threadId: THREAD,
    });
  });

  it("accepts the empty-authority form, where threads lands in the path", () => {
    assert.deepEqual(parseThreadDeepLink(`${SCHEME}:///threads/${ENV}/${THREAD}`, SCHEME), {
      environmentId: ENV,
      threadId: THREAD,
    });
  });

  it("accepts uppercase uuids", () => {
    assert.deepEqual(
      parseThreadDeepLink(`${SCHEME}://threads/${ENV.toUpperCase()}/${THREAD}`, SCHEME),
      { environmentId: ENV.toUpperCase(), threadId: THREAD },
    );
  });

  /**
   * The security case, and the reason both ids must be UUIDs. Without the shape
   * constraint this resolves to `/settings/connections`, which is a real static
   * route and outranks `/$environmentId/$threadId` — so any local process could
   * drive the window onto a settings page through an unauthenticated OS entry
   * point.
   */
  it("declines ids that are not uuids, so a link cannot reach a static route", () => {
    assert.isNull(parseThreadDeepLink(`${SCHEME}://threads/settings/connections`, SCHEME));
    assert.isNull(parseThreadDeepLink(`${SCHEME}://threads/projects/some-key`, SCHEME));
    assert.isNull(parseThreadDeepLink(`${SCHEME}://threads/${ENV}/not-a-uuid`, SCHEME));
    assert.isNull(parseThreadDeepLink(`${SCHEME}://threads/env%20one/thread%2Ftwo`, SCHEME));
  });

  it("declines credentials in the authority", () => {
    assert.isNull(parseThreadDeepLink(`${SCHEME}://user@threads/${ENV}/${THREAD}`, SCHEME));
    assert.isNull(parseThreadDeepLink(`${SCHEME}://user:pw@threads/${ENV}/${THREAD}`, SCHEME));
  });

  it("declines a malformed percent escape instead of throwing", () => {
    assert.isNull(parseThreadDeepLink(`${SCHEME}://threads/${ENV}/%E0%A4%A`, SCHEME));
  });

  /**
   * The invariant is that this side is never LOOSER than mobile. Filtering
   * empty segments would have been, so the split keeps them and an extra or
   * trailing slash is a rejection.
   */
  it("declines an extra or trailing slash, exactly as the mobile parser does", () => {
    assert.isNull(parseThreadDeepLink(`${SCHEME}://threads/${ENV}//${THREAD}`, SCHEME));
    assert.isNull(parseThreadDeepLink(`${SCHEME}://threads/${ENV}/${THREAD}/`, SCHEME));
    assert.isNull(parseThreadDeepLink(`${SCHEME}:///threads/${ENV}/${THREAD}/`, SCHEME));
  });

  /**
   * The one knowing divergence: WHATWG normalises `..` away before this sees
   * the path, so it resolves to the same thread here while mobile, which splits
   * the raw string, rejects it. Asserted so the difference is deliberate rather
   * than discovered later.
   */
  it("accepts a dot-segment that normalisation already removed", () => {
    assert.deepEqual(parseThreadDeepLink(`${SCHEME}://threads/../${ENV}/${THREAD}`, SCHEME), {
      environmentId: ENV,
      threadId: THREAD,
    });
  });

  // Every open-url listener sees every URL delivered to the app, so declining
  // has to be the quiet, normal path rather than an error.
  it("declines a Clerk OAuth callback on the same scheme", () => {
    assert.isNull(parseThreadDeepLink(`${SCHEME}://app/oauth/callback?code=abc`, SCHEME));
  });

  it("declines another scheme", () => {
    assert.isNull(parseThreadDeepLink(`https://threads/${ENV}/${THREAD}`, SCHEME));
    assert.isNull(parseThreadDeepLink(`t3code-dev://threads/${ENV}/${THREAD}`, SCHEME));
  });

  it("declines a wrong host", () => {
    assert.isNull(parseThreadDeepLink(`${SCHEME}://app/${ENV}/${THREAD}`, SCHEME));
    assert.isNull(parseThreadDeepLink(`${SCHEME}://thread/${ENV}/${THREAD}`, SCHEME));
  });

  it("declines the wrong number of segments", () => {
    assert.isNull(parseThreadDeepLink(`${SCHEME}://threads/${ENV}`, SCHEME));
    assert.isNull(parseThreadDeepLink(`${SCHEME}://threads/${ENV}/${THREAD}/terminal`, SCHEME));
    assert.isNull(parseThreadDeepLink(`${SCHEME}://threads`, SCHEME));
  });

  // Mirrors the mobile app's normalizeThreadDeepLink, which rejects both.
  it("declines a query or a fragment", () => {
    assert.isNull(parseThreadDeepLink(`${SCHEME}://threads/${ENV}/${THREAD}?x=1`, SCHEME));
    assert.isNull(parseThreadDeepLink(`${SCHEME}://threads/${ENV}/${THREAD}#top`, SCHEME));
  });

  it("declines an unparseable url", () => {
    assert.isNull(parseThreadDeepLink("not a url", SCHEME));
    assert.isNull(parseThreadDeepLink("", SCHEME));
  });

  it("respects the development scheme", () => {
    assert.deepEqual(parseThreadDeepLink(`t3code-dev://threads/${ENV}/${THREAD}`, "t3code-dev"), {
      environmentId: ENV,
      threadId: THREAD,
    });
  });
});

describe("threadRoutePath", () => {
  // The web routes a chat WITHOUT the threads/ prefix the link carries; that
  // translation is the whole job of this function.
  it("drops the threads prefix the link carries", () => {
    assert.strictEqual(
      threadRoutePath({ environmentId: ENV, threadId: THREAD }),
      `/${ENV}/${THREAD}`,
    );
  });

  it("encodes ids that would otherwise break the path", () => {
    assert.strictEqual(threadRoutePath({ environmentId: "a/b", threadId: "c d" }), "/a%2Fb/c%20d");
  });
});

describe("navigateAction", () => {
  it("prefixes the path so the renderer can tell it from a menu item", () => {
    assert.strictEqual(navigateAction("/a/b"), `${NAVIGATE_ACTION_PREFIX}/a/b`);
  });

  /**
   * The renderer declares the same prefix separately, in
   * `apps/web/src/menuActionNavigation.ts`, because the renderer bundle must
   * not import from the Electron main process and the two packages are separate
   * TypeScript projects. Nothing else would notice if they drifted: both suites
   * would stay green and deep links would silently stop working with nothing
   * pointing at the cause. Both sides pin the literal instead, so whichever one
   * is edited fails its own test.
   */
  it("pins the literal the renderer also pins", () => {
    assert.strictEqual(NAVIGATE_ACTION_PREFIX, "navigate:");
  });
});
