import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { React, act, deferred, flush, loadPrsPanel, mount } from "./prsPanelHarness.mjs";

const { CloneRepositoryPanel, useSourceControlDiscovery } = await loadPrsPanel("clonePanel.tsx");
const repository = {
  provider: "github",
  nameWithOwner: "alex/repo",
  url: "https://github.com/alex/repo",
  sshUrl: "git@github.com:alex/repo.git",
};
const discovery = {
  providers: [
    {
      kind: "github",
      label: "GitHub",
      ready: true,
      status: "available",
      authStatus: "authenticated",
      account: "alex",
      hint: null,
    },
    {
      kind: "gitlab",
      label: "GitLab",
      ready: false,
      status: "missing",
      authStatus: "unknown",
      account: null,
      hint: "Install GitLab CLI",
    },
  ],
};
const render = (host, session) =>
  React.createElement(CloneRepositoryPanel, { host, session, discovery, visible: true });
const change = (panel, name, value) =>
  act(() => panel.find(name).props.onChange({ target: { value } }));
const button = (panel, name) => panel.byName(name).find((node) => node.type === "button");
const click = (panel, name) => act(() => button(panel, name).props.onClick());

function DiscoveryHarness({ host, session, visible }) {
  const data = useSourceControlDiscovery(host, session, visible);
  return React.createElement(
    "div",
    {},
    React.createElement("button", { "aria-label": "Rescan", onClick: data.refresh }, "Rescan"),
    React.createElement("span", {}, data.providers.map((provider) => provider.label).join(",")),
    React.createElement("span", {}, data.error),
  );
}

NodeTest.test("discovery scans once per mounted session, not visibility flips", async () => {
  const renderDiscovery = (visible) => (host, session) =>
    React.createElement(DiscoveryHarness, { host, session, visible });
  const panel = mount(renderDiscovery(false), {
    "t3.source-control/discovery#discover": () => discovery,
  });
  try {
    await flush();
    NodeAssert.equal(panel.calls.length, 0);
    panel.update(renderDiscovery(true));
    await flush();
    panel.update(renderDiscovery(false));
    panel.update(renderDiscovery(true));
    await flush();
    NodeAssert.equal(panel.calls.length, 1);
  } finally {
    panel.unmount();
  }
});

NodeTest.test(
  "rescan retains ready providers while refreshing and after a failed refresh",
  async () => {
    const pending = deferred();
    let scans = 0;
    const panel = mount(
      (host, session) => React.createElement(DiscoveryHarness, { host, session, visible: true }),
      {
        "t3.source-control/discovery#discover": () => (++scans === 1 ? discovery : pending.promise),
      },
    );
    try {
      await flush();
      click(panel, "Rescan");
      await flush();
      NodeAssert.match(panel.text(), /GitHub/);
      await act(async () => pending.reject(new Error("Rescan unavailable")));
      await flush();
      NodeAssert.match(panel.text(), /GitHub/);
      NodeAssert.match(panel.text(), /Rescan unavailable/);
    } finally {
      panel.unmount();
    }
  },
);

NodeTest.test("repository lists stay cached across source and visibility changes", async () => {
  const panel = mount(render, {
    "t3.source-control/discovery#listRepositories": () => ({
      repositories: [repository],
      truncated: false,
    }),
  });
  try {
    change(panel, "Clone source", "github");
    await flush();
    panel.update((host, session) =>
      React.createElement(CloneRepositoryPanel, { host, session, discovery, visible: false }),
    );
    panel.update(render);
    await flush();
    change(panel, "Clone source", "url");
    change(panel, "Clone source", "github");
    await flush();
    NodeAssert.deepEqual(
      panel.calls.map((call) => call.method),
      ["listRepositories"],
    );
    NodeAssert.match(panel.text(), /alex\/repo/);
  } finally {
    panel.unmount();
  }
});

