import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createAssetEnvironmentAtoms } from "./assets.ts";

describe("createAssetEnvironmentAtoms", () => {
  it("keys asset URL queries by environment and resource", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry,
      never
    >;
    const assets = createAssetEnvironmentAtoms(runtime);
    const environmentId = EnvironmentId.make("environment-1");
    const originalTarget = {
      environmentId,
      input: {
        resource: {
          _tag: "project-favicon" as const,
          cwd: "/repo/original",
        },
      },
    };

    expect(assets.createUrl(originalTarget)).toBe(
      assets.createUrl({
        environmentId,
        input: {
          resource: {
            _tag: "project-favicon",
            cwd: "/repo/original",
          },
        },
      }),
    );
    expect(
      assets.createUrl({
        environmentId,
        input: {
          resource: {
            _tag: "project-favicon",
            cwd: "/repo/next",
          },
        },
      }),
    ).not.toBe(assets.createUrl(originalTarget));
    expect(
      assets.createUrl({
        environmentId: EnvironmentId.make("environment-2"),
        input: originalTarget.input,
      }),
    ).not.toBe(assets.createUrl(originalTarget));
  });

  it("keys collections while preserving independent resource queries", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry,
      never
    >;
    const assets = createAssetEnvironmentAtoms(runtime);
    const environmentId = EnvironmentId.make("environment-1");
    const resources = [
      { _tag: "attachment" as const, attachmentId: "attachment-1" },
      { _tag: "attachment" as const, attachmentId: "attachment-2" },
    ];

    expect(assets.createUrls({ environmentId, resources })).toBe(
      assets.createUrls({
        environmentId,
        resources: resources.map((resource) => ({ ...resource })),
      }),
    );
    expect(
      assets.createUrls({
        environmentId,
        resources: [...resources].toReversed(),
      }),
    ).not.toBe(assets.createUrls({ environmentId, resources }));
  });
});
