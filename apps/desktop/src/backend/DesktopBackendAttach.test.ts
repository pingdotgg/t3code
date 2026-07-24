import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as DesktopBackendAttach from "./DesktopBackendAttach.ts";

const runtimeState: DesktopBackendAttach.PersistedRuntimeStateProbe = {
  pid: 4321,
  port: 3773,
  origin: "http://127.0.0.1:3773",
};

interface FakeOverrides {
  readonly noAttach?: boolean;
  readonly appVersion?: string;
  readonly runtimeState?: Option.Option<DesktopBackendAttach.PersistedRuntimeStateProbe>;
  readonly pidAlive?: boolean;
  readonly environment?: Option.Option<DesktopBackendAttach.ProbedEnvironment>;
  readonly token?: Option.Option<string>;
}

// Builds a probe context whose IO is fully faked. Steps that should never run
// for a given case die loudly so an accidental extra probe fails the test.
const makeContext = (overrides: FakeOverrides): DesktopBackendAttach.AttachProbeContext => ({
  noAttach: overrides.noAttach ?? false,
  appVersion: overrides.appVersion ?? "1.0.0",
  readRuntimeState: Effect.succeed(overrides.runtimeState ?? Option.some(runtimeState)),
  isPidAlive: () =>
    overrides.pidAlive === undefined
      ? Effect.die("isPidAlive should not be probed")
      : Effect.succeed(overrides.pidAlive),
  probeEnvironment: () =>
    overrides.environment === undefined
      ? Effect.die("probeEnvironment should not be probed")
      : Effect.succeed(overrides.environment),
  readAttachToken:
    overrides.token === undefined
      ? Effect.die("readAttachToken should not be read")
      : Effect.succeed(overrides.token),
});

describe("resolveAttachDecision", () => {
  it.effect("attaches when a live, healthy backend and a token are present", () =>
    Effect.gen(function* () {
      const decision = yield* DesktopBackendAttach.resolveAttachDecision(
        makeContext({
          pidAlive: true,
          environment: Option.some({ serverVersion: Option.some("1.0.0") }),
          token: Option.some("attach-token"),
        }),
      );
      assert.equal(decision._tag, "attach");
      if (decision._tag === "attach") {
        assert.equal(decision.origin, "http://127.0.0.1:3773");
        assert.equal(decision.token, "attach-token");
        assert.equal(decision.pid, 4321);
      }
    }),
  );

  it.effect("attaches despite a version mismatch", () =>
    Effect.gen(function* () {
      const decision = yield* DesktopBackendAttach.resolveAttachDecision(
        makeContext({
          appVersion: "2.0.0",
          pidAlive: true,
          environment: Option.some({ serverVersion: Option.some("1.0.0") }),
          token: Option.some("attach-token"),
        }),
      );
      assert.equal(decision._tag, "attach");
    }),
  );

  it.effect("spawns when the recorded pid is not alive", () =>
    Effect.gen(function* () {
      const decision = yield* DesktopBackendAttach.resolveAttachDecision(
        makeContext({ pidAlive: false }),
      );
      assert.equal(decision._tag, "spawn");
    }),
  );

  it.effect("spawns when there is no server-runtime.json", () =>
    Effect.gen(function* () {
      const decision = yield* DesktopBackendAttach.resolveAttachDecision(
        makeContext({ runtimeState: Option.none() }),
      );
      assert.equal(decision._tag, "spawn");
    }),
  );

  it.effect("spawns when T3CODE_DESKTOP_NO_ATTACH is set", () =>
    Effect.gen(function* () {
      const decision = yield* DesktopBackendAttach.resolveAttachDecision(
        makeContext({ noAttach: true }),
      );
      assert.equal(decision._tag, "spawn");
    }),
  );

  it.effect("spawns when the backend does not answer the environment probe", () =>
    Effect.gen(function* () {
      const decision = yield* DesktopBackendAttach.resolveAttachDecision(
        makeContext({ pidAlive: true, environment: Option.none() }),
      );
      assert.equal(decision._tag, "spawn");
    }),
  );

  it.effect("spawns when the attach token is missing or unreadable", () =>
    Effect.gen(function* () {
      const decision = yield* DesktopBackendAttach.resolveAttachDecision(
        makeContext({
          pidAlive: true,
          environment: Option.some({ serverVersion: Option.none() }),
          token: Option.none(),
        }),
      );
      assert.equal(decision._tag, "spawn");
    }),
  );
});