NodeTest.test("a successful rescan invalidates cached repository listings", async () => {
  let lists = 0;
  const panel = mount(render, {
    "t3.source-control/discovery#listRepositories": () => ({
      repositories: [{ ...repository, nameWithOwner: lists++ === 0 ? "old/repo" : "new/repo" }],
      truncated: false,
    }),
  });
  try {
    change(panel, "Clone source", "github");
    await flush();
    NodeAssert.match(panel.text(), /old\/repo/);
    panel.update((host, session) =>
      React.createElement(CloneRepositoryPanel, {
        host,
        session,
        discovery: { ...discovery, providers: [...discovery.providers] },
        visible: true,
      }),
    );
    await flush();
    NodeAssert.equal(lists, 2);
    NodeAssert.match(panel.text(), /new\/repo/);
    NodeAssert.doesNotMatch(panel.text(), /old\/repo/);
  } finally {
    panel.unmount();
  }
});

NodeTest.test("unready providers remain visible with setup guidance", async () => {
  const panel = mount(render);
  try {
    NodeAssert.match(panel.text(), /Install GitLab CLI/);
    NodeAssert.equal(
      panel
        .find("Clone source")
        .findAllByType("option")
        .find((option) => option.props.value === "gitlab")?.props.disabled,
      true,
    );
  } finally {
    panel.unmount();
  }
});

NodeTest.test(
  "Git URL confirmation creates one new project using the clone API, never a VCS mutation",
  async () => {
    const panel = mount(render, {
      "t3.projects/clone#start": () => ({
        projectId: "project",
        cwd: "/managed/repo",
        remoteUrl: repository.url,
        repository: null,
      }),
    });
    try {
      change(panel, "Clone repository input", "https://github.com/alex/repo.git");
      click(panel, "Next");
      await flush();
      NodeAssert.equal(panel.find("Clone directory name").props.value, "repo");
      act(() => {
        button(panel, "Clone repository").props.onClick();
        button(panel, "Clone repository").props.onClick();
      });
      await flush();
      NodeAssert.deepEqual(
        panel.calls.map((call) => [call.id, call.method]),
        [["t3.projects/clone", "start"]],
      );
      NodeAssert.deepEqual(panel.calls[0].input, {
        title: "repo",
        destinationName: "repo",
        protocol: "auto",
        remoteUrl: "https://github.com/alex/repo.git",
      });
      NodeAssert.match(panel.text(), /Project added: \/managed\/repo/);
    } finally {
      panel.unmount();
    }
  },
);

NodeTest.test("enterprise provider clone keeps the host-qualified input after lookup", async () => {
  const enterprise = {
    ...repository,
    url: "https://ghe.corp/alex/repo",
    sshUrl: "git@ghe.corp:alex/repo.git",
  };
  const panel = mount(render, {
    "t3.source-control/discovery#listRepositories": () => ({ repositories: [], truncated: false }),
    "t3.source-control/discovery#lookupRepository": () => enterprise,
    "t3.projects/clone#start": () => ({
      projectId: "project",
      cwd: "/managed/repo",
      remoteUrl: enterprise.sshUrl,
      repository: enterprise,
    }),
  });
  try {
    change(panel, "Clone source", "github");
    await flush();
    change(panel, "Clone repository input", "ghe.corp/alex/repo");
    click(panel, "Next");
    await flush();
    click(panel, "Clone repository");
    await flush();
    NodeAssert.equal(
      panel.calls.find((call) => call.method === "start").input.repository,
      "ghe.corp/alex/repo",
    );
  } finally {
    panel.unmount();
  }
});

