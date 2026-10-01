import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  React,
  REF,
  defaultHandlers,
  deferred,
  dispatch,
  detailOf,
  flush,
  loadPrsPanel,
  mount,
} from "./prsPanelHarness.mjs";

let panel;
NodeTest.before(async () => {
  panel = await loadPrsPanel();
});

const labels = {
  candidates: [
    { name: "bug", color: "ff0000", description: "Defect triage", isApplied: false },
    { name: "docs", color: "0000ff", description: null, isApplied: true },
  ],
  truncated: false,
};
const reviewers = {
  candidates: [
    {
      id: "ada",
      kind: "user",
      login: "ada",
      name: "Ada Lovelace",
      avatarUrl: null,
      isRequested: false,
    },
    {
      id: "team-1",
      kind: "team",
      login: "review-team",
      name: "Review Team",
      avatarUrl: null,
      isRequested: true,
    },
  ],
  truncated: false,
};
const metadataDetail = (overrides = {}) => {
  const detail = detailOf();
  return {
    ...detail,
    capabilities: {
      ...detail.capabilities,
      labels: true,
      reviewers: { request: true, listCandidates: true },
    },
    viewerPermissions: { ...detail.viewerPermissions, labels: true, requestReviewers: true },
    labels: [{ name: "docs", color: "0000ff" }],
    reviewers: [],
    ...overrides,
  };
};

function handlers(overrides = {}) {
  const defaults = defaultHandlers();
  const read = defaults["t3.prs/read#getCapabilities"]();
  const write = defaults["t3.prs/write#getCapabilities"]();
  return defaultHandlers({
    "t3.prs/read#getCapabilities": () => ({
      ...read,
      operations: {
        ...read.operations,
        "prs.labelCandidates": true,
        "prs.reviewerCandidates": true,
      },
    }),
    "t3.prs/write#getCapabilities": () => ({
      ...write,
      operations: { ...write.operations, "prs.setLabels": true, "prs.requestReviewers": true },
    }),
    "t3.prs/read#detail": () => metadataDetail(),
    "t3.prs/read#labelCandidates": () => labels,
    "t3.prs/read#reviewerCandidates": () => reviewers,
    "t3.prs/write#setLabels": () => ({}),
    "t3.prs/write#requestReviewers": () => ({}),
    ...overrides,
  });
}

function mountPanel(overrides, members) {
  return mount(
    (host, session) =>
      React.createElement(panel.PullRequestsPanel, {
        host,
        session,
        visible: true,
        selected: REF,
        onSelect: () => {},
      }),
    handlers(overrides),
    members,
  );
}

const button = (view, name) => view.byName(name).find((node) => node.type === "button");
const candidates = (view) => view.renderer.root.findAll((node) => node.props.role === "option");
const candidate = (view, name) =>
  candidates(view).find((node) => node.props["aria-label"] === name);
const reads = (view, method) => view.calls.filter((call) => call.method === method);
const metadata = (view, label) =>
  view.renderer.root.findAll((node) => node.props["aria-label"] === `${label} on pull request`)[0];
const renderedText = (node) =>
  typeof node === "string" ? node : node.children.map(renderedText).join("");

async function open(view, name) {
  await flush();
  NodeAssert.ok(button(view, name), `${name} picker exists`);
  dispatch(button(view, name), "onClick");
  await flush();
}

