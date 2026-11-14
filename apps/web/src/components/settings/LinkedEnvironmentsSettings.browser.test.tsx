import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, type PeerLinkSummary } from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import type { EnvironmentPresentation } from "~/state/environments";
import { LinkedEnvironmentsSettings } from "./LinkedEnvironmentsSettings";

type RenewalResult = AtomCommandResult<{ label: string }, Error>;
const state = vi.hoisted(() => ({
  links: [] as PeerLinkSummary[],
  renew: vi.fn<(input: unknown) => Promise<RenewalResult>>(),
  unlink: vi.fn(),
}));

vi.mock(import("~/state/peerLinks"), async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    peerLinkEnvironment: {
      list: () => ({}),
      link: { kind: "link", permissionAtom: () => allowed },
      unlink: { kind: "unlink", permissionAtom: () => allowed },
    } as never,
    useLinkableMachines: () => [],
  };
});
vi.mock(import("~/state/use-atom-command"), () => ({
  useAtomCommand: ((command: { kind: string }) =>
    command.kind === "link" ? state.renew : state.unlink) as never,
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: unknown) => ({
    data: atom === null ? null : { links: state.links },
    dataUpdatedAt: 1,
    isPending: false,
    isSuccess: atom !== null,
    error: null,
    refresh: () => {},
  })) as never,
}));
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
  const pending = deferred<RenewalResult>();
  state.renew.mockReturnValue(pending.promise);
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  await using screen = await render(settings(registry));
  const row = () => screen.getByRole("button", { name: /^Destination/ });
  await row().click();
  await screen.getByRole("textbox", { name: /^Pairing code/ }).fill("test-code");
  await screen.getByRole("button", { name: "Renew", exact: true }).click();
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
      pending.resolve(AsyncResult.failure(Cause.fail(new Error("Offline"))));
      await pending.promise;
    });
  }
  await expect.element(screen.getByRole("button", { name: "Forget", exact: true })).toBeEnabled();
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
});
