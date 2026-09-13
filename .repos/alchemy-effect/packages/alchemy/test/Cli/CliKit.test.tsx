/** @jsxImportSource react */
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import {
  NonInteractiveTerminal,
  Application,
  Screen,
  TerminalCancelled,
  CliKit,
  layer as cliKitLayer,
} from "@/Cli/CliKit/index.ts";
import {
  AnsweredPrompt,
  Alert,
  Box,
  ChoiceGroup,
  DescriptionList,
  Heading,
  KeyBar,
  LiveStore,
  PromptFrame,
  ProgressGroup,
  ProgressBar,
  SectionHeading,
  Status,
  Toast,
  Tabs,
  TaskRow,
  Text,
  TextField,
  useLiveStore,
} from "@/Cli/components/ui/index.ts";
import { Menu } from "@/Cli/components/ui/Interactive.tsx";
import { tabsWindow } from "@/Cli/components/ui/Layout.tsx";
import { makeRuntime } from "@/Cli/components/view/Runtime.tsx";
import { sigilCli } from "@/Cli/components/view/SigilCli.tsx";
import { Cli, Progress } from "@/Report.ts";
import {
  NukeProgress,
  NukeProgressStore,
  nukePlan,
  reviewNuke,
  renderNukeDelete,
  renderNukeScan,
} from "@/Cli/components/view/Nuke.tsx";
import { renderApply } from "@/Cli/commands/render.ts";
import { isInProgress } from "@/Cli/components/view/statusStyle.ts";
import { spinnerFramesFor } from "@/Util/Theme.ts";
import {
  makeResourceLogger,
  makeResourceOutput,
} from "@/Util/ResourceOutput.ts";
import { stackOutputsView } from "@/Cli/components/view/StackOutputs.tsx";
import { Plan, PlanTree } from "@/Cli/components/view/PlanView.tsx";
import { ApprovePlan } from "@/Cli/components/view/ApprovePlan.tsx";
import {
  ProfileDetailsBody,
  providerBlockHeight,
  type ProfileProviderDisplay,
} from "@/Cli/components/view/Profile.tsx";
import {
  Dashboard,
  DashStore,
  runProfileDashboardSession,
} from "@/Cli/components/view/ProfileDashboard.tsx";
import {
  buildStageNodes,
  stateExplorerScreen,
  StateExplorerStore,
  type StateExplorerSource,
} from "@/Cli/components/view/StateExplorer.tsx";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as NukeRoute from "@/Alchemist/routes/nuke.ts";
import type { ProviderService } from "@/Provider.ts";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { expect, it } from "alchemy-test";
import { deleteNode, noopNode, planWith, updateNode } from "./PlanTestNodes.ts";

class CaptureStream extends PassThrough {
  readonly columns = 80;
  readonly rows = 24;
  output = "";

  constructor(readonly isTTY = false) {
    super();
    this.on("data", (chunk) => {
      this.output += chunk.toString();
    });
  }

  waitFor(text: string): Promise<void> {
    if (this.output.includes(text)) return Promise.resolve();
    return new Promise((resolve) => {
      const onData = () => {
        if (!this.output.includes(text)) return;
        this.off("data", onData);
        resolve();
      };
      this.on("data", onData);
    });
  }
}

class InputStream extends PassThrough {
  readonly isTTY = true;
  isRaw = false;
  private resolveReady: (() => void) | undefined;
  readonly ready = new Promise<void>((resolve) => {
    this.resolveReady = resolve;
  });

  setRawMode(mode: boolean) {
    this.isRaw = mode;
    if (mode) {
      // Size-only consumers no longer query capabilities. Input is ready once
      // the raw-mode reader attaches; a query may temporarily detach it.
      setImmediate(() => {
        if (this.listenerCount("readable") > 0) this.resolveReady?.();
      });
    }
    return this;
  }

  connect(stdout: CaptureStream) {
    stdout.on("data", (chunk) => {
      if (!chunk.toString().includes("\x1b[c")) return;
      // Raw mode starts before Sigil finishes querying the terminal. Answer
      // its device query, then allow input handlers to attach before typing.
      setImmediate(() => {
        this.write("\x1b[?1;2c");
        setImmediate(() => this.resolveReady?.());
      });
    });
  }

  ref() {
    return this;
  }

  unref() {
    return this;
  }
}

const makeStatic = () => {
  const stdout = new CaptureStream();
  const runtime = makeRuntime(
    {
      input: false,
      // SAFETY: CaptureStream implements the writable stream surface consumed by Sigil.
      stdout: stdout as unknown as NodeJS.WriteStream,
      captureConsole: false,
    },
    {
      input: false,
      columns: stdout.columns,
      rows: stdout.rows,
      colors: false,
      unicode: true,
      alternateScreen: false,
    },
  );
  return { ...runtime, stdout };
};

it.effect("reports terminal-native progress on TTY output", () =>
  Effect.gen(function* () {
    const { service, stdout } = yield* makeLive();
    yield* service.nativeProgress.set("indeterminate");
    yield* service.nativeProgress.set("normal", 50);
    yield* service.nativeProgress.set("inactive");

    expect(stdout.output).toContain("\u001B]9;4;3\u001B\\");
    expect(stdout.output).toContain("\u001B]9;4;1;50\u001B\\");
    expect(stdout.output).toContain("\u001B]9;4;0\u001B\\");
  }),
);

const makeExplorerSource = () => {
  const calls = { stacks: 0, stages: 0, resources: 0, files: 0 };
  const source: StateExplorerSource = {
    backend: "local",
    listStacks: Effect.sync(() => {
      calls.stacks++;
      return ["app"];
    }),
    listStages: () =>
      Effect.sync(() => {
        calls.stages++;
        return ["prod"];
      }),
    listResources: () =>
      Effect.sync(() => {
        calls.resources++;
        return ["Api/Worker"];
      }),
    readFile: () =>
      Effect.sync(() => {
        calls.files++;
        return { status: "created", url: "https://workers.dev" };
      }),
    deleteNodes: () => Effect.void,
  };
  return { calls, source };
};

const explorerSource = makeExplorerSource().source;
const flushEffects = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

it("builds Finder-style namespace columns from FQN names", () => {
  const nodes = buildStageNodes("app", "prod", ["Api/Worker"]);
  expect(nodes.map((node) => node.name)).toEqual(["Api", "output"]);
  const api = nodes[0];
  expect(api?.kind).toBe("namespace");
  if (api?.kind === "namespace") {
    expect(api.children.map((node) => node.name)).toEqual(["Worker"]);
  }
});

it("loads state columns and file contents only when selected", async () => {
  const { calls, source } = makeExplorerSource();
  const store = new StateExplorerStore(source);
  store.loadRoot();
  await flushEffects();
  expect(calls).toEqual({ stacks: 1, stages: 0, resources: 0, files: 0 });

  const root = store.snapshot().root;
  expect(root.status).toBe("ready");
  if (root.status !== "ready") return;
  const stack = root.value[0]!;
  store.loadChildren(stack);
  await flushEffects();
  expect(calls).toEqual({ stacks: 1, stages: 1, resources: 0, files: 0 });

  const stages = store.snapshot().children.get(stack.id);
  if (stages?.status !== "ready") return;
  const stage = stages.value[0]!;
  store.loadChildren(stage);
  await flushEffects();
  expect(calls).toEqual({ stacks: 1, stages: 1, resources: 1, files: 0 });

  const state = store.snapshot().children.get(stage.id);
  if (state?.status !== "ready") return;
  const namespace = state.value.find((node) => node.kind === "namespace");
  if (namespace?.kind !== "namespace") return;
  store.loadFile(namespace.children[0]!);
  await flushEffects();
  expect(calls).toEqual({ stacks: 1, stages: 1, resources: 1, files: 1 });
});

it("ignores state explorer responses from before a refresh", async () => {
  let resolveStale: ((stacks: ReadonlyArray<string>) => void) | undefined;
  let request = 0;
  const source: StateExplorerSource = {
    ...explorerSource,
    listStacks: Effect.suspend(() => {
      request++;
      if (request === 1) {
        return Effect.promise(
          () =>
            new Promise((resolve) => {
              resolveStale = resolve;
            }),
        );
      }
      return Effect.succeed(["fresh"]);
    }),
  };
  const store = new StateExplorerStore(source);
  store.loadRoot();
  store.refresh();
  await flushEffects();

  resolveStale?.(["stale"]);
  await flushEffects();

  const root = store.snapshot().root;
  expect(root.status).toBe("ready");
  if (root.status === "ready") {
    expect(root.value.map((node) => node.name)).toEqual(["fresh"]);
  }
});

it("prints stack outputs using inspect without wrapping long lines", () => {
  const { service } = makeStatic();
  const apiUrl =
    "https://cloudflareworkerexample-api-clxp5k3fbtqacxdev7mx7uuxmw.testing-2b2.workers.dev";
  // Narrow width: `wrap="none"` output lines must overflow, not break.
  const output = service.output.format(
    stackOutputsView({
      apiUrl,
      metadata: { region: "us-east-1", replicas: 2 },
    }),
    { columns: 40 },
  );

  expect(output).toBe(
    `{\n  apiUrl: '${apiUrl}',\n  metadata: { region: 'us-east-1', replicas: 2 }\n}`,
  );
});

it("renders detailed plans as nested YAML", () => {
  const { service } = makeStatic();
  const tree = new PlanTree(
    planWith([
      updateNode({ config: { retries: 2 } }, { config: { retries: 3 } }),
    ]),
    { detailed: true, viewport: "full" },
  );
  const output = service.output.format(<Plan tree={tree} />, { columns: 80 });

  expect(output).toContain("properties:");
  expect(output).toContain("config:");
  expect(output).toContain("│ -     retries: 2");
  expect(output).toContain("│ +     retries: 3");
  expect(output).toContain("(Test.Resource)");
});

