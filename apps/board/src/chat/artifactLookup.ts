import { createContext, useContext, useSyncExternalStore } from "react";

import type { Artifact } from "../store/artifacts";
import { findArtifact } from "./links";

/**
 * The board's artifacts as the chat's links read them. The artifact list refreshes about as often as
 * tokens arrive, so a link subscribes to its own match instead of to the list: only a link whose
 * artifact appeared or went away renders again.
 */
export class ArtifactLookup {
  private artifacts: ReadonlyArray<Artifact> = [];
  private key = "";
  private readonly listeners = new Set<() => void>();
  private opener: (artifact: Artifact) => void = () => undefined;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  update(artifacts: ReadonlyArray<Artifact>, open: (artifact: Artifact) => void) {
    this.opener = open;
    const key = artifacts.map((artifact) => artifact.absolutePath).join("\n");
    this.artifacts = artifacts;
    if (key === this.key) return;
    this.key = key;
    this.listeners.forEach((listener) => listener());
  }

  /** The absolute path of the artifact a link names, which is what a link renders from. */
  readonly match = (path: string): string | null =>
    findArtifact(path, this.artifacts)?.absolutePath ?? null;

  readonly open = (absolutePath: string) => {
    const artifact = this.artifacts.find((entry) => entry.absolutePath === absolutePath);
    if (artifact !== undefined) this.opener(artifact);
  };
}

export const ArtifactLookupContext = createContext(new ArtifactLookup());

/** The artifact a path names, as its absolute path, or null. Renders again only when that answer changes. */
export function useArtifactMatch(path: string | null): string | null {
  const lookup = useContext(ArtifactLookupContext);
  return useSyncExternalStore(lookup.subscribe, () => (path === null ? null : lookup.match(path)));
}