NodeTest.test(
  "provider clone discovers repositories and resolves the choice through the native SDK seam",
  async () => {
    const panel = mount(render, {
      "t3.source-control/discovery#listRepositories": () => ({
        repositories: [repository],
        truncated: true,
      }),
      "t3.source-control/discovery#lookupRepository": () => repository,
      "t3.projects/clone#start": () => ({
        projectId: "project",
        cwd: "/managed/repo",
        remoteUrl: repository.sshUrl,
        repository,
      }),
    });
    try {
      NodeAssert.deepEqual(
        panel
          .find("Clone source")
          .findAllByType("option")
          .filter((option) => !option.props.disabled)
          .map((option) => option.props.value),
        ["url", "github"],
      );
      change(panel, "Clone source", "github");
      await flush();
      NodeAssert.match(panel.text(), /Recent repositories only/);
      change(panel, "Your repositories", "alex/repo");
      click(panel, "Next");
      await flush();
      click(panel, "Clone repository");
      await flush();
      NodeAssert.deepEqual(
        panel.calls.map((call) => call.method),
        ["listRepositories", "lookupRepository", "start"],
      );
      NodeAssert.deepEqual(panel.calls[2].input, {
        title: "repo",
        destinationName: "repo",
        protocol: "auto",
        provider: "github",
        repository: "alex/repo",
      });
    } finally {
      panel.unmount();
    }
  },
);

NodeTest.test(
  "running and failed clone snapshots offer the native cancel and retry actions",
  async () => {
    const snapshots = [
      {
        projectId: "running",
        repository: null,
        destinationPath: "/managed/running",
        phase: "running",
        stage: "receiving",
        percent: 40,
        detail: "1 MiB",
        error: null,
      },
      {
        projectId: "failed",
        repository: null,
        destinationPath: "/managed/failed",
        phase: "failed",
        stage: "connecting",
        percent: null,
        detail: null,
        error: "Clone failed",
      },
    ];
    const panel = mount(
      render,
      {
        "t3.projects/clone#cancel": () => ({ applied: true }),
        "t3.projects/clone#retry": () => ({ applied: true }),
      },
      {
        subscribeApi(request, signal) {
          NodeAssert.equal(request.id, "t3.projects/clone");
          return (async function* () {
            yield {
              streamId: "clones",
              sequence: 1,
              type: "snapshot",
              value: { clones: snapshots, truncated: false },
            };
            if (!signal.aborted)
              await new Promise((resolve) =>
                signal.addEventListener("abort", resolve, { once: true }),
              );
          })();
        },
      },
    );
    try {
      await flush();
      NodeAssert.match(panel.text(), /Receiving objects.*40%.*1 MiB/);
      NodeAssert.match(panel.text(), /Clone failed/);
      click(panel, "Cancel clone");
      await flush();
      click(panel, "Retry clone");
      await flush();
      NodeAssert.deepEqual(
        panel.calls.map((call) => [call.method, call.input]),
        [
          ["cancel", { projectId: "running" }],
          ["retry", { projectId: "failed" }],
        ],
      );
    } finally {
      panel.unmount();
    }
  },
);

NodeTest.test("hidden clone panels do not list repositories or subscribe to progress", async () => {
  let subscriptions = 0;
  const panel = mount(
    (host, session) =>
      React.createElement(CloneRepositoryPanel, { host, session, discovery, visible: false }),
    {},
    {
      subscribeApi() {
        subscriptions++;
        return (async function* () {})();
      },
    },
  );
  try {
    change(panel, "Clone source", "github");
    await flush();
    NodeAssert.equal(subscriptions, 0);
    NodeAssert.deepEqual(panel.calls, []);
  } finally {
    panel.unmount();
  }
});

NodeTest.test("lost provider readiness cannot submit a stale prepared repository", async () => {
  const panel = mount(render, {
    "t3.source-control/discovery#listRepositories": () => ({ repositories: [], truncated: false }),
    "t3.source-control/discovery#lookupRepository": () => repository,
  });
  try {
    change(panel, "Clone source", "github");
    change(panel, "Clone repository input", "alex/repo");
    click(panel, "Next");
    await flush();
    panel.update((host, session) =>
      React.createElement(CloneRepositoryPanel, {
        host,
        session,
        discovery: { providers: [] },
        visible: true,
      }),
    );
    NodeAssert.equal(panel.find("Clone source").props.value, "url");
    NodeAssert.equal(button(panel, "Clone repository"), undefined);
  } finally {
    panel.unmount();
  }
});
