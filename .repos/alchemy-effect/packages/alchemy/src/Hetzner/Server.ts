import { generateKeyPairSync } from "node:crypto";
import { Services } from "@distilled.cloud/hetzner";
import type {
  GetServerResponseServer,
  ListServersResponseServersItem,
} from "@distilled.cloud/hetzner/servers";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { tagRecord } from "../Tags.ts";
import { waitForAction, waitForActions } from "./actions.ts";
import {
  alchemyStackSelector,
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "./Labels.ts";
import type { Providers } from "./Providers.ts";

const DEFAULT_LOCATION = "nbg1";
const MAX_NAME_LENGTH = 63;

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* SshKey(...)` and `SshKey(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

/**
 * SSH key identity injected at create time. Accepts a `Hetzner.SshKey`
 * resource or a `{ id }` stub.
 */
export type ServerSshKey = {
  readonly id: number;
};

/**
 * Private Network identity. Accepts a `Hetzner.Network` resource or a
 * `{ networkId }` stub.
 */
export type ServerNetwork = {
  readonly networkId: number;
};

/**
 * Firewall identity applied to the public NIC. Accepts a
 * `Hetzner.Firewall` resource or a `{ id }` stub.
 */
export type ServerFirewall = {
  readonly id: number;
};

/**
 * Volume identity attached at create/sync time. Accepts a
 * `Hetzner.Volume` resource or a `{ id }` stub.
 */
export type ServerVolume = {
  readonly id: number;
};

/**
 * Placement Group identity. Accepts a `Hetzner.PlacementGroup` resource
 * or a `{ id }` stub.
 */
export type ServerPlacementGroup = {
  readonly id: number;
};

export type ServerStatus =
  | "running"
  | "initializing"
  | "starting"
  | "stopping"
  | "off"
  | "deleting"
  | "migrating"
  | "rebuilding"
  | "unknown";

export interface ServerProps {
  /**
   * Server name. Must be unique per project and a valid RFC 1123
   * hostname (letters, digits, periods, dashes). If omitted, a unique
   * name is generated from the stack, stage and logical ID.
   */
  name?: string;
  /**
   * Server type name (`cpx12`, `cx23`, …) or numeric id. Cannot be
   * changed after creation — changing it replaces the Server.
   */
  serverType: string;
  /**
   * Image name (`ubuntu-24.04`, …) or numeric id the Server is created
   * from. Cannot be changed after creation — changing it replaces the
   * Server.
   */
  image: string;
  /**
   * Location name (`nbg1`, `fsn1`, `hel1`, …) or numeric id. Cannot be
   * changed after creation — changing it replaces the Server.
   *
   * @default "nbg1"
   */
  location?: string;
  /**
   * SSH keys injected at create time. Accepts `Hetzner.SshKey` resources
   * or `{ id }` stubs. Hetzner cannot change injected keys after
   * create — this list is applied only when the Server is provisioned.
   */
  sshKeys?: Array<Ref<ServerSshKey>>;
  /**
   * Private Networks to attach. Accepts `Hetzner.Network` resources or
   * `{ networkId }` stubs. Synced on update when set.
   */
  networks?: Array<Ref<ServerNetwork>>;
  /**
   * Firewalls applied to the public NIC. Accepts `Hetzner.Firewall`
   * resources or `{ id }` stubs. Synced on update when set.
   */
  firewalls?: Array<Ref<ServerFirewall>>;
  /**
   * Volumes to attach. Accepts `Hetzner.Volume` resources or `{ id }`
   * stubs. Synced on update when set. Omit to leave Volume-side attach
   * alone.
   */
  volumes?: Array<Ref<ServerVolume>>;
  /**
   * Placement Group to assign. Accepts a `Hetzner.PlacementGroup` or
   * `{ id }`. Synced on update when set.
   */
  placementGroup?: Ref<ServerPlacementGroup>;
  /**
   * Cloud-init user data run on the Server's **first boot** — the place to
   * install packages, write config files, or add users.
   *
   * Accepts a shell script (`#!/bin/bash …`), a `#cloud-config` document,
   * or a bare shell snippet (a `#!/bin/bash` shebang is added for you).
   * Alchemy combines it with its own bootstrap script (which preinstalls
   * Node 26 for `Hetzner.Service`) into a multipart cloud-init document, so
   * both run — the bootstrap first. A document that already starts with a
   * `Content-Type:` / `MIME-Version:` header is passed through untouched,
   * taking over the whole payload including the bootstrap.
   *
   * Capped at 32 KiB (Hetzner's limit) after composition.
   *
   * Cloud-init only runs once, on first boot, so changing this replaces
   * the Server.
   */
  userData?: string;
  /**
   * Attach a public IPv4. Applied only at create time.
   *
   * @default true
   */
  enableIpv4?: boolean;
  /**
   * Attach a public IPv6. Applied only at create time.
   *
   * @default true
   */
  enableIpv6?: boolean;
  /**
   * Power the Server on after create.
   *
   * @default true
   */
  startAfterCreate?: boolean;
  /**
   * Prevent the Server from being deleted or rebuilt via the API until
   * this is cleared. The provider disables protection before delete.
   *
   * @default false
   */
  deleteProtection?: boolean;
  /**
   * User-defined labels. Alchemy ownership labels (`alchemy.stack` /
   * `alchemy.stage` / `alchemy.id`) are always merged in.
   */
  labels?: Record<string, string>;
}

export type Server = Resource<
  "Hetzner.Server",
  ServerProps,
  {
    /** Numeric Hetzner Server ID. */
    id: number;
    /**
     * Same as {@link id}. Present so Volume / Firewall `server` /
     * `applyTo` props accept this resource directly.
     */
    serverId: number;
    /** Server name (unique per project). */
    name: string;
    /** Server status. */
    status: ServerStatus;
    /** Server type name (`cx22`, …). */
    serverType: string;
    /** Numeric Server type id. */
    serverTypeId: number;
    /** Image name, or `undefined` for snapshot/backup images without a name. */
    image: string | undefined;
    /** Numeric Image id, or `undefined` if no image is attached. */
    imageId: number | undefined;
    /** Location name (`nbg1`, `fsn1`, …). */
    location: string;
    /** Numeric location ID. */
    locationId: number;
    /** Public IPv4 address, or `undefined` if IPv4 is disabled. */
    ipv4: string | undefined;
    /** Public IPv6 network (`…/64`), or `undefined` if IPv6 is disabled. */
    ipv6: string | undefined;
    /** Attached Volume IDs. */
    volumeIds: number[];
    /** Attached private Network IDs. */
    networkIds: number[];
    /** Firewall IDs applied to the public NIC. */
    firewallIds: number[];
    /** Placement Group ID, or `undefined` if unassigned. */
    placementGroupId: number | undefined;
    /** Whether delete/rebuild protection is enabled. */
    deleteProtection: boolean;
    /** RFC3339 creation timestamp. */
    created: string;
    /** User-defined labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /**
     * Alchemy-managed deploy SSH private key (PKCS8 PEM). Injected at
     * create via a companion SSH key so `Hetzner.Ssh` / `Hetzner.Service`
     * can reach the box. Persisted in state; not present on adopted
     * foreign servers.
     */
    privateKey?: Redacted.Redacted<string>;
    /** Numeric id of the Alchemy-managed deploy SSH key. */
    deploySshKeyId?: number;
  },
  {
    /** Environment variables collected from bindings. */
    env?: Record<string, any>;
    /**
     * Volumes to attach and mount. Collected from `Hetzner.MountVolume`
     * when the Server is the bind host.
     */
    volumes?: Array<{
      volumeId: number;
      path: string;
    }>;
  },
  Providers
>;

/**
 * A Hetzner Cloud Server — a virtual machine in a Location, created from
 * a Server type and an Image. `serverType`, `image`, and `location` are
 * immutable (changing any of them replaces the Server). Name, labels,
 * delete protection, and (when set) Networks / Firewalls / Volumes /
 * Placement Group update in place. SSH keys are injected only at create.
 *
 * @see https://docs.hetzner.cloud/reference/cloud#servers
 *
 * ### Creating a Server
 * **Example:** Basic Server
 * ```typescript
 * const server = yield* Hetzner.Server("web", {
 *   serverType: "cpx12",
 *   image: "ubuntu-24.04",
 *   location: "nbg1",
 * });
 * ```
 *
 * **Example:** Named Server with labels
 * ```typescript
 * const server = yield* Hetzner.Server("web", {
 *   name: "app-web",
 *   serverType: "cpx12",
 *   image: "ubuntu-24.04",
 *   location: "nbg1",
 *   labels: { role: "web" },
 * });
 * ```
 *
 * ### Attachments
 * **Example:** SSH key and Placement Group
 * ```typescript
 * const key = yield* Hetzner.SshKey("deploy", {
 *   publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI… user@host",
 * });
 * const group = yield* Hetzner.PlacementGroup("web");
 * const server = yield* Hetzner.Server("web", {
 *   serverType: "cpx12",
 *   image: "ubuntu-24.04",
 *   location: "nbg1",
 *   sshKeys: [key],
 *   placementGroup: group,
 * });
 * ```
 *
 * ### Custom init script
 * **Example:** Install packages on first boot
 * ```typescript
 * const server = yield* Hetzner.Server("web", {
 *   serverType: "cpx12",
 *   image: "ubuntu-24.04",
 *   userData: `#!/bin/bash
 * apt-get update
 * DEBIAN_FRONTEND=noninteractive apt-get install -y nginx
 * systemctl enable --now nginx`,
 * });
 * ```
 *
 * **Example:** cloud-config document
 * ```typescript
 * const server = yield* Hetzner.Server("web", {
 *   serverType: "cpx12",
 *   image: "ubuntu-24.04",
 *   userData: `#cloud-config
 * packages:
 *   - nginx
 *   - postgresql-client`,
 * });
 * ```
 *
 * `userData` is merged with Alchemy's own bootstrap script into a
 * multipart cloud-init document, so both run. It is applied on first boot
 * only — changing it replaces the Server.
 *
 * @resource
 */
export const Server = Resource<Server>("Hetzner.Server");

export class ServerNotResolved extends Data.TaggedError(
  "Hetzner.ServerNotResolved",
)<{
  name: string;
}> {}

/**
 * The composed cloud-init document (Alchemy's bootstrap plus the Server's
 * `userData`) exceeds Hetzner's 32 KiB user-data limit.
 */
export class ServerUserDataTooLarge extends Data.TaggedError(
  "Hetzner.ServerUserDataTooLarge",
)<{
  name: string;
  bytes: number;
  limit: number;
}> {}

type CloudServer = GetServerResponseServer | ListServersResponseServersItem;

class ServerPending extends Data.TaggedError("ServerPending")<{
  serverId: number;
  status: string;
}> {}

class ServerTimeout extends Data.TaggedError("ServerTimeout")<{
  serverId: number;
  status: string;
}> {}

const asStatus = (status: string): ServerStatus => {
  switch (status) {
    case "running":
    case "initializing":
    case "starting":
    case "stopping":
    case "off":
    case "deleting":
    case "migrating":
    case "rebuilding":
    case "unknown":
      return status;
    default:
      return "unknown";
  }
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toAttrs = (server: CloudServer): Server["Attributes"] => ({
  id: server.id,
  serverId: server.id,
  name: server.name,
  status: asStatus(server.status),
  serverType: server.server_type.name,
  serverTypeId: server.server_type.id,
  image: server.image?.name ?? undefined,
  imageId: server.image?.id,
  location: server.location.name,
  locationId: server.location.id,
  ipv4: server.public_net.ipv4?.ip,
  ipv6: server.public_net.ipv6?.ip,
  volumeIds: [...(server.volumes ?? [])],
  networkIds: server.private_net
    .map((item) => item.network)
    .filter((id): id is number => typeof id === "number"),
  firewallIds: (server.public_net.firewalls ?? [])
    .map((item) => item.id)
    .filter((id): id is number => typeof id === "number"),
  placementGroupId: server.placement_group?.id,
  deleteProtection: server.protection.delete,
  created: server.created,
  labels: userLabels(server.labels),
});

const retryable = (e: { readonly _tag: string }): boolean =>
  e._tag === "ServerPending" ||
  e._tag === "TooManyRequests" ||
  e._tag === "ServiceUnavailable" ||
  e._tag === "InternalServerError" ||
  e._tag === "BadGateway" ||
  e._tag === "GatewayTimeout" ||
  e._tag === "Locked";

const backoff = Schedule.min([
  Schedule.exponential(Duration.millis(500), 1.5),
  Schedule.spaced(Duration.seconds(5)),
]);

/** Companion deploy keys are not stack resources — delete must be idempotent. */
const deleteDeployKey = (id: number | undefined) =>
  id === undefined
    ? Effect.void
    : Services.sshKeys.deleteSshKey({ id }).pipe(
        Effect.retry({
          while: (e) =>
            retryable(e) ||
            e._tag === "UnprocessableEntity" ||
            e._tag === "Conflict",
          times: 8,
          schedule: backoff,
        }),
        Effect.catchTag("NotFound", () => Effect.void),
      );

const createServerName = (
  id: string,
  name: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    return (
      name ??
      existing ??
      (yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }))
    );
  });

