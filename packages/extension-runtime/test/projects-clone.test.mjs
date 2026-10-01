import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { createApiBroker } from "../dist/broker.js";
import { projectsCloneApi, sourceControlDiscoveryApi } from "@t3tools/extension-sdk/catalogue";

NodeTest.test(
  "VCS mutate permission never grants project creation or source-control discovery",
  async () => {
    let calls = 0;
    const record = {
      id: "fixture.consumer",
      contentHash: "a".repeat(64),
      enabled: true,
      grants: { capabilities: ["t3.vcs/mutate"], projectIds: ["project"] },
      package: {
        format: 3,
        manifest: { id: "fixture.consumer", version: "1.0.0", apiVersion: 1, surfaces: [] },
        tools: [],
        provides: [],
        requires: [projectsCloneApi, sourceControlDiscoveryApi].map((api) => ({
          id: api.definition.id,
          versionRange: "^1.0.0",
        })),
        dependencies: [],
      },
    };
    const broker = createApiBroker({
      installations: () => [record],
      providers: [projectsCloneApi, sourceControlDiscoveryApi].map((api) => ({
        providerId:
          api === projectsCloneApi ? "host.projects-clone" : "host.source-control-discovery",
        definition: api.definition,
        invoke: () => {
          calls++;
          return {};
        },
      })),
      selections: () => [],
      authorize: (_record, grant) => record.grants.capabilities.includes(grant),
      environmentId: "env",
      invokeWorker: () => {
        throw new Error("unexpected worker");
      },
      audit: () => {},
    });
    const context = {
      resource: {
        namespace: "fixture.consumer",
        id: "view",
        environmentId: "env",
        projectId: "project",
      },
      client: "test",
    };
    const signal = new AbortController().signal;
    await NodeAssert.rejects(
      () =>
        broker.invoke(
          record,
          {
            id: projectsCloneApi.definition.id,
            versionRange: "^1.0.0",
            method: "start",
            input: { title: "Repo", destinationName: "repo", remoteUrl: "https://host/repo.git" },
            context,
          },
          signal,
        ),
      /API capability denied: t3\.projects\/create/,
    );
    await NodeAssert.rejects(
      () =>
        broker.invoke(
          record,
          {
            id: sourceControlDiscoveryApi.definition.id,
            versionRange: "^1.0.0",
            method: "discover",
            input: {},
            context,
          },
          signal,
        ),
      /API capability denied: t3\.source-control\/read/,
    );
    NodeAssert.equal(calls, 0);
  },
);

NodeTest.test(
  "explicit project-create and source-control-read grants reach only their host APIs",
  async () => {
    const calls = [];
    const record = {
      id: "fixture.consumer",
      contentHash: "b".repeat(64),
      enabled: true,
      grants: {
        capabilities: ["t3.projects/create", "t3.source-control/read"],
        projectIds: ["project"],
      },
      package: {
        format: 3,
        manifest: { id: "fixture.consumer", version: "1.0.0", apiVersion: 1, surfaces: [] },
        tools: [],
        provides: [],
        requires: [projectsCloneApi, sourceControlDiscoveryApi].map((api) => ({
          id: api.definition.id,
          versionRange: "^1.0.0",
        })),
        dependencies: [],
      },
    };
    const receipt = {
      projectId: "created",
      cwd: "/managed/repo",
      remoteUrl: "https://host/repo.git",
      repository: null,
    };
    const broker = createApiBroker({
      installations: () => [record],
      selections: () => [],
      environmentId: "env",
      providers: [projectsCloneApi, sourceControlDiscoveryApi].map((api) => ({
        providerId:
          api === projectsCloneApi ? "host.projects-clone" : "host.source-control-discovery",
        definition: api.definition,
        requiresRootAuthority: true,
        invoke: (method) => {
          calls.push(method);
          return method === "start" ? receipt : { providers: [] };
        },
      })),
      authorize: (installation, grant) => installation.grants.capabilities.includes(grant),
      invokeWorker: () => {
        throw new Error("unexpected worker");
      },
    });
    const context = {
      resource: {
        namespace: "fixture.consumer",
        id: "view",
        environmentId: "env",
        projectId: "project",
      },
      client: "test",
    };
    const root = {
      principal: {
        kind: "environment-session",
        id: "session",
        environmentId: "env",
        scopes: ["orchestration:read", "orchestration:operate"],
      },
      allowWrite: true,
      revalidate: () => {},
    };
    const signal = new AbortController().signal;
    NodeAssert.deepEqual(
      await broker.invoke(
        record,
        {
          id: projectsCloneApi.definition.id,
          versionRange: "^1.0.0",
          method: "start",
          input: { title: "Repo", destinationName: "repo", remoteUrl: receipt.remoteUrl },
          context,
        },
        signal,
        undefined,
        root,
      ),
      receipt,
    );
    NodeAssert.deepEqual(
      await broker.invoke(
        record,
        {
          id: sourceControlDiscoveryApi.definition.id,
          versionRange: "^1.0.0",
          method: "discover",
          input: {},
          context,
        },
        signal,
        undefined,
        root,
      ),
      { providers: [] },
    );
    NodeAssert.deepEqual(calls, ["start", "discover"]);
  },
);