it("keeps the plan summary visible and updates it during apply", () => {
  const { service } = makeStatic();
  const plan = {
    ...planWith([
      updateNode({ version: 1 }, { version: 2 }),
      noopNode({ version: 1 }, "Stable"),
    ]),
    defaultMode: "local" as const,
  };
  const reviewTree = new PlanTree(plan, { viewport: "full" });
  const reviewOutput = service.output.format(<Plan tree={reviewTree} />, {
    columns: 80,
  });
  const tree = new PlanTree(plan, {
    mode: "apply",
    label: "Starting dev stack",
    busy: true,
  });
  const output = service.output.format(<Plan tree={tree} collapsible />, {
    columns: 160,
  });

  expect(reviewOutput).toContain("1 to update");
  expect(reviewOutput).toContain("1 no change");
  expect(output.indexOf("─")).toBeLessThan(
    output.indexOf("Starting dev stack"),
  );
  expect(output.indexOf("Plan")).toBeLessThan(output.indexOf("Worker"));
  expect(output.indexOf("Starting dev stack")).toBeGreaterThan(
    output.indexOf("Worker"),
  );
  expect(output).toContain("1 pending");
  expect(output).toContain("1 no change");
  expect(
    spinnerFramesFor(true).some((frame) =>
      output.includes(`${frame} Starting dev stack`),
    ),
  ).toBe(true);
  const keybarLine = output
    .split("\n")
    .find((line) => line.includes("p hide widget"));
  expect(keybarLine).toContain("p hide widget");
  expect(keybarLine).toContain("Ctrl+C exit");
  expect(keybarLine).toContain("↑/↓ scroll plan");
  expect(keybarLine).toContain("Starting dev stack");

  tree.emit({
    _tag: "apply.resource.status",
    fqn: "Worker",
    id: "Worker",
    type: "Test.Resource",
    status: "updating",
  });
  tree.setBusy(false);
  tree.setViewport("full");
  const updatingOutput = service.output.format(<Plan tree={tree} />, {
    columns: 80,
  });
  expect(updatingOutput).toContain("1 updating");
  expect(updatingOutput).not.toContain("1 pending");
  expect(updatingOutput).toContain("1 no change");
  expect(
    spinnerFramesFor(true).some((frame) =>
      updatingOutput.includes(`${frame} Starting dev stack`),
    ),
  ).toBe(false);
});

it("keeps a large destroy summary and confirmation visible", () => {
  const { service } = makeStatic();
  const deletions = Array.from({ length: 40 }, (_, index) =>
    deleteNode({}, `Resource${index}`),
  );
  const plan = { ...planWith([], deletions), destroy: true };
  const output = service.output.format(
    <ApprovePlan
      plan={plan}
      controller={{ submit: () => undefined, cancel: () => undefined }}
    />,
    { columns: 80 },
  );

  expect(output).toContain("Destroy");
  expect(output).toContain("40 to delete");
  expect(output).toContain("Destroy?");
  expect(output).toContain("more lines");
  expect(output).toContain("↑/↓ scroll plan");
});

it("keeps apply totals on top and destroy progress on the last row", () => {
  const { service } = makeStatic();
  const plan = {
    ...planWith(
      [],
      Array.from({ length: 10 }, (_, index) =>
        deleteNode({}, `Resource${index}`),
      ),
    ),
    destroy: true,
  };
  const tree = new PlanTree(plan, {
    mode: "apply",
    label: "Destroying stack",
    busy: true,
  });
  tree.emit({
    _tag: "apply.resource.status",
    fqn: "Resource0",
    id: "Resource0",
    type: "Test.Resource",
    status: "deleted",
  });

  const output = service.output.format(<Plan tree={tree} />, {
    columns: 120,
  });
  const lines = output.split("\n");
  const summaryLine = lines.find((line) => line.includes("Plan ·"));
  const progressLine = lines.find((line) => line.includes("Destroying stack"));

  expect(summaryLine).toContain("1 deleted");
  expect(summaryLine).toContain("9 pending");
  expect(progressLine).toContain("Destroying stack (1/10)");
  expect(
    spinnerFramesFor(true).some((frame) => progressLine?.includes(frame)),
  ).toBe(true);
  expect(output.indexOf("Plan ·")).toBeLessThan(output.indexOf("Resource0"));
  expect(output.indexOf("Destroying stack")).toBeGreaterThan(
    output.indexOf("Resource9"),
  );
});

it("binding rows mirror their host resource and stay out of totals", () => {
  const { service } = makeStatic();
  const worker = {
    ...updateNode({ a: 1 }, { a: 2 }, "Worker"),
    bindings: [
      { sid: "BUCKET", action: "update" as const, data: {} },
      { sid: "OLD", action: "delete" as const, data: {} },
      { sid: "STABLE", action: "noop" as const, data: {} },
    ],
  };
  const tree = new PlanTree(planWith([worker]), {
    mode: "apply",
    label: "Deploying stack",
    busy: true,
  });
  const render = () =>
    service.output.format(<Plan tree={tree} />, { columns: 80 });

  // Three bindings never inflate the total: only the host is work.
  expect(tree.progress()).toEqual({ completed: 0, failures: 0, total: 1 });
  let output = render();
  expect(output).toContain("Deploying stack (0/1)");
  expect(output).toContain("unbind");
  expect(output).toContain("no change");

  tree.emit({
    _tag: "apply.resource.status",
    fqn: "Worker",
    id: "Worker",
    type: "Test.Resource",
    status: "updating",
  });
  output = render();
  expect(output).toContain("unbinding");
  expect(output).toContain("Deploying stack (0/1)");

  tree.emit({
    _tag: "apply.resource.status",
    fqn: "Worker",
    id: "Worker",
    type: "Test.Resource",
    status: "updated",
  });
  expect(tree.progress()).toEqual({ completed: 1, failures: 0, total: 1 });
  output = render();
  expect(output).toContain("Deploying stack (1/1)");
  expect(output).toContain("unbound");
  expect(output).toContain("1 updated");
  expect(output).not.toContain("pending");
});

it("binding rows follow a failed host", () => {
  const { service } = makeStatic();
  const worker = {
    ...updateNode({ a: 1 }, { a: 2 }, "Worker"),
    bindings: [{ sid: "BUCKET", action: "update" as const, data: {} }],
  };
  const tree = new PlanTree(planWith([worker]), {
    mode: "apply",
    label: "Deploying stack",
    busy: true,
  });
  tree.emit({
    _tag: "apply.resource.status",
    fqn: "Worker",
    id: "Worker",
    type: "Test.Resource",
    status: "fail",
    message: "worker failed",
  });

  const output = service.output.format(<Plan tree={tree} />, { columns: 80 });
  expect(tree.progress()).toEqual({ completed: 1, failures: 1, total: 1 });
  expect(output).toContain("1 fail");
  expect(output).toContain("Deploying stack (1/1)");
  expect(output).toContain("worker failed");
  expect(output).not.toContain("pending");
});

it.effect("keeps native progress active until the apply outcome settles", () =>
  Effect.gen(function* () {
    const { service, stdout } = yield* makeLive();
    const tree = new PlanTree(
      planWith([updateNode({ version: 1 }, { version: 2 })]),
      {
        mode: "apply",
        label: "Deploying stack",
        busy: true,
      },
    );
    tree.emit({
      _tag: "apply.resource.status",
      fqn: "Worker",
      id: "Worker",
      type: "Test.Resource",
      status: "updated",
    });
    const live = yield* service.live.open(<Plan tree={tree} />);
    yield* Effect.promise(flushEffects);
    expect(stdout.output).toContain("\u001B]9;4;1;100\u001B\\");

    const settledAt = stdout.output.length;
    tree.finish("failure", "Deploy failed");
    yield* Effect.promise(flushEffects);
    expect(stdout.output.slice(settledAt)).toContain(
      "\u001B]9;4;2;100\u001B\\",
    );
    yield* live.close;
  }),
);

it.effect("renders completed dev plans as a hideable output view", () =>
  Effect.gen(function* () {
    const { service, stdout } = yield* makeLive();
    const plan = {
      ...planWith([updateNode({ version: 1 }, { version: 2 })]),
      defaultMode: "local" as const,
    };
    const tree = new PlanTree(plan, {
      mode: "apply",
      label: "Starting dev stack",
    });
    const live = yield* service.live.open(<Plan tree={tree} collapsible />);

    yield* Effect.promise(() => stdout.waitFor("p hide widget"));
    yield* Effect.sync(() => {
      tree.setOutput({ endpoint: "http://localhost:3000" });
      tree.finish("success", "Dev stack ready", "output");
    });
    yield* Effect.promise(() => stdout.waitFor("http://localhost:3000"));
    expect(stdout.output).toContain("←/→ show plan");

    tree.setView("plan");
    expect(tree.snapshot().view).toBe("plan");

    tree.setExpanded(false);
    yield* Effect.promise(() => stdout.waitFor("p show plan/output"));

    const { service: staticService } = makeStatic();
    const hiddenOutput = staticService.output.format(
      <Plan tree={tree} collapsible />,
      { columns: 80 },
    );
    expect(hiddenOutput).not.toContain("Plan ·");
    expect(hiddenOutput).not.toContain("Worker");
    expect(hiddenOutput).not.toContain("http://localhost:3000");
    expect(hiddenOutput).toContain("Dev stack ready (0/1)");
    expect(hiddenOutput).toContain("p show plan/output");
    yield* live.close;
  }),
);

// A dev generation keeps its widget mounted after apply settles and parks
// until a reload (or Ctrl+C) closes its scope. Closing that scope must remove
// the widget: leaving it behind stacks one stale "Dev stack ready" bar per
// reload under the live one.
it.effect("removes the dev apply widget when its generation scope closes", () =>
  Effect.gen(function* () {
    const { service, stdout } = yield* makeLive();
    const plan = {
      ...planWith([updateNode({ version: 1 }, { version: 2 })]),
      defaultMode: "local" as const,
    };
    const cli = sigilCli().pipe(Layer.provide(Layer.succeed(CliKit, service)));
    let settledAt = 0;
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.succeed({ endpoint: "http://localhost:3000" }).pipe(
          renderApply(plan, { dev: true }),
        );
        yield* Effect.promise(() => stdout.waitFor("Dev stack ready"));
        settledAt = stdout.output.length;
      }),
    ).pipe(Effect.provide(cli));

    // Nothing else is live once the generation is gone, so the renderer
    // unmounts and restores the cursor.
    expect(stdout.output.slice(settledAt)).toContain("[?25h");
  }),
);

// `p` hides the dev widget; a hot reload opens a fresh session and must not
// bring it back — the user's choice outlives the generation that made it.
it.effect("keeps the dev plan widget hidden across hot reloads", () =>
  Effect.gen(function* () {
    const stdin = new InputStream();
    const { service, stdout } = yield* makeLive({ stdin });
    const plan = {
      ...planWith([updateNode({ version: 1 }, { version: 2 })]),
      defaultMode: "local" as const,
    };
    const cli = sigilCli().pipe(Layer.provide(Layer.succeed(CliKit, service)));
    yield* Effect.gen(function* () {
      const { startApplySession } = yield* Cli;
      const first = yield* startApplySession(plan, { dev: true });
      yield* first.done("success");
      yield* Effect.promise(() => stdout.waitFor("p hide widget"));
      yield* Effect.promise(() => stdin.ready);
      yield* Effect.sync(() => stdin.write("p"));
      yield* Effect.promise(() => stdout.waitFor("p show plan/output"));
      yield* first.close!;

      const reloadedAt = stdout.output.length;
      const second = yield* startApplySession(plan, { dev: true });
      yield* second.done("success");
      yield* Effect.promise(() => stdout.waitFor("Dev stack ready"));
      const reloaded = stdout.output.slice(reloadedAt);
      expect(reloaded).toContain("p show plan/output");
      expect(reloaded).not.toContain("p hide widget");
      yield* second.close!;
    }).pipe(Effect.provide(cli));
  }),
);

