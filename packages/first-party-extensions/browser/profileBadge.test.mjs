/**
 * The chrome-row profile badge and the page menu's profile group over the
 * REAL profileMenu.tsx and profiles.ts, bundled by esbuild into the system
 * tmpdir and rendered with react-test-renderer against a stubbed
 * `t3.browser/profiles`: a host serving the 1.1.0 `changes` stream, and an
 * older one answering reads only.
 */
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

const require = NodeModule.createRequire(new URL(".", import.meta.url));
const { build } = require("esbuild");
const React = require("react");
const { act, create } = require("react-test-renderer");

const packageDir = NodeURL.fileURLToPath(new URL(".", import.meta.url));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let ProfileBadge;
let ProfileSection;
let createProfileListStore;

NodeTest.before(async () => {
  const built = await build({
    stdin: {
      contents: [
        'export { ProfileBadge, ProfileSection } from "./profileMenu.tsx";',
        'export { createProfileListStore } from "./profiles.ts";',
      ].join("\n"),
      resolveDir: packageDir,
      loader: "ts",
    },
    bundle: true,
    write: false,
    jsx: "automatic",
    platform: "node",
    format: "esm",
    plugins: [
      {
        name: "external-react",
        setup(builder) {
          builder.onResolve({ filter: /^react(?:\/.*)?$/ }, (args) => ({
            path: require.resolve(args.path),
            external: true,
          }));
        },
      },
    ],
  });
  const bundleDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-profile-badge-"));
  const bundlePath = NodePath.join(bundleDir, "bundle.mjs");
  try {
    await NodeFSP.writeFile(bundlePath, built.outputFiles[0].text);
    ({ ProfileBadge, ProfileSection, createProfileListStore } = await import(
      NodeURL.pathToFileURL(bundlePath).href
    ));
  } finally {
    await NodeFSP.rm(bundleDir, { recursive: true, force: true });
  }
});

const LIST = {
  defaultProfileId: "default",
  profiles: [
    { id: "default", name: "Default" },
    { id: "work", name: "Work account" },
  ],
};

/** Lets pending promise callbacks and stream pulls run. */
const settle = async () => {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** A fresh copy per answer, as a real transport delivers. */
const clone = (value) => structuredClone(value);

/** A desktop is connected but has not published its list yet. */
const PENDING = Symbol("pending");

/** A `changes` event: the list, null while no desktop is connected, or loading. */
const change = (list) =>
  list === PENDING ? { list: null, pending: true } : { list: list === null ? null : clone(list) };

/**
 * A stubbed `t3.browser/profiles`. With `stream`, `watch` opens a `changes`
 * subscription that starts with the current list (null: no desktop), as the
 * server does; without it the host predates 1.1.0 and only answers reads.
 * `streamFailure` makes the stream throw instead, as a denied grant does.
 */
function fakeProfiles({ stream, list = LIST, refuse = null, streamFailure = null }) {
  let current = list;
  const reads = [];
  const subscriptions = [];
  const source = {
    invoke(method) {
      reads.push(method);
      if (method !== "list") return Promise.reject(new Error(method));
      return refuse === null ? Promise.resolve(clone(current)) : Promise.reject(refuse);
    },
    async watch() {
      if (!stream) return null;
      if (streamFailure !== null) {
        return { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(streamFailure) }) };
      }
      const queue = [change(current)];
      let wake = null;
      let ended = false;
      const subscription = {
        push(value) {
          queue.push(change(value));
          wake?.();
        },
        end() {
          ended = true;
          wake?.();
        },
      };
      subscriptions.push(subscription);
      const pull = async () => {
        if (queue.length === 0 && !ended) await new Promise((resolve) => (wake = resolve));
        return queue.length === 0 ? pull.done : queue.shift();
      };
      pull.done = Symbol("done");
      return (async function* () {
        for (let next = await pull(); next !== pull.done; next = await pull()) yield next;
      })();
    },
  };
  return {
    source,
    reads,
    subscriptions,
    /** The desktop's settings change; open streams are told. */
    async change(next) {
      current = next;
      await act(async () => {
        for (const subscription of subscriptions) subscription.push(next);
        await settle();
      });
    },
    /** Settings change while no stream is open to hear it. */
    setQuietly(next) {
      current = next;
    },
  };
}

