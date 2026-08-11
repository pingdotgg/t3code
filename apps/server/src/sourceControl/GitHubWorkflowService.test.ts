import { describe, expect, it } from "@effect/vitest";

import { extractRunUrl, workflowRunArguments } from "./GitHubWorkflowService.ts";
import { parseDispatchWorkflow } from "./githubWorkflowYaml.ts";

describe("parseDispatchWorkflow", () => {
  it("parses workflow_dispatch inputs, choices, and defaults", () => {
    expect(
      parseDispatchWorkflow(
        `
name: Deploy preview
on:
  workflow_dispatch:
    inputs:
      environment:
        description: Deployment target
        required: true
        type: choice
        options: [preview, production]
        default: preview
      dry_run:
        type: boolean
        default: false
`,
        "deploy.yml",
      ),
    ).toEqual({
      filename: "deploy.yml",
      name: "Deploy preview",
      inputs: [
        {
          name: "environment",
          description: "Deployment target",
          required: true,
          type: "choice",
          defaultValue: "preview",
          options: ["preview", "production"],
        },
        {
          name: "dry_run",
          required: false,
          type: "boolean",
          defaultValue: "false",
        },
      ],
    });
  });

  it("accepts scalar and array dispatch triggers and falls back to the filename", () => {
    expect(parseDispatchWorkflow("on: workflow_dispatch", "manual.yaml")).toEqual({
      filename: "manual.yaml",
      name: "manual.yaml",
      inputs: [],
    });
    expect(parseDispatchWorkflow("on: [push, workflow_dispatch]", "release.yml")).toEqual({
      filename: "release.yml",
      name: "release.yml",
      inputs: [],
    });
  });

  it("ignores workflows without a manual trigger and malformed yaml", () => {
    expect(parseDispatchWorkflow("on: push", "push.yml")).toBeNull();
    expect(parseDispatchWorkflow("on: [", "broken.yml")).toBeNull();
  });
});

describe("workflowRunArguments", () => {
  it("builds gh workflow run arguments without a shell command", () => {
    expect(
      workflowRunArguments({
        filename: "deploy.yml",
        ref: "feature/manual-release",
        inputs: { environment: "preview", version: "1.2.3" },
      }),
    ).toEqual([
      "workflow",
      "run",
      "deploy.yml",
      "--ref",
      "feature/manual-release",
      "-f",
      "environment=preview",
      "-f",
      "version=1.2.3",
    ]);
  });
});

describe("workflow run URL resolution", () => {
  it("extracts the specific run URL returned by gh workflow run", () => {
    expect(
      extractRunUrl(
        "✓ Created workflow_dispatch event\nhttps://github.com/acme/widgets/actions/runs/123456789",
      ),
    ).toBe("https://github.com/acme/widgets/actions/runs/123456789");
  });

  it("does not accept a generic Actions URL", () => {
    expect(extractRunUrl("https://github.com/acme/widgets/actions")).toBeNull();
  });
});
