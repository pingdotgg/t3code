import * as NodeAssert from "node:assert/strict";

import { EnvironmentId, ServerConfig, ServerNpmReleaseError } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

import { npmReleaseAtom, npmReleaseFailureMessage } from "./npmRelease";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { serverEnvironment } from "./server";

vi.mock("./server", () => ({
  serverEnvironment: { npmRelease: vi.fn(), configValueAtom: vi.fn() },
}));
vi.mock("./presentation", () => ({
  environmentSummaries: { connectedEnvironmentIdsAtom: Atom.make(["first", "second"]) },
}));
vi.mock("./primaryEnvironment", () => ({
  primaryEnvironmentIdAtom: Atom.make<EnvironmentId | null>(null),
}));

const version = "0.0.46-nightly.20261012.3021";
const first = EnvironmentId.make("first");
const second = EnvironmentId.make("second");
const decodeServerConfig = Schema.decodeUnknownSync(ServerConfig);

const configFor = (environmentId: EnvironmentId | null, supported = true) =>
  decodeServerConfig({
    environment: {
      environmentId,
      label: environmentId,
      platform: { os: "linux", arch: "x64" },
      serverVersion: version,
      capabilities: {
        repositoryIdentity: true,
        ...(supported ? { npmReleaseLookup: true } : {}),
      },
    },
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: [],
      sessionMethods: [],
      sessionCookieName: "test",
    },
    cwd: "/test",
    keybindingsConfigPath: "/test/keybindings.json",
    keybindings: [],
    issues: [],
    providers: [],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/test/logs",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: {},
  });

function setup(supported = true) {
  vi.mocked(serverEnvironment.configValueAtom)
    .mockReset()
    .mockImplementation((environmentId) => Atom.make(configFor(environmentId, supported)));
  return vi.mocked(serverEnvironment.npmRelease).mockReset();
}

it.effect(
  "resolves track metadata through the primary environment and follows primary changes",
  () =>
    Effect.gen(function* () {
      const query = setup();
      query.mockImplementation(({ environmentId }) =>
        Atom.make(
          AsyncResult.success({ version, databaseMigration: environmentId === first ? 42 : 43 }),
        ),
      );
      const registry = AtomRegistry.make();
      const release = npmReleaseAtom("nightly");
      NodeAssert.ok(
        Atom.isWritable<EnvironmentId | null, EnvironmentId | null>(primaryEnvironmentIdAtom),
        "Expected the mocked primary environment atom to be writable.",
      );
      registry.set(primaryEnvironmentIdAtom, first);
      const unmount = registry.mount(release);
      try {
        expect(
          yield* AtomRegistry.getResult(registry, release, { suspendOnWaiting: true }),
        ).toEqual({
          version,
          databaseMigration: 42,
        });
        registry.set(primaryEnvironmentIdAtom, second);
        expect(
          yield* AtomRegistry.getResult(registry, release, { suspendOnWaiting: true }),
        ).toEqual({
          version,
          databaseMigration: 43,
        });
      } finally {
        unmount();
        registry.dispose();
      }
    }),
);

it.effect("resolves track metadata through a supporting server when there is no primary", () =>
  Effect.gen(function* () {
    const query = setup();
    vi.mocked(serverEnvironment.configValueAtom).mockImplementation((environmentId) =>
      Atom.make(
        environmentId === first ? configFor(environmentId, false) : configFor(environmentId),
      ),
    );
    query.mockReturnValue(Atom.make(AsyncResult.success({ version })));
    const registry = AtomRegistry.make();
    const release = npmReleaseAtom("nightly");
    const unmount = registry.mount(release);
    try {
      expect(yield* AtomRegistry.getResult(registry, release, { suspendOnWaiting: true })).toEqual({
        version,
        databaseMigration: undefined,
      });
      expect(query).toHaveBeenCalledWith({ environmentId: second, input: { spec: "nightly" } });
    } finally {
      unmount();
      registry.dispose();
    }
  }),
);

it.effect("does not call an unsupported RPC or fetch public npm for an older primary server", () =>
  Effect.gen(function* () {
    const query = setup(false);
    using fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected browser fetch"));
    const registry = AtomRegistry.make();
    NodeAssert.ok(
      Atom.isWritable<EnvironmentId | null, EnvironmentId | null>(primaryEnvironmentIdAtom),
      "Expected the mocked primary environment atom to be writable.",
    );
    registry.set(primaryEnvironmentIdAtom, first);
    const release = npmReleaseAtom("latest");
    const unmount = registry.mount(release);
    try {
      const error = yield* AtomRegistry.getResult(registry, release).pipe(Effect.flip);
      expect(npmReleaseFailureMessage(Cause.fail(error))).toContain(
        "Update it before switching tracks",
      );
      expect(query).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      unmount();
      registry.dispose();
    }
  }),
);

it("only displays the safe release error, not arbitrary transport diagnostics", () => {
  const error = new ServerNpmReleaseError({ reason: "Install npm on the server's PATH." });
  expect(npmReleaseFailureMessage(Cause.fail(error))).toBe(error.message);
  expect(
    npmReleaseFailureMessage(Cause.fail(new Error("sensitive transport details"))),
  ).not.toContain("sensitive");
});