/**
 * Preinstall Node 26 so `Hetzner.Service`'s first deploy does not have to.
 * Mirrors the SSH-side install in `./hosted.ts`. Never fails the boot:
 * `hosted.ts` installs Node over SSH if this did not manage to.
 */
const ALCHEMY_BOOTSTRAP = `#!/bin/bash
set -uo pipefail
export HOME=/root
if ! command -v curl >/dev/null 2>&1 || ! command -v unzip >/dev/null 2>&1; then
  apt-get update || true
  DEBIAN_FRONTEND=noninteractive apt-get install -y curl unzip ca-certificates || true
fi
if ! command -v node >/dev/null 2>&1; then
  for attempt in 1 2 3; do
    curl -fsSL https://deb.nodesource.com/setup_26.x | bash - && DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs && break
    sleep 5
  done
fi
exit 0
`;

/** Hetzner rejects user data larger than 32 KiB. */
const MAX_USER_DATA_BYTES = 32 * 1024;

const MIME_BOUNDARY = "==ALCHEMY==";

/**
 * Cloud-init dispatches on a document's first line. Anything unrecognized
 * is treated as a shell script.
 */
const CLOUD_INIT_FORMATS: ReadonlyArray<readonly [string, string]> = [
  ["#cloud-config", "text/cloud-config"],
  ["#cloud-boothook", "text/cloud-boothook"],
  ["#include", "text/x-include-url"],
  ["#upstart-job", "text/upstart-job"],
  ["#part-handler", "text/part-handler"],
  ["#!", "text/x-shellscript"],
];

