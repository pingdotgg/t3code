import * as OS from "node:os";
import { describe, expect, it } from "vitest";
import { expandTilde } from "./os-jank.js";

describe("expandTilde", () => {
  const home = OS.homedir();

  it("expands bare ~", () => {
    expect(expandTilde("~")).toBe(home);
  });

  it("expands ~/ prefix", () => {
    expect(expandTilde("~/projects/foo")).toBe(`${home}/projects/foo`);
  });

  it("expands ~\\ prefix (Windows)", () => {
    expect(expandTilde("~\\projects\\foo")).toBe(`${home}\\projects\\foo`);
  });

  it("does not expand ~ in the middle of a path", () => {
    expect(expandTilde("/home/~user/foo")).toBe("/home/~user/foo");
  });

  it("returns absolute paths unchanged", () => {
    expect(expandTilde("/usr/local/bin")).toBe("/usr/local/bin");
  });

  it("returns empty string unchanged", () => {
    expect(expandTilde("")).toBe("");
  });
});