it("virtualizes dev stack output", () => {
  const { service } = makeStatic();
  const tree = new PlanTree(planWith([updateNode({}, {})]), {
    mode: "apply",
    label: "Dev stack ready",
  });
  tree.setOutput(
    Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`output${index}`, index]),
    ),
  );
  tree.setView("output");

  const output = service.output.format(<Plan tree={tree} collapsible />, {
    columns: 80,
  });
  expect(output).toContain("Output");
  expect(output).toContain("earlier lines");
  expect(output).not.toContain("Worker");
  expect(output).toContain("←/→ show plan");
  expect(output).toContain("↑/↓ scroll output");
  expect(output.split("\n").length).toBeLessThanOrEqual(21);
});

it("renders drift details without detailed mode", () => {
  const { service } = makeStatic();
  const node = updateNode({ value: "declared" }, { value: "declared" });
  node.drift = {
    expected: { value: "declared" },
    actual: { value: "changed-out-of-band" },
  };
  const tree = new PlanTree(planWith([node]), { viewport: "full" });
  const output = service.output.format(<Plan tree={tree} />, {
    columns: 80,
  });

  expect(output).not.toContain("drift:");
  expect(output).toContain("│ - value: declared");
  expect(output).toContain("│ + value: changed-out-of-band");
});

it("replaces provider details with refresh progress in place", () => {
  const { service } = makeStatic();
  const output = service.output.format(
    <ProfileDetailsBody
      providers={[
        {
          name: "Cloudflare",
          method: "oauth",
          status: "ready",
          lines: ["accessToken: cfoa****", "expires: in 59m"],
        },
        {
          name: "GitHub",
          method: "gh-cli",
          status: "ready",
          lines: ["token: gho_cZ****"],
        },
      ]}
      refreshingProvider="Cloudflare"
    />,
    { columns: 80 },
  );

  expect(output).toContain("Cloudflare");
  expect(output).toContain("refreshing OAuth credentials…");
  expect(output).not.toContain("cfoa****");
  expect(output).not.toContain("in 59m");
  expect(output).toContain("GitHub");
  // `key: value` detail lines render as an aligned key column + value
  expect(output).toContain("token  gho_cZ****");
});

// Eight providers of varying height: 49 rows in total, twice a 24-row terminal.
const dashboardProviders: ReadonlyArray<ProfileProviderDisplay> = [
  {
    name: "AWS",
    method: "sso",
    status: "ready",
    lines: [
      "accessKeyId: ASIA****",
      "secretAccessKey: I7hs****",
      "sessionToken: IQoJ****",
      "region: us-east-2",
      "source: sso - default",
    ],
  },
  {
    name: "Cloudflare",
    method: "stored",
    status: "configured",
    lines: [
      "apiKey: cfk_****",
      "email: blan****",
      "accountId: 2b29****",
      "source: stored",
    ],
  },
  {
    name: "Fly",
    method: "stored",
    status: "configured",
    lines: ["apiKey: FlyV****"],
  },
  {
    name: "GitHub",
    method: "gh-cli",
    status: "configured",
    lines: ["token: gho_cZ****", "source: gh-cli"],
  },
  {
    name: "Hetzner",
    method: "stored",
    status: "configured",
    lines: ["token: 50Kt****"],
  },
  {
    name: "Prisma",
    method: "stored",
    status: "configured",
    lines: ["serviceToken: eyJr****"],
  },
  {
    name: "Railway",
    method: "oauth",
    status: "configured",
    lines: [
      "token: rw_Fe2****",
      "tokenKind: account",
      "apiBaseUrl: https://backboard.railway.com",
      "source: oauth",
    ],
  },
  {
    name: "Vercel",
    method: "stored",
    status: "reauth",
    lines: ["token: vc_****"],
  },
];

const dashboardEntries = [{ name: "default", isActive: true, isDefault: true }];

// The dashboard windows providers by `providerBlockHeight`, so the number must
// match what a block actually renders.
it("sizes provider blocks by providerBlockHeight", () => {
  const { service } = makeStatic();
  const output = service.output.format(
    <ProfileDetailsBody providers={dashboardProviders} focusColumn />,
    { columns: 80 },
  );
  const expected = dashboardProviders.reduce(
    (rows, provider, index) =>
      rows + providerBlockHeight(provider, index === 0),
    0,
  );
  expect(output.split("\n").length).toBe(expected);
});

// Providers are a table separated by blank rows, not rules; the focused
// provider is marked by the cursor glyph in a reserved column, never a rail.
it("marks the focused provider with the pointer and no rails", () => {
  const { service } = makeStatic();
  const output = service.output.format(
    <ProfileDetailsBody
      providers={dashboardProviders}
      focusColumn
      focusedProvider="Cloudflare"
      reauthHint="press r to re-login"
    />,
    { columns: 80 },
  );
  const lines = output.split("\n");
  expect(lines.some((line) => /[│─]/.test(line))).toBe(false);
  const pointed = lines.filter((line) => line.includes("❯"));
  expect(pointed).toHaveLength(1);
  expect(pointed[0]).toMatch(/^  ❯ Cloudflare\s+stored\s+! configured$/);
  expect(lines.some((line) => /^    AWS\s+sso\s+✓ ready$/.test(line))).toBe(
    true,
  );
  // detail keys render as an aligned column: key, gap, value
  expect(output).toContain("apiKey     cfk_****");
  expect(output).toContain("accountId  2b29****");
  // the re-login hint follows the focus cursor, so it is hidden here
  expect(output).not.toContain("press r to re-login");
});

it("windows the profile dashboard's providers to the terminal height", () => {
  const { service, stdout } = makeStatic();
  const store = new DashStore(dashboardEntries);
  store.setDetails("default", {
    state: "ready",
    providers: dashboardProviders,
    available: [],
  });
  const output = service.output.format(
    <Dashboard store={store} initialSelected={0} />,
    { columns: 80 },
  );

  expect(output.split("\n").length).toBeLessThanOrEqual(stdout.rows);
  expect(output).toContain("AWS");
  expect(output).toContain("Cloudflare");
  expect(output).toContain("switch profile");
  expect(output).not.toContain("Vercel");
  // The profile row holds the initial focus slot: the pointer sits on it and
  // the provider rows keep a blank cursor column so the table stays aligned.
  expect(output).toContain("\n  ❯ default");
  expect(output).toContain("\n    AWS ");
});

// The session sleeps on a real clock (loader delay, notice auto-dismiss).
it.live("scrolls the profile dashboard to the focused provider", () =>
  Effect.gen(function* () {
    const stdin = new InputStream();
    const { service, stdout } = yield* makeLive({ stdin });
    const session = yield* runProfileDashboardSession({
      entries: dashboardEntries,
      selected: "default",
      loadDetails: () =>
        Effect.succeed({ providers: dashboardProviders, available: [] }),
      execute: () =>
        Effect.succeed({ ok: true, message: "", entries: dashboardEntries }),
      runFlow: () => Effect.succeed({ ok: true, message: "" }),
      reloadEntries: Effect.succeed(dashboardEntries),
    }).pipe(Effect.provideService(CliKit, service), Effect.forkChild);

    // "focus provider" joins the key bar once the providers have resolved;
    // arrow keys are ignored while the pane still shows the loading spinner.
    yield* Effect.promise(() => stdout.waitFor("focus provider"));
    yield* Effect.promise(() => stdin.ready);
    expect(stdout.output).not.toContain("Vercel");

    // Walk the focus cursor down to the last provider; the list follows it.
    for (const _ of dashboardProviders) {
      yield* Effect.sync(() => stdin.write("\x1b[B"));
    }
    yield* Effect.promise(() => stdout.waitFor("Vercel"));

    yield* Effect.sync(() => stdin.write("q"));
    yield* Fiber.join(session);
  }),
);

it("renders input frames inline by default and keeps a stacked variant", () => {
  const { service } = makeStatic();
  const inline = service.output.format(
    <PromptFrame
      message="Profile name"
      description="Used to select stored credentials."
      layout="inline"
    >
      <Text>production</Text>
    </PromptFrame>,
  );
  const stacked = service.output.format(
    <PromptFrame message="Profile name" layout="stacked">
      <Text>production</Text>
    </PromptFrame>,
  );

  expect(inline).toContain("Profile name: production");
  expect(inline).toContain("Used to select stored credentials.");
  expect(stacked).toContain("Profile name\n");
  expect(stacked).toContain("production");
});

it("renders compact informational toasts as a bare status line", () => {
  const { service } = makeStatic();
  const output = service.output.format(
    <Toast variant="info">Credentials refreshed.</Toast>,
  );

  expect(output).toBe("• Credentials refreshed.");
});

it("renders prompt frames with an indented body and no rail", () => {
  const { service } = makeStatic();
  const output = service.output.format(
    <PromptFrame message="Cloudflare authentication method">
      <Menu
        cursor={0}
        choices={[
          { value: "oauth", label: "OAuth", description: "recommended" },
          {
            value: "token",
            label: "API Token or API Key",
            description: "use an API token",
          },
        ]}
      />
    </PromptFrame>,
    { columns: 100 },
  );

  const lines = output.split("\n");
  expect(lines[0]).toBe("◆ Cloudflare authentication method");
  // options sit directly under the heading; ❯ is the only chevron on screen
  expect(lines[1]).toMatch(/^  ❯ OAuth\s+recommended$/);
  expect(lines[2]).toMatch(/^    API Token or API Key\s+use an API token$/);
  // descriptions share one column across rows
  expect(lines[1]!.indexOf("recommended")).toBe(
    lines[2]!.indexOf("use an API token"),
  );
  expect(output).not.toContain("│");
  expect(output).not.toContain("›");
});

/**
 * Scoped variant of `makeStatic` for tests that mount a persistent renderer.
 * Disposal runs as a finalizer, so a failing test never leaks a Sigil
 * instance.
 */
