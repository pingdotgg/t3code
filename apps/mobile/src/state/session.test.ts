import {
  AuthOrchestrationOperateScope,
  AuthProvidersManageScope,
  EnvironmentId,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({ lastAtom: null as Atom.Atom<unknown> | null }));
vi.mock("react", () => ({ useMemo: <A>(factory: () => A) => factory() }));
vi.mock("@effect/atom-react", async () => {
  const { appAtomRegistry } = await import("./atom-registry");
  return {
    useAtomValue: <A, B>(atom: Atom.Atom<A>, select?: (value: A) => B) => {
      harness.lastAtom = atom;
      const value = appAtomRegistry.get(atom);
      return select === undefined ? value : select(value);
    },
  };
});
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/session", () => ({
  createEnvironmentSessionAtoms: () => ({
    sessionStateAtom: Atom.family((_id: EnvironmentId) =>
      Atom.make(AsyncResult.initial<AuthSessionState, Error>()).pipe(Atom.keepAlive),
    ),
  }),
}));

import { appAtomRegistry } from "./atom-registry";
import {
  environmentSession,
  readEnvironmentScope,
  readThreadTriageScope,
  useEnvironmentScope,
  useEnvironmentsWithScope,
} from "./session";

const primary = EnvironmentId.make("primary");
const secondary = EnvironmentId.make("secondary");
const session = (canOperate: boolean): AuthSessionState => ({
  authenticated: true,
  scopes: canOperate ? [AuthOrchestrationOperateScope] : [],
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "session",
  },
});
const source = (id: EnvironmentId) =>
  environmentSession.sessionStateAtom(id) as unknown as Atom.Writable<
    AsyncResult.AsyncResult<AuthSessionState, Error>
  >;
const releases: Array<() => void> = [];
beforeEach(() => {
  harness.lastAtom = null;
  appAtomRegistry.set(source(primary), AsyncResult.success(session(true)));
  appAtomRegistry.set(source(secondary), AsyncResult.initial());
});
afterEach(() => {
  releases.splice(0).forEach((release) => release());
});

it("keeps pending and denied environments out of worker grants while retaining valid cached access", () => {
  expect(useEnvironmentScope(secondary, AuthOrchestrationOperateScope)).toBe(false);
  expect(readEnvironmentScope(secondary, AuthOrchestrationOperateScope)).toBe(false);
  const environments = [{ environmentId: primary }, { environmentId: secondary }];
  expect(useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope)).toEqual(
    new Set([primary]),
  );
  appAtomRegistry.set(source(secondary), AsyncResult.waiting(AsyncResult.success(session(true))));
  expect(readEnvironmentScope(secondary, AuthOrchestrationOperateScope)).toBe(true);
  expect(useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope)).toEqual(
    new Set([primary, secondary]),
  );
  appAtomRegistry.set(source(secondary), AsyncResult.success(session(false)));
  expect(useEnvironmentScope(secondary, AuthOrchestrationOperateScope)).toBe(false);
});

it("reacts to grant revocation, failure, and regrant without a connection list change", () => {
  const environments = [{ environmentId: primary }, { environmentId: secondary }];
  useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const observed = harness.lastAtom;
  if (!observed) throw new Error("Missing worker grant atom");
  const changes: unknown[] = [];
  releases.push(appAtomRegistry.subscribe(observed, (value) => changes.push(value)));
  appAtomRegistry.set(source(secondary), AsyncResult.success(session(true)));
  expect(appAtomRegistry.get(observed)).toEqual(new Set([primary, secondary]));
  appAtomRegistry.set(source(secondary), AsyncResult.success(session(false)));
  expect(appAtomRegistry.get(observed)).toEqual(new Set([primary]));
  appAtomRegistry.set(
    source(primary),
    AsyncResult.failure(Cause.fail(new Error("Session lookup failed"))),
  );
  expect(appAtomRegistry.get(observed)).toEqual(new Set());
  appAtomRegistry.set(source(secondary), AsyncResult.success(session(true)));
  expect(appAtomRegistry.get(observed)).toEqual(new Set([secondary]));
  expect(changes).not.toHaveLength(0);
});

it("lets settle and snooze queue until a loaded session denies them, also after a failed refresh", () => {
  const failedAfter = (canOperate: boolean) =>
    AsyncResult.failure<AuthSessionState, Error>(Cause.fail(new Error("Session lookup failed")), {
      previousSuccess: Option.some(AsyncResult.success(session(canOperate))),
    });
  expect(readThreadTriageScope(secondary)).toBe(true);
  appAtomRegistry.set(source(secondary), AsyncResult.failure(Cause.fail(new Error("offline"))));
  expect(readThreadTriageScope(secondary)).toBe(true);
  appAtomRegistry.set(source(secondary), AsyncResult.success(session(false)));
  expect(readThreadTriageScope(secondary)).toBe(false);
  appAtomRegistry.set(source(secondary), failedAfter(false));
  expect(readThreadTriageScope(secondary)).toBe(false);
  appAtomRegistry.set(source(secondary), failedAfter(true));
  expect(readThreadTriageScope(secondary)).toBe(true);
});

it("uses exact new-server permissions and keeps old-server grants usable", () => {
  appAtomRegistry.set(source(primary), AsyncResult.success({ ...session(true), permissions: [] }));
  expect(useEnvironmentScope(primary, AuthOrchestrationOperateScope)).toBe(false);
  expect(readEnvironmentScope(primary, AuthOrchestrationOperateScope)).toBe(false);
  appAtomRegistry.set(
    source(primary),
    AsyncResult.success({ ...session(false), permissions: [AuthOrchestrationOperateScope] }),
  );
  expect(useEnvironmentScope(primary, AuthOrchestrationOperateScope)).toBe(true);
  expect(readEnvironmentScope(primary, AuthOrchestrationOperateScope)).toBe(true);
  appAtomRegistry.set(source(primary), AsyncResult.success(session(true)));
  expect(useEnvironmentScope(primary, AuthOrchestrationOperateScope)).toBe(true);
});

it("limits provider accounts to environments granting provider management", () => {
  const environments = [{ environmentId: primary }, { environmentId: secondary }];
  const permitted = () => useEnvironmentsWithScope(environments, AuthProvidersManageScope);
  appAtomRegistry.set(
    source(primary),
    AsyncResult.success({ ...session(true), permissions: [AuthOrchestrationOperateScope] }),
  );
  expect(permitted()).toEqual(new Set());
  appAtomRegistry.set(
    source(secondary),
    AsyncResult.success({ ...session(false), permissions: [AuthProvidersManageScope] }),
  );
  expect(permitted()).toEqual(new Set([secondary]));
  appAtomRegistry.set(source(primary), AsyncResult.success(session(true)));
  expect(permitted()).toEqual(new Set([primary, secondary]));
  appAtomRegistry.set(
    source(secondary),
    AsyncResult.success({ ...session(true), scopes: [AuthProvidersManageScope], permissions: [] }),
  );
  expect(permitted()).toEqual(new Set([primary]));
});
