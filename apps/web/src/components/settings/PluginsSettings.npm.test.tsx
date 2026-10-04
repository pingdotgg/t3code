// @vitest-environment jsdom

import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  type PluginInstallation,
  PluginInstallationId,
  type PluginNpmListResult,
  type PluginNpmPackage,
  WS_METHODS,
} from "@t3tools/contracts";
import { type Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { EnvironmentPresentation } from "../../state/environments";
import type { HeldCall, makeFakePluginEnvironment } from "../../test/fakePluginEnvironment";

const server = vi.hoisted(() => ({
  current: null as ReturnType<typeof makeFakePluginEnvironment> | null,
}));
// Only the transport is fake: the atoms, commands, and registry are the client's own.
vi.mock("../../connection/runtime", async () => {
  const { makeFakePluginEnvironment } = await import("../../test/fakePluginEnvironment");
  const { EnvironmentId: Id } = await import("@t3tools/contracts");
  server.current = makeFakePluginEnvironment({
    environmentId: Id.make("remote"),
    capabilities: { repositoryIdentity: true, plugins: true, pluginNpm: true },
  });
  return { connectionAtomRuntime: server.current.runtime };
});
// Imported by the settings page's other sections, which these tests do not render.
vi.mock("../../environments/primary", () => ({ usePrimarySessionState: () => null }));
vi.mock("../../state/session", () => ({
  environmentSession: { sessionStateAtom: () => null },
  useEnvironmentSessionState: () => null,
  // Settings rows read settings:write; plugin management reads its own session state above.
  useEnvironmentScope: () => true,
  useEnvironmentsWithScope: () => new Set(),
}));

import { pluginEnvironment, pluginNpmEnvironment } from "../../state/plugins";
import { PluginEnvironmentCatalog } from "./PluginsSettings";

const environmentId = EnvironmentId.make("remote");
const environment = {
  environmentId,
  label: "Build box",
  entry: { target: { _tag: "RemoteConnectionTarget" } },
  connection: { phase: "connected" },
  serverConfig: {
    environment: {
      platform: { machine: "server" },
      capabilities: { repositoryIdentity: true, plugins: true, pluginNpm: true },
    },
  },
} as unknown as EnvironmentPresentation;

const installationId = PluginInstallationId.make("installation-npm");
const DIGEST = `sha256:${"a".repeat(64)}`;
const STAGED = `sha256:${"1".repeat(64)}`;
const INTEGRITY = `sha512-${"A".repeat(86)}==`;
const manifest = {
  id: "acme.notifier",
  name: "Notifier",
  version: "1.0.0",
  capabilities: [],
  proposedApi: false,
} as unknown as NonNullable<PluginInstallation["manifest"]>;
const installation = (overrides: Partial<PluginInstallation> = {}) =>
  ({
    installationId,
    generation: 1,
    directory: "/state/plugins/npm/pkg-1/package",
    manifest,
    source: { digest: DIGEST, files: 3, bytes: 2048 },
    problem: null,
    inspectedAt: "2026-10-04T00:00:00.000Z",
    consent: null,
    enabled: false,
    ...overrides,
  }) as PluginInstallation;
const approved = installation({
  consent: { digest: DIGEST, grantedAt: "2026-10-04T00:00:00.000Z" },
  enabled: true,
} as Partial<PluginInstallation>);
/** Added from a directory by another client. */
const other = {
  ...installation(),
  installationId: PluginInstallationId.make("installation-dir"),
  directory: "/srv/plugins/other",
  manifest: null,
} as PluginInstallation;
const npmPackage = (staged: string | null = null): PluginNpmPackage => ({
  installationId,
  source: {
    registry: "https://registry.npmjs.org",
    name: "@acme/t3-notifier",
    version: "1.0.0",
    integrity: INTEGRITY,
    installedAt: "2026-10-04T00:00:00.000Z",
  },
  stagedUpdate:
    staged === null
      ? null
      : {
          version: "1.1.0",
          integrity: INTEGRITY,
          manifest: { ...manifest, version: "1.1.0" },
          source: { digest: staged, files: 4, bytes: 4096 },
          stagedAt: "2026-10-04T01:00:00.000Z",
        },
});

let registry: AtomRegistry.AtomRegistry;
let container: HTMLDivElement;
let root: Root;
const fake = () => server.current!;
const npmAtom = pluginNpmEnvironment.packages({ environmentId, input: {} });
const catalogAtom = pluginEnvironment.catalog({ environmentId, input: {} });

/** Resolves once `atom` holds a value `matches` accepts; the registry's own notification is the receipt. */
function until<A>(atom: Atom.Atom<A>, matches: (value: A) => boolean) {
  return act(
    () =>
      new Promise<void>((resolve) => {
        let done = false;
        let cancel: (() => void) | null = null;
        const check = (value: A) => {
          if (done || !matches(value)) return;
          done = true;
          cancel?.();
          resolve();
        };
        cancel = registry.subscribe(atom, check);
        check(registry.get(atom));
        if (done) cancel();
      }),
  );
}
const nextCall = (method: string) => act(() => fake().next(method));
/** Answers a list read and waits until the client holds that exact list. */
async function answerList(call: HeldCall, list: PluginNpmListResult) {
  await act(async () => call.reply(list));
  await until(npmAtom, (result) => result._tag === "Success" && result.value === list);
}
/** Publishes a catalogue and waits for the client to deliver it. */
async function publish(installations: ReadonlyArray<PluginInstallation>) {
  fake().publish(installations);
  await until(
    catalogAtom,
    (result) =>
      result._tag === "Success" &&
      result.value._tag === "available" &&
      result.value.installations === installations,
  );
}

const elements = (selector: string, text: string) =>
  [...document.querySelectorAll<HTMLElement>(selector)].filter(
    (element) => element.textContent?.trim() === text,
  );
const button = (text: string) => {
  const [found] = [
    ...elements("button,[role=menuitem]", text),
    ...document.querySelectorAll<HTMLElement>(`[aria-label="${text}"]`),
  ];
  if (!found) throw new Error(`No button "${text}"`);
  return found as HTMLButtonElement;
};
const field = (label: string) => {
  const [found] = elements("label", label) as Array<HTMLLabelElement>;
  return document.getElementById(found!.htmlFor) as HTMLInputElement;
};
/** The value shown beside a review field's label, or null when the field is absent. */
const reviewField = (label: string) =>
  elements("dt", label)[0]?.nextElementSibling?.textContent ?? null;
const click = (element: HTMLElement) => act(async () => element.click());
const type = (input: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const acknowledge = () => click(document.querySelector<HTMLElement>("[role=checkbox]")!);

async function publishAndRender(
  installations: ReadonlyArray<PluginInstallation>,
  target = environment,
) {
  fake().publish(installations);
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <PluginEnvironmentCatalog environment={target} access="granted" onRetryAccess={null} />
      </RegistryContext.Provider>,
    ),
  );
  await until(
    catalogAtom,
    (result) =>
      result._tag === "Success" &&
      result.value._tag === "available" &&
      result.value.installations === installations,
  );
}