// Node has no window; one stands in so window-focus behaviour is observable.
globalThis.window ??= new EventTarget();

const text = (node) =>
  node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");

/**
 * Mounts one badge and keeps it mounted, under a Profiler counting its
 * commits. The view's store and the `api` binding both come from `fake`.
 */
async function mountBadge(profileId, fake) {
  const signal = new AbortController().signal;
  const profiles = createProfileListStore(fake.source, signal);
  let commits = 0;
  let renderer;
  const element = (visible) =>
    React.createElement(
      React.Profiler,
      { id: "badge", onRender: () => (commits += 1) },
      React.createElement(ProfileBadge, {
        host: { React },
        session: profileId === undefined ? {} : { profileId },
        api: fake.source,
        signal,
        profiles,
        visible,
      }),
    );
  await act(async () => {
    renderer = create(element(true));
    await settle();
  });
  return {
    commits: () => commits,
    badge() {
      const found = renderer.root.findAll(
        (node) => node.type === "span" && node.props["data-t3-browser-profile-badge"] === true,
      );
      return found.length === 0 ? null : text(found[0]);
    },
    async focusWindow() {
      await act(async () => {
        globalThis.window.dispatchEvent(new Event("focus"));
        await settle();
      });
    },
    async rerender(visible) {
      await act(async () => {
        renderer.update(element(visible));
        await settle();
      });
    },
  };
}

const RENAMED = { ...LIST, profiles: [LIST.profiles[0], { id: "work", name: "Client work" }] };

for (const stream of [true, false]) {
  NodeTest.describe(`profile badge (${stream ? "changes stream" : "reads only"})`, () => {
    NodeTest.it("names a tab in another profile", async () => {
      const mounted = await mountBadge("work", fakeProfiles({ stream }));
      NodeAssert.equal(mounted.badge(), "Work account");
    });

    NodeTest.it("stays hidden for the default profile, set or implied", async () => {
      NodeAssert.equal((await mountBadge("default", fakeProfiles({ stream }))).badge(), null);
      NodeAssert.equal((await mountBadge(undefined, fakeProfiles({ stream }))).badge(), null);
    });

    NodeTest.it("follows the configured default, not the built-in one", async () => {
      const list = { ...LIST, defaultProfileId: "work" };
      NodeAssert.equal(
        (await mountBadge("default", fakeProfiles({ stream, list }))).badge(),
        "Default",
      );
    });

    NodeTest.it("reads a deleted profile as Removed profile", async () => {
      NodeAssert.equal(
        (await mountBadge("gone", fakeProfiles({ stream }))).badge(),
        "Removed profile",
      );
    });
  });
}

NodeTest.it("shows nothing when the list is refused", async () => {
  const refuse = new Error("API capability denied: t3.browser/profiles");
  NodeAssert.equal(
    (await mountBadge("work", fakeProfiles({ stream: false, refuse }))).badge(),
    null,
  );
});

