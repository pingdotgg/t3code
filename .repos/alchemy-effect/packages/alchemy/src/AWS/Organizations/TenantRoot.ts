import * as organizations from "@distilled.cloud/aws/organizations";
import * as Effect from "effect/Effect";
import type { PolicyDocument } from "../IAM/Policy.ts";
import * as IdentityCenter from "../IdentityCenter/index.ts";
import type { Account, AccountProps } from "./Account.ts";
import { Account as OrganizationAccount } from "./Account.ts";
import type { DelegatedAdministrator } from "./DelegatedAdministrator.ts";
import { DelegatedAdministrator as OrganizationsDelegatedAdministrator } from "./DelegatedAdministrator.ts";
import type { Organization, OrganizationProps } from "./Organization.ts";
import { Organization as AwsOrganization } from "./Organization.ts";
import type {
  OrganizationalUnit,
  OrganizationalUnitProps,
} from "./OrganizationalUnit.ts";
import { OrganizationalUnit as AwsOrganizationalUnit } from "./OrganizationalUnit.ts";
import type { Policy } from "./Policy.ts";
import { Policy as OrganizationsPolicy } from "./Policy.ts";
import type { PolicyAttachment } from "./PolicyAttachment.ts";
import { PolicyAttachment as OrganizationsPolicyAttachment } from "./PolicyAttachment.ts";
import type { Root, RootProps } from "./Root.ts";
import { Root as OrganizationRoot } from "./Root.ts";
import type { RootPolicyType } from "./RootPolicyType.ts";
import { RootPolicyType as OrganizationsRootPolicyType } from "./RootPolicyType.ts";
import type { TrustedServiceAccess } from "./TrustedServiceAccess.ts";
import { TrustedServiceAccess as OrganizationsTrustedServiceAccess } from "./TrustedServiceAccess.ts";

export type TenantTargetKey = "root" | string;

export interface TenantAccountSpec extends Omit<
  AccountProps,
  "parentId" | "name" | "email"
> {
  key: string;
  name: string;
  email: string;
}

export interface TenantOrganizationalUnitSpec extends Omit<
  OrganizationalUnitProps,
  "parentId" | "name"
> {
  key: string;
  name?: string;
  accounts?: TenantAccountSpec[];
  children?: TenantOrganizationalUnitSpec[];
}

export interface TenantPolicySpec {
  key: string;
  name?: string;
  description?: string;
  type?: organizations.PolicyType;
  document: PolicyDocument;
  targetKeys: TenantTargetKey[];
  tags?: Record<string, string>;
}

export interface TenantIdentityCenterGroupSpec {
  key: string;
  displayName: string;
  description?: string;
}

export interface TenantIdentityCenterPermissionSetSpec {
  key: string;
  name: string;
  description?: string;
  sessionDuration?: string;
  relayState?: string;
}

export interface TenantIdentityCenterAssignmentSpec {
  key?: string;
  permissionSetKey: string;
  accountKey: string;
  principalType?: "USER" | "GROUP";
  groupKey?: string;
  principalId?: string;
}

export interface TenantIdentityCenterSpec {
  mode?: "existing" | "account";
  instanceArn?: string;
  name?: string;
  delegatedAdminAccountKey?: string;
  groups?: TenantIdentityCenterGroupSpec[];
  permissionSets?: TenantIdentityCenterPermissionSetSpec[];
  assignments?: TenantIdentityCenterAssignmentSpec[];
}

export interface TenantRootProps {
  organization?: OrganizationProps;
  root?: RootProps;
  policyTypes?: organizations.PolicyType[];
  trustedServicePrincipals?: string[];
  organizationalUnits?: TenantOrganizationalUnitSpec[];
  policies?: TenantPolicySpec[];
  identityCenter?: TenantIdentityCenterSpec;
  tags?: Record<string, string>;
}

