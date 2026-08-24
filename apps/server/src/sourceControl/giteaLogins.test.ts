import { describe, expect, it } from "vite-plus/test";

import {
  findGiteaLoginForHost,
  findPrimaryGiteaLogin,
  normalizeGiteaHostname,
  parseGiteaLogins,
} from "./giteaLogins.ts";

// Captured from a real `tea logins list --output json` (tea 0.15.1). Note that `default` is the
// string "true", not a boolean, and that no token is ever included in the output.
const TWO_LOGINS = JSON.stringify([
  {
    name: "local",
    url: "https://git.example.internal",
    ssh_host: "git.example.internal",
    user: "mario",
    default: "true",
  },
  {
    name: "second",
    url: "https://code.home.arpa:3000",
    ssh_host: "code.home.arpa",
    user: "otheruser",
    default: "false",
  },
]);

describe("parseGiteaLogins", () => {
  it("parses multiple logins and reads tea's string `default` flag", () => {
    const logins = parseGiteaLogins(TWO_LOGINS);
    expect(logins).toHaveLength(2);
    expect(logins[0]).toEqual({
      name: "local",
      url: "https://git.example.internal",
      hostname: "git.example.internal",
      sshHostname: "git.example.internal",
      user: "mario",
      isDefault: true,
    });
    expect(logins[1]?.isDefault).toBe(false);
    expect(logins[1]?.hostname).toBe("code.home.arpa");
  });

  it("parses a single login", () => {
    const logins = parseGiteaLogins(
      JSON.stringify([
        {
          name: "only",
          url: "https://git.example.com",
          ssh_host: "",
          user: "sam",
          default: "true",
        },
      ]),
    );
    expect(logins).toHaveLength(1);
    expect(logins[0]?.user).toBe("sam");
    expect(logins[0]?.sshHostname).toBe("");
  });

  it("returns no logins when tea has none configured", () => {
    expect(parseGiteaLogins("[]")).toEqual([]);
    expect(parseGiteaLogins("")).toEqual([]);
    expect(parseGiteaLogins("   \n ")).toEqual([]);
  });

  it("returns no logins for malformed or unexpected output instead of throwing", () => {
    expect(parseGiteaLogins("not json at all")).toEqual([]);
    expect(parseGiteaLogins("{}")).toEqual([]);
    expect(parseGiteaLogins('"a string"')).toEqual([]);
    expect(parseGiteaLogins("[1, 2, null]")).toEqual([]);
    // An entry with neither a URL nor an SSH host cannot be matched to a remote, so it is dropped.
    expect(parseGiteaLogins('[{"name":"broken","user":"x"}]')).toEqual([]);
  });

  it("treats a missing user as unauthenticated rather than an empty name", () => {
    const logins = parseGiteaLogins('[{"name":"n","url":"https://git.example.com","user":""}]');
    expect(logins[0]?.user).toBeNull();
  });
});

describe("normalizeGiteaHostname", () => {
  it("lowercases and strips ports", () => {
    expect(normalizeGiteaHostname("GIT.Example.COM")).toBe("git.example.com");
    expect(normalizeGiteaHostname("git.example.com:3000")).toBe("git.example.com");
    expect(normalizeGiteaHostname("https://GIT.example.com:3000")).toBe("git.example.com");
    expect(normalizeGiteaHostname("http://git.example.com")).toBe("git.example.com");
  });

  it("handles bare IPs and IPv6 literals", () => {
    expect(normalizeGiteaHostname("192.168.1.10:3000")).toBe("192.168.1.10");
    expect(normalizeGiteaHostname("[::1]:3000")).toBe("[::1]");
  });

  it("returns empty for blank input", () => {
    expect(normalizeGiteaHostname("")).toBe("");
    expect(normalizeGiteaHostname("   ")).toBe("");
  });
});

describe("findGiteaLoginForHost", () => {
  const logins = parseGiteaLogins(TWO_LOGINS);

  it("matches an HTTPS remote host", () => {
    expect(findGiteaLoginForHost(logins, "git.example.internal")?.name).toBe("local");
  });

  it("matches regardless of port, since HTTPS and SSH commonly differ", () => {
    // The login is configured on :3000 but an SSH remote reports no port at all.
    expect(findGiteaLoginForHost(logins, "code.home.arpa")?.name).toBe("second");
    expect(findGiteaLoginForHost(logins, "code.home.arpa:3000")?.name).toBe("second");
    expect(findGiteaLoginForHost(logins, "code.home.arpa:22")?.name).toBe("second");
  });

  it("matches case-insensitively", () => {
    expect(findGiteaLoginForHost(logins, "GIT.EXAMPLE.INTERNAL")?.name).toBe("local");
  });

  it("does not match hosts tea knows nothing about", () => {
    expect(findGiteaLoginForHost(logins, "git.unrelated.com")).toBeUndefined();
    expect(findGiteaLoginForHost(logins, "")).toBeUndefined();
    // Substrings must not match: a suffix is a different host.
    expect(findGiteaLoginForHost(logins, "evil-git.example.internal")).toBeUndefined();
    expect(findGiteaLoginForHost(logins, "example.internal")).toBeUndefined();
  });

  it("matches via ssh_host when it differs from the web URL host", () => {
    const split = parseGiteaLogins(
      JSON.stringify([
        {
          name: "split",
          url: "https://gitea.example.com",
          ssh_host: "ssh.example.com",
          user: "sam",
          default: "true",
        },
      ]),
    );
    expect(findGiteaLoginForHost(split, "gitea.example.com")?.name).toBe("split");
    expect(findGiteaLoginForHost(split, "ssh.example.com")?.name).toBe("split");
  });
});

describe("findPrimaryGiteaLogin", () => {
  it("prefers the default login", () => {
    expect(findPrimaryGiteaLogin(parseGiteaLogins(TWO_LOGINS))?.name).toBe("local");
  });

  it("falls back to the first authenticated login when none is marked default", () => {
    const logins = parseGiteaLogins(
      JSON.stringify([
        { name: "a", url: "https://a.example.com", user: "", default: "false" },
        { name: "b", url: "https://b.example.com", user: "sam", default: "false" },
      ]),
    );
    expect(findPrimaryGiteaLogin(logins)?.name).toBe("b");
  });

  it("returns undefined when there are no logins", () => {
    expect(findPrimaryGiteaLogin([])).toBeUndefined();
  });
});