type UserDataPart = {
  readonly contentType: string;
  readonly body: string;
};

const classifyUserData = (doc: string): UserDataPart => {
  const first = doc.split("\n", 1)[0]?.trim() ?? "";
  for (const [prefix, contentType] of CLOUD_INIT_FORMATS) {
    if (first.startsWith(prefix)) return { contentType, body: doc };
  }
  // A bare snippet (`apt-get install -y nginx`) is the common case —
  // cloud-init needs a shebang before it will execute one.
  return { contentType: "text/x-shellscript", body: `#!/bin/bash\n${doc}` };
};

/**
 * Wrap the parts in a multipart cloud-init document. Parts are named
 * `part-001`, `part-002`, … the way cloud-init names anonymous parts
 * itself — scripts run in that (lexical) order, so the bootstrap goes
 * first.
 */
const mimeMultipart = (parts: ReadonlyArray<UserDataPart>) =>
  [
    `Content-Type: multipart/mixed; boundary="${MIME_BOUNDARY}"`,
    "MIME-Version: 1.0",
    "",
    ...parts.flatMap((part, index) => [
      `--${MIME_BOUNDARY}`,
      `Content-Type: ${part.contentType}; charset="utf-8"`,
      "MIME-Version: 1.0",
      `Content-Disposition: attachment; filename="part-${String(index + 1).padStart(3, "0")}"`,
      "",
      part.body.replace(/\n+$/, ""),
    ]),
    `--${MIME_BOUNDARY}--`,
    "",
  ].join("\n");

