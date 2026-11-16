import { describe, expect, it } from "vite-plus/test";

import { hostFileUrlPath } from "./hostFileLinks.ts";

const ORIGIN = "https://app.example.com";
const ORIGINS = [ORIGIN, "http://100.64.0.1:3773"];

describe("hostFileUrlPath", () => {
  it("maps a URL to a file under a served root on one of the environment's origins", () => {
    expect(hostFileUrlPath(`${ORIGIN}/home/me/notes/a.md`, ORIGINS)).toBe("/home/me/notes/a.md");
    expect(hostFileUrlPath(`${ORIGIN}/tmp/report.md#L3`, ORIGINS)).toBe("/tmp/report.md#L3");
    expect(hostFileUrlPath(`${ORIGIN}/work/project/Makefile`, ORIGINS)).toBe(
      "/work/project/Makefile",
    );
    expect(hostFileUrlPath(`${ORIGIN}/home/me/%E6%96%87%20a.md`, ORIGINS)).toBe(
      "/home/me/%E6%96%87%20a.md",
    );
    expect(hostFileUrlPath("HTTPS://APP.EXAMPLE.COM/home/me/a.md", ORIGINS)).toBe("/home/me/a.md");
    expect(hostFileUrlPath("http://100.64.0.1:3773/tmp/a.md", ORIGINS)).toBe("/tmp/a.md");
  });

  it("leaves other machines, app routes, queries and credentials as web links", () => {
    for (const href of [
      "https://other.example.com/home/me/a.md",
      "http://app.example.com/home/me/a.md",
      "https://app.example.com:8443/home/me/a.md",
      `${ORIGIN}/assets/index.js`,
      `${ORIGIN}/api/x.json`,
      `${ORIGIN}/port/8080/index.html`,
      `${ORIGIN}/chat/`,
      `${ORIGIN}/homework/a.md`,
      `${ORIGIN}/home/`,
      `${ORIGIN}/home/me/a.md?download=1`,
      "https://me:secret@app.example.com/home/me/a.md",
      "//app.example.com/home/me/a.md",
      "/home/me/a.md",
    ]) {
      expect(hostFileUrlPath(href, ORIGINS), href).toBeNull();
    }
    expect(hostFileUrlPath(`${ORIGIN}/home/me/a.md`, [])).toBeNull();
  });
});