const makeLive = (
  overrides: {
    readonly stdin?: InputStream;
    readonly captureConsole?: boolean;
    readonly input?: boolean;
    readonly unicode?: boolean;
    readonly colors?: boolean;
  } = {},
) => {
  const input = overrides.input ?? true;
  return Effect.acquireRelease(
    Effect.sync(() => {
      const stdout = new CaptureStream(input);
      const stderr = new CaptureStream(input);
      // Interactive runtimes need a raw-mode-capable stdin: with a real
      // process.stdin pipe Sigil's useInput throws during commit, which now
      // surfaces as a renderer error instead of being silently swallowed.
      const stdin = overrides.stdin ?? (input ? new InputStream() : undefined);
      stdin?.connect(stdout);
      const runtime = makeRuntime(
        {
          input,
          // SAFETY: InputStream implements the raw readable stream surface consumed by Sigil.
          stdin: stdin as unknown as NodeJS.ReadStream | undefined,
          // SAFETY: CaptureStream implements the writable stream surface consumed by Sigil.
          stdout: stdout as unknown as NodeJS.WriteStream,
          // SAFETY: CaptureStream implements the writable stream surface consumed by Sigil.
          stderr: stderr as unknown as NodeJS.WriteStream,
          captureConsole: overrides.captureConsole ?? false,
        },
        {
          input,
          columns: stdout.columns,
          rows: stdout.rows,
          colors: overrides.colors ?? false,
          unicode: overrides.unicode ?? true,
          alternateScreen: input,
        },
      );
      return { ...runtime, stdout, stderr };
    }),
    ({ dispose }) => Effect.promise(dispose),
  );
};

it.effect("keeps stack output URLs reachable", () =>
  Effect.gen(function* () {
    const { service } = yield* makeLive({ colors: true });
    const url = "https://example.com/deploy";
    const output = service.output.format(stackOutputsView({ url }), {
      colors: true,
    });
    expect(stripVTControlCharacters(output)).toContain(url);
  }),
);

it.effect(
  "keeps the state explorer active while searching and quits cleanly",
  () =>
    Effect.gen(function* () {
      const stdin = new InputStream();
      const { service, stdout } = yield* makeLive({ stdin });
      const fiber = yield* service
        .application(service.prompt.custom(stateExplorerScreen(explorerSource)))
        .pipe(Application.alternate)
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => stdin.ready);
      yield* Effect.promise(() => stdout.waitFor("Loading"));

      yield* Effect.sync(() => stdin.write("/"));
      yield* settleInput;
      yield* Effect.sync(() => stdin.write("workers.dev"));
      yield* settleInput;
      yield* Effect.sync(() => stdin.write("\r"));
      yield* settleInput;
      expect(fiber.pollUnsafe()).toBeUndefined();

      yield* Effect.sync(() => stdin.write("q"));
      yield* Fiber.join(fiber);
    }),
);

it.effect("renders the built-in layout components without writing", () =>
  Effect.gen(function* () {
    const { service, stdout } = makeStatic();
    const rendered = yield* service.output.render(
      <>
        <SectionHeading annotation="active">Profile</SectionHeading>
        <DescriptionList
          items={[
            { label: "Name", value: "production" },
            { label: "Status", value: "ready" },
          ]}
        />
      </>,
    );

    expect(rendered).toContain("Profile");
    expect(rendered).toContain("production");
    expect(rendered).toContain("ready");
    expect(stdout.output).toBe("");
  }),
);

it.effect("renders confirmations as a compact segmented choice", () =>
  Effect.gen(function* () {
    const { service } = makeStatic();

    expect(
      (yield* service.output.render(
        <ChoiceGroup
          value
          choices={[
            { value: true, label: "Yes" },
            { value: false, label: "No" },
          ]}
        />,
      )).trim(),
    ).toBe("Yes   No");
    expect(
      (yield* service.output.render(
        <ChoiceGroup
          value={false}
          choices={[
            { value: true, label: "Yes" },
            { value: false, label: "No" },
          ]}
        />,
      )).trim(),
    ).toBe("Yes   No");
    expect(
      (yield* service.output.render(
        <ChoiceGroup
          value
          choices={[
            { value: true, label: "Destroy" },
            { value: false, label: "Cancel" },
          ]}
        />,
      )).trim(),
    ).toBe("Destroy   Cancel");
    expect(
      (yield* service.output.render(
        <ChoiceGroup
          orientation="vertical"
          value="repair"
          choices={[
            {
              value: "repair",
              label: "Repair",
              description: "restore declared state",
            },
            { value: "cancel", label: "Cancel" },
          ]}
        />,
      )).trim(),
    ).toBe("Repair · restore declared state\n   Cancel");
  }),
);

it.effect("preserves zero in primitive-array views", () =>
  Effect.gen(function* () {
    const { service } = makeStatic();
    const rendered = yield* service.output.render(["count: ", 0, false, null]);

    expect(rendered).toBe("count: 0");
  }),
);

it("does not animate work before it starts", () => {
  expect(isInProgress("pending")).toBe(false);
  expect(isInProgress("creating")).toBe(true);
  expect(isInProgress("updating")).toBe(true);
  expect(isInProgress("deleting")).toBe(true);
  expect(isInProgress("running")).toBe(true);
});

it.effect("prints headings and data views through one service", () =>
  Effect.gen(function* () {
    const { service, stdout } = makeStatic();
    yield* service.output.print(<Heading>Deployments</Heading>);
    yield* service.output.print(
      <DescriptionList
        items={[
          { label: "api", value: "ready" },
          { label: "worker", value: "updating" },
        ]}
      />,
    );

    expect(stdout.output).toContain("Deployments");
    expect(stdout.output).toContain("worker");
    expect(stdout.output).toContain("updating");
  }),
);

it.effect("fails input operations when no terminal input is available", () =>
  Effect.gen(function* () {
    const { service } = makeStatic();
    const failure = yield* service.prompt
      .select({
        message: "Choose",
        options: [{ label: "One", value: 1 }],
      })
      .pipe(Effect.flip);

    expect(failure).toBeInstanceOf(NonInteractiveTerminal);
    if (failure instanceof NonInteractiveTerminal) {
      expect(failure.operation).toBe("selection");
    }

    const cycleFailure = yield* service.prompt
      .cycle({ message: "Change", options: [] })
      .pipe(Effect.flip);
    const externalFailure = yield* service.prompt
      .awaitExternal({
        message: "Authorize",
        waitingLabel: "Waiting",
        inputLabel: "Enter code",
      })
      .pipe(Effect.flip);
    expect(cycleFailure).toBeInstanceOf(NonInteractiveTerminal);
    if (cycleFailure instanceof NonInteractiveTerminal) {
      expect(cycleFailure.operation).toBe("cycle selection");
    }
    expect(externalFailure).toBeInstanceOf(NonInteractiveTerminal);
    if (externalFailure instanceof NonInteractiveTerminal) {
      expect(externalFailure.operation).toBe("external authorization");
    }
  }),
);

it.effect("progress handles are updateable and settle only once", () =>
  Effect.gen(function* () {
    const { service, stdout } = makeStatic();
    const progress = yield* service.live.progress({ label: "Deploying" });
    yield* progress.update({ label: "Uploading", detail: "2/3" });
    yield* progress.succeed("Deployed");
    yield* progress.fail("must not print");

    expect(stdout.output).toContain("Deploying");
    expect(stdout.output).toContain("Deployed");
    expect(stdout.output).not.toContain("must not print");
  }),
);

/** Live views are immutable; dynamic content flows through caller stores. */
const LiveLabel = ({ store }: { readonly store: LiveStore<string> }) => (
  <Text>{useLiveStore(store)}</Text>
);

it.effect("tears down store-driven live views idempotently", () =>
  Effect.gen(function* () {
    const { service, stdout } = yield* makeLive();

    const store = new LiveStore("Scanning");
    const live = yield* service.live.open(<LiveLabel store={store} />);
    yield* Effect.sync(() => store.set("Deleting"));
    yield* live.close;
    yield* live.close;

    expect(stdout.output).toContain("\u001B[?25h");
  }),
);

it.effect("does not let one closing view tear down a newer live view", () =>
  Effect.gen(function* () {
    const { service, stdout } = yield* makeLive();

    const first = yield* service.live.open(<Text>first</Text>);
    const closing = yield* first.close.pipe(Effect.forkChild);
    const store = new LiveStore("second");
    const second = yield* service.live.open(<LiveLabel store={store} />, {
      persistOnClose: true,
    });
    yield* Fiber.join(closing);
    yield* Effect.sync(() => store.set("second updated"));
    yield* second.close;

    expect(stdout.output).toContain("second updated");
  }),
);

interface OrderingCase {
  readonly name: string;
  readonly captureConsole: boolean;
  readonly emit: (service: CliKit["Service"]) => Effect.Effect<void>;
  readonly verify: (output: string) => void;
}

const orderingCases: ReadonlyArray<OrderingCase> = [
  {
    name: "commits persistent live views to the static transcript",
    captureConsole: false,
    emit: () => Effect.void,
    verify: (output) => {
      expect(output).toContain("Deployed");
      expect(output.slice(output.lastIndexOf("Deployed"))).not.toContain(
        "\u001B[2K",
      );
      expect(output).toContain("\u001B[?25h");
    },
  },
  {
    name: "keeps styled captured logs static and ordered before completed live views",
    captureConsole: true,
    emit: () =>
      Effect.sync(() => console.log("\u001B[32mruntime ready\u001B[0m")),
    verify: (output) => {
      expect(output.match(/runtime ready/g)?.length).toBe(1);
      expect(output).toContain("\u001B[32m");
      expect(output.indexOf("runtime ready")).toBeLessThan(
        output.lastIndexOf("Deployed"),
      );
    },
  },
  {
    name: "orders semantic output through the active renderer",
    captureConsole: false,
    emit: (service) => service.output.info("runtime ready"),
    verify: (output) => {
      expect(output.indexOf("runtime ready")).toBeLessThan(
        output.lastIndexOf("Deployed"),
      );
    },
  },
];

it.effect.each(orderingCases)("$name", ({ captureConsole, emit, verify }) =>
  Effect.gen(function* () {
    const { service, stdout } = yield* makeLive({
      captureConsole,
      colors: captureConsole,
    });

    const store = new LiveStore("Deploying");
    const live = yield* service.live.open(<LiveLabel store={store} />, {
      persistOnClose: true,
    });
    yield* emit(service);
    yield* Effect.sync(() => store.set("Deployed"));
    yield* live.close;

    verify(stdout.output);
  }),
);

it.effect("commits stdio above active Sigil views", () =>
  Effect.gen(function* () {
    const { service, stdout, stderr } = yield* makeLive({
      captureConsole: true,
    });
    const store = new LiveStore("Resolving credentials");
    const live = yield* service.live.open(<LiveLabel store={store} />, {
      persistOnClose: true,
    });

    yield* Effect.sync(() => {
      stdout.write("floci stdout\n");
      stderr.write("node warning\n");
      store.set("Credentials resolved");
    });
    yield* live.close;

    expect(stdout.output).toContain("floci stdout");
    expect(stdout.output).toContain("node warning");
    expect(stderr.output).not.toContain("node warning");
    expect(stdout.output).toContain("Credentials resolved");
    expect(stdout.output.lastIndexOf("node warning")).toBeLessThan(
      stdout.output.lastIndexOf("Credentials resolved"),
    );
  }),
);