/**
 * Compose the cloud-init document sent at create: Alchemy's bootstrap
 * script plus the caller's `userData`, if any.
 */
export const composeUserData = (userData: string | undefined): string => {
  if (userData === undefined) return ALCHEMY_BOOTSTRAP;
  const doc = userData.replace(/^\uFEFF/, "").replace(/^[\s\n]+/, "");
  if (doc === "") return ALCHEMY_BOOTSTRAP;
  // An explicit MIME document is passed through verbatim — the caller owns
  // the whole payload, bootstrap included.
  if (/^(content-type|mime-version):/i.test(doc)) return userData;
  return mimeMultipart([
    { contentType: "text/x-shellscript", body: ALCHEMY_BOOTSTRAP },
    classifyUserData(doc),
  ]);
};

const buildUserData = Effect.fn(function* (input: {
  name: string;
  userData: string | undefined;
}) {
  const doc = yield* Effect.sync(() => composeUserData(input.userData));
  const bytes = yield* Effect.sync(() => Buffer.byteLength(doc, "utf8"));
  if (bytes > MAX_USER_DATA_BYTES) {
    return yield* new ServerUserDataTooLarge({
      name: input.name,
      bytes,
      limit: MAX_USER_DATA_BYTES,
    });
  }
  return doc;
});

