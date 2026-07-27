import { adopt } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as pages from "@distilled.cloud/cloudflare/pages";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// Deterministic per-test names (never derived from Date.now() or
// randomness). Each test owns disjoint identifiers so reruns never collide.
const PROJECT_CRUD = "alchemy-e3-pages-dom-crud";
const PROJECT_REPLACE = "alchemy-e3-pages-dom-repl";
const PROJECT_LIST = "alchemy-e3-pages-dom-list";
const DOMAIN_LIST = `alchemy-pages-list.${zoneName}`;
const DOMAIN_CRUD = `alchemy-pages-crud.${zoneName}`;
const DOMAIN_REPLACE_A = `alchemy-pages-replace-a.${zoneName}`;
const DOMAIN_REPLACE_B = `alchemy-pages-replace-b.${zoneName}`;

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips (`Forbidden`,
// declared in the distilled error union) on the test's own out-of-band
// verification calls.
const forbiddenRetry = {
  while: (e: { _tag: string }) => e._tag === "Forbidden",
  schedule: Schedule.exponential("500 millis"),
  times: 8,
} as const;

const getDomain = (
  accountId: string,
  projectName: string,
  domainName: string,
) =>
  pages
    .getProjectDomain({ accountId, projectName, domainName })
    .pipe(Effect.retry(forbiddenRetry));

// Attaching a domain is asynchronous: the attachment, its zone tag and
// validation/verification blocks propagate across Cloudflare's edge a beat
// after `create` returns. Poll `getProjectDomain` with a bounded schedule,
// riding out the brief `PagesDomainNotFound` window, until the domain is
// observable with a status. We assert reachability — NOT a terminal `active`
// status, since certificate issuance needs a real CNAME and stays pending.
const waitForDomain = (
  accountId: string,
  projectName: string,
  domainName: string,
) =>
  pages.getProjectDomain({ accountId, projectName, domainName }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden" || e._tag === "PagesDomainNotFound",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

const expectDomainGone = (
  accountId: string,
  projectName: string,
  domainName: string,
) =>
  getDomain(accountId, projectName, domainName).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "DomainNotDeleted" } as const)),
    // A detached domain surfaces as `PagesDomainNotFound` (code 8000021);
    // if the whole project is gone the API reports `ProjectNotFound`
    // (code 8000007). Both mean the attachment no longer exists.
    Effect.catchTag("PagesDomainNotFound", () => Effect.void),
    Effect.catchTag("ProjectNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "DomainNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

// Purge leftovers from interrupted runs so deterministically-named tests
// start from a clean slate (deleting the project detaches its domains).
const purgeProject = (accountId: string, projectName: string) =>
  pages.deleteProject({ accountId, projectName }).pipe(
    Effect.catchTag("ProjectNotFound", () => Effect.void),
    Effect.retry(forbiddenRetry),
  );

test.provider("attach and detach a custom domain", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();
    yield* purgeProject(accountId, PROJECT_CRUD);

    const { project, domain } = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Cloudflare.Pages.Project("DomainCrudProject", {
          name: PROJECT_CRUD,
        }).pipe(adopt(true));
        const domain = yield* Cloudflare.Pages.Domain("CrudDomain", {
          projectName: project.name,
          name: DOMAIN_CRUD,
        }).pipe(adopt(true));
        return { project, domain };
      }),
    );

    expect(domain.domainId).toBeDefined();
    expect(domain.accountId).toEqual(accountId);
    expect(domain.projectName).toEqual(project.name);
    expect(domain.name).toEqual(DOMAIN_CRUD);
    // Certificate issuance is asynchronous — the domain legitimately stays
    // `initializing`/`pending` (the cert authority, validation/verification
    // blocks and zone tag fill in over time). This test exercises CRUD, not
    // certificate issuance, so only assert the attachment exists with a
    // status, never a terminal `active`.
    expect(domain.status).toBeTruthy();
    expect(domain.createdOn).toBeTruthy();

    // The attachment propagates a beat after `create` returns — poll until
    // it is observable rather than asserting it is immediately readable.
    const live = yield* waitForDomain(accountId, project.name, DOMAIN_CRUD);
    expect(live.domainId).toEqual(domain.domainId);
    expect(live.name).toEqual(DOMAIN_CRUD);
    expect(live.status).toBeTruthy();

    // Redeploying identical props is a no-op (same attachment).
    const noop = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Cloudflare.Pages.Project("DomainCrudProject", {
          name: PROJECT_CRUD,
        }).pipe(adopt(true));
        const domain = yield* Cloudflare.Pages.Domain("CrudDomain", {
          projectName: project.name,
          name: DOMAIN_CRUD,
        }).pipe(adopt(true));
        return { project, domain };
      }),
    );
    expect(noop.domain.domainId).toEqual(domain.domainId);

    yield* stack.destroy();

    yield* expectDomainGone(accountId, PROJECT_CRUD, DOMAIN_CRUD);
  }).pipe(
    logLevel,
    // Guarantee teardown even if an assertion throws mid-test, so a failed
    // run never leaves a dangling Pages.Domain / Pages.Project behind.
    // `stack.destroy()` tears down everything in the scratch stack (domain
    // then project); the next run's start-of-test purge is the backstop.
    Effect.ensuring(stack.destroy().pipe(Effect.ignore)),
  ),
);

