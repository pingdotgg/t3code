import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  hasIamMembership,
  revokeIamMembership,
  updateIamMembership,
  type GcpIamResourceKind,
} from "../IamPolicy.ts";
import type { Providers } from "../Providers.ts";

export type MemberProps = {
  /**
   * Kind of resource whose IAM policy receives the member, e.g.
   * `run.service`, `pubsub.topic`, `storage.bucket`, or `project`.
   * Changing it replaces the grant.
   */
  kind: GcpIamResourceKind;
  /**
   * Full resource name (`projects/p/locations/l/services/s`), a bucket name
   * for `storage.bucket`, or a project id for `project`. Changing it
   * replaces the grant.
   */
  name: string;
  /** Role to grant, e.g. `roles/run.invoker`. Changing it replaces the grant. */
  role: string;
  /**
   * Principal, e.g. `serviceAccount:x@p.iam.gserviceaccount.com`. A bare
   * email is treated as a service account. Changing it replaces the grant.
   */
  member: string;
};

/**
 * One `role` → `member` edge on a single resource's IAM policy — the GCP
 * analog of a Terraform `google_*_iam_member`. Only this edge is managed:
 * other members of the role, other roles, and conditional bindings are
 * left alone. Updates are etag-guarded and retried on concurrent writes.
 *
 * Event sources use it to let a push identity invoke its Cloud Run host.
 *
 * ### Granting a role
 * **Example:** Let a service account invoke a Cloud Run service
 * ```typescript
 * yield* GCP.IAM.Member("Invoker", {
 *   kind: "run.service",
 *   name: service.name,
 *   role: "roles/run.invoker",
 *   member: Output.interpolate`serviceAccount:${caller.email}`,
 * });
 * ```
 *
 * @resource
 * @category IAM
 */
export type Member = Resource<
  "GCP.IAM.Member",
  MemberProps,
  MemberProps,
  never,
  Providers
>;

export const Member = Resource<Member>("GCP.IAM.Member");

export const MemberProvider = () =>
  Provider.succeed(Member, {
    stables: ["kind", "name", "role", "member"],

    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news) || olds === undefined) return undefined;
      const changed =
        news.kind !== olds.kind ||
        news.name !== olds.name ||
        news.role !== olds.role ||
        news.member !== olds.member;
      return changed
        ? { action: "replace" as const, deleteFirst: false }
        : undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const props = output ?? olds;
      if (props === undefined) return undefined;
      const present = yield* hasIamMembership(props);
      return present ? { ...props } : undefined;
    }),

    reconcile: Effect.fn(function* ({ news }) {
      yield* updateIamMembership({
        kind: news.kind,
        name: news.name,
        member: news.member,
        add: [news.role],
      });
      return { ...news };
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* revokeIamMembership({
        kind: output.kind,
        name: output.name,
        member: output.member,
        roles: [output.role],
      });
    }),
  });