const u32be = (n: number) => {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(n);
  return buf;
};

const sshString = (data: Buffer | string) => {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  return Buffer.concat([u32be(buf.length), buf]);
};

/**
 * Encode an ed25519 keypair as OpenSSH public + private key files.
 * `ssh -i` on macOS rejects PKCS8 ed25519 PEMs with exit 255.
 */
const encodeOpenSshEd25519 = (
  publicRaw: Buffer,
  seed: Buffer,
  comment: string,
) => {
  const algo = Buffer.from("ssh-ed25519");
  const pubBlob = Buffer.concat([sshString(algo), sshString(publicRaw)]);
  const publicKey = `ssh-ed25519 ${pubBlob.toString("base64")} ${comment}`;

  const check = Buffer.alloc(4);
  check.writeUInt32BE(0xa1b2c3d4);
  const secret = Buffer.concat([seed, publicRaw]);
  let inner = Buffer.concat([
    check,
    check,
    sshString(algo),
    sshString(publicRaw),
    sshString(secret),
    sshString(comment),
  ]);
  const padLen = (8 - (inner.length % 8)) % 8;
  const pad = Buffer.alloc(padLen);
  for (let i = 0; i < padLen; i++) pad[i] = i + 1;
  inner = Buffer.concat([inner, pad]);

  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0"),
    sshString("none"),
    sshString("none"),
    sshString(""),
    u32be(1),
    sshString(pubBlob),
    sshString(inner),
  ]);
  const b64 = body.toString("base64");
  const wrapped = b64.match(/.{1,70}/g)?.join("\n") ?? b64;
  const privateKey = `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrapped}\n-----END OPENSSH PRIVATE KEY-----\n`;
  return { publicKey, privateKey };
};

const generateDeployKey = Effect.sync(() => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" });
  const publicRaw = spki.subarray(spki.length - 32);
  const seed = pkcs8.subarray(pkcs8.length - 32);
  return encodeOpenSshEd25519(publicRaw, seed, "alchemy-deploy");
});

const unwrapPrivateKey = (
  value: Redacted.Redacted<string> | string | undefined,
): string | undefined => {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : Redacted.value(value);
};

const ensureDeployKey = Effect.fn(function* (input: {
  name: string;
  labels: Record<string, string>;
  output?: Pick<Server["Attributes"], "privateKey" | "deploySshKeyId">;
  creating: boolean;
}) {
  const existingKey = unwrapPrivateKey(input.output?.privateKey);
  const existingId = input.output?.deploySshKeyId;
  if (existingKey !== undefined && existingId !== undefined) {
    return {
      privateKey: Redacted.make(existingKey),
      deploySshKeyId: existingId,
    };
  }
  if (!input.creating) {
    return {
      privateKey: input.output?.privateKey,
      deploySshKeyId: existingId,
    };
  }
  const generated = yield* generateDeployKey;
  const keyName = `${input.name.slice(0, 55)}-d`;
  const created = yield* Services.sshKeys
    .createSshKey({
      name: keyName,
      public_key: generated.publicKey,
      labels: input.labels,
    })
    .pipe(
      Effect.catchTag("Conflict", () =>
        Services.sshKeys.listSshKeys({ name: keyName, per_page: 50 }).pipe(
          Effect.map(({ ssh_keys }) =>
            ssh_keys.find((item) => item.name === keyName),
          ),
          Effect.flatMap((hit) =>
            hit !== undefined
              ? Effect.succeed({ ssh_key: hit })
              : Services.sshKeys.createSshKey({
                  name: keyName,
                  public_key: generated.publicKey,
                  labels: input.labels,
                }),
          ),
        ),
      ),
    );
  return {
    privateKey: Redacted.make(generated.privateKey),
    deploySshKeyId: created.ssh_key.id,
  };
});