NodeTest.it("reads native repository candidates lazily and searches locally", async () => {
  const view = mountPanel();
  await flush();
  NodeAssert.equal(reads(view, "labelCandidates").length, 0);
  NodeAssert.equal(reads(view, "reviewerCandidates").length, 0);
  await open(view, "Change labels");
  NodeAssert.deepEqual(reads(view, "labelCandidates")[0].input, REF);
  NodeAssert.equal(candidate(view, "docs").props["aria-selected"], true);
  dispatch(view.find("Search labels"), "onChange", { target: { value: "TRIAGE" } });
  NodeAssert.deepEqual(
    candidates(view).map((node) => node.props["aria-label"]),
    ["bug"],
  );
  NodeAssert.equal(reads(view, "labelCandidates").length, 1);
  dispatch(view.find("Search labels"), "onChange", { target: { value: "missing" } });
  NodeAssert.ok(view.text().includes("No label matches that."));
  dispatch(view.find("Search labels"), "onKeyDown", { key: "Escape" });
  NodeAssert.equal(view.focused(), "Change labels");
  await open(view, "Request a review");
  dispatch(view.find("Search people with access"), "onChange", {
    target: { value: "LOVELACE" },
  });
  NodeAssert.deepEqual(
    candidates(view).map((node) => node.props["aria-label"]),
    ["ada"],
  );
  NodeAssert.equal(reads(view, "reviewerCandidates").length, 1);
  view.unmount();
});

NodeTest.it(
  "optimistically adds and removes labels, locks rows, and rolls back a refused write",
  async () => {
    let pending = deferred();
    const view = mountPanel({ "t3.prs/write#setLabels": () => pending.promise });
    await open(view, "Change labels");
    dispatch(candidate(view, "bug"), "onClick");
    await flush();
    NodeAssert.equal(candidate(view, "bug").props["aria-selected"], true);
    NodeAssert.ok(renderedText(metadata(view, "Labels")).includes("bug"));
    NodeAssert.ok(candidates(view).every((node) => node.props.disabled === true));
    dispatch(candidate(view, "docs"), "onClick");
    await flush();
    NodeAssert.equal(view.writes().length, 1);
    NodeAssert.deepEqual(view.writes()[0].input, { ...REF, labels: ["bug"], applied: true });
    pending.reject(new Error("triage access refused"));
    await flush();
    NodeAssert.equal(candidate(view, "bug").props["aria-selected"], false);
    NodeAssert.ok(!renderedText(metadata(view, "Labels")).includes("bug"));
    NodeAssert.ok(view.text().includes("Could not put bug on"));
    NodeAssert.ok(view.text().includes("triage access refused"));
    pending = deferred();
    dispatch(candidate(view, "docs"), "onClick");
    await flush();
    NodeAssert.equal(candidate(view, "docs").props["aria-selected"], false);
    NodeAssert.ok(renderedText(metadata(view, "Labels")).includes("None"));
    pending.resolve({});
    await flush();
    NodeAssert.equal(candidate(view, "docs").props["aria-selected"], false);
    NodeAssert.equal(button(view, "Change labels").props["aria-expanded"], true);
    NodeAssert.deepEqual(view.writes()[1].input, { ...REF, labels: ["docs"], applied: false });
    NodeAssert.equal(reads(view, "labelCandidates").length, 1);
    view.unmount();
  },
);

NodeTest.it(
  "requests and takes back user/team reviews with optimistic state and rollback",
  async () => {
    let pending = deferred();
    const view = mountPanel({ "t3.prs/write#requestReviewers": () => pending.promise });
    await open(view, "Request a review");
    NodeAssert.equal(candidate(view, "review-team").props["aria-selected"], true);
    dispatch(candidate(view, "ada"), "onClick");
    await flush();
    NodeAssert.equal(candidate(view, "ada").props["aria-selected"], true);
    NodeAssert.ok(renderedText(metadata(view, "Reviewers")).includes("ada"));
    NodeAssert.deepEqual(view.writes()[0].input, {
      ...REF,
      reviewers: [{ id: "ada", kind: "user" }],
      requested: true,
    });
    pending.reject(new Error("write access refused"));
    await flush();
    NodeAssert.equal(candidate(view, "ada").props["aria-selected"], false);
    NodeAssert.ok(!renderedText(metadata(view, "Reviewers")).includes("ada"));
    NodeAssert.ok(view.text().includes("Could not ask ada for a review"));
    pending = deferred();
    dispatch(candidate(view, "review-team"), "onClick");
    await flush();
    NodeAssert.ok(renderedText(metadata(view, "Reviewers")).includes("None"));
    pending.resolve({});
    await flush();
    NodeAssert.deepEqual(view.writes()[1].input, {
      ...REF,
      reviewers: [{ id: "team-1", kind: "team" }],
      requested: false,
    });
    NodeAssert.ok(view.text().includes("Review request to review-team taken back"));
    view.unmount();
  },
);

