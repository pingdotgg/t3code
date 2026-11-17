import { describe, expect, it } from "vite-plus/test";

import { parseTeaToken } from "./ForgejoCli.ts";

const config = (host: string, token: string) => `logins:
  - name: work
    url: http://${host}
    token: ${token}
    default: true
preferences:
  editor: false
`;

describe("tea config tokens", () => {
  it("reads the token of the login that names the host, port included", () => {
    expect(parseTeaToken(config("git.example.test:3000", "secret"), "git.example.test:3000")).toBe(
      "secret",
    );
    expect(parseTeaToken(config("git.example.test:3000", "secret"), "other.example.test")).toBe(
      null,
    );
  });

  it("reads nothing out of a file it cannot parse", () => {
    expect(parseTeaToken("logins: [", "git.example.test:3000")).toBeNull();
    expect(parseTeaToken("preferences:\n  editor: true\n", "git.example.test:3000")).toBeNull();
  });
});
