import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { testName } from "../../names.ts";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

test.provider(
  "create and delete basic allow policy",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const policy = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.Policy("BasicAllowPolicy", {
            decision: "allow",
            include: [{ emailDomain: { domain: "example.com" } }],
          });
        }),
      );

      expect(policy.policyId).toBeDefined();
      expect(policy.decision).toEqual("allow");
      expect(policy.accountId).toEqual(accountId);

      const actual = yield* zeroTrust.getAccessPolicy({
        accountId,
        policyId: policy.policyId,
      });
      expect(actual.id).toEqual(policy.policyId);
      expect(actual.decision).toEqual("allow");
      expect(actual.include?.length).toEqual(1);

      yield* stack.destroy();

      const afterDestroy = yield* zeroTrust
        .getAccessPolicy({ accountId, policyId: policy.policyId })
        .pipe(Effect.catch(() => Effect.succeed(undefined)));
      expect(afterDestroy).toBeUndefined();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:access", "live"] },
);

test.provider(
  "update mutates includes without replacing",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.Policy("UpdatePolicy", {
            decision: "allow",
            include: [{ emailDomain: { domain: "example.com" } }],
            adopt: true,
          });
        }),
      );

      expect(initial.policyId).toBeDefined();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.Policy("UpdatePolicy", {
            decision: "allow",
            include: [
              { emailDomain: { domain: "example.com" } },
              { emailDomain: { domain: "test.example.com" } },
            ],
            adopt: true,
          });
        }),
      );

      expect(updated.policyId).toEqual(initial.policyId);

      const actual = yield* zeroTrust.getAccessPolicy({
        accountId,
        policyId: updated.policyId,
      });
      expect(actual.include?.length).toEqual(2);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:access", "live"] },
);

test.provider(
  "adopts an out-of-band reusable policy",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = testName("alchemy-access-policy-adopt-test");

      yield* stack.destroy();

      // Pre-create the policy out of band so adoption has something to find.
      const preExisting = yield* zeroTrust.createAccessPolicy({
        accountId,
        name,
        decision: "allow",
        include: [{ emailDomain: { domain: "example.com" } }],
      });
      expect(preExisting.id).toBeDefined();

      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.Policy("AdoptPolicy", {
            name,
            decision: "allow",
            include: [{ emailDomain: { domain: "example.com" } }],
            adopt: true,
          });
        }),
      );

      expect(adopted.policyId).toEqual(preExisting.id);
      expect(adopted.accountId).toEqual(accountId);

      yield* stack.destroy();

      const afterDestroy = yield* zeroTrust
        .getAccessPolicy({ accountId, policyId: preExisting.id! })
        .pipe(Effect.catch(() => Effect.succeed(undefined)));
      expect(afterDestroy).toBeUndefined();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:access", "live"] },
);

test.provider(
  "list enumerates the deployed reusable policy",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const policy = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.Policy("ListPolicy", {
            decision: "allow",
            include: [{ emailDomain: { domain: "example.com" } }],
          });
        }),
      );

      const provider = yield* Provider.findProvider(Cloudflare.Access.Policy);
      const all = yield* provider.list();

      const match = all.find((p) => p.policyId === policy.policyId);
      expect(match).toBeDefined();
      expect(match?.accountId).toEqual(accountId);
      expect(match?.decision).toEqual("allow");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:access", "live"] },
);

