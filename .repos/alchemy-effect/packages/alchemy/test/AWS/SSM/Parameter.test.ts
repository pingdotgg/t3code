import * as AWS from "@/AWS";
import { Parameter } from "@/AWS/SSM";
import * as Test from "@/Test/Alchemy";
import * as ssm from "@distilled.cloud/aws/ssm";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const plain = (
  value: string | Redacted.Redacted<string> | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : typeof value === "string"
      ? value
      : Redacted.value(value);

class ParameterStillExists extends Data.TaggedError("ParameterStillExists")<{
  readonly name: string;
}> {}

const assertParameterDeleted = (name: string) =>
  ssm.getParameter({ Name: name }).pipe(
    Effect.flatMap(() => Effect.fail(new ParameterStillExists({ name }))),
    Effect.catchTag("ParameterNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "ParameterStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

test.provider(
  "create, update value, update tags, delete String parameter",
  (stack) =>
    Effect.gen(function* () {
      // reconcile away any prior partial/crashed deployment
      yield* stack.destroy();

      const parameter = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Parameter("ConfigParam", {
            value: "v1",
            description: "test config value",
            tags: { Environment: "test" },
          });
        }),
      );

      expect(parameter.parameterName).toBeDefined();
      expect(parameter.parameterArn).toContain(":parameter/");
      expect(parameter.type).toBe("String");
      expect(parameter.version).toBe(1);
      expect(parameter.keyArn).toBeUndefined();

      // out-of-band verification via distilled
      const created = yield* ssm.getParameter({
        Name: parameter.parameterName,
      });
      expect(plain(created.Parameter?.Value)).toBe("v1");
      expect(created.Parameter?.Type).toBe("String");

      // update the value (new version) and add a tag
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Parameter("ConfigParam", {
            value: "v2",
            description: "test config value",
            tags: { Environment: "test", Extra: "1" },
          });
        }),
      );
      expect(updated.parameterName).toBe(parameter.parameterName);
      expect(updated.version).toBeGreaterThan(parameter.version);

      const afterUpdate = yield* ssm.getParameter({
        Name: parameter.parameterName,
      });
      expect(plain(afterUpdate.Parameter?.Value)).toBe("v2");

      const tags = yield* ssm.listTagsForResource({
        ResourceType: "Parameter",
        ResourceId: parameter.parameterName,
      });
      const tagRecord = Object.fromEntries(
        (tags.TagList ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(tagRecord.Environment).toBe("test");
      expect(tagRecord.Extra).toBe("1");
      expect(tagRecord["alchemy::id"]).toBe("ConfigParam");

      // no-op deploy converges without bumping the version
      const noop = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Parameter("ConfigParam", {
            value: "v2",
            description: "test config value",
            tags: { Environment: "test", Extra: "1" },
          });
        }),
      );
      expect(noop.version).toBe(updated.version);

      // remove a tag
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Parameter("ConfigParam", {
            value: "v2",
            description: "test config value",
            tags: { Environment: "test" },
          });
        }),
      );
      const afterTagRemoval = yield* ssm.listTagsForResource({
        ResourceType: "Parameter",
        ResourceId: parameter.parameterName,
      });
      const remaining = Object.fromEntries(
        (afterTagRemoval.TagList ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(remaining.Extra).toBeUndefined();
      expect(remaining.Environment).toBe("test");

      yield* stack.destroy();
      yield* assertParameterDeleted(parameter.parameterName);
    }),
  { timeout: 120_000 },
);

test.provider(
  "SecureString parameter lifecycle",
  (stack) =>
    Effect.gen(function* () {
      // reconcile away any prior partial/crashed deployment
      yield* stack.destroy();

      const parameter = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Parameter("SecureParam", {
            type: "SecureString",
            value: Redacted.make("super-secret-v1"),
          });
        }),
      );

      expect(parameter.type).toBe("SecureString");
      expect(parameter.keyArn).toContain(":key/");

      const decrypted = yield* ssm.getParameter({
        Name: parameter.parameterName,
        WithDecryption: true,
      });
      expect(plain(decrypted.Parameter?.Value)).toBe("super-secret-v1");
      expect(decrypted.Parameter?.Type).toBe("SecureString");

      // rotate the value
      const rotated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Parameter("SecureParam", {
            type: "SecureString",
            value: Redacted.make("super-secret-v2"),
          });
        }),
      );
      expect(rotated.version).toBeGreaterThan(parameter.version);
      const afterRotate = yield* ssm.getParameter({
        Name: parameter.parameterName,
        WithDecryption: true,
      });
      expect(plain(afterRotate.Parameter?.Value)).toBe("super-secret-v2");

      yield* stack.destroy();
      yield* assertParameterDeleted(parameter.parameterName);
    }),
  { timeout: 120_000 },
);

test.provider(
  "type change String -> SecureString updates in place",
  (stack) =>
    Effect.gen(function* () {
      // reconcile away any prior partial/crashed deployment
      yield* stack.destroy();

      const parameter = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Parameter("TypeChangeParam", {
            value: "plain-value",
          });
        }),
      );
      expect(parameter.type).toBe("String");

      const upgraded = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Parameter("TypeChangeParam", {
            type: "SecureString",
            value: Redacted.make("now-encrypted"),
          });
        }),
      );

      // same physical parameter — updated in place via Overwrite, not replaced
      expect(upgraded.parameterName).toBe(parameter.parameterName);
      expect(upgraded.type).toBe("SecureString");
      expect(upgraded.keyArn).toContain(":key/");

      const observed = yield* ssm.getParameter({
        Name: parameter.parameterName,
        WithDecryption: true,
      });
      expect(observed.Parameter?.Type).toBe("SecureString");
      expect(plain(observed.Parameter?.Value)).toBe("now-encrypted");

      yield* stack.destroy();
      yield* assertParameterDeleted(parameter.parameterName);
    }),
  { timeout: 120_000 },
);

test.provider(
  "custom hierarchical name and replacement on rename",
  (stack) =>
    Effect.gen(function* () {
      // reconcile away any prior partial/crashed deployment
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Parameter("PathParam", {
            name: "/alchemy-test/ssm/path-param-a",
            value: "a",
          });
        }),
      );
      expect(first.parameterName).toBe("/alchemy-test/ssm/path-param-a");
      expect(first.parameterArn).toContain(
        ":parameter/alchemy-test/ssm/path-param-a",
      );

      // renaming triggers a replacement: new physical parameter, old one gone
      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Parameter("PathParam", {
            name: "/alchemy-test/ssm/path-param-b",
            value: "b",
          });
        }),
      );
      expect(second.parameterName).toBe("/alchemy-test/ssm/path-param-b");

      const observed = yield* ssm.getParameter({
        Name: "/alchemy-test/ssm/path-param-b",
      });
      expect(plain(observed.Parameter?.Value)).toBe("b");
      yield* assertParameterDeleted("/alchemy-test/ssm/path-param-a");

      yield* stack.destroy();
      yield* assertParameterDeleted("/alchemy-test/ssm/path-param-b");
    }),
  { timeout: 120_000 },
);
