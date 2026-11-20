import type { EnvironmentId } from "@t3tools/contracts";
import { createContext, useContext } from "react";

import type { ArtifactGroups } from "../domain/artifact";
import type { Artifact } from "../store/artifacts";

/** The key the board-level artifacts expand under, beside the ticket keys. */
export const BOARD_KEY = "__board";

export interface ArtifactsValue {
  readonly environmentId: EnvironmentId;
  /** The project folder, which every read is made from. */
  readonly cwd: string;
  /** The thread a media URL is minted under. */
  readonly mediaThreadId: string;
  readonly all: ReadonlyArray<Artifact>;
  readonly groups: ArtifactGroups<Artifact>;
  /** The ticket keys, and `BOARD_KEY`, whose cards are open. */
  readonly expanded: ReadonlySet<string>;
  readonly toggle: (key: string) => void;
  readonly open: (artifact: Artifact) => void;
}

const ArtifactsContext = createContext<ArtifactsValue | null>(null);

export const ArtifactsProvider = ArtifactsContext.Provider;

export function useArtifacts(): ArtifactsValue {
  const value = useContext(ArtifactsContext);
  if (value === null) throw new Error("useArtifacts needs an ArtifactsProvider");
  return value;
}
