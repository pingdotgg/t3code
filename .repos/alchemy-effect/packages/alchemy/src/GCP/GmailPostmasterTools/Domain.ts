import * as gmailpostmastertools from "@distilled.cloud/gcp/gmailpostmastertools_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  domainIdOf,
  getDomain,
  ignoreMissing,
  isAlchemyDomain,
  listOwnedDomains,
  sameText,
  toDomainName,
  toGeneratedDomainId,
} from "./internal.ts";

export type DomainProps = {
  /**
   * Fully qualified domain name registered with Postmaster Tools
   * (`mail.example.com`). If omitted, a unique `alchemy-*.example.com`
   * name is generated from the stack, stage, and logical id. Immutable —
   * changing it replaces the domain. Domains have no labels field, so
   * Alchemy stamps ownership into the generated name prefix for
   * `list` / nuke.
   */
  domainId?: string;
  /**
   * DNS verification method. When set, reconcile calls `domains.verify`
   * if the domain is not already `VERIFIED`. Requires the matching TXT
   * or CNAME record.
   */
  verificationMethod?:
    | gmailpostmastertools.VerifyDomainRequestVerificationMethodEnum
    | (string & {});
};

export type Domain = Resource<
  "GCP.GmailPostmasterTools.Domain",
  DomainProps,
  {
    /** Full resource name `domains/{domain}`. */
    name: string;
    /** Fully qualified domain name. */
    domainId: string;
    /** Project id used when the domain was reconciled. */
    project: string;
    /** Caller's permission on the domain. */
    permission: string | undefined;
    /** Domain ownership verification state. */
    verificationState: string | undefined;
    /** RFC3339 time the domain was added. */
    createTime: string | undefined;
    /** RFC3339 time the domain was last verified. */
    lastVerifyTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Gmail Postmaster Tools domain.
 *
 * Domains have no labels or description, so identity is the FQDN and
 * `list` / nuke returns names whose first label starts with `alchemy-`.
 * There is nothing mutable beyond identity except optional DNS
 * verification. Changing `domainId` replaces the domain.
 *
 * ### Creating a Domain
 * **Example:** Generated domain
 * ```typescript
 * const domain = yield* GCP.GmailPostmasterTools.Domain("Mail", {});
 * ```
 *
 * **Example:** Explicit domain
 * ```typescript
 * const domain = yield* GCP.GmailPostmasterTools.Domain("Mail", {
 *   domainId: "mail.example.com",
 * });
 * ```
 *
 * ### Verifying a Domain
 * **Example:** Verify with a TXT record
 * ```typescript
 * const domain = yield* GCP.GmailPostmasterTools.Domain("Mail", {
 *   domainId: "mail.example.com",
 *   verificationMethod: "TXT",
 * });
 * ```
 *
 * @resource
 * @category Gmail Postmaster Tools
 */
export const Domain = Resource<Domain>("GCP.GmailPostmasterTools.Domain");

export class DomainNotResolved extends Data.TaggedError(
  "GCP.GmailPostmasterTools.DomainNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (
  domain: gmailpostmastertools.Domain,
  project: string,
  fallbackId?: string,
) => {
  const name = domain.name ?? (fallbackId ? toDomainName(fallbackId) : "");
  return {
    name,
    domainId: domainIdOf(name) || fallbackId || "",
    project,
    permission: domain.permission,
    verificationState: domain.verificationState,
    createTime: domain.createTime,
    lastVerifyTime: domain.lastVerifyTime,
  };
};

export const DomainProvider = () =>
  Provider.succeed(Domain, {
    stables: ["name", "domainId", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previous = olds?.domainId ?? output?.domainId;
      if (
        previous !== undefined &&
        news.domainId !== undefined &&
        domainIdOf(news.domainId) !== domainIdOf(previous)
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const domainId = olds?.domainId ?? output?.domainId ?? "";
      const name = toDomainName(output?.name || domainId);
      const existing = yield* getDomain(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, domainId);
      return output !== undefined || isAlchemyDomain(existing.name)
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const domains = yield* listOwnedDomains();
        return domains.map((domain) => toAttrs(domain, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const domainId = yield* toGeneratedDomainId(
        id,
        news.domainId,
        output?.domainId,
      );
      const name = toDomainName(domainId);

      let current = yield* getDomain(output?.name || name);

      if (current === undefined) {
        const created = yield* gmailpostmastertools
          .createDomains({ body: { domainId } })
          .pipe(Effect.catchTag("Conflict", () => getDomain(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new DomainNotResolved({ name });
      }

      const resourceName = current.name ?? name;
      if (
        news.verificationMethod !== undefined &&
        !sameText(current.verificationState, "VERIFIED")
      ) {
        yield* gmailpostmastertools.verifyDomains({
          name: resourceName,
          body: { verificationMethod: news.verificationMethod },
        });
        current = (yield* getDomain(resourceName)) ?? current;
      }

      return toAttrs(current, env.project, domainId);
    }),

    delete: Effect.fn(function* ({ output }) {
      const name = output.name || toDomainName(output.domainId);
      if (name.length === 0) return;
      yield* ignoreMissing(
        gmailpostmastertools.deleteDomains({ name }).pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            schedule: Schedule.spaced("1 second"),
            times: 8,
          }),
        ),
      );
    }),
  });