for (const [method, trigger, empty, noMatch, error, truncated] of [
  [
    "labelCandidates",
    "Change labels",
    "This repository has no labels.",
    "No label matches that.",
    "The labels could not be read.",
    "This repository has more labels than are listed here. Apply the rest on the host.",
  ],
  [
    "reviewerCandidates",
    "Request a review",
    "Nobody else has access to this repository.",
    "Nobody with access matches that.",
    "The people with access could not be read.",
    "This repository has more people with access than are listed here. Ask for the rest on the host.",
  ],
]) {
  NodeTest.it(
    `${trigger} preserves native empty, loading, error and bounded-list states`,
    async () => {
      const pending = deferred();
      const view = mountPanel({ [`t3.prs/read#${method}`]: () => pending.promise });
      await open(view, trigger);
      NodeAssert.ok(view.renderer.root.findAll((node) => node.props["aria-busy"] === true).length);
      pending.resolve({ candidates: [], truncated: true });
      await flush();
      NodeAssert.ok(view.text().includes(empty));
      NodeAssert.ok(view.text().includes(truncated));
      const search = method === "labelCandidates" ? "Search labels" : "Search people with access";
      dispatch(view.find(search), "onChange", { target: { value: "missing" } });
      NodeAssert.ok(view.text().includes(noMatch));
      view.unmount();

      const refused = mountPanel({
        [`t3.prs/read#${method}`]: () => Promise.reject(new Error("host read refused")),
      });
      await open(refused, trigger);
      NodeAssert.ok(refused.text().includes(error));
      NodeAssert.ok(refused.text().includes("host read refused"));
      refused.unmount();
    },
  );
}

NodeTest.it(
  "gates editors by the selected provider, viewer permissions and SDK read/write grants",
  async () => {
    const detail = metadataDetail();
    for (const overrides of [
      {
        "t3.prs/read#detail": () => ({
          ...detail,
          viewerPermissions: {
            ...detail.viewerPermissions,
            labels: false,
            requestReviewers: false,
          },
        }),
      },
      { "t3.prs/write#getCapabilities": defaultHandlers()["t3.prs/write#getCapabilities"] },
      { "t3.prs/read#getCapabilities": defaultHandlers()["t3.prs/read#getCapabilities"] },
    ]) {
      const view = mountPanel(overrides);
      await flush();
      NodeAssert.equal(button(view, "Change labels")?.props.disabled, true);
      NodeAssert.equal(button(view, "Request a review")?.props.disabled, true);
      dispatch(button(view, "Change labels"), "onClick");
      dispatch(button(view, "Request a review"), "onClick");
      await flush();
      NodeAssert.equal(reads(view, "labelCandidates").length, 0);
      NodeAssert.equal(reads(view, "reviewerCandidates").length, 0);
      NodeAssert.equal(view.writes().length, 0);
      view.unmount();
    }
    const unsupported = mountPanel({
      "t3.prs/read#detail": () => ({
        ...detail,
        provider: "azure-devops",
        capabilities: {
          ...detail.capabilities,
          labels: false,
          reviewers: { request: true, listCandidates: false },
        },
      }),
    });
    await flush();
    NodeAssert.equal(button(unsupported, "Change labels"), undefined);
    NodeAssert.equal(button(unsupported, "Request a review"), undefined);
    NodeAssert.ok(unsupported.text().includes("docs"));
    unsupported.unmount();
  },
);

