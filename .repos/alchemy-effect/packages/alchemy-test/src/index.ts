/**
 * alchemy-test — a minimal, Effect-native, vitest-compatible test harness.
 *
 * This entrypoint is safe to import from anywhere (including code that gets
 * bundled into Workers): it only contains the registration API and the
 * assertion library. The runner, CLI and TUI live in separate modules that
 * are only loaded by the `alchemy-test` binary.
 */
export {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  exclusiveOf,
  it,
  layer,
  registerHook,
  registerTest,
  retryOf,
  test,
  timeoutOf,
  type DescribeFn,
  type HookKind,
  type LayerMethods,
  type RegisterTestOptions,
  type TestContext,
  type Tester,
  type TestFn,
  type TestOptions,
} from "./Api.ts";
export {
  assert,
  AssertionError,
  equals,
  expect,
  stringify,
  type Assert,
  type Expect,
  type Matchers,
} from "./Expect.ts";
export type {
  FileSuite,
  Hook,
  LogEntry,
  Mode,
  Suite,
  TestBody,
  TestCase,
} from "./Model.ts";
