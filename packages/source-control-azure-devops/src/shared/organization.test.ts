import { describe, expect, it } from "@effect/vitest";

import { azureDevOpsOrganizationKey } from "./organization.ts";

describe("azureDevOpsOrganizationKey", () => {
  it("names the organization of every remote, API URL and typed spelling", () => {
    for (const value of [
      "https://dev.azure.com/Acme/p1/_apis/git/repositories/r1",
      "https://acme@dev.azure.com/acme/p1/_git/r1",
      "https://acme.visualstudio.com/p1/_git/r1",
      "git@ssh.dev.azure.com:v3/acme/p1/r1",
      "ssh://git@ssh.dev.azure.com/v3/acme/p1/r1",
      "acme@vs-ssh.visualstudio.com:v3/acme/p1/r1",
      "https://dev.azure.com/%61cme/p1/_git/r1",
      "dev.azure.com/acme",
      " DEV.AZURE.COM/ACME ",
      "dev.azure.com/acme/",
      "https://dev.azure.com/acme",
      "https://dev.azure.com/acme/",
      "acme.visualstudio.com",
      "https://Acme.visualstudio.com/",
    ]) {
      expect(azureDevOpsOrganizationKey(value), value).toBe("dev.azure.com/acme");
    }
  });

  it("names the organization a request reaches after dot segments", () => {
    for (const value of [
      "https://dev.azure.com/acme/../globex/p/_apis/git/repositories/r/items",
      "https://dev.azure.com/acme/%2e%2e/globex/p/_apis/git/repositories/r/items",
    ]) {
      expect(azureDevOpsOrganizationKey(value), value).toBe("dev.azure.com/globex");
    }
  });

  it("names no organization for other servers or malformed names", () => {
    for (const value of [
      "",
      "dev.azure.com",
      "dev.azure.com/",
      "https://tfs.example.com/tfs/c/p1/_git/r1",
      "https://dev.azure.com.attacker.example/acme/p1/_git/r1",
      "http://dev.azure.com/acme/p1/_git/r1",
      "https://dev.azure.com:8443/acme/p1/_git/r1",
      "https://dev.azure.com/%E0%A4%A/p1",
      "https://dev.azure.com/ac%2Fme/p1",
      "https://dev.azure.com/-acme/p1",
      "https://a.b.visualstudio.com/p1",
      "https://vs-ssh.visualstudio.com/p1",
      "git@github.com:acme/r1.git",
    ]) {
      expect(azureDevOpsOrganizationKey(value), value).toBeNull();
    }
  });
});