/** Mounts the environment's plugin list and answers its first npm list read with `list`. */
async function mount(installations: ReadonlyArray<PluginInstallation>, list: PluginNpmListResult) {
  await publishAndRender(installations);
  await answerList(await nextCall(WS_METHODS.pluginsNpmList), list);
}

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
beforeEach(() => {
  fake().reset();
  registry = AtomRegistry.make();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  registry.dispose();
});

describe("installing a plugin from npm", () => {
  it("offers nothing from npm and reads no npm list on a server without it", async () => {
    const older = {
      ...environment,
      serverConfig: {
        environment: { platform: { machine: "server" }, capabilities: { plugins: true } },
      },
    } as unknown as EnvironmentPresentation;
    await publishAndRender([installation()], older);
    expect(elements("button", "Install from npm")).toEqual([]);
    expect(button("Review")).toBeTruthy();
    expect(fake().calls(WS_METHODS.pluginsNpmList)).toEqual([]);
  });

  it("downloads the exact version typed and keeps its reply over a list read that started before it", async () => {
    await mount([], { packages: [] });
    await click(button("Install from npm"));
    await type(field("Package"), " @acme/t3-notifier ");
    await type(field("Version or tag"), "1.2.3");
    await click(button("Download and review"));
    const add = await nextCall(WS_METHODS.pluginsNpmAdd);
    expect(add.input).toEqual({ name: "@acme/t3-notifier", version: "1.2.3" });

    // While the download runs, another client adds a plugin and the list is read again.
    await publish([other]);
    await answerList(await nextCall(WS_METHODS.pluginsNpmList), { packages: [] });

    // The server lists the install just before replying, which starts another read.
    await publish([other, installation()]);
    const readDuring = await nextCall(WS_METHODS.pluginsNpmList);
    const reply = npmPackage();
    await act(async () => add.reply({ installation: installation(), package: reply }));
    const afterInstall = await nextCall(WS_METHODS.pluginsNpmList);
    // Reading again after the install dropped the read that started before it.
    expect(readDuring.interrupted).toBe(true);
    expect(reviewField("Package")).toBe("@acme/t3-notifier@1.0.0");
    expect(reviewField("Integrity")).toContain(INTEGRITY);

    await answerList(afterInstall, { packages: [reply] });
    expect(reviewField("Package")).toBe("@acme/t3-notifier@1.0.0");

    await acknowledge();
    await click(button("Approve and enable"));
    const consent = await nextCall(WS_METHODS.pluginsConsent);
    expect(consent.input).toEqual({ installationId, digest: DIGEST });
    await act(async () =>
      consent.reply({ installation: installation({ consent: approved.consent }) }),
    );
    const enable = await nextCall(WS_METHODS.pluginsEnable);
    expect(enable.input).toEqual({ installationId });
  });

  it("sends nothing for a version range", async () => {
    await mount([], { packages: [] });
    await click(button("Install from npm"));
    await type(field("Package"), "t3-notifier");
    await type(field("Version or tag"), "^1.0.0");
    expect(button("Download and review").disabled).toBe(true);
    await act(async () => document.querySelector("form")!.requestSubmit());
    expect(fake().calls(WS_METHODS.pluginsNpmAdd)).toEqual([]);
  });
});