export interface TenantRootResult {
  organization: Organization;
  root: Root;
  policyTypes: RootPolicyType[];
  trustedServiceAccess: TrustedServiceAccess[];
  delegatedAdministrators: DelegatedAdministrator[];
  organizationalUnits: Record<string, OrganizationalUnit>;
  accounts: Record<string, Account>;
  policies: Record<string, Policy>;
  policyAttachments: PolicyAttachment[];
  identityCenter?: {
    instance: IdentityCenter.Instance;
    groups: Record<string, IdentityCenter.Group>;
    permissionSets: Record<string, IdentityCenter.PermissionSet>;
    assignments: Record<string, IdentityCenter.AccountAssignment>;
  };
}

const defaultTenantOrganizationalUnits = (): TenantOrganizationalUnitSpec[] => [
  {
    key: "security",
    name: "security",
    accounts: [
      {
        key: "security",
        name: "security",
        email: "security@example.com",
      },
      {
        key: "log-archive",
        name: "log-archive",
        email: "log-archive@example.com",
      },
    ],
  },
  {
    key: "infrastructure",
    name: "infrastructure",
    accounts: [
      {
        key: "shared-services",
        name: "shared-services",
        email: "shared-services@example.com",
      },
    ],
  },
  {
    key: "workloads",
    name: "workloads",
    accounts: [
      {
        key: "prod",
        name: "prod",
        email: "prod@example.com",
      },
    ],
  },
];

const toLogicalIdSegment = (value: string) =>
  value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

/**
 * Compose an opinionated single-tenant landing zone inside the current AWS
 * Organizations management account.
 *
 * This helper intentionally stays aligned to native AWS semantics:
 * one real Organization, one root, nested OUs, and accounts beneath that
 * tenant root. The broader `RootRoot` concept is an Alchemy control-plane
 * abstraction over many such tenant roots deployed into separate management
 * accounts, not a nested AWS Organizations feature.
 *
 * @section Creating A Tenant Root
 * @example Tenant With Baseline Accounts
 * ```typescript
 * const tenant = yield* TenantRoot("CustomerA", {
 *   identityCenter: {
 *     mode: "existing",
 *     groups: [
 *       { key: "platform", displayName: "platform-engineers" },
 *     ],
 *     permissionSets: [
 *       {
 *         key: "admin",
 *         name: "AdministratorAccess",
 *         sessionDuration: "PT8H",
 *       },
 *     ],
 *     assignments: [
 *       {
 *         permissionSetKey: "admin",
 *         groupKey: "platform",
 *         accountKey: "prod",
 *       },
 *     ],
 *   },
 * });
 * ```
 */