it.effect("flushes a captured partial line without waiting for unmount", () =>
  Effect.gen(function* () {
    const { service, stdout, stderr } = yield* makeLive({
      captureConsole: true,
    });
    const store = new LiveStore("Deploying");
    const live = yield* service.live.open(<LiveLabel store={store} />);
    // A writer whose final chunk has no trailing newline (e.g. an error
    // block written raw to stderr): its tail must render within the
    // partial-flush deadline — before this, it sat buffered until the
    // renderer unmounted at process exit, so the last line of an error
    // only ever appeared on shutdown.
    yield* Effect.sync(() => {
      stderr.write("stack tail without newline");
    });
    yield* Effect.promise(() => stdout.waitFor("stack tail without newline"));
    yield* live.close;
  }),
);

it.effect("progress settles into success and failure status output", () =>
  Effect.gen(function* () {
    const { service, stdout } = makeStatic();
    yield* Effect.scoped(
      Effect.gen(function* () {
        const first = yield* service.live.progress({
          label: "Resolve credentials",
        });
        yield* first.succeed();
        const second = yield* service.live.progress({
          label: "Apply resource",
        });
        yield* second.fail();
      }),
    );

    expect(stdout.output).toContain("Resolve credentials");
    expect(stdout.output).toContain("Apply resource");
    expect(stdout.output).toContain("✓");
    expect(stdout.output).toContain("×");
  }),
);

it.effect("task collapses success and failure into status output", () =>
  Effect.gen(function* () {
    const { service, stdout } = makeStatic();
    yield* service.task(
      { label: "Resolve credentials" },
      Effect.succeed("credentials"),
    );
    yield* service
      .task({ label: "Apply resource" }, Effect.fail("nope"))
      .pipe(Effect.ignore);

    expect(stdout.output).toContain("Resolve credentials");
    expect(stdout.output).toContain("Apply resource");
    expect(stdout.output).toContain("✓");
    expect(stdout.output).toContain("×");
  }),
);

it.effect("status output composes as a normal view", () =>
  Effect.gen(function* () {
    const { service } = makeStatic();
    const rendered = yield* service.output.render(
      <Status variant="warning" detail="retrying">
        API unavailable
      </Status>,
    );
    expect(rendered).toContain("API unavailable");
    expect(rendered).toContain("retrying");
  }),
);

it.effect("uses ASCII fallbacks when Unicode is unavailable", () =>
  Effect.gen(function* () {
    const { service } = yield* makeLive({ input: false, unicode: false });
    const rendered = yield* service.output.render(
      <>
        <Heading>Deploy</Heading>
        <Status variant="success">Complete</Status>
      </>,
    );
    expect(rendered).toContain("@ Deploy");
    expect(rendered).toContain("+ Complete");
    expect(rendered).not.toContain("✓");
  }),
);

it("uses one resource-prefixed pipeline for chunked stdout and stderr", () => {
  const lines: string[] = [];
  const output = makeResourceOutput("www", {
    log: (...args) => lines.push(args.join(" ")),
  });

  output.stdout.push("first\nsec");
  output.stdout.push("ond\r");
  output.stderr.push("failed");
  output.stdout.flush();
  output.stderr.flush();

  const prefix = "[www]";
  expect(lines.map(stripVTControlCharacters)).toEqual([
    `${prefix} first`,
    `${prefix} second`,
    `${prefix} failed`,
  ]);
});

it.effect(
  "routes effectful resource output through the configured logger",
  () => {
    const entries: Array<{ level: string; message: unknown }> = [];
    const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
      entries.push({ level: logLevel, message });
    });
    const output = makeResourceLogger("www");

    return Effect.gen(function* () {
      yield* output("stdout", "[MDX] generated files");
      yield* output("stderr", "vite diagnostic");
      expect(entries).toEqual([
        { level: "Info", message: ["[www] [MDX] generated files"] },
        { level: "Info", message: ["[www] vite diagnostic"] },
      ]);
    }).pipe(Effect.provide(Logger.layer([logger])));
  },
);

it.effect("does not decorate resource stderr as a semantic failure", () =>
  Effect.gen(function* () {
    const { service, stdout } = yield* makeLive({ captureConsole: true });
    const live = yield* service.live.open(<Text>Building</Text>);

    const output = makeResourceOutput("www", globalThis.console);
    output.stderr.push("[FILE_NAME_CONFLICT] warning\n");
    output.stderr.flush();
    yield* live.close;

    const rendered = stripVTControlCharacters(stdout.output);
    expect(rendered).toContain(`[www] [FILE_NAME_CONFLICT] warning`);
    expect(rendered).not.toContain("×");
  }),
);

it.effect("runs interactive components inside the owned session", () =>
  Effect.gen(function* () {
    const { service, stdout } = yield* makeLive();

    const result = yield* service.prompt.custom(
      Screen.make("test screen", ({ submit }) => {
        queueMicrotask(() => submit("completed", <Status>Done</Status>));
        return <Status>Working</Status>;
      }),
    );
    expect(result).toBe("completed");
    expect(stdout.output).toContain("Done");
  }),
);

it.effect("restores the terminal after an alternate-screen interaction", () =>
  Effect.gen(function* () {
    const { service, stdout } = yield* makeLive();

    yield* service
      .application(
        service.prompt.custom(
          Screen.make("full screen", ({ submit }) => {
            queueMicrotask(() => submit(undefined));
            return <Status>Browsing</Status>;
          }),
        ),
      )
      .pipe(Application.alternate);

    expect(stdout.output).toContain("\u001B[?1049h");
    expect(stdout.output).toContain("\u001B[?1049l");
    expect(stdout.output.indexOf("\u001B[?1049h")).toBeLessThan(
      stdout.output.indexOf("\u001B[?1049l"),
    );
  }),
);

it.effect("treats the terminal DEL byte as text-field backspace", () =>
  Effect.gen(function* () {
    const stdin = new InputStream();
    const { service } = yield* makeLive({ stdin });

    const fiber = yield* service.prompt
      .custom(
        Screen.make("backspace", ({ submit }) => (
          <TextField initialValue="abc" onChange={submit} onSubmit={submit} />
        )),
      )
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => stdin.ready);
    yield* Effect.sync(() => stdin.write("\x7f"));
    const result = yield* Fiber.join(fiber);

    expect(result).toBe("ab");
  }),
);

/** Let a written stdin chunk flow through Sigil's input pipeline. */
const settleInput = Effect.yieldNow.pipe(Effect.repeat({ times: 2 }));

it.effect("strips control characters from pasted text-field input", () =>
  Effect.gen(function* () {
    const stdin = new InputStream();
    const { service } = yield* makeLive({ stdin });

    const fiber = yield* service.prompt
      .custom(
        Screen.make("paste", ({ submit }) => <TextField onSubmit={submit} />),
      )
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => stdin.ready);
    // A paste arrives as one chunk; embedded newlines/tabs must not survive.
    yield* Effect.sync(() => stdin.write("to\tken\r\n123"));
    yield* settleInput;
    yield* Effect.sync(() => stdin.write("\r"));
    const result = yield* Fiber.join(fiber);

    expect(result).toBe("token123");
  }),
);

it.effect("shows the whole typed value while width remains available", () =>
  Effect.gen(function* () {
    const stdin = new InputStream();
    const { service, stdout } = yield* makeLive({ stdin });

    const fiber = yield* service.prompt
      .text({ message: "New profile name" })
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => stdin.ready);
    // Regression: the field's box used to shrink to its content, so the
    // measured "available" width collapsed to the minimum and the value
    // scrolled after ~4 characters despite a mostly-empty row.
    yield* Effect.sync(() => stdin.write("my-longer-profile-name"));
    yield* Effect.promise(() => stdout.waitFor("my-longer-profile-name"));
    expect(stdout.output).toContain("my-longer-profile-name");
    yield* Effect.sync(() => stdin.write("\r"));
    const result = yield* Fiber.join(fiber);

    expect(result).toBe("my-longer-profile-name");
  }),
);

it.effect("shows a text prompt default before it is accepted", () =>
  Effect.gen(function* () {
    const stdin = new InputStream();
    const { service, stdout } = yield* makeLive({ stdin });

    const fiber = yield* service.prompt
      .text({
        message: "Emulator endpoint",
        defaultValue: "http://localhost:4566",
      })
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => stdin.ready);
    yield* Effect.promise(() => stdout.waitFor("http://localhost:4566"));
    expect(stripVTControlCharacters(stdout.output)).toContain(
      "Emulator endpoint: http://localhost:4566",
    );
    yield* Effect.sync(() => stdin.write("\r"));

    expect(yield* Fiber.join(fiber)).toBe("http://localhost:4566");
  }),
);

it.effect("deletes a whole emoji grapheme on backspace", () =>
  Effect.gen(function* () {
    const stdin = new InputStream();
    const { service } = yield* makeLive({ stdin });

    const fiber = yield* service.prompt
      .custom(
        Screen.make("grapheme", ({ submit }) => (
          <TextField initialValue="a👍" onChange={submit} onSubmit={submit} />
        )),
      )
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => stdin.ready);
    yield* Effect.sync(() => stdin.write("\x7f"));
    const result = yield* Fiber.join(fiber);

    expect(result).toBe("a");
  }),
);

it.effect("erases the multi-select filter with the terminal DEL byte", () =>
  Effect.gen(function* () {
    const stdin = new InputStream();
    const { service } = yield* makeLive({ stdin });

    const fiber = yield* service.prompt
      .multiSelect({
        message: "pick",
        options: [
          { value: "alpha", label: "alpha" },
          { value: "beta", label: "beta" },
        ],
      })
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => stdin.ready);
    // Filter to nothing, erase the filter with DEL, then toggle + confirm.
    yield* Effect.sync(() => stdin.write("z"));
    yield* settleInput;
    yield* Effect.sync(() => stdin.write("\x7f"));
    yield* settleInput;
    yield* Effect.sync(() => stdin.write(" "));
    yield* settleInput;
    yield* Effect.sync(() => stdin.write("\r"));
    const result = yield* Fiber.join(fiber);

    expect(result).toEqual(["alpha"]);
  }),
);

it.effect("filters searchable selects without stealing Enter", () =>
  Effect.gen(function* () {
    const stdin = new InputStream();
    const { service } = yield* makeLive({ stdin });

    const fiber = yield* service.prompt
      .select({
        message: "pick",
        searchable: true,
        options: [
          { value: "alpha", label: "alpha" },
          { value: "beta", label: "beta" },
        ],
      })
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => stdin.ready);
    yield* Effect.sync(() => stdin.write("bet"));
    yield* settleInput;
    yield* Effect.sync(() => stdin.write("\r"));
    const result = yield* Fiber.join(fiber);

    expect(result).toBe("beta");
  }),
);

