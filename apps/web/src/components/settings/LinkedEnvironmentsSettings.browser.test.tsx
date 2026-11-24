import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { EnvironmentId, type PeerLinkSummary } from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { peerLinkEnvironment } from "~/state/peerLinks";
import type { EnvironmentPresentation } from "~/state/environments";
import { LinkedEnvironmentsSettings } from "./LinkedEnvironmentsSettings";

type RenewalResult = AtomCommandResult<{ label: string }, Error>;
const state = vi.hoisted(() => ({
  realQuery: false,
  links: [] as PeerLinkSummary[],
  renew: vi.fn<(input: unknown) => Promise<RenewalResult>>(),
  unlink: vi.fn(),
}));

vi.mock(import("~/state/peerLinks"), async (original) => {
  const actual = await original();
  const { Atom: AtomModule } = await import("effect/reactivity");
  const EffectModule = await import("effect/Effect");
  // The real list query's options: stale-while-revalidate, revalidating only when it is built.
  const list = AtomModule.make(
    EffectModule.gen(function* () {
      server.started += 1;
      yield* EffectModule.promise(() => server.answer);
      return { links: [...server.links] };
    }).pipe(
      EffectModule.onInterrupt(() =>
        EffectModule.sync(() => {
          server.interrupted += 1;
        }),
      ),
    ),
  ).pipe(AtomModule.swr({ staleTime: 10_000, revalidateOnMount: true }));
  const allowed = AtomModule.make(true);
  return {
    ...actual,
    useLinkableMachines: () => [],
    peerLinkEnvironment: {
      ...actual.peerLinkEnvironment,
      list: (() => list) as never,
      link: { ...actual.peerLinkEnvironment.link, kind: "link", permissionAtom: () => allowed },
      unlink: {
        ...actual.peerLinkEnvironment.unlink,
        kind: "unlink",
        permissionAtom: () => allowed,
      },
    },
  };
});
vi.mock(import("~/state/use-atom-command"), () => ({
  useAtomCommand: ((command: { kind: string }) =>
    command.kind === "link" ? state.renew : state.unlink) as never,
}));
vi.mock(import("~/state/query"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useEnvironmentQuery: ((atom: never) =>
      state.realQuery
        ? actual.useEnvironmentQuery(atom)
        : {
            data: atom === null ? null : { links: state.links },
            dataUpdatedAt: 1,
            isPending: false,
            isSuccess: atom !== null,
            error: null,
            refresh: () => {},
          }) as never,
  };
});
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  usePreparedConnection: () => Option.none(),
  useEnvironmentScope: () => false,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: () => null,
}));
vi.mock(import("~/state/peerPairingCode"), () => ({ mintPairingCodeOn: vi.fn() }));

const sourceId = EnvironmentId.make("source");
const source = { environmentId: sourceId, label: "Source" } as EnvironmentPresentation;
const destination: PeerLinkSummary = {
  environmentId: EnvironmentId.make("destination"),
  label: "Destination",
  urls: ["https://destination.example.com"],
  access: "read-only",
  linkedAt: DateTime.makeUnsafe("2026-11-01T00:00:00Z"),
  expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00Z"),
  lastReachedAt: null,
  lastError: null,
  status: "reachable",
};
function setup() {
  vi.clearAllMocks();
  state.realQuery = false;
  state.links = [destination];
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
const settings = (registry: AtomRegistry.AtomRegistry) => (
  <RegistryContext value={registry}>
    <LinkedEnvironmentsSettings environments={[source]} primaryEnvironmentId={sourceId} />
  </RegistryContext>
);

it("keeps an in-flight renewal exclusive across collapsing and reopening Settings", async () => {
  setup();
  state.links = [{ ...destination, access: "full-access" }];
  const pending = deferred<RenewalResult>();
  state.renew.mockReturnValue(pending.promise);
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  await using screen = await render(settings(registry));
  const row = () => screen.getByRole("button", { name: /^Destination/ });
  await row().click();
  await screen.getByRole("combobox", { name: "Permissions", exact: true }).click();
  await page.getByRole("option", { name: /^Read only/ }).click();
  await screen.getByRole("textbox", { name: /^Pairing code/ }).fill("test-code");
  await screen.getByRole("button", { name: "Save & renew", exact: true }).click();
  try {
    await row().click();
    await row().click();
    await expect
      .element(screen.getByRole("button", { name: "Forget", exact: true }))
      .toBeDisabled();
    await expect.element(screen.getByRole("button", { name: "Link", exact: true })).toBeDisabled();
    await screen.rerender(<RegistryContext value={registry}>{null}</RegistryContext>);
    await screen.rerender(settings(registry));
    await row().click();
    await expect
      .element(screen.getByRole("button", { name: "Forget", exact: true }))
      .toBeDisabled();
    expect(state.renew).toHaveBeenCalledTimes(1);
    expect(state.unlink).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      pending.resolve(AsyncResult.success({ label: destination.label }));
      await pending.promise;
    });
  }
  await expect.element(screen.getByRole("button", { name: "Forget", exact: true })).toBeEnabled();
  await expect
    .element(screen.getByRole("combobox", { name: "Permissions", exact: true }))
    .toHaveTextContent("Read only");
  await screen.rerender(<RegistryContext value={registry}>{null}</RegistryContext>);
  state.links = state.links.map((link) => ({ ...link, access: "full-access" }));
  await screen.rerender(settings(registry));
  await row().click();
  await expect
    .element(screen.getByRole("combobox", { name: "Permissions", exact: true }))
    .toHaveTextContent("Full access");
});

