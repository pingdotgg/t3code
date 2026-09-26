import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  canGoBack,
  canGoForward,
  currentUrl,
  describeStatus,
  NO_SESSION_NOTICE,
  goBack,
  goForward,
  initialNavigationState,
  isBrowserPreviewFile,
  normalizeAddress,
  recentTargets,
  reload,
  submitAddress,
  tabLabel,
} from "./viewModel.ts";

NodeTest.describe("normalizeAddress", () => {
  NodeTest.it("defaults bare loopback hosts to http", () => {
    NodeAssert.equal(normalizeAddress("localhost:5173").url, "http://localhost:5173/");
    NodeAssert.equal(normalizeAddress("127.0.0.1:3000/app").url, "http://127.0.0.1:3000/app");
  });

  NodeTest.it("defaults bare public hosts to https", () => {
    NodeAssert.equal(normalizeAddress("example.com").url, "https://example.com/");
  });

  NodeTest.it("accepts qualified http(s) URLs and returns href form", () => {
    NodeAssert.equal(
      normalizeAddress("https://example.com/a?b=1").url,
      "https://example.com/a?b=1",
    );
    NodeAssert.equal(normalizeAddress("http://dev.local:8080").url, "http://dev.local:8080/");
  });

  NodeTest.it("rejects empty input", () => {
    const result = normalizeAddress("   ");
    NodeAssert.equal(result.ok, false);
    NodeAssert.match(result.message, /empty/i);
  });

  NodeTest.it("rejects unsupported protocols", () => {
    const result = normalizeAddress("ftp://example.com/file");
    NodeAssert.equal(result.ok, false);
    NodeAssert.match(result.message, /unsupported-protocol/i);
  });

  NodeTest.it("rejects unparseable input", () => {
    const result = normalizeAddress("http://[::1");
    NodeAssert.equal(result.ok, false);
  });
});

NodeTest.describe("submitAddress", () => {
  NodeTest.it("records a valid target as current", () => {
    const state = submitAddress(initialNavigationState, "example.com");
    NodeAssert.equal(state.history.length, 1);
    NodeAssert.equal(state.index, 0);
    NodeAssert.equal(state.epoch, 1);
    NodeAssert.deepEqual(state.status, { kind: "target", url: "https://example.com/" });
  });

  NodeTest.it("rejected input never enters history", () => {
    const state = submitAddress(initialNavigationState, "not a url at all spaces");
    NodeAssert.equal(state.status.kind, "rejected");
    NodeAssert.equal(state.history.length, 0);
    NodeAssert.equal(state.index, -1);
    NodeAssert.equal(state.epoch, 0);
  });

  NodeTest.it("rejection preserves the existing history and current target", () => {
    const first = submitAddress(initialNavigationState, "example.com");
    const next = submitAddress(first, "ftp://bad");
    NodeAssert.equal(next.status.kind, "rejected");
    NodeAssert.equal(next.history.length, 1);
    NodeAssert.equal(next.index, 0);
    NodeAssert.equal(currentUrl(next), "https://example.com/");
  });

  NodeTest.it("submitting after goBack truncates the forward entries", () => {
    let state = initialNavigationState;
    state = submitAddress(state, "a.example.com");
    state = submitAddress(state, "b.example.com");
    state = submitAddress(state, "c.example.com");
    state = goBack(state);
    state = goBack(state);
    NodeAssert.equal(currentUrl(state), "https://a.example.com/");
    state = submitAddress(state, "d.example.com");
    NodeAssert.deepEqual(state.history, ["https://a.example.com/", "https://d.example.com/"]);
    NodeAssert.equal(state.index, 1);
    NodeAssert.equal(canGoForward(state), false);
  });
});

