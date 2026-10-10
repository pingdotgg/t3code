import {
  type PluginInstallation,
  PluginInstallationId,
  PluginInstallationManifest,
  PluginNpmAddInput,
  type PluginNpmListResult,
  type PluginNpmPackage,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import { createPluginActionGate } from "./pluginPresentation.ts";
import {
  PLUGIN_NPM_SCRIPTS_STATEMENT,
  pluginNpmInstallRequest,
  pluginNpmListKey,
  pluginNpmProvenanceKnown,
  pluginRemoveDescription,
  pluginNpmRowLabel,
  pluginNpmUpdateRequest,
  presentPluginNpmUpdate,
  resolvePluginNpmPackagesState,
  resolvePluginNpmProvenance,
  supportsPluginNpm,
} from "./pluginNpmPresentation.ts";

const ID = PluginInstallationId.make("installation-1");
const DIGEST = `sha256:${"a".repeat(64)}`;
const NEXT_DIGEST = `sha256:${"c".repeat(64)}`;
const INTEGRITY = `sha512-${"A".repeat(86)}==`;

const decodeManifest = Schema.decodeSync(PluginInstallationManifest);
const decodeAddInput = Schema.decodeUnknownSync(PluginNpmAddInput);

const manifest = (version: string, capabilities: ReadonlyArray<string>) =>
  decodeManifest({
    id: "acme.notifier",
    name: "Notifier",
    version,
    capabilities: [...capabilities],
    proposedApi: false,
  });

const installation = (overrides: Partial<PluginInstallation> = {}): PluginInstallation => ({
  installationId: ID,
  generation: 1,
  directory: "/state/plugins/npm/pkg-1/package",
  manifest: manifest("1.0.0", ["actions", "settings"]),
  source: { digest: DIGEST, files: 3, bytes: 2048 },
  problem: null,
  inspectedAt: "2026-10-04T00:00:00.000Z",
  consent: null,
  enabled: false,
  addedAt: "2026-10-04T00:00:00.000Z",
  ...overrides,
});

const pkg = (
  version: string,
  stagedUpdate: PluginNpmPackage["stagedUpdate"] = null,
  registry = "https://registry.npmjs.org",
): PluginNpmPackage => ({
  installationId: ID,
  source: {
    registry,
    name: "t3-notifier",
    version,
    integrity: INTEGRITY,
    installedAt: "2026-10-04T00:00:00.000Z",
  },
  stagedUpdate,
});

const staged = (version: string, digest: string, capabilities: ReadonlyArray<string>) => ({
  version,
  integrity: INTEGRITY,
  manifest: manifest(version, capabilities),
  source: { digest, files: 4, bytes: 4096 },
  stagedAt: "2026-10-04T01:00:00.000Z",
});

const list = (...packages: ReadonlyArray<PluginNpmPackage>): PluginNpmListResult => ({ packages });
const available = (value: PluginNpmListResult) =>
  resolvePluginNpmPackagesState({ supported: true, data: value, error: null });

describe("supportsPluginNpm", () => {
  it("offers npm only on servers that report it", () => {
    expect(supportsPluginNpm({ pluginNpm: true })).toBe(true);
    expect(supportsPluginNpm({ pluginNpm: false })).toBe(false);
    expect(supportsPluginNpm({})).toBe(false);
    expect(supportsPluginNpm(null)).toBe(false);
  });
});

describe("pluginNpmInstallRequest", () => {
  const form = { canManage: true, busy: false, name: "t3-notifier", version: "", registry: "" };

  it("sends a name with latest by default, in the server's input shape", () => {
    const request = pluginNpmInstallRequest({ ...form, name: "  @acme/t3-notifier " });
    expect(request).toEqual({
      _tag: "ready",
      input: { name: "@acme/t3-notifier", version: "latest" },
    });
    if (request._tag !== "ready") throw new Error("expected a request");
    expect(decodeAddInput(request.input)).toEqual(request.input);
  });

  it("sends an exact version, a tag, and a registry when given", () => {
    expect(
      pluginNpmInstallRequest({
        ...form,
        version: " 1.2.3-beta.1 ",
        registry: "https://npm.example.test",
      }),
    ).toEqual({
      _tag: "ready",
      input: { name: "t3-notifier", version: "1.2.3-beta.1", registry: "https://npm.example.test" },
    });
    expect(pluginNpmInstallRequest({ ...form, version: "next" })).toMatchObject({
      _tag: "ready",
      input: { version: "next" },
    });
  });

  it("refuses ranges and invalid names before sending", () => {
    for (const version of ["^1.0.0", "~1.2.0", ">=1", "1.x", "x", "1.2"])
      expect(pluginNpmInstallRequest({ ...form, version })._tag).toBe("invalid");
    expect(pluginNpmInstallRequest({ ...form, name: "Not A Name" })._tag).toBe("invalid");
  });

  it("sends nothing without management, while busy, or without a name", () => {
    expect(pluginNpmInstallRequest({ ...form, canManage: false })).toEqual({ _tag: "blocked" });
    expect(pluginNpmInstallRequest({ ...form, busy: true })).toEqual({ _tag: "blocked" });
    expect(pluginNpmInstallRequest({ ...form, name: "  " })).toEqual({ _tag: "blocked" });
  });
});

describe("pluginNpmUpdateRequest", () => {
  it("downloads latest by default and refuses ranges and read-only sessions", () => {
    expect(pluginNpmUpdateRequest({ canManage: true, busy: false, version: "" })).toEqual({
      _tag: "ready",
      input: "latest",
    });
    expect(pluginNpmUpdateRequest({ canManage: true, busy: false, version: "^2" })._tag).toBe(
      "invalid",
    );
    expect(pluginNpmUpdateRequest({ canManage: false, busy: false, version: "2.0.0" })).toEqual({
      _tag: "blocked",
    });
  });
});

describe("resolvePluginNpmProvenance", () => {
  it("shows a step's reply until a list read after it arrives, then the list", () => {
    const before = list(pkg("1.0.0"));
    const reply = pkg("1.0.0", staged("1.1.0", NEXT_DIGEST, []));
    const step = { list: before, reply };
    // The list still in hand predates the step.
    expect(
      resolvePluginNpmProvenance({ state: available(before), installationId: ID, step }),
    ).toEqual({ _tag: "found", package: reply });
    // A later read is the truth, even if another client discarded the update meanwhile.
    const after = list(pkg("1.0.0"));
    expect(
      resolvePluginNpmProvenance({ state: available(after), installationId: ID, step }),
    ).toEqual({ _tag: "found", package: after.packages[0] });
  });

  it("shows a just-installed package before the first list read", () => {
    const reply = pkg("1.0.0");
    const loading = resolvePluginNpmPackagesState({ supported: true, data: null, error: null });
    expect(
      resolvePluginNpmProvenance({
        state: loading,
        installationId: ID,
        step: { list: null, reply },
      }),
    ).toEqual({ _tag: "found", package: reply });
  });

  it("claims nothing after a failed apply until the list says what is installed", () => {
    const before = list(pkg("1.0.0", staged("1.1.0", NEXT_DIGEST, [])));
    const step = { list: before, reply: null };
    expect(
      resolvePluginNpmProvenance({ state: available(before), installationId: ID, step }),
    ).toEqual({ _tag: "checking" });
    // Rolled back: the old version is still installed and the update is still downloaded.
    const rolledBack = list(pkg("1.0.0", staged("1.1.0", NEXT_DIGEST, [])));
    expect(
      resolvePluginNpmProvenance({ state: available(rolledBack), installationId: ID, step }),
    ).toEqual({ _tag: "found", package: rolledBack.packages[0] });
    // Committed but not re-enabled: the new version is installed.
    const committed = list(pkg("1.1.0"));
    expect(
      resolvePluginNpmProvenance({ state: available(committed), installationId: ID, step }),
    ).toMatchObject({ _tag: "found", package: { source: { version: "1.1.0" } } });
  });

  it("finds nothing for a directory plugin or a server without npm", () => {
    const other = PluginInstallationId.make("installation-2");
    expect(
      resolvePluginNpmProvenance({
        state: available(list(pkg("1.0.0"))),
        installationId: other,
        step: null,
      }),
    ).toEqual({ _tag: "none" });
    expect(
      resolvePluginNpmProvenance({
        state: resolvePluginNpmPackagesState({ supported: false, data: null, error: null }),
        installationId: ID,
        step: { list: null, reply: pkg("1.0.0") },
      }),
    ).toEqual({ _tag: "none" });
  });

  it("reports a failed list read rather than a stale one", () => {
    expect(
      resolvePluginNpmPackagesState({ supported: true, data: list(), error: "offline" }),
    ).toEqual({ _tag: "failed", message: "offline" });
  });
});

describe("unknown npm provenance", () => {
  const loading = resolvePluginNpmPackagesState({ supported: true, data: null, error: null });
  const failed = resolvePluginNpmPackagesState({ supported: true, data: null, error: "offline" });

  it("is not known while the list loads or after it failed, unlike a list without it", () => {
    for (const state of [loading, failed]) {
      const provenance = resolvePluginNpmProvenance({ state, installationId: ID, step: null });
      expect(provenance).toEqual({ _tag: "unknown" });
      expect(pluginNpmProvenanceKnown(provenance)).toBe(false);
    }
    const directory = resolvePluginNpmProvenance({
      state: available(list()),
      installationId: ID,
      step: null,
    });
    expect(directory).toEqual({ _tag: "none" });
    expect(pluginNpmProvenanceKnown(directory)).toBe(true);
    expect(
      pluginNpmProvenanceKnown(
        resolvePluginNpmProvenance({
          state: resolvePluginNpmPackagesState({ supported: false, data: null, error: null }),
          installationId: ID,
          step: null,
        }),
      ),
    ).toBe(true);
  });

  it("approves a reopened download only once its package is known, as both clients gate it", async () => {
    // A download nobody approved, reopened without the install reply.
    const unapproved = installation();
    const gate = createPluginActionGate();
    const sent: Array<string> = [];
    const step = (name: string) => () => {
      sent.push(name);
      return Promise.resolve({ value: name });
    };
    const show = (state: typeof loading) =>
      gate.set({
        environmentId: "environment-1",
        installation: unapproved,
        acknowledgedDigest: DIGEST,
        provenanceKnown: pluginNpmProvenanceKnown(
          resolvePluginNpmProvenance({ state, installationId: ID, step: null }),
        ),
      });
    const approve = () =>
      gate.run({ environmentId: "environment-1", installationId: ID, approvedDigest: DIGEST }, [
        step("consent"),
        step("enable"),
      ]);
    for (const state of [loading, failed]) {
      show(state);
      expect(await approve()).toEqual({ _tag: "refused" });
    }
    expect(sent).toEqual([]);
    // Retry read the list: the package, checksum, and scripts policy are on screen now.
    show(available(list(pkg("1.0.0"))));
    expect(await approve()).toEqual({ _tag: "done" });
    expect(sent).toEqual(["consent", "enable"]);
  });

  it("stops before enable when the screen loses the package between steps", async () => {
    const gate = createPluginActionGate();
    const sent: Array<string> = [];
    const subject = (provenanceKnown: boolean) => ({
      environmentId: "environment-1",
      installation: installation(),
      acknowledgedDigest: DIGEST,
      provenanceKnown,
    });
    gate.set(subject(true));
    const outcome = await gate.run(
      { environmentId: "environment-1", installationId: ID, approvedDigest: DIGEST },
      [
        () => {
          sent.push("consent");
          gate.set(subject(false));
          return Promise.resolve({ value: "consent" });
        },
        () => {
          sent.push("enable");
          return Promise.resolve({ value: "enable" });
        },
      ],
    );
    expect(outcome).toEqual({ _tag: "refused" });
    expect(sent).toEqual(["consent"]);
  });

  it("promises nothing about the files on removal until it knows where they came from", () => {
    expect(pluginRemoveDescription({ _tag: "none" }, "Build box")).toContain(
      "Its directory stays on Build box's machine.",
    );
    expect(
      pluginRemoveDescription({ _tag: "found", package: pkg("1.0.0") }, "Build box"),
    ).toContain("deletes the copy of t3-notifier it downloaded");
    for (const provenance of [{ _tag: "unknown" }, { _tag: "checking" }] as const) {
      const text = pluginRemoveDescription(provenance, "Build box");
      expect(text).not.toContain("Its directory stays");
      expect(text).toContain("one downloaded from npm has its copy deleted");
    }
  });

  it("says removal deletes saved settings and storage, wherever the files came from", () => {
    for (const provenance of [
      { _tag: "none" },
      { _tag: "found", package: pkg("1.0.0") },
      { _tag: "unknown" },
      { _tag: "checking" },
    ] as const)
      expect(pluginRemoveDescription(provenance, "Build box")).toContain(
        "deletes its saved settings and storage",
      );
  });
});

describe("pluginNpmListKey", () => {
  it("changes when installations come and go or their files change, not with process state", () => {
    const base = installation();
    const key = pluginNpmListKey([base]);
    expect(pluginNpmListKey([{ ...base, enabled: true, hostState: { _tag: "running" } }])).toBe(
      key,
    );
    expect(
      pluginNpmListKey([{ ...base, source: { digest: NEXT_DIGEST, files: 4, bytes: 1 } }]),
    ).not.toBe(key);
    expect(pluginNpmListKey([])).not.toBe(key);
  });
});

describe("presentPluginNpmUpdate", () => {
  it("names the capabilities an update adds and removes", () => {
    const update = presentPluginNpmUpdate(
      installation(),
      pkg("1.0.0", staged("1.1.0", NEXT_DIGEST, ["actions", "tools"])),
    );
    expect(update).toMatchObject({
      sameAsInstalled: false,
      addedCapabilities: ["tools"],
      removedCapabilities: ["settings"],
    });
  });

  it("recognizes a download of the installed files and has nothing without a download", () => {
    expect(
      presentPluginNpmUpdate(installation(), pkg("1.0.0", staged("1.0.0", DIGEST, [])))
        ?.sameAsInstalled,
    ).toBe(true);
    expect(presentPluginNpmUpdate(installation(), pkg("1.0.0"))).toBeNull();
  });

  it("states that scripts never run and dependencies are never installed before Apply", () => {
    // Every staged download, including one approved and staged by another client.
    for (const download of [
      staged("1.1.0", NEXT_DIGEST, ["actions", "tools"]),
      staged("1.0.0", DIGEST, []),
    ]) {
      const update = presentPluginNpmUpdate(
        installation({
          consent: { digest: DIGEST, capabilities: [], grantedAt: "2026-10-04T00:00:00.000Z" },
        }),
        pkg("1.0.0", download),
      );
      expect(update?.disclosure[0]).toBe(PLUGIN_NPM_SCRIPTS_STATEMENT);
      expect(update?.disclosure.join(" ")).toContain("the installed version stays");
    }
  });
});

describe("pluginNpmRowLabel", () => {
  it("names the package, a non-default registry, and an update waiting for review", () => {
    expect(pluginNpmRowLabel(pkg("1.0.0"))).toBe("npm · t3-notifier@1.0.0");
    expect(pluginNpmRowLabel(pkg("1.0.0", null, "https://npm.example.test"))).toBe(
      "npm · t3-notifier@1.0.0 from https://npm.example.test",
    );
    expect(pluginNpmRowLabel(pkg("1.0.0", staged("1.1.0", NEXT_DIGEST, [])))).toBe(
      "npm · t3-notifier@1.0.0 · Update 1.1.0 ready to review",
    );
    expect(pluginNpmRowLabel(pkg("1.0.0", staged("1.0.0", NEXT_DIGEST, [])))).toBe(
      "npm · t3-notifier@1.0.0 · Download ready to review",
    );
  });
});