it.effect("keeps required cycle edits open until something changes", () =>
  Effect.gen(function* () {
    const stdin = new InputStream();
    const { service } = yield* makeLive({ stdin });

    const fiber = yield* service.prompt
      .cycle({
        message: "Manage accounts",
        requireChange: true,
        options: [
          {
            label: "Cloudflare",
            states: [
              { value: "keep", label: "keep" },
              { value: "remove", label: "remove" },
            ],
          },
        ],
      })
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => stdin.ready);
    yield* Effect.sync(() => stdin.write("\r"));
    yield* settleInput;
    expect(fiber.pollUnsafe()).toBe(undefined);

    yield* Effect.sync(() => stdin.write(" "));
    yield* settleInput;
    yield* Effect.sync(() => stdin.write("\r"));
    const result = yield* Fiber.join(fiber);
    expect(result).toEqual(["remove"]);
  }),
);

it.effect("reopens browser authorization from the waiting screen", () =>
  Effect.gen(function* () {
    const stdin = new InputStream();
    const { service } = yield* makeLive({ stdin });
    let opened = 0;

    const fiber = yield* service.prompt
      .awaitExternal({
        message: "Authorize",
        waitingLabel: "Waiting",
        url: "https://example.com/authorize",
        inputLabel: "Enter code",
        onOpen: async () => {
          opened += 1;
        },
      })
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => stdin.ready);
    yield* Effect.sync(() => stdin.write("o"));
    yield* settleInput;
    expect(opened).toBe(1);

    yield* Effect.sync(() => stdin.write("\r"));
    yield* settleInput;
    yield* Effect.sync(() => stdin.write("code"));
    yield* settleInput;
    yield* Effect.sync(() => stdin.write("\r"));
    const result = yield* Fiber.join(fiber);
    expect(result).toBe("code");
  }),
);

it.effect("keeps browser-only authorization cancellable", () =>
  Effect.gen(function* () {
    const stdin = new InputStream();
    const { service, stdout } = yield* makeLive({ stdin });

    const fiber = yield* service.prompt
      .awaitExternal({
        message: "AWS authorization",
        waitingLabel: "Waiting",
        url: "https://example.com/authorize",
        allowManualInput: false,
      })
      .pipe(Effect.flip, Effect.forkChild);
    yield* Effect.promise(() => stdin.ready);
    yield* Effect.promise(() => stdout.waitFor("AWS authorization"));
    expect(stripVTControlCharacters(stdout.output)).not.toContain(
      "enter code manually",
    );

    // Enter is intentionally inert for a browser-only flow.
    yield* Effect.sync(() => stdin.write("\r"));
    yield* settleInput;
    expect(fiber.pollUnsafe()).toBeUndefined();

    yield* Effect.sync(() => stdin.write("\x1b"));
    const failure = yield* Fiber.join(fiber);
    expect(failure).toBeInstanceOf(TerminalCancelled);
  }),
);

it.effect("shows a device authorization code", () =>
  Effect.gen(function* () {
    const stdin = new InputStream();
    const { service, stdout } = yield* makeLive({ stdin });

    const fiber = yield* service.prompt
      .awaitExternal({
        message: "AWS authorization",
        waitingLabel: "Waiting for device authorization…",
        url: "https://device.sso.example.com/",
        code: "ABCD-EFGH",
        allowManualInput: false,
      })
      .pipe(Effect.flip, Effect.forkChild);
    yield* Effect.promise(() => stdin.ready);
    yield* Effect.promise(() => stdout.waitFor("ABCD-EFGH"));

    const output = stripVTControlCharacters(stdout.output);
    expect(output).toContain("Code ABCD-EFGH");
    expect(output).toContain("copy code");

    yield* Effect.sync(() => stdin.write("\x1b"));
    const failure = yield* Fiber.join(fiber);
    expect(failure).toBeInstanceOf(TerminalCancelled);
  }),
);

it.effect("toggles every visible multi-select choice on ctrl+a", () =>
  Effect.gen(function* () {
    const stdin = new InputStream();
    const { service } = yield* makeLive({ stdin });

    const fiber = yield* service.prompt
      .multiSelect({
        message: "pick",
        options: [
          { value: "alpha", label: "alpha" },
          { value: "beta", label: "beta" },
          { value: "gamma", label: "gamma", disabled: true },
        ],
      })
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => stdin.ready);
    yield* Effect.sync(() => stdin.write("\x01"));
    yield* settleInput;
    yield* Effect.sync(() => stdin.write("\r"));
    const result = yield* Fiber.join(fiber);

    expect(result).toEqual(["alpha", "beta"]);
  }),
);

it.effect("returns an explicit undefined menu back target on Escape", () =>
  Effect.gen(function* () {
    const stdin = new InputStream();
    const { service } = yield* makeLive({ stdin });

    const fiber = yield* service.prompt
      .menu<string | undefined>({
        message: "pick",
        back: undefined,
        options: [{ value: "alpha", label: "alpha" }],
      })
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => stdin.ready);
    yield* Effect.sync(() => stdin.write("\x1b"));
    const result = yield* Fiber.join(fiber);

    expect(result).toBe(undefined);
  }),
);

it.effect("cleans up a cancelled standalone prompt", () =>
  Effect.gen(function* () {
    const { service, stdout } = yield* makeLive();

    const failure = yield* service.prompt
      .custom(
        Screen.make("cancel test", ({ cancel }) => {
          queueMicrotask(cancel);
          return <Status>Waiting</Status>;
        }),
      )
      .pipe(Effect.flip);

    expect(failure).toBeInstanceOf(TerminalCancelled);
    expect(stdout.output).toContain("cancel test cancelled");
  }),
);

it.effect("releases the renderer when a running prompt is interrupted", () =>
  Effect.gen(function* () {
    const stdin = new InputStream();
    const { service } = yield* makeLive({ stdin });

    const fiber = yield* service.prompt
      .custom(Screen.make("interrupted", () => <Status>Waiting</Status>))
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => stdin.ready);
    yield* Fiber.interrupt(fiber);

    // The interrupted prompt must have released the renderer and the prompt
    // gate for the next interaction.
    const result = yield* service.prompt.custom(
      Screen.make("after interruption", ({ submit }) => {
        queueMicrotask(() => submit("ok"));
        return <Status>After</Status>;
      }),
    );
    expect(result).toBe("ok");
  }),
);

it.effect("closes leaked live handles when their scope closes", () =>
  Effect.gen(function* () {
    const { service, stdout } = yield* makeLive();

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* service.live.open(<Text>Leaky</Text>);
        // Deliberately no close — the enclosing scope must release the row
        // and unmount the renderer.
      }),
    );

    expect(stdout.output).toContain("[?25h");
  }),
);

it.effect("fails the active prompt when a screen throws during render", () =>
  Effect.gen(function* () {
    const { service } = yield* makeLive();
    const Broken = (): never => {
      throw new Error("screen render boom");
    };

    // Without exit observation this would hang forever: the screen's
    // submit/cancel can never run once the renderer has crashed.
    const exit = yield* service.prompt
      .custom(Screen.make("broken screen", () => <Broken />))
      .pipe(Effect.exit);

    expect(Exit.isFailure(exit)).toBe(true);
  }),
);

it.effect("cancels a screen with no cancel wiring on ctrl+c", () =>
  Effect.gen(function* () {
    const stdin = new InputStream();
    const { service, stdout } = yield* makeLive({ stdin });

    // The screen never touches the controller — the centralized handler in
    // the runtime must still turn Ctrl+C into a cancellation.
    const fiber = yield* service.prompt
      .custom(Screen.make("no cancel wiring", () => <Status>Waiting</Status>))
      .pipe(Effect.flip, Effect.forkChild);
    yield* Effect.promise(() => stdin.ready);
    yield* Effect.sync(() => stdin.write("\x03"));
    const failure = yield* Fiber.join(fiber);

    expect(failure).toBeInstanceOf(TerminalCancelled);
    expect(stdout.output).toContain("no cancel wiring cancelled");
  }),
);

it.effect("keeps one renderer alive for an Effect-driven application", () =>
  Effect.gen(function* () {
    const { service, stdout } = yield* makeLive();

    const result = yield* service.application(
      Effect.gen(function* () {
        const action = yield* service.prompt.custom(
          Screen.make("main menu", ({ submit }) => {
            queueMicrotask(() => submit("add"));
            return <Status>Main menu</Status>;
          }),
        );
        const name = yield* service.wizard(
          service.prompt.custom(
            Screen.make("auth flow", ({ submit }) => {
              queueMicrotask(() =>
                submit("cloudflare", <Status>Profile name</Status>),
              );
              return <Status>Cloudflare auth</Status>;
            }),
          ),
        );
        const done = yield* service.prompt.custom(
          Screen.make("returned menu", ({ submit }) => {
            queueMicrotask(() => submit(true));
            return <Status>Returned menu</Status>;
          }),
        );
        return { action, name, done };
      }),
    );

    expect(result).toEqual({
      action: "add",
      name: "cloudflare",
      done: true,
    });
    // Clearing an inline application first renders an empty frame. Its final
    // row must be reclaimed before teardown or the next shell prompt starts
    // one line too low.
    expect(stdout.output.slice(stdout.output.lastIndexOf("\n") + 1)).toContain(
      "\u001B[1A",
    );
  }),
);

it.effect("provides CliKit once as a scoped injectable service", () => {
  const stdout = new CaptureStream();
  return Effect.gen(function* () {
    const capabilities = yield* CliKit.useSync((cli) => cli.terminal);
    const cli = yield* CliKit;
    yield* cli.output.print("Injected");

    expect(capabilities.input).toBe(false);
    expect(capabilities.colors).toBe(false);
    expect(stdout.output).toContain("Injected");
  }).pipe(
    Effect.provide(
      cliKitLayer({
        input: false,
        stdout: stdout as unknown as NodeJS.WriteStream,
        captureConsole: false,
      }),
    ),
  );
});

it.effect("uses append-only progress when input is disabled on a TTY", () => {
  const stdout = new CaptureStream(true);
  return Effect.gen(function* () {
    const cli = yield* CliKit;
    const progress = yield* cli.live.progress({ label: "Deploying" });
    yield* progress.update({ label: "Uploading" });
    yield* progress.succeed("Deployed");

    expect(cli.terminal.input).toBe(false);
    expect(stdout.output).toContain("Deploying\n");
    expect(stdout.output).toContain("Deployed\n");
    expect(stdout.output).not.toContain("\u001B[");
  }).pipe(
    Effect.provide(
      cliKitLayer({
        input: false,
        stdout: stdout as unknown as NodeJS.WriteStream,
        captureConsole: false,
      }),
    ),
  );
});

