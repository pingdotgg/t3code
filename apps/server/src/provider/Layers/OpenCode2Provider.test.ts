import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";

import { OpenCode2Settings } from "../OpenCode2Settings.ts";
import * as OpenCode2Server from "../opencode2/OpenCode2Server.ts";
import {
  OPENCODE_1_RESPONSES,
  OPENCODE_2_RESPONSES,
  replayOpenCodeServer,
} from "../testFixtures/opencodeProbeResponses.ts";
import {
  buildInitialOpenCode2ProviderSnapshot,
  checkOpenCode2ProviderStatus,
  makeOpenCode2RuntimeProbe,
} from "./OpenCode2Provider.ts";
import { MINIMUM_OPENCODE2_VERSION } from "../opencodeVersionProbe.ts";
import { OPENCODE2_DRIVER_KIND } from "../OpenCode2Settings.ts";
import { probeOpenCodeRuntime } from "../opencodeVersionProbe.ts";
import { OpenCodeRuntimeError, type OpenCodeRuntimeShape } from "../opencodeRuntime.ts";

const decodeOpenCode2Settings = Schema.decodeSync(OpenCode2Settings);

const makeSettings = (overrides?: Partial<OpenCode2Settings>): OpenCode2Settings =>
  decodeOpenCode2Settings({
    enabled: true,
    binaryPath: "opencode",
    serverUrl: "",
    serverPassword: "",
    customModels: [],
    ...overrides,
  });

it("decodes OpenCode2Settings defaults for an empty envelope", () => {
  const settings = decodeOpenCode2Settings({});
  NodeAssert.equal(settings.enabled, false);
  NodeAssert.equal(settings.binaryPath, "opencode");
  NodeAssert.equal(settings.serverUrl, "");
  NodeAssert.equal(settings.serverPassword, "");
  NodeAssert.deepEqual(settings.customModels, []);
});

it("trims OpenCode2Settings server fields and falls back to the default binary", () => {
  const settings = decodeOpenCode2Settings({
    binaryPath: "",
    serverUrl: "  http://127.0.0.1:4096  ",
    serverPassword: "  secret  ",
  });
  NodeAssert.equal(settings.binaryPath, "opencode");
  NodeAssert.equal(settings.serverUrl, "http://127.0.0.1:4096");
  NodeAssert.equal(settings.serverPassword, "secret");
});

it("owns the standalone opencode2 driver slug", () => {
  NodeAssert.equal(String(OPENCODE2_DRIVER_KIND), "opencode2");
});

it.effect("buildInitialOpenCode2ProviderSnapshot returns a disabled snapshot when disabled", () =>
  Effect.gen(function* () {
    const snapshot = yield* buildInitialOpenCode2ProviderSnapshot(makeSettings({ enabled: false }));
    NodeAssert.equal(snapshot.enabled, false);
    NodeAssert.equal(snapshot.status, "disabled");
    NodeAssert.equal(snapshot.installed, false);
    NodeAssert.match(snapshot.message ?? "", /disabled/);
  }),
);

it.effect("buildInitialOpenCode2ProviderSnapshot returns a pending snapshot when enabled", () =>
  Effect.gen(function* () {
    const snapshot = yield* buildInitialOpenCode2ProviderSnapshot(makeSettings());
    NodeAssert.equal(snapshot.enabled, true);
    NodeAssert.equal(snapshot.installed, true);
    NodeAssert.equal(snapshot.status, "warning");
    NodeAssert.equal(snapshot.version, null);
    NodeAssert.match(snapshot.message ?? "", /Checking OpenCode 2/);
  }),
);

const binaryRuntime = (
  stdout: string | null,
): Pick<OpenCodeRuntimeShape, "runOpenCodeCommand"> => ({
  runOpenCodeCommand: () =>
    stdout === null
      ? Effect.fail(new OpenCodeRuntimeError({ operation: "spawn", detail: "spawn ENOENT" }))
      : Effect.succeed({ stdout, stderr: "", code: 0 }),
});

/** Failing inventory server: status checks map its failure, never empty lists. */
const failingInventoryServer = (detail: string) =>
  Layer.succeed(
    OpenCode2Server.OpenCode2Server,
    OpenCode2Server.OpenCode2Server.of({
      withConnection: () =>
        Effect.fail(new OpenCodeRuntimeError({ operation: "inventory", detail })),
    }),
  );

/**
 * Runs the status check against a memoized probe over a fake runtime. The
 * fake `OpenCode2Server` fails inventory loads with `inventoryDetail`, so
 * the check exercises version gating + inventory-error mapping.
 */
const checkProvider = (
  settings: OpenCode2Settings,
  runtime: Pick<OpenCodeRuntimeShape, "runOpenCodeCommand">,
  inventoryDetail = "opencode models failed",
  cwd = process.cwd(),
) =>
  Effect.gen(function* () {
    const probe = yield* makeOpenCode2RuntimeProbe(
      probeOpenCodeRuntime(runtime, {
        binaryPath: settings.binaryPath,
        serverUrl: "",
        serverPassword: "",
      }),
    );
    return yield* checkOpenCode2ProviderStatus(settings, cwd, probe.refresh);
  }).pipe(Effect.provide(failingInventoryServer(inventoryDetail)));

