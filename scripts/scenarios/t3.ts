// @effect-diagnostics nodeBuiltinImport:off
// `test` for web scenarios: e2e's web test plus `t3`, which seeds state and opens the signed-in
// app. `t3-mobile.ts` is the same for the iOS app.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { test as base } from "@e2e-dev/web";

import { APP_DIR, T3_HOME } from "../e2e.config.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

export interface T3State {
  /** Creates a git repository holding `files` and adds it as a project. Returns its path. */
  readonly project: (title: string, files?: Readonly<Record<string, string>>) => Promise<string>;
  /**
   * Starts a thread in a project and plays one replayed turn per message before returning.
   * `model` is a dev replay recording: showcase, todo-list, approval, question, multi-turn.
   */
  readonly thread: (input: {
    readonly project: string;
    readonly title: string;
    readonly messages: ReadonlyArray<string>;
    readonly model?: string;
  }) => Promise<void>;
}

export interface T3 extends T3State {
  /** Opens the app, signed in, at `path`. */
  readonly open: (path?: string) => Promise<void>;
}

/** State for the server on `home`, made through the app's own CLI: real events, not inserted rows. */
export function makeState(home: string, env: NodeJS.ProcessEnv = {}) {
  const cli = (args: ReadonlyArray<string>) =>
    execFile(process.execPath, ["apps/server/src/bin.ts", ...args, "--base-dir", home], {
      cwd: APP_DIR,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    });
  const projects: Array<string> = [];
  const state: T3State = {
    project: async (title, files = {}) => {
      // Its own folder per test: the server and this home outlive one test.
      NodeFS.mkdirSync(NodePath.join(home, "workspaces"), { recursive: true });
      const parent = NodeFS.mkdtempSync(NodePath.join(home, "workspaces", "w-"));
      const workspace = NodePath.join(parent, title);
      for (const [file, content] of Object.entries({ "README.md": "", ...files })) {
        NodeFS.mkdirSync(NodePath.dirname(NodePath.join(workspace, file)), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(workspace, file), content);
      }
      const git = (args: ReadonlyArray<string>) => execFile("git", args, { cwd: workspace });
      const author = ["-c", "user.name=Scenario", "-c", "user.email=scenario@example.invalid"];
      await git(["init", "--quiet", "--initial-branch=main"]);
      await git(["add", "--all"]);
      await git([...author, "commit", "--quiet", "--message", "Initial commit"]);
      await cli(["project", "add", workspace, "--title", title]);
      projects.push(workspace);
      return workspace;
    },
    thread: async ({ project, title, messages, model = "multi-turn" }) => {
      // Exit code 2 means the turn waits for an answer, which a scenario may want to start from.
      const turn = (args: ReadonlyArray<string>) =>
        cli(["thread", ...args, "--wait", "--json"]).catch(
          (error: { code?: unknown; stdout?: string }) => {
            if (error.code !== 2 || error.stdout === undefined) throw error;
            return { stdout: error.stdout };
          },
        );
      const [first = "Start", ...rest] = messages;
      const replay = ["--provider", "devReplay", "--model", model];
      const started = await turn(["start", project, first, "--title", title, ...replay]);
      const { threadId } = JSON.parse(started.stdout) as { threadId: string };
      for (const message of rest) await turn(["send", threadId, message]);
    },
  };
  return {
    state,
    cli,
    // The server outlives the test, so the next one must not see this one's projects.
    cleanup: async () => {
      for (const workspace of projects) await cli(["project", "remove", workspace, "--force"]);
    },
  };
}

export const test = base.extend<{ t3: T3 }>({
  t3: async ({ app }, use) => {
    const { state, cleanup } = makeState(T3_HOME);
    await use({
      ...state,
      open: async (path = "/") => {
        await app.open(NodeFS.readFileSync(NodePath.join(T3_HOME, "pairing-path"), "utf8"));
        if (path !== "/") await app.open(path);
      },
    });
    await cleanup();
  },
});

/** Test option for a web scenario: the iOS target skips it. */
export const WEB = { platforms: ["web"] } as const;