const getById = (id: number) =>
  Services.servers.getServer({ id }).pipe(
    Effect.map(({ server }) => server),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const getByName = (name: string) =>
  Services.servers
    .listServers({ name, per_page: 50 })
    .pipe(
      Effect.map(({ servers }) => servers.find((item) => item.name === name)),
    );

const observe = Effect.fn(function* ({
  name,
  outputId,
}: {
  id: string;
  name?: string;
  outputId?: number;
}) {
  if (outputId !== undefined) {
    const byId = yield* getById(outputId);
    if (byId !== undefined) return byId;
  }
  if (name !== undefined) {
    return yield* getByName(name);
  }
  return undefined;
});

const READY = new Set<string>(["running", "off"]);

const waitUntilReady = (serverId: number) =>
  Services.servers.getServer({ id: serverId }).pipe(
    Effect.flatMap(({ server }) =>
      server !== undefined && READY.has(server.status)
        ? Effect.succeed(server)
        : Effect.fail(
            new ServerPending({
              serverId,
              status: server?.status ?? "missing",
            }),
          ),
    ),
    Effect.retry({
      while: retryable,
      times: 10,
      schedule: backoff,
    }),
    Effect.catchTag(
      "ServerPending",
      (e) =>
        new ServerTimeout({
          serverId: e.serverId,
          status: e.status,
        }),
    ),
  );

const waitUntilGone = (serverId: number) =>
  Services.servers.getServer({ id: serverId }).pipe(
    Effect.map(() => false),
    Effect.catchTag("NotFound", () => Effect.succeed(true)),
    Effect.repeat({
      schedule: Schedule.spaced(Duration.seconds(1)),
      until: (gone) => gone,
      times: 10,
    }),
  );

const numericId = (
  value: unknown,
  keys: readonly string[],
): number | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof rec[key] === "number") return rec[key];
  }
  return undefined;
};

const idsOf = (
  items: ReadonlyArray<unknown> | undefined,
  keys: readonly string[],
): number[] => {
  const ids = new Set<number>();
  for (const item of items ?? []) {
    const id = numericId(item, keys);
    if (id !== undefined) ids.add(id);
  }
  return [...ids];
};

const sameRef = (desired: string, name: string, id: number): boolean =>
  desired === name || desired === String(id);

const setEquals = (a: ReadonlyArray<number>, b: ReadonlyArray<number>) => {
  if (a.length !== b.length) return false;
  const left = new Set(a);
  return b.every((id) => left.has(id));
};

const refresh = (id: number) =>
  getById(id).pipe(
    Effect.flatMap((server) =>
      server !== undefined ? Effect.succeed(server) : waitUntilReady(id),
    ),
  );

const syncNetworks = Effect.fn(function* (input: {
  serverId: number;
  observed: ReadonlyArray<number>;
  desired: ReadonlyArray<number>;
}) {
  const observed = new Set(input.observed);
  const desired = new Set(input.desired);
  for (const networkId of input.observed) {
    if (desired.has(networkId)) continue;
    const { action } = yield* Services.serverActions.detachServerFromNetwork({
      id: input.serverId,
      network: networkId,
    });
    yield* waitForAction(action);
  }
  for (const networkId of input.desired) {
    if (observed.has(networkId)) continue;
    const { action } = yield* Services.serverActions.attachServerToNetwork({
      id: input.serverId,
      network: networkId,
    });
    yield* waitForAction(action);
  }
});

const syncVolumes = Effect.fn(function* (input: {
  serverId: number;
  observed: ReadonlyArray<number>;
  desired: ReadonlyArray<number>;
}) {
  const observed = new Set(input.observed);
  const desired = new Set(input.desired);
  for (const volumeId of input.observed) {
    if (desired.has(volumeId)) continue;
    const { action } = yield* Services.volumeActions.detachVolume({
      id: volumeId,
    });
    yield* waitForAction(action);
  }
  for (const volumeId of input.desired) {
    if (observed.has(volumeId)) continue;
    const { action } = yield* Services.volumeActions.attachVolume({
      id: volumeId,
      server: input.serverId,
    });
    yield* waitForAction(action);
  }
});

const firewallApplyItems = (serverId: number) => [
  { type: "server" as const, server: { id: serverId } },
];

const syncFirewalls = Effect.fn(function* (input: {
  serverId: number;
  observed: ReadonlyArray<number>;
  desired: ReadonlyArray<number>;
}) {
  const observed = new Set(input.observed);
  const desired = new Set(input.desired);
  for (const firewallId of input.observed) {
    if (desired.has(firewallId)) continue;
    const { actions } =
      yield* Services.firewallActions.removeFirewallFromResources({
        id: firewallId,
        remove_from: firewallApplyItems(input.serverId),
      });
    yield* waitForActions(actions);
  }
  for (const firewallId of input.desired) {
    if (observed.has(firewallId)) continue;
    const { actions } =
      yield* Services.firewallActions.applyFirewallToResources({
        id: firewallId,
        apply_to: firewallApplyItems(input.serverId),
      });
    yield* waitForActions(actions);
  }
});

