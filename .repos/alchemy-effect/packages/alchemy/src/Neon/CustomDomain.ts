import * as Neon from "@distilled.cloud/neon";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

export interface CustomDomainProps {
  /** Target Function. Domain ownership remains independent of Function configuration. */ function: {
    projectId: string;
    branchId: string;
    slug: string;
    url: string;
  };
  /** Public DNS hostname. Register the returned target with a DNS-only CNAME. */ hostname: string;
}
export interface CustomDomainAttributes {
  /** Owning project. */ projectId: string;
  /** Owning branch. */ branchId: string;
  /** Target Function slug. */ slug: string;
  /** Normalized custom hostname. */ hostname: string;
  /** DNS-only CNAME target; returned before DNS activation to avoid dependency cycles. */ cnameTarget: string;
  /** Registration state. This is not an independent HTTPS probe. */ status:
    | string
    | undefined;
  /** DNS/CAA check state. */ dnsStatus: string | undefined;
  /** Internal routing state. */ bindingStatus: string | undefined;
  /** Machine-readable status explanation. */ statusReason: string | undefined;
  /** Custom HTTPS URL; not proof that the certificate is ready. */ url: string;
  /** Native Function URL. */ nativeUrl: string;
}
export interface CustomDomain extends Resource<
  "Neon.CustomDomain",
  CustomDomainProps,
  CustomDomainAttributes,
  never,
  Providers
> {}

/**
 * Register a branch-local custom Function domain without waiting for DNS.
 * A registration does not prove HTTPS works. Publish a DNS-only CNAME, then
 * verify the custom URL separately. Domains are not inherited by child branches.
 *
 * ### Register a Domain
 * **Example:** Obtain DNS configuration
 * ```typescript
 * const domain = yield* Neon.CustomDomain("Domain", { function: api, hostname: "api.example.com" });
 * // Publish domain.cnameTarget as a DNS-only CNAME for domain.hostname.
 * ```
 *
 * @resource
 * @product Function
 */
export const CustomDomain = Resource<CustomDomain>("Neon.CustomDomain");
export class FunctionDomainConflict extends Data.TaggedError(
  "FunctionDomainConflict",
)<{ hostname: string }> {}
const normalize = (value: string) => value.toLowerCase().replace(/\.$/, "");
const scopeOf = (fn: { projectId: string; branchId: string }) => ({
  project_id: fn.projectId,
  branch_id: fn.branchId,
});
const observe = Effect.fn(function* (
  scope: { project_id: string; branch_id: string },
  hostname: string,
) {
  const domains = yield* Neon.listProjectBranchCustomDomains
    .items(scope)
    .pipe(Stream.runCollect);
  return domains.find((domain) => domain.domain === hostname);
});
const attrs = (
  fn: { projectId: string; branchId: string; slug: string; url: string },
  domain: Neon.CustomDomain,
): CustomDomainAttributes => ({
  projectId: fn.projectId,
  branchId: fn.branchId,
  slug: fn.slug,
  hostname: domain.domain,
  cnameTarget: domain.cname_target,
  status: domain.status,
  dnsStatus: domain.dns_status,
  bindingStatus: domain.binding_status,
  statusReason: domain.status_reason,
  url: `https://${domain.domain}`,
  nativeUrl: fn.url,
});
export const CustomDomainProvider = () =>
  Provider.succeed(CustomDomain, {
    stables: ["projectId", "branchId", "slug", "hostname", "url"],
    list: Effect.fn(function* () {
      const result: CustomDomainAttributes[] = [];
      for (const project of yield* Neon.listProjects
        .items({})
        .pipe(Stream.runCollect)) {
        for (const branch of yield* Neon.listProjectBranches
          .items({ project_id: project.id })
          .pipe(Stream.runCollect)) {
          for (const domain of yield* Neon.listProjectBranchCustomDomains
            .items({ project_id: project.id, branch_id: branch.id })
            .pipe(Stream.runCollect)) {
            result.push(
              attrs(
                {
                  projectId: project.id,
                  branchId: branch.id,
                  slug: domain.entity_id,
                  url: "",
                },
                domain,
              ),
            );
          }
        }
      }
      return result;
    }),
    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || !output) return;
      if (
        normalize(news.hostname) !== output.hostname ||
        news.function.projectId !== output.projectId ||
        news.function.branchId !== output.branchId ||
        news.function.slug !== output.slug
      )
        return { action: "replace", deleteFirst: true };
    }),
    read: Effect.fn(function* ({ olds, output }) {
      if (!output && (!olds?.function || !olds.hostname)) return undefined;
      const fn = output ? { ...output, url: output.nativeUrl } : olds!.function;
      const domain = yield* observe(
        scopeOf(fn),
        output?.hostname ?? normalize(olds!.hostname),
      );
      if (!domain) return undefined;
      const result = attrs(fn, domain);
      return output ? result : Unowned(result);
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const scope = scopeOf(news.function);
      const hostname = normalize(news.hostname);
      let domain = yield* observe(scope, hostname);
      if (!domain) {
        yield* Neon.registerProjectBranchCustomDomain({
          ...scope,
          domain: hostname,
          entity_type: "function",
          entity_id: news.function.slug,
        }).pipe(Effect.catchTag("Conflict", () => Effect.void));
        domain = yield* observe(scope, hostname);
      }
      if (
        !domain ||
        domain.entity_type !== "function" ||
        domain.entity_id !== news.function.slug
      )
        return yield* new FunctionDomainConflict({ hostname });
      return attrs(news.function, domain);
    }),
    delete: Effect.fn(function* ({ output }) {
      const scope = scopeOf(output);
      const domain = yield* observe(scope, output.hostname);
      if (!domain) return;
      if (domain.entity_id !== output.slug || domain.entity_type !== "function")
        return yield* new FunctionDomainConflict({ hostname: output.hostname });
      yield* Neon.deleteProjectBranchCustomDomain({
        ...scope,
        domain: output.hostname,
      }).pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