test.provider(
  "connection rules and approval settings round-trip through create and update",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const deploy = (usernames: string[]) =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Access.Policy("SshPolicy", {
              decision: "allow",
              include: [{ emailDomain: "example.com" }],
              connectionRules: {
                ssh: { usernames, allowEmailAlias: true },
                rdp: { allowedClipboardLocalToRemoteFormats: ["text"] },
              },
              isolationRequired: false,
              purposeJustificationRequired: true,
              purposeJustificationPrompt: "Why do you need access?",
            });
          }),
        );

      const created = yield* deploy(["root"]);
      const live1 = yield* zeroTrust.getAccessPolicy({
        accountId,
        policyId: created.policyId,
      });
      expect(live1.connectionRules?.ssh?.usernames).toEqual(["root"]);
      expect(live1.connectionRules?.ssh?.allowEmailAlias).toBe(true);
      expect(live1.connectionRules?.rdp?.allowedClipboardLocalToRemoteFormats).toEqual(["text"]);
      expect(live1.purposeJustificationPrompt).toEqual("Why do you need access?");

      const updated = yield* deploy(["root", "ubuntu"]);
      expect(updated.policyId).toEqual(created.policyId);
      const live2 = yield* zeroTrust.getAccessPolicy({
        accountId,
        policyId: updated.policyId,
      });
      expect(live2.connectionRules?.ssh?.usernames).toEqual(["root", "ubuntu"]);
      expect(live2.purposeJustificationRequired).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:access", "live"] },
);

test.provider(
  "adopted policy keeps the live fields it does not declare",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = `alchemy-access-policy-preserve-test-${stack.stage}`;

      yield* stack.destroy();

      const existing = yield* zeroTrust.createAccessPolicy({
        accountId,
        name,
        decision: "allow",
        include: [{ emailDomain: { domain: "example.com" } }],
        exclude: [{ email: { email: "intern@example.com" } }],
        require: [{ geo: { countryCode: "US" } }],
        approvalRequired: true,
        approvalGroups: [{ approvalsNeeded: 1, emailAddresses: ["lead@example.com"] }],
        purposeJustificationRequired: true,
        purposeJustificationPrompt: "Ticket number?",
        connectionRules: {
          ssh: { usernames: ["root", "ubuntu"], allowEmailAlias: true },
          rdp: { allowedClipboardLocalToRemoteFormats: ["text"] },
        },
      });

      const deploy = (props: Partial<Cloudflare.Access.PolicyProps>) =>
        stack.deploy(
          Cloudflare.Access.Policy("PreservePolicy", {
            name,
            decision: "allow",
            include: [{ emailDomain: "example.com" }],
            adopt: true,
            ...props,
          }),
        );
      const live = () => zeroTrust.getAccessPolicy({ accountId, policyId: existing.id! });

      // Only sessionDuration is declared; every other live field survives the PUT.
      const adopted = yield* deploy({ sessionDuration: "12h" });
      expect(adopted.policyId).toEqual(existing.id);
      const kept = yield* live();
      expect(kept.sessionDuration).toEqual("12h");
      expect(kept.exclude).toEqual([{ email: { email: "intern@example.com" } }]);
      expect(kept.require).toEqual([{ geo: { countryCode: "US" } }]);
      expect(kept.approvalRequired).toBe(true);
      expect(kept.approvalGroups?.[0]?.emailAddresses).toEqual(["lead@example.com"]);
      expect(kept.purposeJustificationRequired).toBe(true);
      expect(kept.purposeJustificationPrompt).toEqual("Ticket number?");
      expect(kept.connectionRules?.ssh?.usernames).toEqual(["root", "ubuntu"]);
      expect(kept.connectionRules?.ssh?.allowEmailAlias).toBe(true);
      expect(kept.connectionRules?.rdp?.allowedClipboardLocalToRemoteFormats).toEqual(["text"]);

      // Explicit `[]` / `false` still clear.
      yield* deploy({ sessionDuration: "12h", require: [], approvalRequired: false });
      const cleared = yield* live();
      expect(cleared.require ?? []).toEqual([]);
      expect(cleared.approvalRequired ?? false).toBe(false);
      expect(cleared.exclude).toEqual([{ email: { email: "intern@example.com" } }]);

      yield* stack.destroy();

      const afterDestroy = yield* live().pipe(Effect.catch(() => Effect.succeed(undefined)));
      expect(afterDestroy).toBeUndefined();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:access", "live"] },
);