NodeTest.describe("on a host with the changes stream", () => {
  NodeTest.it("renames the held profile with no focus, show or profile switch", async () => {
    const fake = fakeProfiles({ stream: true });
    const mounted = await mountBadge("work", fake);
    await fake.change(RENAMED);
    NodeAssert.equal(mounted.badge(), "Client work");
    NodeAssert.deepEqual(fake.reads, []);
  });

  NodeTest.it("reads a profile deleted in Settings as Removed profile, unprompted", async () => {
    const fake = fakeProfiles({ stream: true });
    const mounted = await mountBadge("work", fake);
    await fake.change({ ...LIST, profiles: [LIST.profiles[0]] });
    NodeAssert.equal(mounted.badge(), "Removed profile");
  });

  NodeTest.it("hides once the held profile becomes the default, and back", async () => {
    const fake = fakeProfiles({ stream: true });
    const mounted = await mountBadge("work", fake);
    await fake.change({ ...LIST, defaultProfileId: "work" });
    NodeAssert.equal(mounted.badge(), null);
    await fake.change(LIST);
    NodeAssert.equal(mounted.badge(), "Work account");
  });

  NodeTest.it("commits nothing for an unchanged list or a window focus", async () => {
    const fake = fakeProfiles({ stream: true });
    const mounted = await mountBadge("work", fake);
    const settled = mounted.commits();
    // A fresh copy of the same list, as a re-sent snapshot arrives.
    await fake.change(LIST);
    await mounted.focusWindow();
    await mounted.focusWindow();
    await mounted.focusWindow();
    NodeAssert.equal(mounted.commits(), settled);
    NodeAssert.deepEqual(fake.reads, []);
  });

  NodeTest.it(
    "a dropped stream reopens on the next show and starts from its snapshot",
    async () => {
      const fake = fakeProfiles({ stream: true });
      const mounted = await mountBadge("work", fake);
      NodeAssert.equal(fake.subscriptions.length, 1);
      await act(async () => {
        fake.subscriptions[0].end();
        await settle();
      });
      fake.setQuietly(RENAMED);
      await mounted.rerender(false);
      await mounted.rerender(true);
      NodeAssert.equal(fake.subscriptions.length, 2);
      NodeAssert.equal(mounted.badge(), "Client work");
      NodeAssert.deepEqual(fake.reads, []);
    },
  );

  NodeTest.it("the page menu shares the badge's list instead of reading its own", async () => {
    const fake = fakeProfiles({ stream: true });
    const signal = new AbortController().signal;
    const profiles = createProfileListStore(fake.source, signal);
    let renderer;
    const props = { api: fake.source, signal, profiles, onOpenInProfile() {}, report() {} };
    await act(async () => {
      renderer = create(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(ProfileBadge, {
            host: { React },
            session: { profileId: "work" },
            visible: true,
            ...props,
          }),
          React.createElement(ProfileSection, { session: { profileId: "work" }, ...props }),
        ),
      );
      await settle();
    });
    await fake.change(RENAMED);
    const heading = renderer.root.find(
      (node) =>
        node.type === "span" &&
        typeof node.children[0] === "string" &&
        node.children[0] === "Profile: ",
    );
    NodeAssert.equal(text(heading), "Profile: Client work");
    NodeAssert.equal(fake.subscriptions.length, 1);
    NodeAssert.deepEqual(fake.reads, []);
  });
});

NodeTest.describe("on a host without the changes stream", () => {
  NodeTest.it("re-reads when the panel is shown again, not while hidden", async () => {
    const fake = fakeProfiles({ stream: false });
    const mounted = await mountBadge("work", fake);
    fake.setQuietly({ ...LIST, defaultProfileId: "work" });
    await mounted.rerender(false);
    const hiddenReads = fake.reads.length;
    await mounted.rerender(true);
    NodeAssert.equal(fake.reads.length, hiddenReads + 1);
    NodeAssert.equal(mounted.badge(), null);
  });

  NodeTest.it("does not read, or commit, on window focus", async () => {
    const fake = fakeProfiles({ stream: false });
    const mounted = await mountBadge("work", fake);
    const reads = fake.reads.length;
    const settled = mounted.commits();
    fake.setQuietly(RENAMED);
    await mounted.focusWindow();
    NodeAssert.equal(fake.reads.length, reads);
    NodeAssert.equal(mounted.commits(), settled);
    NodeAssert.equal(mounted.badge(), "Work account");
  });

  NodeTest.it("an unchanged re-read on show commits nothing", async () => {
    const fake = fakeProfiles({ stream: false });
    const mounted = await mountBadge("work", fake);
    await mounted.rerender(false);
    const settled = mounted.commits();
    await mounted.rerender(true);
    // The show itself is one commit; the unchanged answer adds none.
    NodeAssert.equal(mounted.commits(), settled + 1);
    NodeAssert.equal(mounted.badge(), "Work account");
  });
});