export const TenantRoot = Effect.fn(function* (
  id: string,
  props: TenantRootProps = {},
) {
  const sharedTags = props.tags ?? {};
  const organization = yield* AwsOrganization(`${id}Organization`, {
    featureSet: "ALL",
    ...props.organization,
  });
  const root = yield* OrganizationRoot(`${id}Root`, {
    ...props.root,
    tags: mergeTags(sharedTags, props.root?.tags),
  });

  const policyTypes = yield* Effect.forEach(
    props.policyTypes ?? ["SERVICE_CONTROL_POLICY"],
    (policyType) =>
      OrganizationsRootPolicyType(
        `${id}${toLogicalIdSegment(policyType)}PolicyType`,
        {
          rootId: root.rootId,
          policyType,
        },
      ),
    { concurrency: "unbounded" },
  );

  const trustedServicePrincipals = [
    ...(props.trustedServicePrincipals ?? []),
    ...(props.identityCenter ? ["sso.amazonaws.com"] : []),
  ];
  const trustedServiceAccess = yield* Effect.forEach(
    [...new Set(trustedServicePrincipals)],
    (servicePrincipal) =>
      OrganizationsTrustedServiceAccess(
        `${id}${toLogicalIdSegment(servicePrincipal)}TrustedAccess`,
        { servicePrincipal },
      ),
    { concurrency: "unbounded" },
  );

  const organizationalUnits: Record<string, OrganizationalUnit> = {};
  const accounts: Record<string, Account> = {};
  const targets: Record<TenantTargetKey, { targetId: any }> = {
    root: { targetId: root.rootId as any },
  };

  yield* createOrganizationalUnits({
    id,
    parentId: root.rootId,
    sharedTags,
    specs: props.organizationalUnits ?? defaultTenantOrganizationalUnits(),
    organizationalUnits,
    accounts,
    targets,
  });

  const delegatedAdministrators: DelegatedAdministrator[] = [];
  const identityCenter = props.identityCenter
    ? yield* createTenantIdentityCenter({
        id,
        spec: props.identityCenter,
        accounts,
        sharedTags,
        delegatedAdministrators,
      })
    : undefined;

  const policies: Record<string, Policy> = {};
  const policyAttachments: PolicyAttachment[] = [];
  for (const policySpec of props.policies ?? []) {
    const policy = yield* OrganizationsPolicy(
      `${id}${toLogicalIdSegment(policySpec.key)}Policy`,
      {
        name: policySpec.name,
        description: policySpec.description,
        type: policySpec.type ?? "SERVICE_CONTROL_POLICY",
        document: policySpec.document,
        tags: mergeTags(sharedTags, policySpec.tags),
      },
    );
    policies[policySpec.key] = policy;

    for (const targetKey of policySpec.targetKeys) {
      const target = targets[targetKey];
      if (!target) {
        return yield* Effect.fail(
          new Error(
            `Unknown tenant policy target '${targetKey}' for policy '${policySpec.key}'`,
          ),
        );
      }

      policyAttachments.push(
        yield* OrganizationsPolicyAttachment(
          `${id}${toLogicalIdSegment(policySpec.key)}${toLogicalIdSegment(targetKey)}Attachment`,
          {
            policyId: policy.policyId,
            targetId: target.targetId,
          },
        ),
      );
    }
  }

  return {
    organization,
    root,
    policyTypes,
    trustedServiceAccess,
    delegatedAdministrators,
    organizationalUnits,
    accounts,
    policies,
    policyAttachments,
    identityCenter,
  } satisfies TenantRootResult;
});

const createOrganizationalUnits = ({
  id,
  parentId,
  sharedTags,
  specs,
  organizationalUnits,
  accounts,
  targets,
}: {
  id: string;
  parentId: any;
  sharedTags: Record<string, string>;
  specs: TenantOrganizationalUnitSpec[];
  organizationalUnits: Record<string, OrganizationalUnit>;
  accounts: Record<string, Account>;
  targets: Record<TenantTargetKey, { targetId: any }>;
}): Effect.Effect<void, unknown, unknown> =>
  Effect.gen(function* () {
    for (const spec of specs) {
      const ou = yield* AwsOrganizationalUnit(
        `${id}${toLogicalIdSegment(spec.key)}Ou`,
        {
          parentId,
          name: spec.name ?? spec.key,
          tags: mergeTags(sharedTags, spec.tags),
        },
      );
      organizationalUnits[spec.key] = ou;
      targets[spec.key] = { targetId: ou.ouId as any };

      for (const accountSpec of spec.accounts ?? []) {
        const account = yield* OrganizationAccount(
          `${id}${toLogicalIdSegment(accountSpec.key)}Account`,
          {
            ...accountSpec,
            parentId: ou.ouId,
            tags: mergeTags(sharedTags, accountSpec.tags),
          },
        );
        accounts[accountSpec.key] = account;
        targets[accountSpec.key] = { targetId: account.accountId as any };
      }

      if (spec.children?.length) {
        yield* createOrganizationalUnits({
          id,
          parentId: ou.ouId as any,
          sharedTags,
          specs: spec.children,
          organizationalUnits,
          accounts,
          targets,
        });
      }
    }
  });