NodeTest.it(
  "keyboard selection keeps the picker open and Escape returns to its opener",
  async () => {
    const view = mountPanel();
    await open(view, "Change labels");
    const search = view.find("Search labels");
    dispatch(search, "onKeyDown", { key: "ArrowDown" });
    dispatch(search, "onKeyDown", { key: "Enter" });
    await flush();
    NodeAssert.deepEqual(view.writes()[0].input, { ...REF, labels: ["docs"], applied: false });
    NodeAssert.equal(button(view, "Change labels").props["aria-expanded"], true);
    dispatch(view.find("Search labels"), "onKeyDown", { key: "Escape" });
    NodeAssert.equal(button(view, "Change labels").props["aria-expanded"], false);
    NodeAssert.equal(view.focused(), "Change labels");
    view.unmount();
  },
);

NodeTest.it(
  "selection changes ignore late candidate reads and metadata writes from the old PR",
  async () => {
    const pending = deferred();
    const view = mountPanel({ "t3.prs/read#labelCandidates": () => pending.promise });
    await open(view, "Change labels");
    const selectOther = () =>
      view.update((host, session) =>
        React.createElement(panel.PullRequestsPanel, {
          host,
          session,
          visible: true,
          selected: { ...REF, number: 4 },
          onSelect: () => {},
        }),
      );
    selectOther();
    pending.resolve(labels);
    await flush();
    NodeAssert.equal(button(view, "Change labels").props["aria-expanded"], false);
    NodeAssert.equal(candidates(view).length, 0);
    view.unmount();

    const write = deferred();
    const mutation = mountPanel({ "t3.prs/write#setLabels": () => write.promise });
    await open(mutation, "Change labels");
    dispatch(candidate(mutation, "bug"), "onClick");
    await flush();
    mutation.update((host, session) =>
      React.createElement(panel.PullRequestsPanel, {
        host,
        session,
        visible: true,
        selected: { ...REF, number: 4 },
        onSelect: () => {},
      }),
    );
    write.reject(new Error("old PR refusal"));
    await flush();
    NodeAssert.ok(!mutation.text().includes("old PR refusal"));
    NodeAssert.ok(!renderedText(metadata(mutation, "Labels")).includes("bug"));
    mutation.unmount();
  },
);

NodeTest.it("places the pickers through the host floating layer when available", async () => {
  const placements = [];
  const view = mountPanel(undefined, {
    floatingLayer: {
      version: 1,
      Popover: (props) => {
        placements.push({ side: props.side, align: props.align, anchor: props.anchor });
        return React.createElement("div", { ...props, ref: props.elementRef }, props.children);
      },
    },
  });
  await open(view, "Change labels");
  NodeAssert.ok(placements.length > 0);
  NodeAssert.equal(placements[0].side, "bottom");
  NodeAssert.equal(placements[0].align, "start");
  NodeAssert.ok(placements[0].anchor);
  view.unmount();
});

NodeTest.it(
  "a refreshed detail preserves the in-flight choice and rollback keeps the fresh metadata",
  async () => {
    for (const refused of [true, false]) {
      let detail = metadataDetail();
      const pending = deferred();
      const view = mountPanel({
        "t3.prs/read#detail": () => detail,
        "t3.prs/write#setLabels": () => pending.promise,
      });
      await open(view, "Change labels");
      dispatch(candidate(view, "bug"), "onClick");
      await flush();
      detail = metadataDetail({ labels: [{ name: "other", color: null }] });
      await view.refresh();
      NodeAssert.ok(renderedText(metadata(view, "Labels")).includes("other"));
      NodeAssert.ok(renderedText(metadata(view, "Labels")).includes("bug"));
      if (refused) pending.reject(new Error("host refused the label"));
      else pending.resolve({});
      await flush();
      NodeAssert.ok(renderedText(metadata(view, "Labels")).includes("other"));
      NodeAssert.equal(renderedText(metadata(view, "Labels")).includes("bug"), !refused);
      view.unmount();
    }
  },
);