test.provider("changing the domain name triggers replacement", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();
    yield* purgeProject(accountId, PROJECT_REPLACE);

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Cloudflare.Pages.Project("DomainReplProject", {
          name: PROJECT_REPLACE,
        }).pipe(adopt(true));
        const domain = yield* Cloudflare.Pages.Domain("ReplaceDomain", {
          projectName: project.name,
          name: DOMAIN_REPLACE_A,
        }).pipe(adopt(true));
        return domain;
      }),
    );

    expect(initial.name).toEqual(DOMAIN_REPLACE_A);

    const replaced = yield* stack.deploy(
      Effect.gen(function* () {
        const project = yield* Cloudflare.Pages.Project("DomainReplProject", {
          name: PROJECT_REPLACE,
        }).pipe(adopt(true));
        const domain = yield* Cloudflare.Pages.Domain("ReplaceDomain", {
          projectName: project.name,
          name: DOMAIN_REPLACE_B,
        }).pipe(adopt(true));
        return domain;
      }),
    );

    // The domain name is the attachment's identity — a new physical
    // attachment exists.
    expect(replaced.domainId).not.toEqual(initial.domainId);
    expect(replaced.name).toEqual(DOMAIN_REPLACE_B);

    // The old domain was detached as part of the replacement.
    yield* expectDomainGone(accountId, PROJECT_REPLACE, DOMAIN_REPLACE_A);

    const live = yield* getDomain(accountId, PROJECT_REPLACE, DOMAIN_REPLACE_B);
    expect(live.domainId).toEqual(replaced.domainId);

    yield* stack.destroy();

    yield* expectDomainGone(accountId, PROJECT_REPLACE, DOMAIN_REPLACE_B);
  }).pipe(logLevel),
);

// Canonical `list()` test (parent fan-out): domains have no account-wide
// enumeration API, so `list()` enumerates every Pages project and lists each
// project's domains. Deploy a project + domain, then assert the attachment
// appears in the exhaustively-paginated result with its full `read`
// Attributes shape.
//
// SKIP-GATED on a distilled schema bug: `pages.listProjects` fails to decode
// the live response with
//   CloudflareHttpError { status: 200, statusText: "Schema decode failed" }
// because `ListProjectsResponse.result[].canonicalDeployment` and
// `.latestDeployment` declare `source` as a *required* `Schema.Struct`
// (pages.ts ~1540 / ~2002), but Cloudflare omits `source` on deployment
// objects. NEEDED PATCH: make `source` optional/nullable on both deployment
// shapes in the `listProjects` response schema, regenerate the `pages`
// service, then drop this gate. Re-enable with CLOUDFLARE_TEST_PAGES_LIST=1.
test.provider.skipIf(!process.env.CLOUDFLARE_TEST_PAGES_LIST)(
  "list enumerates domains across all Pages projects",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();
      yield* purgeProject(accountId, PROJECT_LIST);

      const { domain } = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Cloudflare.Pages.Project("DomainListProject", {
            name: PROJECT_LIST,
          }).pipe(adopt(true));
          const domain = yield* Cloudflare.Pages.Domain("ListDomain", {
            projectName: project.name,
            name: DOMAIN_LIST,
          }).pipe(adopt(true));
          return { domain };
        }),
      );

      const provider = yield* Provider.findProvider(Cloudflare.Pages.Domain);
      const all = yield* provider.list();

      const found = all.find((d) => d.domainId === domain.domainId);
      expect(found).toBeDefined();
      expect(found?.name).toEqual(DOMAIN_LIST);
      expect(found?.projectName).toEqual(PROJECT_LIST);
      expect(found?.accountId).toEqual(accountId);

      yield* stack.destroy();

      yield* expectDomainGone(accountId, PROJECT_LIST, DOMAIN_LIST);
    }).pipe(logLevel),
);