const createTenantIdentityCenter = Effect.fn(function* ({
  id,
  spec,
  accounts,
  delegatedAdministrators,
}: {
  id: string;
  spec: TenantIdentityCenterSpec;
  accounts: Record<string, Account>;
  sharedTags: Record<string, string>;
  delegatedAdministrators: DelegatedAdministrator[];
}) {
  const instance = yield* IdentityCenter.Instance(`${id}IdentityCenter`, {
    mode: spec.mode ?? "existing",
    instanceArn: spec.instanceArn,
    name: spec.name,
  });

  if (spec.delegatedAdminAccountKey) {
    const account = accounts[spec.delegatedAdminAccountKey];
    if (!account) {
      return yield* Effect.fail(
        new Error(
          `Unknown delegated admin account '${spec.delegatedAdminAccountKey}'`,
        ),
      );
    }
    delegatedAdministrators.push(
      yield* OrganizationsDelegatedAdministrator(
        `${id}${toLogicalIdSegment(spec.delegatedAdminAccountKey)}IdentityCenterDelegatedAdmin`,
        {
          accountId: account.accountId,
          servicePrincipal: "sso.amazonaws.com",
        },
      ),
    );
  }

  const groups: Record<string, IdentityCenter.Group> = {};
  for (const groupSpec of spec.groups ?? []) {
    groups[groupSpec.key] = yield* IdentityCenter.Group(
      `${id}${toLogicalIdSegment(groupSpec.key)}Group`,
      {
        identityStoreId: instance.identityStoreId,
        displayName: groupSpec.displayName,
        description: groupSpec.description,
      },
    );
  }

  const permissionSets: Record<string, IdentityCenter.PermissionSet> = {};
  for (const permissionSetSpec of spec.permissionSets ?? []) {
    permissionSets[permissionSetSpec.key] = yield* IdentityCenter.PermissionSet(
      `${id}${toLogicalIdSegment(permissionSetSpec.key)}PermissionSet`,
      {
        instanceArn: instance.instanceArn,
        name: permissionSetSpec.name,
        description: permissionSetSpec.description,
        sessionDuration: permissionSetSpec.sessionDuration,
        relayState: permissionSetSpec.relayState,
      },
    );
  }

  const assignments: Record<string, IdentityCenter.AccountAssignment> = {};
  for (const assignmentSpec of spec.assignments ?? []) {
    const account = accounts[assignmentSpec.accountKey];
    if (!account) {
      return yield* Effect.fail(
        new Error(`Unknown assignment account '${assignmentSpec.accountKey}'`),
      );
    }
    const permissionSet = permissionSets[assignmentSpec.permissionSetKey];
    if (!permissionSet) {
      return yield* Effect.fail(
        new Error(
          `Unknown assignment permission set '${assignmentSpec.permissionSetKey}'`,
        ),
      );
    }
    const principalId =
      assignmentSpec.groupKey !== undefined
        ? groups[assignmentSpec.groupKey]?.groupId
        : assignmentSpec.principalId;
    if (!principalId) {
      return yield* Effect.fail(
        new Error(
          `Unable to resolve principal for assignment '${assignmentSpec.key ?? `${assignmentSpec.permissionSetKey}-${assignmentSpec.accountKey}`}'`,
        ),
      );
    }

    const key =
      assignmentSpec.key ??
      `${assignmentSpec.permissionSetKey}-${assignmentSpec.accountKey}-${assignmentSpec.groupKey ?? principalId}`;

    assignments[key] = yield* IdentityCenter.AccountAssignment(
      `${id}${toLogicalIdSegment(key)}Assignment`,
      {
        instanceArn: instance.instanceArn,
        permissionSetArn: permissionSet.permissionSetArn,
        principalId,
        principalType: assignmentSpec.groupKey
          ? "GROUP"
          : (assignmentSpec.principalType ?? "USER"),
        targetId: account.accountId,
      },
    );
  }

  return {
    instance,
    groups,
    permissionSets,
    assignments,
  };
});

const mergeTags = (
  shared: Record<string, string>,
  tags: Record<string, string> | undefined,
) => ({
  ...shared,
  ...tags,
});
