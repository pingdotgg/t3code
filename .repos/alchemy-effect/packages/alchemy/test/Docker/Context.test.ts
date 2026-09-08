import * as Docker from "@/Docker";
import * as Provider from "@/Provider";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({
  providers: Docker.providers(),
  state: inMemoryState(),
});

test.provider("diff replaces a context when name changes", () =>
  Effect.gen(function* () {
    const contextProvider = yield* Provider.findProvider(Docker.Context);
    const contextDiff = yield* contextProvider.diff!({
      id: "build-context",
      fqn: "build-context",
      instanceId: "instance",
      olds: { name: "old-context", description: "old" },
      news: { name: "new-context", description: "old" },
      oldBindings: [],
      newBindings: [],
      output: {
        id: "old-context",
        name: "old-context",
        description: "old",
        docker: undefined,
      },
    });
    expect(contextDiff).toEqual({ action: "replace", deleteFirst: true });
  }),
);

test.provider("diff updates a context when description changes", () =>
  Effect.gen(function* () {
    const contextProvider = yield* Provider.findProvider(Docker.Context);
    const contextDiff = yield* contextProvider.diff!({
      id: "build-context",
      fqn: "build-context",
      instanceId: "instance",
      olds: {
        name: "build-context",
        description: "old description",
        docker: "host=unix:///var/run/docker.sock",
      },
      news: {
        name: "build-context",
        description: "new description",
        docker: "host=unix:///var/run/docker.sock",
      },
      oldBindings: [],
      newBindings: [],
      output: {
        id: "build-context",
        name: "build-context",
        description: "old description",
        docker: "host=unix:///var/run/docker.sock",
      },
    });
    expect(contextDiff).toEqual({ action: "update" });
  }),
);

test.provider("diff replaces a context when docker endpoint is removed", () =>
  Effect.gen(function* () {
    const contextProvider = yield* Provider.findProvider(Docker.Context);
    const contextDiff = yield* contextProvider.diff!({
      id: "build-context",
      fqn: "build-context",
      instanceId: "instance",
      olds: {
        name: "build-context",
        description: "dev context",
        docker: "host=ssh://user@example.com",
      },
      news: {
        name: "build-context",
        description: "dev context",
      },
      oldBindings: [],
      newBindings: [],
      output: {
        id: "build-context",
        name: "build-context",
        description: "dev context",
        docker: "host=ssh://user@example.com",
      },
    });
    expect(contextDiff).toEqual({ action: "replace", deleteFirst: true });
  }),
);

describe("Docker.Context", { concurrent: false }, () => {
  test.provider("creates a context with description and endpoint", (stack) =>
    Effect.gen(function* () {
      const docker = yield* Docker.Docker;
      const contextName = "alchemy-test-context-create";

      yield* Effect.addFinalizer(() =>
        docker.context.remove(contextName, true).pipe(Effect.ignore),
      );

      const context = yield* stack.deploy(
        Docker.Context("created-context", {
          name: contextName,
          description: "created by alchemy tests",
          docker: "host=unix:///var/run/docker.sock",
        }),
      );

      expect(context.name).toBe(contextName);
      expect(context.id).toBe(contextName);
      expect(context.description).toBe("created by alchemy tests");
      expect(extractDockerHost(context.docker)).toBe(
        "unix:///var/run/docker.sock",
      );
    }),
  );

  test.provider("updates an existing context without replacing it", (stack) =>
    Effect.gen(function* () {
      const contextName = "alchemy-test-context-update";

      const first = yield* stack.deploy(
        Docker.Context("updatable-context", {
          name: contextName,
          description: "v1",
          docker: "host=unix:///var/run/docker.sock",
        }),
      );

      const second = yield* stack.deploy(
        Docker.Context("updatable-context", {
          name: contextName,
          description: "v2",
          docker: "host=unix:///var/run/docker.sock",
        }),
      );

      expect(second.id).toBe(first.id);
      expect(second.name).toBe(first.name);
      expect(second.description).toBe("v2");
      expect(extractDockerHost(second.docker)).toBe(
        "unix:///var/run/docker.sock",
      );
    }),
  );

  test.provider("plans a replace when docker endpoint is cleared", (stack) =>
    Effect.gen(function* () {
      const base = Docker.Context("planned-context", {
        description: "with endpoint",
        docker: "host=ssh://user@example.com",
      });

      const changed = Docker.Context("planned-context", {
        description: "with endpoint",
      });

      yield* stack.deploy(base);
      const plan = yield* stack.plan(changed);
      expect(plan.resources["planned-context"]).toMatchObject({
        action: "replace",
      });
    }),
  );
});

const extractDockerHost = (docker: unknown): string | undefined => {
  if (typeof docker === "string") {
    return docker.startsWith("host=") ? docker.slice("host=".length) : docker;
  }
  if (typeof docker === "object" && docker !== null && "Host" in docker) {
    const host = (docker as { Host?: unknown }).Host;
    return typeof host === "string" ? host : undefined;
  }
  return undefined;
};