it.effect(
  "renders the same semantic and component output without terminal input",
  () =>
    Effect.gen(function* () {
      const { service, stdout } = yield* makeLive({
        input: false,
        unicode: false,
      });

      yield* service.output.info("Resolving credentials");
      yield* service.output.success({
        message: "Authenticated",
        detail: "cloudflare",
      });
      yield* service.output.warning("Token expires soon");
      yield* service.output.error("Authentication failed");
      yield* service.output.print(
        <Alert variant="warning" title="Attention">
          Manual action required
        </Alert>,
      );
      yield* service.output.print(<Status>React output</Status>);

      expect(stdout.output).toContain("Resolving credentials\n");
      expect(stdout.output).toContain("Authenticated");
      expect(stdout.output).toContain("cloudflare");
      expect(stdout.output).toContain("Token expires soon");
      expect(stdout.output).toContain("Authentication failed");
      expect(stdout.output).toContain("Attention");
      expect(stdout.output).toContain("Manual action required");
      expect(stdout.output).toContain("React output");
    }),
);

it.effect(
  "renders application, transcript, live-work, and data primitives together",
  () =>
    Effect.gen(function* () {
      const { service } = makeStatic();
      const rendered = yield* service.output.render(
        <>
          <Tabs
            tabs={[
              { id: "dev", label: "dev" },
              { id: "prod", label: "prod", marked: true },
            ]}
            active="prod"
          />
          <AnsweredPrompt message="Account" answer="production" />
          <TaskRow spinning label="stack" />
          <TaskRow icon="+" label="worker" depth={1} />
          <ProgressGroup
            rows={[
              {
                id: "providers",
                label: "providers",
                completed: 2,
                total: 4,
              },
            ]}
          />
          <Status>q quit</Status>
        </>,
      );

      expect(rendered).toContain("prod");
      expect(rendered).toContain("production");
      expect(rendered).toContain("worker");
      expect(rendered).toContain("2/4");
    }),
);

it.effect("composes widgets before and after divided key hints", () =>
  Effect.gen(function* () {
    const { service } = makeStatic();
    const rendered = yield* service.output.render(
      <KeyBar
        inline
        marginTop={0}
        divider
        before={<Text>Plan summary</Text>}
        keys={[["p", "show plan"]]}
        after={<Text>ready</Text>}
      />,
    );

    expect(rendered.trim().split("\n")).toHaveLength(1);
    expect(rendered).toContain("Plan summary");
    expect(rendered.match(/│/g)).toHaveLength(2);
    expect(rendered).toContain("p show plan");
    expect(rendered).toContain("ready");
  }),
);

it("wraps individual key hints in narrow terminals", () => {
  const { service } = makeStatic();
  const rendered = service.output.format(
    <KeyBar
      inline
      marginTop={0}
      divider
      before={<Text>Ready</Text>}
      keys={[
        ["p", "show plan"],
        ["Ctrl+C", "exit"],
      ]}
    />,
    { columns: 20 },
  );

  expect(rendered).toContain("p show plan");
  expect(rendered).toContain("Ctrl+C exit");
  expect(rendered.trimEnd().split("\n").length).toBeGreaterThan(1);
});

it.effect("tabs scroll horizontally instead of wrapping when overflowing", () =>
  Effect.gen(function* () {
    const { service } = makeStatic();
    const tabs = Array.from({ length: 20 }, (_, i) => {
      const label = `profile-${String(i + 1).padStart(2, "0")}`;
      return { id: label, label, marked: i === 0 };
    });

    // Active tab in the middle: window centers on it, arrows on both sides.
    const middle = yield* service.output.render(
      <Tabs tabs={tabs} active="profile-10" />,
    );
    expect(middle).toContain("profile-10");
    expect(middle).toContain("‹");
    expect(middle).toContain("›");
    expect(middle).not.toContain("profile-01");
    expect(middle).not.toContain("profile-20");
    // every rendered tab stays on the single tab row — no wrapped chips
    expect(middle.trimEnd()).not.toContain("\n");

    // Active tab at the start: no left arrow, right arrow only.
    const first = yield* service.output.render(
      <Tabs tabs={tabs} active="profile-01" />,
    );
    expect(first).toContain("profile-01");
    expect(first).not.toContain("‹");
    expect(first).toContain("›");

    // Active tab at the end: left arrow only.
    const last = yield* service.output.render(
      <Tabs tabs={tabs} active="profile-20" />,
    );
    expect(last).toContain("profile-20");
    expect(last).toContain("‹");
    expect(last).not.toContain("›");

    // Everything fits: no arrows at all.
    const fitting = yield* service.output.render(
      <Tabs tabs={tabs.slice(0, 3)} active="profile-02" />,
    );
    expect(fitting).toContain("profile-01");
    expect(fitting).toContain("profile-03");
    expect(fitting).not.toContain("‹");
    expect(fitting).not.toContain("›");
  }),
);

it("tabsWindow keeps the active tab visible within the available width", () => {
  // 5 chips of width 12, gap 1, 74 columns → 5 fit exactly around the middle
  const widths = Array.from({ length: 20 }, () => 12);
  expect(tabsWindow(widths, 9, 74)).toEqual({ start: 7, end: 12 });
  // at the edges the window pins to the boundary
  expect(tabsWindow(widths, 0, 74)).toEqual({ start: 0, end: 5 });
  expect(tabsWindow(widths, 19, 74)).toEqual({ start: 15, end: 20 });
  // active always inside, even when nothing else fits
  expect(tabsWindow(widths, 3, 12)).toEqual({ start: 3, end: 4 });
  expect(tabsWindow(widths, 3, 5)).toEqual({ start: 3, end: 4 });
  // out-of-range active clamps; empty input yields an empty window
  expect(tabsWindow(widths, 99, 74)).toEqual({ start: 15, end: 20 });
  expect(tabsWindow([], 0, 74)).toEqual({ start: 0, end: 0 });
});

it.live(
  "state explorer confirms deletes inline and keeps its position afterwards",
  () =>
    Effect.gen(function* () {
      const { calls, source } = makeExplorerSource();
      let resources = ["Api/Worker", "Api/Queue", "Db"];
      const deleted: string[] = [];
      const mutable: StateExplorerSource = {
        ...source,
        listResources: () =>
          Effect.sync(() => {
            calls.resources++;
            return resources;
          }),
        deleteNodes: (nodes) =>
          Effect.sync(() => {
            for (const node of nodes) {
              deleted.push(node.path);
              const prefix = `app/prod/`;
              const fqn = node.path.slice(prefix.length);
              resources = resources.filter(
                (r) => r !== fqn && !r.startsWith(`${fqn}/`),
              );
            }
          }),
      };
      const stdin = new InputStream();
      const { service, stdout } = yield* makeLive({ stdin });
      const fiber = yield* service
        .application(service.prompt.custom(stateExplorerScreen(mutable)))
        .pipe(Application.alternate)
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => stdin.ready);
      const press = (key: string) =>
        Effect.sync(() => stdin.write(key)).pipe(Effect.andThen(settleInput));
      // Bounded waits that dump the last frame on expiry — a silent hang here
      // is otherwise undebuggable.
      const frame = () => stripVTControlCharacters(stdout.output.slice(-6000));
      const waitFrame = (text: string) =>
        Effect.promise(() => stdout.waitFor(text)).pipe(
          Effect.timeoutOrElse({
            duration: "3 seconds",
            orElse: () =>
              Effect.sync(() => {
                console.log(`=== TIMEOUT waiting for ${text} ===\n${frame()}`);
                throw new Error(`timeout waiting for ${text}`);
              }),
          }),
        );
      yield* waitFrame("app");
      // root → stages → state → into Api → Worker (select a row, then enter it)
      const enter = Effect.gen(function* () {
        yield* press("j");
        yield* press("\x1B[C");
      });
      yield* enter;
      yield* waitFrame("prod");
      yield* enter;
      yield* waitFrame("Api");
      yield* enter;
      yield* waitFrame("Worker");
      yield* press("j");
      yield* waitFrame("PREVIEW");
      yield* press("d");
      yield* waitFrame("Delete state records?");
      // The panel must not narrow the layout: its top border spans the
      // terminal, exactly like the header rule above the columns.
      const confirmFrame = frame();
      const rule = confirmFrame
        .split("\n")
        .filter((line) => /^─+$/.test(line.trim()));
      expect(rule.at(-1)?.trim().length).toBe(stdout.columns);
      const before = stdout.output.length;
      yield* press("y");
      yield* waitFrame("Deleted state at");
      yield* settleInput;
      yield* Effect.promise(flushEffects);
      yield* settleInput;
      const after = stripVTControlCharacters(stdout.output.slice(before));
      expect(deleted).toEqual(["app/prod/Api/Queue"]);
      // stage listing re-read once; stacks/stages untouched
      expect(calls.stacks).toBe(1);
      expect(calls.stages).toBe(1);
      expect(calls.resources).toBe(2);
      // cursor moved to the surviving sibling in the same column
      expect(after).toContain("app/prod/Api/Worker");
      yield* press("q");
      yield* Fiber.join(fiber);
    }),
);

it.effect("renders nuke scan counts and outstanding providers", () =>
  Effect.gen(function* () {
    const { service } = makeStatic();
    const store = new NukeProgressStore();
    store.emit({ _tag: "nuke.scan.started", total: 2 });
    store.emit({ _tag: "nuke.scan.provider.started", provider: "Test.Fast" });
    store.emit({ _tag: "nuke.scan.provider.started", provider: "Test.Slow" });
    store.emit({
      _tag: "nuke.scan.provider.completed",
      provider: "Test.Fast",
      resources: 3,
    });
    const output = yield* service.output.render(<NukeProgress store={store} />);
    expect(output).toContain("1/2");
    expect(output).toContain("3 resources found");
    expect(output).toContain("Scanning Test.Slow");
    const lines = output.split("\n");
    const header = lines.findIndex((line) => line.includes("1/2"));
    expect(lines[header]).toMatch(/^  \[[⣿⡇ ]+\] {2}\[1\/2\]\s*$/);
    expect(lines[header + 1]?.trim()).toBe("");
    expect(lines[header + 2]).toContain("Scanning providers");
    expect(output).not.toContain("Scanning Test.Fast");
  }),
);

