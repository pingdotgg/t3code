import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cloneJson } from "@t3tools/rr-e2e";

import type { ReplayFixture } from "../types.ts";

export interface ReplayHarnessEnvironment {
  readonly dbPath: string;
  readonly keybindingsConfigPath: string;
  readonly rootDir: string;
  readonly state: Record<string, unknown>;
  readonly stateDir: string;
  readonly workspaceDir: string;
  readonly cleanup: () => void;
}

export function createReplayHarnessEnvironment(fixture: ReplayFixture): ReplayHarnessEnvironment {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-web-replay-"));
  const workspaceDir = path.join(rootDir, "workspace");
  const stateDir = path.join(rootDir, "state");
  const dbPath = path.join(stateDir, "state.sqlite");
  const keybindingsConfigPath = path.join(stateDir, "keybindings.json");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, ".git"), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  const state = cloneJson(fixture.state ?? {}) as Record<string, unknown>;
  state.cwd = workspaceDir;
  state.projectName = state.projectName ?? (path.basename(workspaceDir) || "workspace");

  return {
    dbPath,
    keybindingsConfigPath,
    rootDir,
    state,
    stateDir,
    workspaceDir,
    cleanup: () => {
      fs.rmSync(rootDir, { recursive: true, force: true });
    },
  };
}
