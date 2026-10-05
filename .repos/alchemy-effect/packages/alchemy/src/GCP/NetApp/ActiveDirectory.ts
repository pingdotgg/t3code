import * as netapp from "@distilled.cloud/gcp/netapp_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  fieldMask,
  listAtLocation,
  listLabeledPages,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  sameStringList,
  toPhysicalId,
  userLabels,
  waitForDeleteOperation,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

export type ActiveDirectoryProps = {
  /**
   * Active Directory id (the `{activeDirectory}` segment of
   * `projects/{project}/locations/{location}/activeDirectories/{activeDirectory}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the directory.
   */
  activeDirectoryId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the directory. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Active Directory domain name (`ad.example.com`).
   */
  domain: string;
  /**
   * Comma-separated DNS server IP addresses for the domain.
   */
  dns: string;
  /**
   * NetBIOS prefix used for the SMB server name. Max 15 characters.
   */
  netBiosPrefix: string;
  /**
   * Domain administrator username.
   */
  username: string;
  /**
   * Domain administrator password. Write-only — never returned on read.
   */
  password?: string;
  /**
   * Active Directory site used to limit Domain Controller discovery.
   */
  site?: string;
  /**
   * Organizational Unit (OU) the machine account is created in.
   */
  organizationalUnit?: string;
  /**
   * Users added to the Built-in Administrators group.
   */
  administrators?: string[];
  /**
   * Users added to the Built-in Backup Operators group.
   */
  backupOperators?: string[];
  /**
   * Domain users granted SeSecurityPrivilege.
   */
  securityOperators?: string[];
  /**
   * Encrypt SMB traffic to the Domain Controller.
   */
  encryptDcConnections?: boolean;
  /**
   * Allow local users and LDAP users. Disable for LDAP-only access.
   */
  nfsUsersWithLdap?: boolean;
  /**
   * Sign LDAP traffic.
   */
  ldapSigning?: boolean;
  /**
   * Enable AES encryption for SMB communication.
   */
  aesEncryption?: boolean;
  /**
   * KDC server IP address (Kerberos volumes).
   */
  kdcIp?: string;
  /**
   * KDC hostname (Kerberos volumes).
   */
  kdcHostname?: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type ActiveDirectory = Resource<
  "GCP.NetApp.ActiveDirectory",
  ActiveDirectoryProps,
  {
    /** Full resource name. */
    name: string;
    /** Active Directory id (last path segment). */
    activeDirectoryId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Domain name. */
    domain: string | undefined;
    /** DNS server list. */
    dns: string | undefined;
    /** NetBIOS prefix. */
    netBiosPrefix: string | undefined;
    /** Administrator username. */
    username: string | undefined;
    /** Site name. */
    site: string | undefined;
    /** Organizational unit. */
    organizationalUnit: string | undefined;
    /** Built-in Administrators group members. */
    administrators: string[];
    /** Built-in Backup Operators group members. */
    backupOperators: string[];
    /** SeSecurityPrivilege users. */
    securityOperators: string[];
    /** Whether DC connections are encrypted. */
    encryptDcConnections: boolean | undefined;
    /** Whether local + LDAP users are allowed. */
    nfsUsersWithLdap: boolean | undefined;
    /** Whether LDAP signing is enabled. */
    ldapSigning: boolean | undefined;
    /** Whether AES encryption is enabled. */
    aesEncryption: boolean | undefined;
    /** KDC IP address. */
    kdcIp: string | undefined;
    /** KDC hostname. */
    kdcHostname: string | undefined;
    /** Human-readable description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported state. */
    state: string | undefined;
    /** State details. */
    stateDetails: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud NetApp Volumes Active Directory connection used by SMB and
 * Kerberos volumes.
 *
 * Changing `activeDirectoryId`, `location`, `domain`, or `netBiosPrefix`
 * replaces the directory. Credentials, operators, description, and labels
 * update in place.
 *
 * ### Creating an Active Directory
 * **Example:** Generated name
 * ```typescript
 * const ad = yield* GCP.NetApp.ActiveDirectory("Corp", {
 *   domain: "ad.example.com",
 *   dns: "10.0.0.2",
 *   netBiosPrefix: "netapp",
 *   username: "admin",
 *   password: secret,
 * });
 * ```
 *
 * **Example:** Operators and encryption
 * ```typescript
 * const ad = yield* GCP.NetApp.ActiveDirectory("Corp", {
 *   domain: "ad.example.com",
 *   dns: "10.0.0.2,10.0.0.3",
 *   netBiosPrefix: "netapp",
 *   username: "admin",
 *   password: secret,
 *   administrators: ["alice"],
 *   aesEncryption: true,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating an Active Directory
 * **Example:** Description and labels
 * ```typescript
 * const ad = yield* GCP.NetApp.ActiveDirectory("Corp", {
 *   domain: "ad.example.com",
 *   dns: "10.0.0.2",
 *   netBiosPrefix: "netapp",
 *   username: "admin",
 *   description: "corp ad v2",
 *   labels: { env: "prod", team: "storage" },
 * });
 * ```
 *
 * @resource
 * @category NetApp
 */
export const ActiveDirectory = Resource<ActiveDirectory>(
  "GCP.NetApp.ActiveDirectory",
);

const resourceName = (
  project: string,
  location: string,
  activeDirectoryId: string,
) =>
  `projects/${project}/locations/${location}/activeDirectories/${activeDirectoryId}`;

const toAttrs = (
  item: netapp.ActiveDirectory,
  project: string,
  region: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "activeDirectories", region);
  return {
    name,
    activeDirectoryId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    domain: item.domain,
    dns: item.dns,
    netBiosPrefix: item.netBiosPrefix,
    username: item.username,
    site: item.site,
    organizationalUnit: item.organizationalUnit,
    administrators: item.administrators ?? [],
    backupOperators: item.backupOperators ?? [],
    securityOperators: item.securityOperators ?? [],
    encryptDcConnections: item.encryptDcConnections,
    nfsUsersWithLdap: item.nfsUsersWithLdap,
    ldapSigning: item.ldapSigning,
    aesEncryption: item.aesEncryption,
    kdcIp: item.kdcIp,
    kdcHostname: item.kdcHostname,
    description: item.description,
    labels: userLabels(item.labels),
    state: item.state,
    stateDetails: item.stateDetails,
    createTime: item.createTime,
  };
};

const getByName = (name: string) =>
  netapp
    .getProjectsLocationsActiveDirectories({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  listAtLocation(project, (parent) =>
    listLabeledPages(
      netapp.listProjectsLocationsActiveDirectories.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.activeDirectories,
      (item) => item.labels,
    ),
  );

export const ActiveDirectoryProvider = () =>
  Provider.succeed(ActiveDirectory, {
    stables: ["name", "activeDirectoryId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousDomain = olds?.domain ?? output?.domain;
      const previousPrefix = olds?.netBiosPrefix ?? output?.netBiosPrefix;
      return replaceOnIdentity({
        previousId: olds?.activeDirectoryId ?? output?.activeDirectoryId,
        nextId:
          news.activeDirectoryId ??
          olds?.activeDirectoryId ??
          output?.activeDirectoryId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          (previousDomain !== undefined && news.domain !== previousDomain) ||
          (previousPrefix !== undefined &&
            news.netBiosPrefix !== previousPrefix),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const activeDirectoryId = yield* toPhysicalId(
        id,
        olds?.activeDirectoryId,
        output?.activeDirectoryId,
        "activedirectory",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, activeDirectoryId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project);
        return items.map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output, olds }) {
      const env = yield* GcpEnvironment.current;
      const activeDirectoryId = yield* toPhysicalId(
        id,
        news.activeDirectoryId,
        output?.activeDirectoryId,
        "activedirectory",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, activeDirectoryId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const body: netapp.ActiveDirectory = {
        domain: news.domain,
        dns: news.dns,
        netBiosPrefix: news.netBiosPrefix,
        username: news.username,
        password: news.password,
        site: news.site,
        organizationalUnit: news.organizationalUnit,
        administrators: news.administrators,
        backupOperators: news.backupOperators,
        securityOperators: news.securityOperators,
        encryptDcConnections: news.encryptDcConnections,
        nfsUsersWithLdap: news.nfsUsersWithLdap,
        ldapSigning: news.ldapSigning,
        aesEncryption: news.aesEncryption,
        kdcIp: news.kdcIp,
        kdcHostname: news.kdcHostname,
        description: news.description,
        labels: desiredLabels,
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* netapp
          .createProjectsLocationsActiveDirectories({
            parent: parentOf(env.project, location),
            activeDirectoryId,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      current = yield* waitUntilReady(
        getByName(current.name ?? name),
        current.name ?? name,
        (item) => item.state,
        (item) => item.stateDetails,
      );

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const passwordChanged =
        news.password !== undefined && news.password !== olds?.password;
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
        (current.description ?? "") !== (news.description ?? "") &&
          "description",
        (current.dns ?? "") !== news.dns && "dns",
        (current.username ?? "") !== news.username && "username",
        passwordChanged && "password",
        (current.site ?? "") !== (news.site ?? "") && "site",
        (current.organizationalUnit ?? "") !==
          (news.organizationalUnit ?? "") && "organizationalUnit",
        !sameStringList(current.administrators, news.administrators) &&
          "administrators",
        !sameStringList(current.backupOperators, news.backupOperators) &&
          "backupOperators",
        !sameStringList(current.securityOperators, news.securityOperators) &&
          "securityOperators",
        (current.encryptDcConnections ?? false) !==
          (news.encryptDcConnections ?? false) && "encryptDcConnections",
        (current.nfsUsersWithLdap ?? false) !==
          (news.nfsUsersWithLdap ?? false) && "nfsUsersWithLdap",
        (current.ldapSigning ?? false) !== (news.ldapSigning ?? false) &&
          "ldapSigning",
        (current.aesEncryption ?? false) !== (news.aesEncryption ?? false) &&
          "aesEncryption",
        (current.kdcIp ?? "") !== (news.kdcIp ?? "") && "kdcIp",
        (current.kdcHostname ?? "") !== (news.kdcHostname ?? "") &&
          "kdcHostname",
      ]);

      if (mask.length > 0) {
        const operation = yield* netapp.patchProjectsLocationsActiveDirectories(
          {
            name: current.name ?? name,
            updateMask: mask,
            body: {
              name: current.name ?? name,
              ...body,
            },
          },
        );
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(
          getByName(current.name ?? name),
          current.name ?? name,
          (item) => item.state,
          (item) => item.stateDetails,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* netapp
        .deleteProjectsLocationsActiveDirectories({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForDeleteOperation(operation);
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
