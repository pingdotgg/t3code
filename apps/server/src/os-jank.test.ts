import * as NodeOS from "node:os";
import { assert, it } from "vite-plus/test";

import { hydratePosixEnvironment, hydratePosixHome } from "./os-jank.ts";

it.each(["linux", "darwin"] as const)(
  "hydrates the SSH agent and merges PATH from the login shell on %s",
  (platform) => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/service/bin", SHELL: "/bin/bash" };

    hydratePosixEnvironment(env, platform, () => ({
      PATH: "/shell/bin:/usr/bin",
      SSH_AUTH_SOCK: "/opt/orbstack-guest/run/host-ssh-agent.sock",
    }));

    assert.equal(env.SSH_AUTH_SOCK, "/opt/orbstack-guest/run/host-ssh-agent.sock");
    assert.equal(env.PATH, "/shell/bin:/usr/bin:/service/bin");
  },
);

it("preserves an explicitly forwarded SSH agent", () => {
  const env: NodeJS.ProcessEnv = { SSH_AUTH_SOCK: "/forwarded/agent.sock" };

  hydratePosixEnvironment(env, "linux", () => ({
    PATH: "/usr/bin",
    SSH_AUTH_SOCK: "/login/agent.sock",
  }));

  assert.equal(env.SSH_AUTH_SOCK, "/forwarded/agent.sock");
});

it("leaves the SSH agent unset when the login shell has none", () => {
  const env: NodeJS.ProcessEnv = { PATH: "/service/bin" };

  hydratePosixEnvironment(env, "linux", () => ({ PATH: "/usr/bin" }));

  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.equal(env.PATH, "/usr/bin:/service/bin");
});

it("reads the current agent socket for each fresh service environment", () => {
  const first: NodeJS.ProcessEnv = {};
  const next: NodeJS.ProcessEnv = {};
  let socket = "/run/user/1000/agent-first.sock";
  const readShellEnvironment = () => ({ PATH: "/usr/bin", SSH_AUTH_SOCK: socket });

  hydratePosixEnvironment(first, "linux", readShellEnvironment);
  socket = "/run/user/1000/agent-next.sock";
  hydratePosixEnvironment(next, "linux", readShellEnvironment);

  assert.equal(first.SSH_AUTH_SOCK, "/run/user/1000/agent-first.sock");
  assert.equal(next.SSH_AUTH_SOCK, "/run/user/1000/agent-next.sock");
});

it("hydrates HOME for minimal service environments from the user account", () => {
  const env: NodeJS.ProcessEnv = {};

  hydratePosixHome(env);

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("hydrates HOME independently of a blank process HOME", () => {
  const originalHome = process.env.HOME;
  const env: NodeJS.ProcessEnv = { HOME: " " };

  try {
    process.env.HOME = " ";
    hydratePosixHome(env);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("preserves an explicitly configured HOME", () => {
  const env: NodeJS.ProcessEnv = { HOME: "/custom/home" };

  hydratePosixHome(env, () => {
    throw new Error("HOME lookup should not run");
  });

  assert.equal(env.HOME, "/custom/home");
});
