import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  type SourceControlProviderKind,
  type SourceControlRepositoryCloneUrls,
} from "@t3tools/contracts";
import type { SourceControlProvider } from "../sourceControl/SourceControlProvider.ts";
import { createSourceControlDiscoveryApiProvider } from "./sourceControlDiscoveryApi.ts";
import { createProjectsCloneApiProvider } from "./projectsCloneApi.ts";

const context = {
  resource: { namespace: "test", id: "clone", environmentId: "env" },
  client: "test",
};
const urls = (host: string) => ({
  nameWithOwner: "o/n",
  url: `https://${host}/o/n`,
  sshUrl: `git@${host}:o/n.git`,
});
function fixture(
  kind: SourceControlProviderKind,
  hosts: readonly string[],
  result: SourceControlRepositoryCloneUrls,
  withForgejoOrigin = true,
) {
  const calls: unknown[] = [];
  const starts: unknown[] = [];
  const probes: string[] = [];
  const lookup = (input: unknown) =>
    Effect.sync(() => {
      calls.push(input);
      return {
        ...result,
        ...(kind === "forgejo" && withForgejoOrigin ? { repositoryHost: hosts[0] } : {}),
      };
    });
  const discovery = {
    discover: Effect.sync(() => {
      probes.push("all");
      return hosts.slice(0, 1).map((host) => ({
        kind,
        label: kind,
        status: "available" as const,
        installHint: "",
        version: Option.none<string>(),
        detail: Option.none<string>(),
        auth: {
          status: "authenticated" as const,
          host: Option.some(host),
          account: Option.some("alex"),
          detail: Option.none<string>(),
        },
      }));
    }),
    repositoryHosts: (provider: SourceControlProviderKind) =>
      Effect.sync(() => {
        probes.push(provider);
        return hosts;
      }),
    get: () =>
      Effect.succeed({
        kind,
        getRepositoryCloneUrls: lookup,
      } as unknown as SourceControlProvider["Service"]),
  };
  const read = createSourceControlDiscoveryApiProvider({
    environmentId: "env",
    cwd: "/host",
    discovery,
    listRepositories: () => Effect.succeed({ repositories: [], truncated: false }),
  });
  const clone = createProjectsCloneApiProvider({
    environmentId: "env",
    cwd: "/host",
    discovery,
    destinationPath: () => Effect.succeed("/managed/repo"),
    tracker: {
      start: (input) =>
        Effect.sync(() => {
          starts.push(input);
          return {
            projectId: input.projectId,
            cwd: input.destinationPath,
            remoteUrl: input.remoteUrl ?? "",
            repository: null,
          };
        }),
      cancel: () => Effect.succeed(true),
      retry: () => Effect.succeed(true),
      stream: Stream.make([]),
    },
    hooks: { createProject: () => Effect.void, onCloned: () => Effect.void },
  });
  const invoke = (api: typeof read, repository: string) =>
    api.invoke(
      api === read ? "lookupRepository" : "start",
      {
        provider: kind,
        repository,
        ...(api === read ? {} : { title: "Repo", destinationName: "repo", protocol: "https" }),
      },
      context,
      new AbortController().signal,
      {
        callId: "call",
        rootCallerId: "caller",
        callerId: "caller",
        providerId: api.providerId,
        providerGeneration: 1,
        callerGenerations: [],
        principal: {
          kind: "environment-session" as const,
          id: "session",
          environmentId: "env",
          scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
        },
        assertAuthority: async () => {},
      },
    );
  return { read, clone, invoke, calls, starts, probes };
}
const positives = [
  {
    kind: "gitlab",
    hosts: ["https://gitlab.corp:8443"],
    repository: "ssh://git@gitlab.corp:2222/g/p.git",
    result: {
      ...urls("gitlab.corp"),
      url: "https://gitlab.corp:8443/g/p",
      sshUrl: "ssh://git@gitlab.corp:2222/g/p.git",
    },
  },
  {
    kind: "github",
    hosts: ["ghe.corp", "github.com"],
    repository: "github.com/o/n",
    result: urls("github.com"),
  },
  {
    kind: "github",
    hosts: ["ghe.corp", "github.com"],
    repository: "o/n",
    result: urls("github.com"),
  },
  {
    kind: "gitlab",
    hosts: ["first.corp", "gitlab.corp"],
    repository: "gitlab.corp/g/p",
    result: { ...urls("gitlab.corp"), sshUrl: "ssh://git@gitlab.corp:2222/g/p.git" },
  },
  {
    kind: "forgejo",
    hosts: ["http://forgejo.lan:3000"],
    repository: "http://forgejo.lan:3000/o/n",
    result: { ...urls("forgejo.lan"), url: "http://forgejo.lan:3000/o/n" },
  },
  {
    kind: "bitbucket",
    hosts: ["bitbucket.org"],
    repository: "o/n",
    result: { ...urls("bitbucket.org"), url: "https://alex@bitbucket.org/o/n" },
  },
  {
    kind: "azure-devops",
    hosts: ["https://org.visualstudio.com"],
    repository: "https://org.visualstudio.com/o/n",
    result: { ...urls("org.visualstudio.com"), sshUrl: "org@vs-ssh.visualstudio.com:o/n" },
  },
  {
    kind: "azure-devops",
    hosts: ["https://ado.corp"],
    repository: "ado.corp/o/n",
    result: urls("ado.corp"),
  },
  {
    kind: "azure-devops",
    hosts: ["https://org.visualstudio.com"],
    repository: "o/n",
    result: { ...urls("org.visualstudio.com"), sshUrl: "org@vs-ssh.visualstudio.com:o/n" },
  },
  {
    kind: "azure-devops",
    hosts: ["https://ado.corp"],
    repository: "o/n",
    result: urls("ado.corp"),
  },
  {
    kind: "forgejo",
    hosts: ["http://forgejo.lan:3000"],
    repository: "o/n",
    result: { ...urls("forgejo.lan"), url: "http://forgejo.lan:3000/o/n" },
  },
] as const;
it.each(positives)(
  "accepts extension $kind $repository and resolves only once per start",
  async ({ kind, hosts, repository, result }) => {
    for (const operation of ["read", "clone"] as const) {
      const f = fixture(kind, hosts, result);
      const value = await f.invoke(f[operation], repository);
      expect(value).toBeDefined();
      expect(f.calls).toHaveLength(1);
      expect(f.probes).toEqual(repository === "o/n" ? [] : [kind]);
      if (operation === "clone")
        expect(f.starts).toEqual([
          expect.objectContaining({ remoteUrl: result.url.replace("alex@", "") }),
        ]);
      if (repository === "o/n") expect(f.calls[0]).toEqual({ cwd: "/host", repository: "o/n" });
    }
  },
);