NodeTest.it(
  "successful review requests use the native receipt without a picker-initiated detail read",
  async () => {
    const view = mountPanel();
    await open(view, "Request a review");
    dispatch(candidate(view, "ada"), "onClick");
    await flush();
    NodeAssert.ok(renderedText(metadata(view, "Reviewers")).includes("ada"));
    NodeAssert.equal(candidate(view, "ada").props["aria-selected"], true);
    NodeAssert.ok(view.text().includes("Review requested from ada"));
    NodeAssert.equal(reads(view, "reviewerCandidates").length, 1);
    NodeAssert.equal(reads(view, "detail").length, 1);
    NodeAssert.equal(reads(view, "invalidate").length, 0);
    view.unmount();
  },
);

NodeTest.it("team requests stay checked while another reviewer is toggled", async () => {
  const pending = deferred();
  const view = mountPanel({ "t3.prs/write#requestReviewers": () => pending.promise });
  await open(view, "Request a review");
  NodeAssert.equal(candidate(view, "review-team").props["aria-selected"], true);
  dispatch(candidate(view, "ada"), "onClick");
  await flush();
  NodeAssert.equal(candidate(view, "review-team").props["aria-selected"], true);
  pending.resolve({});
  await flush();
  NodeAssert.equal(candidate(view, "review-team").props["aria-selected"], true);
  dispatch(candidate(view, "review-team"), "onClick");
  await flush();
  NodeAssert.deepEqual(view.writes()[1].input, {
    ...REF,
    reviewers: [{ id: "team-1", kind: "team" }],
    requested: false,
  });
  NodeAssert.equal(candidate(view, "review-team").props["aria-selected"], false);
  view.unmount();
});

NodeTest.it("team requests keep their direction across detail refreshes", async () => {
  const view = mountPanel();
  await open(view, "Request a review");
  await view.refresh();
  NodeAssert.equal(candidate(view, "review-team").props["aria-selected"], true);
  dispatch(candidate(view, "review-team"), "onClick");
  await flush();
  NodeAssert.deepEqual(view.writes()[0].input, {
    ...REF,
    reviewers: [{ id: "team-1", kind: "team" }],
    requested: false,
  });
  await view.refresh();
  NodeAssert.equal(candidate(view, "review-team").props["aria-selected"], false);
  dispatch(candidate(view, "review-team"), "onClick");
  await flush();
  await view.refresh();
  NodeAssert.equal(candidate(view, "review-team").props["aria-selected"], true);
  NodeAssert.equal(view.writes()[1].input.requested, true);
  NodeAssert.equal(reads(view, "reviewerCandidates").length, 1);
  view.unmount();
});

NodeTest.it(
  "reviewer selection distinguishes users and teams with the same id and login",
  async () => {
    const view = mountPanel({
      "t3.prs/read#reviewerCandidates": () => ({
        ...reviewers,
        candidates: reviewers.candidates.map((entry) => ({
          ...entry,
          id: "shared",
          login: "shared",
        })),
      }),
    });
    await open(view, "Request a review");
    dispatch(candidates(view)[1], "onClick");
    await flush();
    dispatch(candidates(view)[0], "onClick");
    await flush();
    NodeAssert.equal(candidates(view)[0].props["aria-selected"], true);
    NodeAssert.equal(candidates(view)[1].props["aria-selected"], false);
    NodeAssert.deepEqual(
      view.writes().map((write) => write.input.reviewers),
      [[{ id: "shared", kind: "team" }], [{ id: "shared", kind: "user" }]],
    );
    view.unmount();
  },
);