it.effect("updates individual nuke plan rows during deletion", () =>
  Effect.gen(function* () {
    const { service } = makeStatic();
    const tree = new PlanTree(
      nukePlan(
        [
          { providerId: "Test.B", displayName: "same-name" },
          { providerId: "Test.A", displayName: "same-name" },
          { providerId: "Test.A", displayName: "same-name" },
        ],
        { mode: "live" },
      ),
      { mode: "apply", viewport: "full", busy: true },
    );
    tree.setLabel("Deleting resources · pass 2");
    tree.emit({
      _tag: "apply.resource.status",
      fqn: "nuke/2",
      id: "Test.A",
      type: "Test.A",
      status: "deleted",
    });
    tree.emit({
      _tag: "apply.resource.status",
      fqn: "nuke/1",
      id: "Test.A",
      type: "Test.A",
      status: "fail",
      message: "blocked",
    });
    tree.emit({
      _tag: "apply.resource.status",
      fqn: "nuke/0",
      id: "Test.B",
      type: "Test.B",
      status: "deleting",
    });
    expect(tree.snapshot().tasks.get("nuke/2")?.status).toBe("deleted");
    expect(tree.snapshot().tasks.get("nuke/1")?.status).toBe("fail");
    expect(tree.progress()).toEqual({ completed: 2, total: 3, failures: 1 });
    const output = yield* service.output.render(<Plan tree={tree} />);
    expect(output).toContain("pass 2");
    expect(output).toContain("blocked");
    expect(output.match(/same-name/g)).toHaveLength(3);
    expect(output).not.toContain("(Test.A)");
  }),
);

it.effect("renders nuke execution outcomes in the shared plan", () =>
  Effect.gen(function* () {
    const { service, stdout } = yield* makeLive();
    const provider: ProviderService = {
      nuke: { dependsOn: ["Test.Parent"] },
      list: () => Effect.succeed([]),
      reconcile: () => Effect.succeed({}),
      delete: () => Effect.void,
    };
    const resources = [
      {
        providerId: "Test.Parent",
        displayName: "parent",
        attributes: {},
        provider: { ...provider, nuke: undefined },
      },
      {
        providerId: "Test.Child",
        displayName: "same-name",
        attributes: {},
        provider: {
          ...provider,
          delete: () => Effect.fail("cannot delete child"),
        },
      },
      {
        providerId: "Test.Child",
        displayName: "same-name",
        attributes: {},
        provider,
      },
    ];
    const result = yield* NukeRoute.execute({
      scan: { resources, mode: "live", context: Context.empty(), failures: [] },
      resources,
      strategy: { _tag: "coordinated" },
    }).pipe(
      renderNukeDelete(resources, "live"),
      Effect.provideService(CliKit, service),
    );
    expect(result.deleted).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.held).toHaveLength(1);
    expect(stdout.output).toContain("Nuke incomplete");
    expect(stdout.output).toContain("Held back by Test.Child");
    expect(stdout.output).toContain("cannot delete child");
    expect(stdout.output).toContain("same-name");
    expect(stdout.output).not.toContain("Test.Child 1/2");
  }),
);

it.effect("closes nuke live progress when the operation fails", () =>
  Effect.gen(function* () {
    const { service, stdout } = yield* makeLive();
    yield* Effect.gen(function* () {
      const report = yield* Progress;
      yield* report({ _tag: "nuke.scan.started", total: 2 });
      yield* Effect.fail("scan failed");
    }).pipe(
      renderNukeScan(),
      Effect.provideService(CliKit, service),
      Effect.result,
    );
    expect(stdout.output).toContain("\u001B[?25h");
    yield* service.output.info("After nuke");
    expect(stdout.output).toContain("After nuke");
  }),
);

it.effect("renders fixed-width Braille progress bars with partial cells", () =>
  Effect.gen(function* () {
    const { service } = makeStatic();
    for (const [value, expected] of [
      [-1, "[  ]"],
      [0, "[  ]"],
      [0.0625, "[  ]"],
      [0.25, "[⡇ ]"],
      [0.5, "[⣿ ]"],
      [0.75, "[⣿⡇]"],
      [1, "[⣿⣿]"],
      [2, "[⣿⣿]"],
    ] as const) {
      const output = yield* service.output.render(
        <ProgressBar value={value} width={2} showPercent={false} />,
      );
      expect(output.trim()).toBe(expected);
    }
    const labeled = yield* service.output.render(
      <ProgressBar
        value={0.5}
        width={2}
        label="Uploading"
        detail="2 of 4 files"
      />,
    );
    expect(labeled).toContain("[⣿ ]");
    expect(labeled).toContain("50%");
    expect(labeled).toContain("Uploading");
    expect(labeled).toContain("2 of 4 files");
  }),
);

it.effect("falls back to ASCII for progress bars without Unicode", () =>
  Effect.gen(function* () {
    const { service } = yield* makeLive({ input: false, unicode: false });
    const output = yield* service.output.render(
      <ProgressBar value={0.5} width={4} showPercent={false} />,
    );
    expect(output.trim()).toBe("[##..]");
  }),
);

it.effect(
  "renders nuke inventory with resource types as names and distinct row keys",
  () =>
    Effect.gen(function* () {
      const { service } = makeStatic();
      const targets = [
        { providerId: "Cloudflare.R2.Bucket", displayName: "same/name" },
        { providerId: "Cloudflare.R2.Bucket", displayName: "same/name" },
        { providerId: "AWS.S3.Bucket", displayName: "" },
      ];
      const plan = nukePlan(targets, { mode: "live" });
      const tree = new PlanTree(plan, { viewport: "full" });
      expect(tree.progressRows).toHaveLength(3);
      expect(new Set(tree.rows.map((row) => row.key)).size).toBe(3);
      expect(tree.rows.map((row) => row.id)).toEqual([
        "AWS.S3.Bucket",
        "Cloudflare.R2.Bucket",
        "Cloudflare.R2.Bucket",
      ]);
      expect(
        tree.rows.every((row) => row.type === "resource" && row.depth === 0),
      ).toBe(true);
      const output = yield* service.output.render(<Plan tree={tree} />);
      expect(output).toContain("3 to delete");
      expect(output.match(/Cloudflare.R2.Bucket/g)).toHaveLength(2);
      expect(output).not.toContain("(Cloudflare.R2.Bucket)");
      expect(output.match(/same\/name/g)).toHaveLength(2);

      const compact = yield* service.output.render(
        <Plan
          tree={
            new PlanTree(nukePlan(targets, { mode: "live" }), {
              viewport: "full",
            })
          }
        />,
      );
      expect(compact).toContain("3 to delete");
      expect(compact.match(/same\/name/g)).toHaveLength(2);
      expect(compact.match(/Cloudflare.R2.Bucket/g)).toHaveLength(2);
      expect(compact).not.toContain("(x2)");
    }),
);

it.effect(
  "prints the shared nuke plan for dry-run and yes without prompting",
  () =>
    Effect.gen(function* () {
      for (const options of [
        { yes: false, dryRun: true },
        { yes: true, dryRun: false },
      ]) {
        const { service, stdout } = makeStatic();
        const result = yield* reviewNuke(
          [{ providerId: "AWS.S3.Bucket", displayName: "bucket" }],
          { ...options, mode: "local" },
        ).pipe(Effect.provideService(CliKit, service));
        expect(result).toBe(true);
        expect(stdout.output).toContain("1 to delete");
        expect(stdout.output).toContain("AWS.S3.Bucket");
        expect(stdout.output).toContain("bucket");
      }
    }),
);

it.live("defaults nuke plan approval to Cancel", () =>
  Effect.gen(function* () {
    const stdin = new InputStream();
    const { service, stdout } = yield* makeLive({ stdin });
    const review = yield* reviewNuke(
      [{ providerId: "AWS.S3.Bucket", displayName: "bucket" }],
      { mode: "local", yes: false, dryRun: false },
    ).pipe(Effect.provideService(CliKit, service), Effect.forkChild);
    yield* Effect.promise(flushEffects);
    yield* Effect.raceFirst(
      Effect.promise(() => stdout.waitFor("Cancel")),
      Fiber.join(review).pipe(
        Effect.flatMap(() => Effect.die("review ended before prompt")),
      ),
    );
    yield* Effect.promise(() => stdin.ready);
    expect(stdout.output).toContain("1 to delete");
    expect(stdout.output).toContain("locally emulated");
    yield* Effect.sync(() => stdin.write("\r"));
    yield* Effect.promise(flushEffects);
    expect(yield* Fiber.join(review)).toBe(false);
  }),
);

it.effect("keeps unnamed and duplicate nuke targets as individual rows", () =>
  Effect.gen(function* () {
    const { service } = makeStatic();
    const targets = [
      { providerId: "AWS.ApiGateway.GatewayResponse", displayName: "api-123" },
      { providerId: "AWS.ApiGateway.GatewayResponse", displayName: "api-123" },
      { providerId: "AWS.S3.Bucket", displayName: "photos" },
      { providerId: "AWS.S3.Bucket", displayName: "backups" },
      { providerId: "Test.Unknown", displayName: "unknown" },
      { providerId: "Test.Unknown", displayName: "" },
    ];
    const plan = nukePlan(targets, { mode: "live" });
    expect(plan.rows).toHaveLength(6);
    const output = yield* service.output.render(
      <Plan tree={new PlanTree(plan, { viewport: "full" })} />,
    );
    expect(output).toContain("6 to delete");
    expect(output.match(/api-123/g)).toHaveLength(2);
    expect(output.match(/Test.Unknown/g)).toHaveLength(2);
    expect(output).not.toContain("(x2)");
    expect(output).toContain("photos");
    expect(output).toContain("backups");
    expect(output).not.toContain("· unknown");
  }),
);

it.effect(
  "logs nuke errors immediately through the configured Effect logger",
  () =>
    Effect.gen(function* () {
      for (const input of [true, false]) {
        const { service } = yield* makeLive({ input });
        const entries: Array<{ level: string; message: unknown }> = [];
        const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
          entries.push({ level: logLevel, message });
        });
        yield* Effect.gen(function* () {
          const report = yield* Progress;
          yield* report({ _tag: "nuke.scan.started", total: 2 });
          yield* report({
            _tag: "nuke.scan.provider.completed",
            provider: "Test.Failed",
            resources: 0,
            error: "denied during scan",
          });
          // Check before the operation returns: errors must not wait for completion.
          expect(entries).toEqual([
            { level: "Warn", message: ["Test.Failed: denied during scan"] },
          ]);
          yield* report({
            _tag: "nuke.resource.failed",
            provider: "Test.Resource",
            resource: "example",
            message: "denied during delete",
          });
          expect(entries[1]).toEqual({
            level: "Warn",
            message: ["Test.Resource example: denied during delete"],
          });
          yield* report({
            _tag: "nuke.scan.provider.completed",
            provider: "Test.Ready",
            resources: 1,
          });
          yield* report({
            _tag: "nuke.resource.deleted",
            provider: "Test.Ready",
            resource: "gone",
          });
        }).pipe(
          renderNukeScan(),
          Effect.provideService(CliKit, service),
          Effect.provide(Logger.layer([logger])),
        );
        expect(entries).toHaveLength(input ? 2 : 4);
        if (!input) {
          expect(entries.slice(2)).toEqual([
            { level: "Info", message: ["scanned Test.Ready (1)"] },
            { level: "Info", message: ["deleted Test.Ready gone"] },
          ]);
        }
      }
    }),
);
