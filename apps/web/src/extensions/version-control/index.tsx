import type { ComponentProps } from "react";
import type { Extension } from "@t3tools/extension-sdk/host";
import type { SurfaceRenderer } from "@t3tools/extension-sdk/react";

import { PullRequestDetailPanel } from "../../components/pullRequest/PullRequestDetailPanel";
import { ThreadPullRequestsPanel } from "../../components/pullRequest/ThreadPullRequestsPanel";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { PullRequestDetailGhost } from "../../components/pullRequest/PullRequestGhosts";
import { PullRequestsUnavailableState } from "../../components/pullRequest/PullRequestsUnavailableState";

export type VersionControlBindings =
  | { readonly status: "list"; readonly threadRef: ScopedThreadRef }
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "ready";
      readonly detail: Omit<ComponentProps<typeof PullRequestDetailPanel>, "onClose">;
    };

export function createVersionControlExtension(
  useBindings: () => VersionControlBindings,
): Extension<SurfaceRenderer> {
  function VersionControlSurface() {
    const bindings = useBindings();
    if (bindings.status === "list")
      return <ThreadPullRequestsPanel threadRef={bindings.threadRef} />;
    if (bindings.status === "loading") return <PullRequestDetailGhost />;
    if (bindings.status === "unavailable") {
      return (
        <PullRequestsUnavailableState
          title="Pull requests unavailable"
          error="Update this environment's T3 Code server to browse pull requests."
        />
      );
    }
    const { reference } = bindings.detail;
    return (
      <PullRequestDetailPanel
        {...bindings.detail}
        key={`${bindings.detail.environmentId}:${bindings.detail.reference.projectId}:${reference.host ?? ""}:${reference.repository}#${reference.number}`}
      />
    );
  }

  return {
    manifest: {
      id: "t3.version-control",
      apiVersion: 1,
      version: "0.1.0",
      surfaces: [
        {
          id: "t3.version-control/view",
          title: "Version Control",
          placements: ["side-panel"],
          clients: ["web", "desktop"],
          scope: "project",
          capabilities: [],
          stateVersion: 1,
        },
      ],
    },
    surfaces: [
      {
        id: "t3.version-control/view",
        validateRestore: (state) => state === null,
        createView: () => ({ renderer: VersionControlSurface }),
      },
    ],
  };
}