NodeTest.describe("history traversal", () => {
  const loaded = () => {
    let state = initialNavigationState;
    state = submitAddress(state, "a.example.com");
    state = submitAddress(state, "b.example.com");
    return state;
  };

  NodeTest.it("canGoBack/canGoForward track the cursor", () => {
    const state = loaded();
    NodeAssert.equal(canGoBack(state), true);
    NodeAssert.equal(canGoForward(state), false);
    const back = goBack(state);
    NodeAssert.equal(canGoBack(back), false);
    NodeAssert.equal(canGoForward(back), true);
    NodeAssert.equal(currentUrl(back), "https://a.example.com/");
    const forward = goForward(back);
    NodeAssert.equal(currentUrl(forward), "https://b.example.com/");
  });

  NodeTest.it("goBack/goForward are no-ops at the bounds", () => {
    const state = loaded();
    NodeAssert.equal(goForward(state), state);
    const atStart = goBack(state);
    NodeAssert.equal(goBack(atStart), atStart);
    NodeAssert.equal(goBack(initialNavigationState), initialNavigationState);
  });

  NodeTest.it("recentTargets lists newest first, paired with the stack index", () => {
    NodeAssert.deepEqual(recentTargets(loaded()), [
      { url: "https://b.example.com/", index: 1 },
      { url: "https://a.example.com/", index: 0 },
    ]);
    NodeAssert.deepEqual(recentTargets(initialNavigationState), []);
  });

  NodeTest.it("lease urls stay in the nav stack but never list as targets", () => {
    // A minted workspace-file url expires
    // with its token — clicking it later opens a guaranteed 404. It must be
    // filtered from the rendered list while remaining in history so
    // back/forward and currentUrl keep matching the session's traversal.
    const lease = "http://localhost:3773/api/assets/tok/site/index.html";
    let state = submitAddress(initialNavigationState, "example.com");
    state = submitAddress(state, lease);
    NodeAssert.equal(currentUrl(state), lease, "the file view stays the current target");
    NodeAssert.equal(canGoBack(state), true, "stack keeps the lease entry");
    NodeAssert.deepEqual(recentTargets(state), [{ url: "https://example.com/", index: 0 }]);
    NodeAssert.equal(recentTargets(goBack(state))[0]?.index, 0);
  });
});

NodeTest.describe("reload", () => {
  NodeTest.it("re-requests the current target without touching history", () => {
    const state = submitAddress(initialNavigationState, "example.com");
    const next = reload(state);
    NodeAssert.equal(next.epoch, state.epoch + 1);
    NodeAssert.equal(next.history, state.history);
    NodeAssert.equal(next.index, state.index);
    NodeAssert.equal(next.status.kind, "target");
  });

  NodeTest.it("is a no-op when there is no current target", () => {
    NodeAssert.equal(reload(initialNavigationState), initialNavigationState);
    const rejected = submitAddress(initialNavigationState, "ftp://bad");
    NodeAssert.equal(reload(rejected), rejected);
  });
});

NodeTest.describe("describeStatus", () => {
  NodeTest.it("names the idle state", () => {
    NodeAssert.match(describeStatus(initialNavigationState), /nothing requested/i);
  });

  NodeTest.it("names the rejected input and reason", () => {
    const state = submitAddress(initialNavigationState, "ftp://bad");
    const text = describeStatus(state);
    NodeAssert.match(text, /Rejected/);
    NodeAssert.match(text, /ftp:\/\/bad/);
  });

  NodeTest.it("names the requested target honestly — requested, never 'loaded'", () => {
    const state = submitAddress(initialNavigationState, "example.com");
    const text = describeStatus(state);
    NodeAssert.match(text, /Requested https:\/\/example\.com\//);
    NodeAssert.doesNotMatch(text, /loaded/i);
  });

  NodeTest.it("the no-session notice names the contract that opens one", () => {
    NodeAssert.match(NO_SESSION_NOTICE, /t3\.browser\/sessions/);
  });
});

NodeTest.describe("tabLabel", () => {
  NodeTest.it("prefers a non-empty page title", () => {
    NodeAssert.equal(tabLabel("  Deploy docs  ", "https://example.com/"), "Deploy docs");
  });

  NodeTest.it("falls back to the url host, then the neutral label", () => {
    NodeAssert.equal(tabLabel("", "https://example.com:8443/app"), "example.com:8443");
    NodeAssert.equal(tabLabel("   ", "not a url"), "Browser");
    NodeAssert.equal(tabLabel("", null), "Browser");
  });
});

NodeTest.describe("isBrowserPreviewFile", () => {
  NodeTest.it("accepts html/htm/pdf like the native rule", () => {
    for (const path of ["index.html", "docs/guide.htm", "report.PDF", "a/b/c.html?x=1"])
      NodeAssert.equal(isBrowserPreviewFile(path), true, path);
  });

  NodeTest.it("rejects everything else", () => {
    for (const path of ["notes.txt", "app.ts", "archive.htmlz", ".htmlrc", "page"])
      NodeAssert.equal(isBrowserPreviewFile(path), false, path);
  });
});
