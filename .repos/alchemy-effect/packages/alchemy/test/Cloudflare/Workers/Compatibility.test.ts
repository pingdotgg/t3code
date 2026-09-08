import { getCompatibility } from "@/Cloudflare/Workers/Compatibility";
import type { WorkerProps } from "@/Cloudflare/Workers/Worker";
import * as Output from "@/Output";
import { describe, expect, test } from "alchemy-test";

describe("getCompatibility", () => {
  // The default nodejs_compat contract from #796: every JS Worker gets the
  // flag — Effect-native Workers need it for the bundled Effect runtime,
  // external Workers (plain `export default { fetch }`, vite builds)
  // routinely import `node:*` built-ins.
  test("defaults nodejs_compat for Effect-native workers", () => {
    const { flags } = getCompatibility({} as WorkerProps);
    expect(flags).toContain("nodejs_compat");
  });

  test("defaults nodejs_compat for external workers", () => {
    const { flags } = getCompatibility({ isExternal: true } as WorkerProps);
    expect(flags).toContain("nodejs_compat");
  });

  test("does not duplicate an explicit nodejs_compat", () => {
    const { flags } = getCompatibility({
      isExternal: true,
      compatibility: { flags: ["nodejs_compat"] },
    } as WorkerProps);
    expect(flags.filter((f) => f === "nodejs_compat")).toHaveLength(1);
  });

  // nodejs_compat with a date before 2024-09-23 selects the legacy v1 mode,
  // which lacks `process.getBuiltinModule` — the build-side unenv transform
  // emits code that needs it, so the deploy would fail at script startup.
  test("skips the external-worker default for pre-v2 compatibility dates", () => {
    const { flags } = getCompatibility({
      isExternal: true,
      compatibility: { date: "2024-01-01" },
    } as WorkerProps);
    expect(flags).not.toContain("nodejs_compat");
  });

  test("applies the external-worker default from the v2 date onward", () => {
    const { flags } = getCompatibility({
      isExternal: true,
      compatibility: { date: "2024-09-23" },
    } as WorkerProps);
    expect(flags).toContain("nodejs_compat");
  });

  // An explicit no_nodejs_compat opts out — appending nodejs_compat
  // alongside it would send Cloudflare a contradictory flag pair.
  test("no_nodejs_compat opts out of the default", () => {
    const { flags } = getCompatibility({
      isExternal: true,
      compatibility: { flags: ["no_nodejs_compat"] },
    } as WorkerProps);
    expect(flags).toContain("no_nodejs_compat");
    expect(flags).not.toContain("nodejs_compat");
  });

  // Python Workers don't go through the JS bundler: they get the beta
  // python_workers flag and no nodejs_compat default.
  test("python workers get python_workers and no nodejs_compat default", () => {
    const { flags } = getCompatibility({
      isExternal: true,
      main: "./src/entry.py",
    } as WorkerProps);
    expect(flags).toContain("python_workers");
    expect(flags).not.toContain("nodejs_compat");
  });

  // `precreate` is handed raw, *unresolved* props so resources in a
  // dependency cycle can signal early, and `main` is an Input — a `main`
  // derived from another resource's output (e.g. a `Command.Build` outdir)
  // is still an Output there. An unresolved Output is a callable Proxy, so
  // a `main !== undefined` guard passes and `main.split("?")[0]` used to
  // blow up with a bare `TypeError` out of the Worker's pre-create.
  test("tolerates an unresolved Output main", () => {
    const main = Output.map(
      Output.literal("/build"),
      (dir: string) => `${dir}/server/entry.mjs`,
    ) as unknown as string;
    const { flags } = getCompatibility({
      isExternal: true,
      main,
    } as WorkerProps);
    expect(flags).not.toContain("python_workers");
    expect(flags).toContain("nodejs_compat");
  });

  test("forces handle_cross_request_promise_resolution for Effect workers on old dates", () => {
    const { flags } = getCompatibility({
      compatibility: { date: "2024-10-01" },
    } as WorkerProps);
    expect(flags).toContain("handle_cross_request_promise_resolution");
  });

  test("omits handle_cross_request_promise_resolution once default-on", () => {
    const { flags } = getCompatibility({} as WorkerProps);
    expect(flags).not.toContain("handle_cross_request_promise_resolution");
  });
});