NodeTest.it(
  "disabled pickers show the access or availability reason through the host tooltip",
  async () => {
    const cases = [
      {
        overrides: {
          "t3.prs/read#detail": () =>
            metadataDetail({
              viewerPermissions: {
                ...metadataDetail().viewerPermissions,
                labels: false,
                requestReviewers: false,
              },
            }),
        },
        reasons: [
          "Changing labels needs triage access on this repository",
          "Asking someone to review needs write access on this repository",
        ],
      },
      {
        overrides: {
          "t3.prs/read#getCapabilities": defaultHandlers()["t3.prs/read#getCapabilities"],
        },
        reasons: ["Labels cannot be changed from here", "Reviews cannot be requested from here"],
      },
      {
        overrides: {
          "t3.prs/write#getCapabilities": defaultHandlers()["t3.prs/write#getCapabilities"],
        },
        reasons: ["Labels cannot be changed from here", "Reviews cannot be requested from here"],
      },
    ];
    for (const { overrides, reasons } of cases) {
      const view = mountPanel(overrides, {
        tooltip: {
          version: 1,
          Tooltip: ({ children, label, showWhenDisabled }) =>
            children.props.disabled && !showWhenDisabled
              ? children
              : React.createElement("span", { title: label }, children),
        },
      });
      await flush();
      for (const [index, name] of ["Change labels", "Request a review"].entries()) {
        NodeAssert.equal(button(view, name).props.disabled, true);
        NodeAssert.equal(button(view, name).parent.props.title, reasons[index]);
      }
      view.unmount();
    }
  },
);

NodeTest.it("keyboard highlight scrolls long candidate lists before selecting", async () => {
  const manyLabels = Array.from({ length: 15 }, (_, index) => ({
    name: `label-${index}`,
    color: null,
    description: null,
    isApplied: false,
  }));
  const view = mountPanel({
    "t3.prs/read#labelCandidates": () => ({ candidates: manyLabels, truncated: false }),
  });
  await open(view, "Change labels");
  for (let index = 0; index < 12; index += 1)
    dispatch(view.find("Search labels"), "onKeyDown", { key: "ArrowDown" });
  NodeAssert.deepEqual(view.scrolls().at(-1), { name: "label-12", options: { block: "nearest" } });
  dispatch(view.find("Search labels"), "onKeyDown", { key: "Enter" });
  await flush();
  NodeAssert.deepEqual(view.writes()[0].input, { ...REF, labels: ["label-12"], applied: true });
  dispatch(view.find("Search labels"), "onKeyDown", { key: "ArrowUp" });
  NodeAssert.equal(view.scrolls().at(-1).name, "label-11");
  dispatch(view.find("Search labels"), "onChange", { target: { value: "label-14" } });
  NodeAssert.equal(view.scrolls().at(-1).name, "label-14");
  view.unmount();
});

for (const [method, trigger, search, name, field] of [
  ["labelCandidates", "Change labels", "Search labels", "bug", "applied"],
  ["reviewerCandidates", "Request a review", "Search people with access", "ada", "requested"],
]) {
  NodeTest.it(`${method} reopen keeps patched rows and the next toggle direction`, async () => {
    const stale = deferred();
    let count = 0;
    const view = mountPanel({
      [`t3.prs/read#${method}`]: () => {
        count += 1;
        return count === 1 ? (method === "labelCandidates" ? labels : reviewers) : stale.promise;
      },
    });
    await open(view, trigger);
    dispatch(view.find(search), "onKeyDown", { key: "Escape" });
    await open(view, trigger);
    dispatch(candidate(view, name), "onClick");
    await flush();
    NodeAssert.equal(candidate(view, name).props["aria-selected"], true);
    stale.resolve(method === "labelCandidates" ? labels : reviewers);
    await flush();
    NodeAssert.equal(candidate(view, name).props["aria-selected"], true);
    dispatch(candidate(view, name), "onClick");
    await flush();
    NodeAssert.equal(view.writes()[1].input[field], false);
    NodeAssert.equal(reads(view, method).length, 1);
    view.unmount();
  });
}