const withHttpClient = <A, E>(self: Effect.Effect<A, E, HttpClient.HttpClient>) =>
  Effect.provideServiceEffect(
    self,
    HttpClient.HttpClient,
    Effect.succeed(HttpClient.make(() => Effect.die(new Error("unexpected HTTP request")))),
  );

it.layer(NodeServices.layer)("checkOpenCode2ProviderStatus", (it) => {
  it.effect("reports a disabled snapshot without probing the CLI", () =>
    Effect.gen(function* () {
      const snapshot = yield* withHttpClient(
        checkProvider(
          makeSettings({ enabled: false, binaryPath: "/definitely/not/installed/opencode" }),
          binaryRuntime("opencode v2.3.1\n"),
        ),
      );
      NodeAssert.equal(snapshot.enabled, false);
      NodeAssert.equal(snapshot.status, "disabled");
      NodeAssert.equal(snapshot.installed, false);
    }),
  );

  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* withHttpClient(
        checkProvider(
          makeSettings({
            binaryPath: "/definitely/not/installed/opencode",
            serverUrl: "",
            serverPassword: "",
          }),
          binaryRuntime(null),
        ),
      );
      NodeAssert.equal(snapshot.enabled, true);
      NodeAssert.equal(snapshot.installed, false);
      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.match(snapshot.message ?? "", /not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("rejects a v1 binary on an opencode2 instance", () =>
    Effect.gen(function* () {
      const snapshot = yield* withHttpClient(
        checkProvider(makeSettings({ binaryPath: "opencode" }), binaryRuntime("1.14.19\n")),
      );
      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.version, "1.14.19");
      NodeAssert.match(snapshot.message ?? "", /1\.x release/);
    }),
  );

  it.effect("reports inventory failures without treating them as empty", () =>
    Effect.gen(function* () {
      const snapshot = yield* withHttpClient(
        checkProvider(makeSettings({ binaryPath: "opencode" }), binaryRuntime("opencode v2.3.1\n")),
      );
      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(snapshot.version, "2.3.1");
      NodeAssert.equal(snapshot.models.length, 0);
      NodeAssert.match(snapshot.message ?? "", /opencode models failed/);
    }),
  );

  it.effect("rejects an early 2.x binary below the pinned-client floor", () =>
    Effect.gen(function* () {
      const snapshot = yield* withHttpClient(
        checkProvider(makeSettings({ binaryPath: "opencode" }), binaryRuntime("opencode v2.0.0\n")),
      );
      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.version, "2.0.0");
      NodeAssert.match(snapshot.message ?? "", /too old/);
      NodeAssert.match(
        snapshot.message ?? "",
        new RegExp(MINIMUM_OPENCODE2_VERSION.replaceAll(".", "\\.")),
      );
    }),
  );

  it.effect("keeps the v2 minimum on the 2.x line", () => {
    NodeAssert.match(MINIMUM_OPENCODE2_VERSION, /^2\./);
    return Effect.void;
  });
});

it.layer(NodeServices.layer)("checkOpenCode2ProviderStatus with configured server URL", (it) => {
  it.effect("surfaces a friendly auth error for configured servers", () =>
    Effect.gen(function* () {
      const settings = makeSettings({
        serverUrl: "http://127.0.0.1:9999",
        serverPassword: "secret-password",
      });
      const probe = yield* makeOpenCode2RuntimeProbe(
        probeOpenCodeRuntime(binaryRuntime("opencode v2.3.1\n"), {
          binaryPath: settings.binaryPath,
          serverUrl: settings.serverUrl,
          serverPassword: "wrong-password",
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            replayOpenCodeServer(OPENCODE_2_RESPONSES, "secret-password"),
          ),
        ),
      );
      const snapshot = yield* checkOpenCode2ProviderStatus(settings, process.cwd(), probe.refresh);
      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(
        snapshot.message,
        "OpenCode 2 server rejected authentication. Check the server URL and password.",
      );
      // The snapshot is what ships to clients: no field may carry a password.
      const rendered = [
        snapshot.message ?? "",
        snapshot.version ?? "",
        String(snapshot.models.map((model) => model.slug)),
      ].join("\n");
      NodeAssert.ok(
        !rendered.includes("secret-password"),
        "snapshot must not contain the configured password",
      );
      NodeAssert.ok(
        !rendered.includes("wrong-password"),
        "snapshot must not contain the attempted password",
      );
    }).pipe(Effect.provide(failingInventoryServer("unreachable"))),
  );

  it.effect("marks a v1 server as stale for an opencode2 instance", () =>
    Effect.gen(function* () {
      const settings = makeSettings({
        serverUrl: "http://127.0.0.1:9999",
        serverPassword: "pw",
      });
      const probe = yield* makeOpenCode2RuntimeProbe(
        probeOpenCodeRuntime(binaryRuntime("opencode v2.3.1\n"), {
          binaryPath: settings.binaryPath,
          serverUrl: settings.serverUrl,
          serverPassword: settings.serverPassword,
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            replayOpenCodeServer(OPENCODE_1_RESPONSES, "pw"),
          ),
        ),
      );
      const snapshot = yield* checkOpenCode2ProviderStatus(settings, process.cwd(), probe.refresh);
      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.version, "1.18.32");
      NodeAssert.match(snapshot.message ?? "", /1\.x release/);
    }).pipe(Effect.provide(failingInventoryServer("unreachable"))),
  );
});
