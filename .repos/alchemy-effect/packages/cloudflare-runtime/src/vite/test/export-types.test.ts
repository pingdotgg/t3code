import {
  configuredExportTypes,
  mergeExportTypes,
  renderExportWrappers,
} from "../export-types.ts";
import { describe, expect, test } from "vitest";

describe("configuredExportTypes", () => {
  test("is empty without a worker config", () => {
    expect(configuredExportTypes({})).toEqual({});
    expect(
      configuredExportTypes({ worker: { name: "worker", bindings: [] } }),
    ).toEqual({});
  });

  test("derives export types from declared namespaces and workflows", () => {
    expect(
      configuredExportTypes({
        worker: {
          name: "worker",
          bindings: [],
          durableObjectNamespaces: [{ className: "Counter", sql: true }],
          workflows: [
            { workflowName: "example", className: "ExampleWorkflow" },
          ],
        },
      }),
    ).toEqual({
      Counter: "DurableObject",
      ExampleWorkflow: "WorkflowEntrypoint",
    });
  });
});

describe("mergeExportTypes", () => {
  test("adds detected exports that were not configured", () => {
    expect(
      mergeExportTypes(
        { Counter: "DurableObject" },
        { Api: "WorkerEntrypoint" },
      ),
    ).toEqual({
      Counter: "DurableObject",
      Api: "WorkerEntrypoint",
    });
  });

  test("keeps the configured type when detection disagrees", () => {
    expect(
      mergeExportTypes(
        { Counter: "DurableObject" },
        { Counter: "WorkerEntrypoint" },
      ),
    ).toEqual({
      Counter: "DurableObject",
    });
  });
});

describe("renderExportWrappers", () => {
  test("wraps each export with the factory for its type", () => {
    expect(
      renderExportWrappers({
        Api: "WorkerEntrypoint",
        Counter: "DurableObject",
        ExampleWorkflow: "WorkflowEntrypoint",
      }),
    ).toEqual([
      'export const Api = createWorkerEntrypointWrapper("Api");',
      'export const Counter = createDurableObjectWrapper("Counter");',
      'export const ExampleWorkflow = createWorkflowEntrypointWrapper("ExampleWorkflow");',
    ]);
  });

  test("skips names the generated entry already uses", () => {
    expect(
      renderExportWrappers({
        default: "WorkerEntrypoint",
        ModuleRunnerDO: "DurableObject",
      }),
    ).toEqual([]);
  });

  test("skips export names that are not valid identifiers", () => {
    expect(
      renderExportWrappers({
        "not-an-identifier": "WorkerEntrypoint",
        "with space": "DurableObject",
        "1leading": "WorkerEntrypoint",
        $valid_name0: "WorkerEntrypoint",
      }),
    ).toEqual([
      'export const $valid_name0 = createWorkerEntrypointWrapper("$valid_name0");',
    ]);
  });
});
