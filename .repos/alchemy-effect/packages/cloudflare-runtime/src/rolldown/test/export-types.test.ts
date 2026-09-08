import { createMiniflareFromRolldown } from "../../../../cloudflare-test-tools/src/miniflare/miniflare.ts";
import type { LoadResult, ResolveIdResult } from "rolldown";
import { assert, describe, expect, it } from "vitest";
import {
  EXPORT_TYPES_MODULE_ID,
  haveExportTypesChanged,
  isExportTypes,
  RESOLVED_EXPORT_TYPES_MODULE_ID,
  WORKER_EXPORT_TYPES_EVENT,
  type ExportTypes,
} from "../export-types.ts";
import { virtualModulesPlugin } from "../plugins/virtual-modules.ts";
import { buildFixture } from "./utils/build-fixture.ts";

describe("export type detection", async () => {
  const built = await buildFixture({ fixture: "export-types/index.ts" });

  it("classifies each export of the entry module", async () => {
    await using miniflare = await createMiniflareFromRolldown(built.output, {
      compatibilityDate: "2025-07-01",
    });

    expect(await miniflare.fetchJson("/")).toEqual({
      NamedEntrypoint: "WorkerEntrypoint",
      Counter: "DurableObject",
      ExampleWorkflow: "WorkflowEntrypoint",
      // Classes that extend none of the base classes are assumed to be Durable
      // Objects written against the original API.
      LegacyDurableObject: "DurableObject",
      // A plain object export is an `ExportedHandler`, i.e. a named entrypoint.
      handlerEntrypoint: "WorkerEntrypoint",
    });
  });

  it("omits the default export and values that cannot be an entrypoint", async () => {
    await using miniflare = await createMiniflareFromRolldown(built.output, {
      compatibilityDate: "2025-07-01",
    });

    const exportTypes = await miniflare.fetchJson<ExportTypes>("/");
    expect(exportTypes).not.toHaveProperty("default");
    expect(exportTypes).not.toHaveProperty("version");
    expect(exportTypes).not.toHaveProperty("revision");
  });
});

describe("export types virtual module", () => {
  const plugin = virtualModulesPlugin.rolldown({});

  const resolveId = (id: string): ResolveIdResult => {
    assert(typeof plugin.resolveId === "object" && plugin.resolveId !== null);
    return plugin.resolveId.handler.call({} as never, id, undefined, {
      isEntry: false,
      kind: "import-statement",
    }) as ResolveIdResult;
  };

  const load = (id: string): LoadResult => {
    assert(typeof plugin.load === "object" && plugin.load !== null);
    return plugin.load.handler.call({} as never, id) as LoadResult;
  };

  it("resolves the importable specifier to the virtual id", () => {
    expect(resolveId(EXPORT_TYPES_MODULE_ID)).toEqual({
      id: RESOLVED_EXPORT_TYPES_MODULE_ID,
    });
    expect(resolveId(RESOLVED_EXPORT_TYPES_MODULE_ID)).toEqual({
      id: RESOLVED_EXPORT_TYPES_MODULE_ID,
    });
  });

  it("loads the detection module", () => {
    const result = load(RESOLVED_EXPORT_TYPES_MODULE_ID);
    assert(typeof result === "string");
    expect(result).toContain('from "cloudflare:workers"');
    expect(result).toContain("export function getExportTypes(module)");
  });

  it("reports the entry's export types over the HMR channel", () => {
    const result = load("\0distilled:worker-entry:/app/worker.ts");
    assert(typeof result === "string");
    expect(result).toContain(`await import("${EXPORT_TYPES_MODULE_ID}")`);
    expect(result).toContain(
      `import.meta.hot.send("${WORKER_EXPORT_TYPES_EVENT}", exportTypes)`,
    );
  });
});

describe("haveExportTypesChanged", () => {
  const previous: ExportTypes = {
    Counter: "DurableObject",
    Api: "WorkerEntrypoint",
  };

  it("is false for the same exports in a different order", () => {
    expect(
      haveExportTypesChanged(previous, {
        Api: "WorkerEntrypoint",
        Counter: "DurableObject",
      }),
    ).toBe(false);
  });

  it("is true when an export is added", () => {
    expect(
      haveExportTypesChanged(previous, {
        ...previous,
        Flow: "WorkflowEntrypoint",
      }),
    ).toBe(true);
  });

  it("is true when an export is removed", () => {
    expect(haveExportTypesChanged(previous, { Counter: "DurableObject" })).toBe(
      true,
    );
  });

  it("is true when an export changes type", () => {
    expect(
      haveExportTypesChanged(previous, { ...previous, Api: "DurableObject" }),
    ).toBe(true);
  });

  it("is true when an export is renamed", () => {
    expect(
      haveExportTypesChanged(previous, {
        Counter: "DurableObject",
        Rpc: "WorkerEntrypoint",
      }),
    ).toBe(true);
  });
});

describe("isExportTypes", () => {
  it("accepts an export types payload", () => {
    expect(isExportTypes({})).toBe(true);
    expect(
      isExportTypes({ Counter: "DurableObject", Flow: "WorkflowEntrypoint" }),
    ).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isExportTypes(null)).toBe(false);
    expect(isExportTypes(undefined)).toBe(false);
    expect(isExportTypes([])).toBe(false);
    expect(isExportTypes("DurableObject")).toBe(false);
    expect(isExportTypes({ Counter: "Something" })).toBe(false);
    expect(isExportTypes({ Counter: undefined })).toBe(false);
  });
});