/** Mounts the page menu's profile group over `fake`, as the page menu does. */
async function mountSection(profileId, fake) {
  const signal = new AbortController().signal;
  const profiles = createProfileListStore(fake.source, signal);
  let renderer;
  await act(async () => {
    renderer = create(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(ProfileBadge, {
          host: { React },
          session: { profileId },
          profiles,
          visible: true,
        }),
        React.createElement(ProfileSection, {
          session: { profileId },
          api: fake.source,
          profiles,
          signal,
          onOpenInProfile() {},
          report() {},
        }),
      ),
    );
    await settle();
  });
  const find = (predicate) => renderer.root.findAll(predicate);
  return {
    note() {
      const notes = find((node) => node.type === "p" && node.props.role === "note");
      return notes.length === 0 ? null : notes.map(text).join(" ");
    },
    heading() {
      return text(
        find(
          (node) =>
            node.type === "span" &&
            typeof node.children[0] === "string" &&
            node.children[0] === "Profile: ",
        )[0],
      );
    },
    badge() {
      const found = find(
        (node) => node.type === "span" && node.props["data-t3-browser-profile-badge"] === true,
      );
      return found.length === 0 ? null : text(found[0]);
    },
    openIn: () =>
      find((node) => node.type === "select" && node.props["aria-label"] === "Open page in profile")
        .length > 0,
  };
}

const DESKTOP_REQUIRED_NOTE =
  "Listing browser profiles needs the T3 Code desktop app — no desktop browser engine is connected (desktop-required).";

NodeTest.describe("when no desktop can answer for profiles", () => {
  NodeTest.it("a web-only environment says the desktop is required, without a read", async () => {
    const fake = fakeProfiles({ stream: true, list: null });
    const mounted = await mountSection("work", fake);
    NodeAssert.equal(mounted.note(), DESKTOP_REQUIRED_NOTE);
    NodeAssert.equal(mounted.badge(), null);
    NodeAssert.equal(mounted.openIn(), false);
    NodeAssert.deepEqual(fake.reads, []);
  });

  NodeTest.it(
    "the last desktop leaving says so, and one arriving brings the list back",
    async () => {
      const fake = fakeProfiles({ stream: true });
      const mounted = await mountSection("work", fake);
      NodeAssert.equal(mounted.note(), null);
      NodeAssert.equal(mounted.badge(), "Work account");
      NodeAssert.equal(mounted.openIn(), true);

      await fake.change(null);
      // The old list is not passed off as current: no badge, no other profiles.
      NodeAssert.equal(mounted.note(), DESKTOP_REQUIRED_NOTE);
      NodeAssert.equal(mounted.badge(), null);
      NodeAssert.equal(mounted.openIn(), false);

      await fake.change(RENAMED);
      NodeAssert.equal(mounted.note(), null);
      NodeAssert.equal(mounted.heading(), "Profile: Client work");
      NodeAssert.equal(mounted.badge(), "Client work");
      NodeAssert.equal(fake.subscriptions.length, 1);
    },
  );

  NodeTest.it("a view told no desktop shows loading when one connects, then its list", async () => {
    const fake = fakeProfiles({ stream: true, list: null });
    const mounted = await mountSection("work", fake);
    NodeAssert.equal(mounted.note(), DESKTOP_REQUIRED_NOTE);

    await fake.change(PENDING);
    NodeAssert.equal(mounted.note(), "Loading profiles…");
    NodeAssert.equal(mounted.badge(), null);
    NodeAssert.equal(mounted.openIn(), false);

    await fake.change(LIST);
    NodeAssert.equal(mounted.note(), null);
    NodeAssert.equal(mounted.badge(), "Work account");
    NodeAssert.equal(fake.subscriptions.length, 1);
  });

  NodeTest.it("a desktop with no profiles yet is not reported as missing", async () => {
    const fake = fakeProfiles({
      stream: true,
      list: { profiles: [], defaultProfileId: "default" },
    });
    const mounted = await mountSection("work", fake);
    NodeAssert.equal(mounted.note(), null);
    NodeAssert.equal(mounted.heading(), "Profile: Removed profile");
  });

  NodeTest.it("a denied stream names the missing grant", async () => {
    const fake = fakeProfiles({
      stream: true,
      streamFailure: new Error("API capability denied: t3.browser/profiles"),
    });
    const mounted = await mountSection("work", fake);
    NodeAssert.equal(
      mounted.note(),
      "Listing browser profiles — Needs permission t3.browser/profiles. Grant it in Settings → Extensions.",
    );
    NodeAssert.equal(mounted.badge(), null);
  });
});