it.each(["github", "gitlab", "forgejo", "azure-devops", "bitbucket"] as const)(
  "keeps unconfigured %s host bypasses closed",
  async (kind) => {
    for (const repository of [
      "attacker.tld/o/n",
      "1.2.3.4/o/n",
      "https://attacker.tld/o/n",
      "ssh://attacker.tld/o/n",
      "git@attacker.tld:o/n",
      "github.com.attacker.tld/o/n",
      "github.com./o/n",
      "https://github.com@attacker.tld/o/n",
      "ssh://github.com@attacker.tld/o/n",
      "github.com@attacker.tld:o/n",
      "https://github%2ecom/o/n",
      "https://github.com%2f.attacker.tld/o/n",
      "https://github.com/#@attacker.tld/o/n",
      "https://github.com/?@attacker.tld/o/n",
      "https://gíthub.com/o/n",
      "https://127.1/o/n",
      "https://0x7f.1/o/n",
      "https://[::1]/o/n",
      "//attacker.tld/o/n",
      "o/%2e%2e/n",
      "o//n",
      "git@github.com:o/n://x",
    ]) {
      for (const operation of ["read", "clone"] as const) {
        const f = fixture(kind, ["github.com"], urls("github.com"));
        await expect(f.invoke(f[operation], repository)).rejects.toThrow();
        expect(f.calls).toEqual([]);
        expect(f.starts).toEqual([]);
      }
    }
  },
);

it.each(["github", "gitlab", "forgejo", "azure-devops", "bitbucket"] as const)(
  "validates both %s provider URLs before lookup or clone returns",
  async (kind) => {
    const host = {
      github: "github.com",
      gitlab: "gitlab.com",
      forgejo: "forge.example",
      "azure-devops": "dev.azure.com",
      bitbucket: "bitbucket.org",
    }[kind];
    for (const field of ["url", "sshUrl"] as const)
      for (const remote of [
        "/local/path",
        "file:///x",
        "http://attacker.tld/o/n",
        `http://${host}/o/n`,
        "git://attacker.tld/o/n",
        "ext::sh",
        "fd::3",
        "https://attacker.tld/o/n",
        "https://ssh.dev.azure.com/o/n",
        "git@attacker.tld:o/n",
        "ssh://ho\nst/x",
        "\tssh://host/x",
        "https://host/x\u0000",
        "git@host:x\u0000y",
        "https:host/x",
        "https://host\\@-x/y",
        "-cfoo.x@h:y.z=1",
        "-uX@h:y",
        "ssh://-oProxyCommand=x/y",
        "git@github.com:o/n://x",
      ])
        for (const operation of ["read", "clone"] as const) {
          const f = fixture(kind, [host], { ...urls(host), [field]: remote });
          await expect(f.invoke(f[operation], "o/n")).rejects.toThrow();
          expect(f.calls).toHaveLength(1);
          expect(f.starts).toEqual([]);
        }
  },
);

it.each(["github", "gitlab", "forgejo", "azure-devops", "bitbucket"] as const)(
  "rejects paired attacker clone URLs for an authenticated %s host lookup",
  async (kind) => {
    const trusted = {
      github: "github.com",
      gitlab: "gitlab.com",
      forgejo: "forge.example",
      "azure-devops": "dev.azure.com",
      bitbucket: "bitbucket.org",
    }[kind];
    for (const operation of ["read", "clone"] as const) {
      const f = fixture(kind, [trusted], urls("attacker.tld"));
      await expect(f.invoke(f[operation], `${trusted}/o/n`)).rejects.toThrow();
      expect(f.starts).toEqual([]);
    }
  },
);

it("requires Forgejo's resolved login origin instead of trusting paired response hosts", async () => {
  for (const operation of ["read", "clone"] as const) {
    const f = fixture(
      "forgejo",
      ["http://forgejo.lan:3000"],
      { ...urls("attacker.test"), url: "http://attacker.test/o/n" },
      false,
    );
    await expect(f.invoke(f[operation], "o/n")).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
    expect(f.probes).toEqual([]);
    expect(f.starts).toEqual([]);
  }
});