describe("reviewing an npm download", () => {
  it("discards an unapproved download by removing it, once", async () => {
    await mount([installation()], { packages: [npmPackage()] });
    await click(button("Review"));
    expect(reviewField("Package")).toBe("@acme/t3-notifier@1.0.0");
    await click(button("Discard"));
    await click(button("Discard"));
    const remove = await nextCall(WS_METHODS.pluginsRemove);
    expect(remove.input).toEqual({ installationId });
    expect(fake().calls(WS_METHODS.pluginsRemove)).toHaveLength(1);
  });
});

describe("updating an npm plugin", () => {
  it("checks what is installed after a failed download, even when a list arrived during it", async () => {
    await mount([approved], { packages: [npmPackage()] });
    await click(button("Actions for Notifier"));
    await click(button("Details"));
    await type(field("Version or tag"), "1.1.0");
    await click(button("Download update"));
    const stage = await nextCall(WS_METHODS.pluginsNpmStageUpdate);
    expect(stage.input).toEqual({ installationId, version: "1.1.0" });

    await publish([approved, other]);
    await answerList(await nextCall(WS_METHODS.pluginsNpmList), { packages: [npmPackage()] });

    await act(async () => stage.fail(new Error("The registry did not answer.")));
    const afterFailure = await nextCall(WS_METHODS.pluginsNpmList);
    expect(elements("[role=status]", "Checking what is installed…")).toHaveLength(1);
    expect(document.querySelector("[role=alert]")?.textContent).toBe(
      "The registry did not answer.",
    );

    // The download had landed after all: the next read shows it for review.
    await answerList(afterFailure, { packages: [npmPackage(STAGED)] });
    expect(reviewField("New version")).toBe("1.1.0");
    expect(button("Apply update").disabled).toBe(true);
    await acknowledge();
    await click(button("Apply update"));
    const apply = await nextCall(WS_METHODS.pluginsNpmApplyUpdate);
    expect(apply.input).toEqual({ installationId, digest: STAGED });
  });
});