/**
 * Mounts the profile group with an api that holds each action open, as the
 * desktop does while its confirmation is up, and records what the group
 * asks of the menu and the status line.
 */
async function mountActions() {
  const signal = new AbortController().signal;
  const fake = fakeProfiles({ stream: true });
  const profiles = createProfileListStore(fake.source, signal);
  const calls = [];
  const pending = new Map();
  const api = {
    invoke(method, input) {
      calls.push(method);
      if (method === "listImportSources") {
        return Promise.resolve({
          sources: [
            {
              id: "firefox",
              name: "Firefox",
              profiles: [{ handle: "proof-fixture", name: "proof-fixture", cookieCount: 1 }],
            },
          ],
        });
      }
      return new Promise((resolve) => pending.set(method, { resolve, input }));
    },
  };
  const log = [];
  let renderer;
  await act(async () => {
    renderer = create(
      React.createElement(ProfileSection, {
        session: { profileId: "work" },
        api,
        profiles,
        signal,
        onOpenInProfile: (profileId) => log.push(`open:${profileId}`),
        report: (message) => log.push(`report:${message}`),
        onChosen: () => log.push("chosen"),
      }),
    );
    await settle();
  });
  const button = (label) =>
    renderer.root.find((node) => node.type === "button" && text(node) === label);
  return {
    calls,
    log,
    async click(label) {
      await act(async () => {
        button(label).props.onClick();
        await settle();
      });
    },
    async select(ariaLabel, value) {
      await act(async () => {
        renderer.root
          .find((node) => node.type === "select" && node.props["aria-label"] === ariaLabel)
          .props.onChange({ target: { value } });
        await settle();
      });
    },
    async answer(method, result) {
      await act(async () => {
        pending.get(method).resolve(result);
        await settle();
      });
    },
  };
}

NodeTest.describe("choosing a profile action", () => {
  NodeTest.it(
    "Import into closes the menu before the desktop's confirmation, then reports",
    async () => {
      const mounted = await mountActions();
      await mounted.click("Import cookies…");
      // Expanding the importer is not a choice: the menu stays open.
      NodeAssert.deepEqual(mounted.log, []);
      await mounted.click("Import into Work account");
      // The confirmation is still up (the invoke is unanswered), and the menu
      // is already closed, so it can never cover the dialog's buttons.
      NodeAssert.deepEqual(mounted.log, [
        "chosen",
        "report:Importing — confirm the import in the T3 Code desktop app.",
      ]);
      await mounted.answer("importCookies", {
        outcome: "imported",
        profileId: "work",
        imported: 1,
        skipped: 0,
      });
      NodeAssert.equal(mounted.log.at(-1), 'report:Imported 1 cookie into "Work account".');
    },
  );

  NodeTest.it("Clear cookies and Clear cache close the menu, as native's items do", async () => {
    for (const [label, method] of [
      ["Clear cookies", "clearCookies"],
      ["Clear cache", "clearCache"],
    ]) {
      const mounted = await mountActions();
      await mounted.click(label);
      NodeAssert.equal(mounted.log[0], "chosen");
      await mounted.answer(method, { outcome: "cleared", profileId: "work" });
      NodeAssert.ok(mounted.log.at(-1).startsWith("report:C"));
      NodeAssert.ok(mounted.calls.includes(method));
    }
  });

  NodeTest.it("opening the page in another profile closes the menu", async () => {
    const mounted = await mountActions();
    await mounted.select("Open page in profile", "default");
    NodeAssert.deepEqual(mounted.log, ["chosen", "open:default"]);
  });
});
