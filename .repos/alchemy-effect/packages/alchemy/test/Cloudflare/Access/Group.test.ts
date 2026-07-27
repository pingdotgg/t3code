import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider("create, update rules, and delete group", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const group = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Access.Group("BasicGroup", {
          include: [{ emailDomain: { domain: "example.com" } }],
        });
      }),
    );

    expect(group.groupId).toBeDefined();
    expect(group.accountId).toEqual(accountId);
    expect(group.name).toBeDefined();

    const actual = yield* zeroTrust.getAccessGroupForAccount({
      accountId,
      groupId: group.groupId,
    });
    expect(actual.id).toEqual(group.groupId);
    expect(actual.name).toEqual(group.name);
    expect(actual.include?.length).toEqual(1);

    // Update — add an include arm plus exclude/require rule groups. The
    // group must converge in place (same id).
    const updated = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Access.Group("BasicGroup", {
          include: [
            { emailDomain: { domain: "example.com" } },
            { geo: { countryCode: "US" } },
          ],
          exclude: [{ email: { email: "intern@example.com" } }],
          require: [{ emailDomain: { domain: "example.com" } }],
        });
      }),
    );
    expect(updated.groupId).toEqual(group.groupId);

    const afterUpdate = yield* zeroTrust.getAccessGroupForAccount({
      accountId,
      groupId: group.groupId,
    });
    expect(afterUpdate.include?.length).toEqual(2);
    expect(afterUpdate.exclude?.length).toEqual(1);
    expect(afterUpdate.require?.length).toEqual(1);

    yield* stack.destroy();

    const afterDestroy = yield* zeroTrust
      .getAccessGroupForAccount({ accountId, groupId: group.groupId })
      .pipe(
        Effect.catchTag("AccessGroupNotFound", () => Effect.succeed(undefined)),
      );
    expect(afterDestroy?.id ?? undefined).toBeUndefined();
  }).pipe(logLevel),
);

test.provider("rename updates the group in place", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const group = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Access.Group("RenameGroup", {
          name: "alchemy-test-access-group-rename-a",
          include: [{ everyone: {} }],
        });
      }),
    );
    expect(group.name).toEqual("alchemy-test-access-group-rename-a");

    const renamed = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Access.Group("RenameGroup", {
          name: "alchemy-test-access-group-rename-b",
          include: [{ everyone: {} }],
        });
      }),
    );
    expect(renamed.groupId).toEqual(group.groupId);
    expect(renamed.name).toEqual("alchemy-test-access-group-rename-b");

    const actual = yield* zeroTrust.getAccessGroupForAccount({
      accountId,
      groupId: group.groupId,
    });
    expect(actual.name).toEqual("alchemy-test-access-group-rename-b");

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider("list enumerates the deployed access group", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const group = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Access.Group("ListGroup", {
          include: [{ emailDomain: { domain: "example.com" } }],
        });
      }),
    );

    const provider = yield* Provider.findProvider(Cloudflare.Access.Group);
    const all = yield* provider.list();

    const found = all.find((g) => g.groupId === group.groupId);
    expect(found).toBeDefined();
    expect(found?.accountId).toEqual(group.accountId);
    expect(found?.name).toEqual(group.name);

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider("group can be referenced from an access policy", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const { group, policy } = yield* stack.deploy(
      Effect.gen(function* () {
        const group = yield* Cloudflare.Access.Group("PolicyGroup", {
          include: [{ emailDomain: { domain: "example.com" } }],
        });
        const policy = yield* Cloudflare.Access.Policy("GroupPolicy", {
          decision: "allow",
          include: [{ group: { id: group.groupId } }],
        });
        return { group, policy };
      }),
    );

    const actual = yield* zeroTrust.getAccessPolicy({
      accountId,
      policyId: policy.policyId,
    });
    const includes = (actual.include ?? []) as Array<{
      group?: { id: string };
    }>;
    expect(includes[0]?.group?.id).toEqual(group.groupId);

    yield* stack.destroy();
  }).pipe(logLevel),
);
