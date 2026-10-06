import * as iam from "@distilled.cloud/gcp/unstable/iam_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  ALCHEMY_HOST_SA_DISPLAY_NAME,
  deleteHostServiceAccount,
  hostServiceAccountEmail,
} from "../Host.ts";
import type { Providers } from "../Providers.ts";

/**
 * Nuke-only enumeration of Alchemy-minted Cloud Run / Functions runtime
 * service accounts (`alch-*` with display name {@link ALCHEMY_HOST_SA_DISPLAY_NAME}).
 * Not a user-facing resource.
 *
 * @internal
 */
export type HostServiceAccount = Resource<
  "GCP.IAM.HostServiceAccount",
  object,
  {
    name: string;
    email: string;
    project: string;
    accountId: string;
  },
  never,
  Providers
>;

export const HostServiceAccount = Resource<HostServiceAccount>(
  "GCP.IAM.HostServiceAccount",
);

const toAttrs = (
  account: iam.ServiceAccount,
  project: string,
): HostServiceAccount["Attributes"] => {
  const email = account.email ?? "";
  const accountId = email.split("@")[0] ?? "";
  return {
    name: account.name ?? "",
    email,
    project,
    accountId,
  };
};

const isManaged = (account: iam.ServiceAccount, project: string) => {
  const email = account.email ?? "";
  return (
    account.displayName === ALCHEMY_HOST_SA_DISPLAY_NAME &&
    email.startsWith("alch-") &&
    email.endsWith(`@${project}.iam.gserviceaccount.com`)
  );
};

export const HostServiceAccountProvider = () =>
  Provider.succeed(HostServiceAccount, {
    stables: ["name", "email", "project", "accountId"],

    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const env = yield* GcpEnvironment.current;
      const accountId = output.accountId;
      const email = hostServiceAccountEmail(env.project, accountId);
      const name = `projects/${env.project}/serviceAccounts/${email}`;
      const existing = yield* iam
        .getProjectsServiceAccounts({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (existing === undefined || !isManaged(existing, env.project)) {
        return undefined;
      }
      return toAttrs(existing, env.project);
    }),

    // Host accounts are minted by their host (`GCP.Run.Service`, …); this
    // resource only exists so `nuke` can list and delete leaked ones.
    reconcile: Effect.fn(function* ({ id, output }) {
      const env = yield* GcpEnvironment.current;
      const accountId =
        output?.accountId ?? `alch-${id.toLowerCase()}`.slice(0, 30);
      const email = hostServiceAccountEmail(env.project, accountId);
      const name = `projects/${env.project}/serviceAccounts/${email}`;
      const existing = yield* iam
        .getProjectsServiceAccounts({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (existing === undefined) {
        return {
          name,
          email,
          project: env.project,
          accountId,
        };
      }
      return toAttrs(existing, env.project);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* iam.listProjectsServiceAccounts
          .pages({
            name: `projects/${env.project}`,
            pageSize: 100,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.accounts ?? [])),
            Stream.filter((account) => isManaged(account, env.project)),
            Stream.map((account) => toAttrs(account, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as HostServiceAccount["Attributes"][]),
            ),
          );
      }),

    delete: Effect.fn(function* ({ output }) {
      yield* deleteHostServiceAccount({
        project: output.project,
        email: hostServiceAccountEmail(output.project, output.accountId),
      });
    }),
  });
