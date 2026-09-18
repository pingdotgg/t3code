import * as NodeOS from "node:os";
import { assert, it } from "vite-plus/test";

import { hydratePosixEnvironment, hydratePosixHome } from "./os-jank.ts";

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

it("imports the whole login-shell environment, not just PATH", () => {
  const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };

  hydratePosixEnvironment(env, "linux", () => ({
    PATH: "/home/u/.nvm/bin:/usr/bin",
    EDITOR: "nvim",
    GOROOT: "/home/u/.gvm/go",
    RBENV_SHELL: "zsh",
  }));

  assert.equal(env.EDITOR, "nvim");
  assert.equal(env.GOROOT, "/home/u/.gvm/go");
  assert.equal(env.RBENV_SHELL, "zsh");
  assert.equal(env.PATH, "/home/u/.nvm/bin:/usr/bin");
});

it("keeps runtime-owned variables out of the import", () => {
  const env: NodeJS.ProcessEnv = {
    SHELL: "/bin/zsh",
    PATH: "/usr/bin",
    HOME: "/run/service-home",
    T3CODE_NO_BROWSER: "1",
  };

  hydratePosixEnvironment(env, "linux", () => ({
    HOME: "/home/u",
    T3CODE_NO_BROWSER: "0",
    PWD: "/home/u",
    SHLVL: "3",
    EDITOR: "nvim",
  }));

  assert.equal(env.HOME, "/run/service-home");
  assert.equal(env.T3CODE_NO_BROWSER, "1");
  assert.equal(env.PWD, undefined);
  assert.equal(env.SHLVL, undefined);
  assert.equal(env.EDITOR, "nvim");
});

it("preserves inherited values instead of overwriting them from the login shell", () => {
  const env: NodeJS.ProcessEnv = {
    SHELL: "/bin/zsh",
    PATH: "/usr/bin",
    SSH_AUTH_SOCK: "/tmp/inherited.sock",
    EDITOR: "vi",
  };

  hydratePosixEnvironment(env, "linux", () => ({
    SSH_AUTH_SOCK: "/tmp/login-shell.sock",
    EDITOR: "nvim",
  }));

  assert.equal(env.SSH_AUTH_SOCK, "/tmp/inherited.sock");
  assert.equal(env.EDITOR, "vi");
});

it("backfills a session handle the service was launched without", () => {
  const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };

  hydratePosixEnvironment(env, "linux", () => ({ SSH_AUTH_SOCK: "/tmp/login-shell.sock" }));

  assert.equal(env.SSH_AUTH_SOCK, "/tmp/login-shell.sock");
});

it("treats an inherited empty value as absent", () => {
  const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin", EDITOR: "" };

  hydratePosixEnvironment(env, "linux", () => ({ EDITOR: "nvim" }));

  assert.equal(env.EDITOR, "nvim");
});

it("keeps the inherited environment when every candidate shell fails", () => {
  const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin", EDITOR: "vi" };

  hydratePosixEnvironment(env, "linux", () => {
    throw new Error("login shell unavailable");
  });

  assert.equal(env.EDITOR, "vi");
  assert.equal(env.PATH, "/usr/bin");
});