NodeTest.it(
  "scroll-induced mouse entry preserves keyboard selection until the pointer moves",
  async () => {
    const view = mountPanel();
    await open(view, "Change labels");
    dispatch(view.find("Search labels"), "onKeyDown", { key: "ArrowDown" });
    dispatch(candidate(view, "bug"), "onMouseEnter");
    dispatch(view.find("Search labels"), "onKeyDown", { key: "Enter" });
    await flush();
    NodeAssert.deepEqual(view.writes()[0].input, { ...REF, labels: ["docs"], applied: false });
    dispatch(candidate(view, "bug"), "onMouseMove");
    dispatch(view.find("Search labels"), "onKeyDown", { key: "Enter" });
    await flush();
    NodeAssert.deepEqual(view.writes()[1].input, { ...REF, labels: ["bug"], applied: true });
    view.unmount();
  },
);

NodeTest.it("Tab closes a portaled picker even when focus has no next target", async () => {
  const view = mountPanel(undefined, {
    floatingLayer: {
      version: 1,
      Popover: (props) =>
        React.createElement("div", { ...props, ref: props.elementRef }, props.children),
    },
  });
  await open(view, "Change labels");
  const event = dispatch(view.find("Search labels"), "onKeyDown", { key: "Tab" });
  NodeAssert.equal(event.defaultPrevented, false);
  NodeAssert.equal(view.focused(), "Change labels");
  NodeAssert.equal(button(view, "Change labels").props["aria-expanded"], false);
  NodeAssert.equal(candidates(view).length, 0);
  view.unmount();
});

NodeTest.it(
  "candidate read and mutation failures use bounded host words or useful hints",
  async () => {
    const longReason = "Repository access denied. ".repeat(30);
    for (const [reason, expected] of [
      ["Pull request operation labelCandidates failed: Access denied", "Access denied"],
      [
        "Pull request operation labelCandidates failed: exited with code 1",
        "The labels could not be read.",
      ],
      [longReason, `${longReason.slice(0, 319)}…`],
    ]) {
      const view = mountPanel({
        "t3.prs/read#labelCandidates": () => Promise.reject(new Error(reason)),
      });
      await open(view, "Change labels");
      NodeAssert.ok(view.text().includes(expected));
      NodeAssert.ok(!view.text().includes("Pull request operation"));
      NodeAssert.ok(!view.text().includes("exited with code"));
      NodeAssert.ok(!view.text().includes(longReason));
      view.unmount();
    }
    for (const [reason, expected] of [
      ["Pull request operation setLabels failed: Triage access denied", "Triage access denied"],
      [
        "unknown error",
        "The host refused it. Check that you have triage access on this repository.",
      ],
      [longReason, `${longReason.slice(0, 319)}…`],
    ]) {
      const view = mountPanel({
        "t3.prs/write#setLabels": () => Promise.reject(new Error(reason)),
      });
      await open(view, "Change labels");
      dispatch(candidate(view, "bug"), "onClick");
      await flush();
      NodeAssert.ok(view.text().includes(expected));
      NodeAssert.ok(!view.text().includes("Pull request operation"));
      NodeAssert.ok(!view.text().includes("unknown error"));
      NodeAssert.ok(!view.text().includes(longReason));
      NodeAssert.equal(candidate(view, "bug").props["aria-selected"], false);
      view.unmount();
    }
  },
);

NodeTest.it("private-host avatar failures fall back to the native login initial", async () => {
  const avatarUrl = "https://private.invalid/ada.png";
  const view = mountPanel({
    "t3.prs/read#reviewerCandidates": () => ({
      ...reviewers,
      candidates: [{ ...reviewers.candidates[0], avatarUrl }],
    }),
  });
  await open(view, "Request a review");
  const avatars = () =>
    view.renderer.root.findAll((node) => node.type === "img" && node.props.src === avatarUrl);
  NodeAssert.equal(avatars().length, 1);
  dispatch(avatars()[0], "onError");
  NodeAssert.equal(avatars().length, 0);
  NodeAssert.ok(renderedText(candidate(view, "ada")).includes("Aada"));
  view.unmount();
});
