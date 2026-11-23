import { describe, expect, it } from "vite-plus/test";
import { UserCommandError, type UserCommandSummary } from "@t3tools/contracts";

import {
  offeredUserCommands,
  parseUserCommandPrompt,
  userCommandNeverStarted,
} from "./userCommandPrompt.ts";

const commands: ReadonlyArray<UserCommandSummary> = [
  { name: "graph", description: "Graph", output: "html", source: "user" },
];

describe("parseUserCommandPrompt", () => {
  it("splits the name from the typed arguments", () => {
    expect(parseUserCommandPrompt("  /graph  --depth 2\n", commands)).toEqual({
      command: commands[0],
      args: "--depth 2",
    });
    expect(parseUserCommandPrompt("/graph", commands)?.args).toBe("");
  });

  it("leaves unknown commands, other text and paths to the agent", () => {
    expect(parseUserCommandPrompt("/other", commands)).toBeNull();
    expect(parseUserCommandPrompt("/graphs", commands)).toBeNull();
    expect(parseUserCommandPrompt("run /graph", commands)).toBeNull();
    expect(parseUserCommandPrompt("/graph/sub", commands)).toBeNull();
  });
});

describe("offeredUserCommands", () => {
  it("leaves a provider's own command to the provider", () => {
    const review: UserCommandSummary = {
      name: "review",
      description: "Not the provider's review",
      output: "markdown",
      source: "project",
    };
    const offered = offeredUserCommands([...commands, review], [{ name: "review" }]);
    expect(offered).toEqual(commands);
    expect(parseUserCommandPrompt("/review", offered)).toBeNull();
  });
});

describe("userCommandNeverStarted", () => {
  it("keeps the prompt only for failures that come before the program starts", () => {
    const failure = (reason: UserCommandError["reason"]) =>
      new UserCommandError({ reason, message: "No." });
    expect(userCommandNeverStarted(failure("unknown-command"))).toBe(true);
    expect(userCommandNeverStarted(failure("thread-not-found"))).toBe(true);
    expect(userCommandNeverStarted(failure("unavailable"))).toBe(false);
    expect(userCommandNeverStarted(new Error("Connection lost"))).toBe(false);
  });
});