const syncPlacementGroup = Effect.fn(function* (input: {
  serverId: number;
  observed: number | undefined;
  desired: number | undefined;
}) {
  if (input.desired === input.observed) return;
  if (input.observed !== undefined) {
    const { action } =
      yield* Services.serverActions.removeServerFromPlacementGroup({
        id: input.serverId,
      });
    yield* waitForAction(action);
  }
  if (input.desired !== undefined) {
    const { action } = yield* Services.serverActions.addServerToPlacementGroup({
      id: input.serverId,
      placement_group: input.desired,
    });
    yield* waitForAction(action);
  }
});

export const ServerProvider = () =>
  Provider.succeed(Server, {
    stables: [
      "id",
      "serverId",
      "created",
      "location",
      "locationId",
      "ipv4",
      "ipv6",
      "privateKey",
      "deploySshKeyId",
    ],
    list: Effect.fn(function* () {
      const items = yield* Services.servers.listServers
        .items({ label_selector: alchemyStackSelector, per_page: 50 })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
        );
      return items.map(toAttrs);
    }),
    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      if (output !== undefined) {
        // Cloud-init runs once, on first boot — a changed init script can
        // only take effect on a freshly provisioned Server.
        if (news.userData !== olds?.userData) {
          return { action: "replace" } as const;
        }
        const location = news.location ?? DEFAULT_LOCATION;
        if (!sameRef(location, output.location, output.locationId)) {
          return { action: "replace" } as const;
        }
        if (!sameRef(news.serverType, output.serverType, output.serverTypeId)) {
          return { action: "replace" } as const;
        }
        const imageId = output.imageId;
        const imageMatches =
          output.image !== undefined && news.image === output.image
            ? true
            : imageId !== undefined && news.image === String(imageId);
        if (!imageMatches) {
          return { action: "replace" } as const;
        }
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const found = yield* observe({
        id,
        name: olds?.name ?? output?.name,
        outputId: output?.id ?? output?.serverId,
      });
      if (found === undefined) return undefined;
      const attrs = {
        ...toAttrs(found),
        privateKey: output?.privateKey,
        deploySshKeyId: output?.deploySshKeyId,
      };
      const owned = yield* hasAlchemyLabels(id, tagRecord(found.labels));
      return owned ? attrs : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = yield* createServerName(id, news.name, output?.name);
      const internalLabels = yield* createInternalLabels(id);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...internalLabels,
      };
      const location = news.location ?? DEFAULT_LOCATION;
      const userSshKeyIds = idsOf(news.sshKeys, ["id"]);
      const networkIds = idsOf(news.networks, ["networkId", "id"]);
      const firewallIds = idsOf(news.firewalls, ["id"]);
      const volumeIds = idsOf(news.volumes, ["id"]);
      const placementGroupId = numericId(news.placementGroup, ["id"]);
      const startAfterCreate = news.startAfterCreate ?? true;
      const desiredProtection = news.deleteProtection ?? false;
      const userData = yield* buildUserData({ name, userData: news.userData });

      // Observe by id then desired name only. Do not fall back to
      // ownership labels — a create-first replacement still has the old
      // generation live under the same logical id.
      let current =
        output?.id !== undefined ? yield* getById(output.id) : undefined;
      if (current === undefined) {
        current = yield* getByName(name);
      }

      const deployKey = yield* ensureDeployKey({
        name,
        labels: desiredLabels,
        output,
        creating: current === undefined,
      });
      const sshKeyIds = [
        ...userSshKeyIds,
        ...(deployKey.deploySshKeyId !== undefined
          ? [deployKey.deploySshKeyId]
          : []),
      ];

      // Ensure — create only when missing. A Conflict is a race with a
      // peer reconciler or a name that just became visible; re-observe.
      if (current === undefined) {
        const created = yield* Services.servers
          .createServer({
            name,
            server_type: news.serverType,
            image: news.image,
            location,
            labels: desiredLabels,
            start_after_create: startAfterCreate,
            ssh_keys: sshKeyIds.length > 0 ? sshKeyIds : undefined,
            networks: networkIds.length > 0 ? networkIds : undefined,
            firewalls:
              firewallIds.length > 0
                ? firewallIds.map((firewall) => ({ firewall }))
                : undefined,
            volumes: volumeIds.length > 0 ? volumeIds : undefined,
            placement_group: placementGroupId,
            user_data: userData,
            public_net:
              news.enableIpv4 !== undefined || news.enableIpv6 !== undefined
                ? {
                    enable_ipv4: news.enableIpv4 ?? true,
                    enable_ipv6: news.enableIpv6 ?? true,
                  }
                : undefined,
          })
          .pipe(
            Effect.retry({
              while: (e) =>
                e._tag === "ServerLimitExceeded" ||
                e._tag === "ServerPlacementError",
              schedule: Schedule.spaced("5 seconds"),
              times: 8,
            }),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
            // The deploy key is a side-effect, not a stack resource. If
            // createServer fails after minting it (quota skip, timeout),
            // nothing is persisted for Server.delete to clean up.
            Effect.tapError(() =>
              deleteDeployKey(deployKey.deploySshKeyId).pipe(Effect.ignore),
            ),
          );
        if (created !== undefined) {
          if (created.action) {
            yield* waitForActions([created.action, ...created.next_actions]);
          }
          current = yield* waitUntilReady(created.server.id);
        } else {
          const hit = yield* getByName(name);
          if (hit === undefined) {
            return yield* new ServerNotResolved({ name });
          }
          current = yield* waitUntilReady(hit.id);
        }
      }

      // Sync name + labels against observed cloud labels, not olds.
      // updateServer overwrites the full label set.
      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const needsMeta =
        current.name !== name || upsert.length > 0 || removed.length > 0;
      if (needsMeta) {
        yield* Services.servers.updateServer({
          id: current.id,
          name,
          labels: desiredLabels,
        });
        current = yield* refresh(current.id);
      }

      if (current.protection.delete !== desiredProtection) {
        const { action } = yield* Services.serverActions.changeServerProtection(
          {
            id: current.id,
            delete: desiredProtection,
            rebuild: desiredProtection,
          },
        );
        yield* waitForAction(action);
        current = yield* refresh(current.id);
      }

      // Attachment props are opt-in: omit them to leave Volume / Firewall
      // / Network / PlacementGroup as the owner of the relationship.
      if (news.networks !== undefined) {
        const observed = current.private_net
          .map((item) => item.network)
          .filter((netId): netId is number => typeof netId === "number");
        if (!setEquals(observed, networkIds)) {
          yield* syncNetworks({
            serverId: current.id,
            observed,
            desired: networkIds,
          });
          current = yield* refresh(current.id);
        }
      }

      if (news.volumes !== undefined) {
        const observed = current.volumes ?? [];
        if (!setEquals(observed, volumeIds)) {
          yield* syncVolumes({
            serverId: current.id,
            observed,
            desired: volumeIds,
          });
          current = yield* refresh(current.id);
        }
      }

      if (news.firewalls !== undefined) {
        const observed = (current.public_net.firewalls ?? [])
          .map((item) => item.id)
          .filter((fwId): fwId is number => typeof fwId === "number");
        if (!setEquals(observed, firewallIds)) {
          yield* syncFirewalls({
            serverId: current.id,
            observed,
            desired: firewallIds,
          });
          current = yield* refresh(current.id);
        }
      }

      if (news.placementGroup !== undefined) {
        const observed = current.placement_group?.id;
        if (observed !== placementGroupId) {
          yield* syncPlacementGroup({
            serverId: current.id,
            observed,
            desired: placementGroupId,
          });
          current = yield* refresh(current.id);
        }
      }

      return {
        ...toAttrs(current),
        privateKey: deployKey.privateKey,
        deploySshKeyId: deployKey.deploySshKeyId,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      const current = yield* getById(output.id);
      if (current !== undefined) {
        if (current.protection.delete) {
          const { action } =
            yield* Services.serverActions.changeServerProtection({
              id: current.id,
              delete: false,
              rebuild: false,
            });
          yield* waitForAction(action);
        }

        const deleted = yield* Services.servers
          .deleteServer({ id: current.id })
          .pipe(
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
            Effect.retry({
              while: retryable,
              times: 8,
              schedule: backoff,
            }),
          );
        if (deleted?.action) {
          yield* waitForAction(deleted.action);
        }
        yield* waitUntilGone(current.id);
      }

      yield* deleteDeployKey(output.deploySshKeyId);
    }),
  });