it("follows refreshed permissions while pristine and retains edits and codes through filtering and failed renewal", async () => {
  setup();
  state.links = [
    destination,
    ...["Second", "Third"].map((label) => ({
      ...destination,
      label,
      environmentId: EnvironmentId.make(label),
    })),
  ];
  state.renew.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("Offline"))));
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  await using screen = await render(settings(registry));
  const row = () => screen.getByRole("button", { name: /^Destination/ });
  await row().click();
  state.links = state.links.map((link) => ({ ...link, access: "full-access" }));
  await screen.rerender(settings(registry));
  await expect
    .element(screen.getByRole("combobox", { name: "Permissions", exact: true }))
    .toHaveTextContent("Full access");
  await screen.getByRole("combobox", { name: "Permissions", exact: true }).click();
  await page.getByRole("option", { name: /^Read only/ }).click();
  await screen.getByRole("textbox", { name: /^Pairing code/ }).fill("test-code");
  await screen.getByRole("textbox", { name: "Find a destination" }).fill("Second");
  await screen.getByRole("textbox", { name: "Find a destination" }).fill("");
  await expect
    .element(screen.getByRole("textbox", { name: /^Pairing code/ }))
    .toHaveValue("test-code");
  await expect
    .element(screen.getByRole("combobox", { name: "Permissions", exact: true }))
    .toHaveTextContent("Read only");
  await screen.getByRole("button", { name: "Save & renew", exact: true }).click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Error: Offline");
  await expect
    .element(screen.getByRole("textbox", { name: /^Pairing code/ }))
    .toHaveValue("test-code");
  state.renew.mockResolvedValue(AsyncResult.success({ label: destination.label }));
  await screen.getByRole("button", { name: "Save & renew", exact: true }).click();
  await expect.element(screen.getByText("Link renewed.", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("combobox", { name: "Permissions", exact: true }))
    .toHaveTextContent("Read only");
  await expect.element(screen.getByRole("button", { name: "Renew", exact: true })).toBeVisible();
  state.links = state.links.map((link) => ({ ...link, access: "read-only" }));
  await screen.rerender(settings(registry));
  state.links = state.links.map((link) => ({ ...link, access: "full-access" }));
  await screen.rerender(settings(registry));
  await expect
    .element(screen.getByRole("combobox", { name: "Permissions", exact: true }))
    .toHaveTextContent("Full access");
});

const hostId = EnvironmentId.make("mac");
const vmLink: PeerLinkSummary = {
  environmentId: EnvironmentId.make("vm"),
  label: "boat-task",
  urls: ["http://boat-task.example.ts.net:3773"],
  access: "full-access",
  linkedAt: DateTime.makeUnsafe("2026-11-01T00:00:00.000Z"),
  expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
  lastReachedAt: null,
  lastError: null,
  status: "reachable",
};

// What the host's `peerLinks.list` answers. The CLI and agents link machines without this client.
const server = vi.hoisted(() => ({
  links: [] as Array<PeerLinkSummary>,
  started: 0,
  interrupted: 0,
  answer: Promise.resolve(),
}));

function setupServer() {
  setup();
  state.realQuery = true;
  server.links = [];
  server.started = 0;
  server.interrupted = 0;
  server.answer = Promise.resolve();
}

/** Stands in for the chat composer, which reads the same list while a thread is open. */
function ComposerReader() {
  const result = useAtomValue(peerLinkEnvironment.list({ environmentId: hostId, input: {} }));
  return AsyncResult.isSuccess(result) ? <p>Composer loaded</p> : null;
}

describe("LinkedEnvironmentsSettings", () => {
  it("shows a link made elsewhere while the composer keeps the list loaded", async () => {
    setupServer();
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    await using composer = await render(
      <RegistryContext.Provider value={registry}>
        <ComposerReader />
      </RegistryContext.Provider>,
    );
    await expect.element(composer.getByText("Composer loaded")).toBeVisible();

    server.links = [vmLink];
    await using screen = await render(
      <RegistryContext.Provider value={registry}>
        <LinkedEnvironmentsSettings
          environments={[{ environmentId: hostId, label: "Mac" } as EnvironmentPresentation]}
          primaryEnvironmentId={hostId}
        />
      </RegistryContext.Provider>,
    );

    await expect.element(screen.getByRole("button", { name: /^boat-task/ })).toBeVisible();
  });

  it("leaves a list that is still loading to answer", async () => {
    setupServer();
    // useLiveRefresh remembers each view's last read across mounts, so this view gets its own host.
    const loadingHostId = EnvironmentId.make("mac-loading");
    let answer = () => {};
    server.answer = new Promise((resolve) => {
      answer = resolve;
    });
    server.links = [vmLink];
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    await using screen = await render(
      <RegistryContext.Provider value={registry}>
        <LinkedEnvironmentsSettings
          environments={[{ environmentId: loadingHostId, label: "Mac" } as EnvironmentPresentation]}
          primaryEnvironmentId={loadingHostId}
        />
      </RegistryContext.Provider>,
    );
    await expect.element(screen.getByRole("status")).toBeVisible();

    answer();
    await expect.element(screen.getByRole("button", { name: /^boat-task/ })).toBeVisible();
    expect(server).toMatchObject({ started: 1, interrupted: 0 });
    await screen.rerender(
      <RegistryContext.Provider value={registry}>
        <LinkedEnvironmentsSettings environments={[source]} primaryEnvironmentId={loadingHostId} />
      </RegistryContext.Provider>,
    );
    await expect.element(screen.getByText("Source unavailable", { exact: true })).toBeVisible();
  });
});
