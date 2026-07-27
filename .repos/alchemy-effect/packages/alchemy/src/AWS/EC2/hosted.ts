import * as iam from "@distilled.cloud/aws/iam";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as rolldown from "rolldown";
import * as Bundle from "../../Bundle/Bundle.ts";
import { findCwdForBundle, resolveMainPath } from "../../Bundle/TempRoot.ts";
import type { ScopedPlanStatusSession } from "../../Cli/Cli.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import type { PlatformProps } from "../../Platform.ts";
import type { ResourceBinding } from "../../Resource.ts";
import {
  createHostRuntimeContext,
  type HostRuntimeContext,
} from "../../Server/Process.ts";
import { createInternalTags, createTagsList, hasTags } from "../../Tags.ts";
import { sha256 } from "../../Util/sha256.ts";
import { zipCode } from "../../Util/zip.ts";
import { Assets } from "../Assets.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";

/**
 * Binding contract accepted by EC2-hosted runtimes: environment variables and
 * IAM policy statements attached by capability bindings.
 */
export interface Ec2HostedBinding {
  /** Environment variables injected into the hosted runtime. */
  env?: Record<string, any>;
  /** IAM policy statements attached to the instance profile role. */
  policyStatements?: PolicyStatement[];
}

/**
 * Shared props for EC2-backed hosted runtimes (an Instance that bundles and
 * runs an application entrypoint).
 */
export interface Ec2HostedProps extends PlatformProps {
  /** AMI ID to launch the instance from. */
  imageId: string;
  /** EC2 instance type, e.g. `t3.micro`. */
  instanceType: string;
  /** Name of an EC2 key pair for SSH access. */
  keyName?: Input<string>;
  /** Existing instance profile to attach instead of a managed one. */
  instanceProfileName?: string;
  /** Additional user-data script prepended to the runtime bootstrap. */
  userData?: string;
  /** Subnet to launch the instance into. */
  subnetId?: any;
  /** Security groups attached to the instance. */
  securityGroupIds?: readonly any[];
  /** Whether to associate a public IP address. */
  associatePublicIpAddress?: boolean;
  /** Static private IP address within the subnet. */
  privateIpAddress?: string;
  /** Availability Zone to launch into. */
  availabilityZone?: string;
  /** Tags applied to the instance. */
  tags?: Record<string, string>;
  /** Path to the application entrypoint to bundle and run on the instance. */
  main?: string;
  /** Named export of the handler within `main`. */
  handler?: string;
  /** Port the hosted HTTP server listens on. */
  port?: number;
  /** Environment variables injected into the hosted runtime. */
  env?: Record<string, any>;
  /** Overrides for the rolldown bundling of `main`. */
  build?: {
    /** Rolldown input options overrides. */
    input?: Partial<rolldown.InputOptions>;
    /** Rolldown output options overrides. */
    output?: Partial<rolldown.OutputOptions>;
  };
  /** Managed policy ARNs attached to the instance role. */
  roleManagedPolicyArns?: string[];
}

export interface Ec2HostedRuntimeState {
  userData?: string;
  roleName?: string;
  roleArn?: string;
  policyName?: string;
  instanceProfileName?: string;
  instanceProfileArn?: string;
  managedIam?: boolean;
  runtimeUnitName?: string;
  assetPrefix?: string;
  code?: {
    hash: string;
  };
}

export interface Ec2HostedCleanupState {
  roleName?: string;
  policyName?: string;
  instanceProfileName?: string;
  managedIam?: boolean;
  assetPrefix?: string;
}

/**
 * Deploy-time / plan-time host context for EC2-backed platforms that bundle a
 * long-lived program (`exports.program`) and collect background work via `run`
 * / HTTP handlers via `serve`. Alias of the shared {@link HostRuntimeContext}.
 */
export type Ec2HostRuntimeContext = HostRuntimeContext;

export const createEc2HostRuntimeContext = createHostRuntimeContext;

export const createEc2HostedSupport = ({
  stackName,
  stage,
  virtualEntryPlugin,
  resourceType,
}: {
  stackName: string;
  stage: string;
  fs: FileSystem.FileSystem;
  virtualEntryPlugin: (
    content: (importPath: string) => string,
  ) => rolldown.Plugin;
  resourceType: string;
}) => {
  const alchemyEnv = {
    ALCHEMY_STACK_NAME: stackName,
    ALCHEMY_STAGE: stage,
    ALCHEMY_PHASE: "runtime",
  };

  const createRoleName = (id: string) =>
    createPhysicalName({
      id: `${id}-role`,
      maxLength: 64,
    });

  const createPolicyName = (id: string) =>
    createPhysicalName({
      id: `${id}-policy`,
      maxLength: 128,
    });

  const createManagedProfileName = (id: string) =>
    createPhysicalName({
      id: `${id}-profile`,
      maxLength: 128,
    });

  const createRuntimeUnitName = (id: string) =>
    createPhysicalName({
      id: `${id}-instance`,
      maxLength: 64,
      lowercase: true,
    }).pipe(Effect.map((name) => name.replaceAll(/[^a-z0-9-]/g, "-")));

  const normalizeSecurityGroups = (groups?: readonly string[]) =>
    [...(groups ?? [])].sort((a, b) => a.localeCompare(b));

  const bundleProgram = Effect.fn(function* (
    id: string,
    props: Ec2HostedProps,
  ) {
    if (!props.main) {
      return yield* Effect.fail(
        new Error(
          `${resourceType} '${id}' requires 'main' when bundling a hosted process`,
        ),
      );
    }

    const handler = props.handler ?? "default";
    const realMain = yield* resolveMainPath(props.main);
    const cwd = yield* findCwdForBundle(realMain);

    const buildBundle = Effect.fn(function* (
      entry: string,
      plugins?: rolldown.RolldownPluginOption,
    ) {
      return yield* Bundle.build(
        {
          ...props.build?.input,
          input: entry,
          cwd,
          platform: "node",
          // The hosted process runs under `bun` (installed by the user-data);
          // keep `bun`/`bun:*` external and resolve the `bun` export condition
          // so `@effect/platform-bun` picks its Bun implementations.
          external: [
            "bun",
            "bun:*",
            ...((props.build?.input?.external as string[] | undefined) ?? []),
          ],
          resolve: {
            conditionNames: ["bun", "import", "module", "default"],
            ...props.build?.input?.resolve,
          },
          plugins: [props.build?.input?.plugins, plugins],
        },
        {
          ...props.build?.output,
          format: "esm",
          sourcemap: props.build?.output?.sourcemap ?? false,
          minify: props.build?.output?.minify ?? false,
          entryFileNames: "index.mjs",
        },
      );
    });

    const bundleOutput = props.isExternal
      ? yield* buildBundle(realMain)
      : yield* buildBundle(
          realMain,
          virtualEntryPlugin(
            (importPath) => `
import { BunServices } from "@effect/platform-bun";
import { BunHttpServer } from "alchemy/Http";
import { Stack } from "alchemy/Stack";
import { reifyBoundConfigProvider } from "alchemy/Runtime";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Region from "@distilled.cloud/aws/Region";

import { ${handler} as handler } from ${JSON.stringify(importPath)};

const platform = Layer.mergeAll(
  BunServices.layer,
  FetchHttpClient.layer,
  Logger.layer([Logger.consolePretty()]),
);

// Resolve the bundled program (the runners registered via host.run / serve)
// and run it with a Bun HTTP server bound to PORT, so a returned { fetch }
// handler is actually served and host.run loops stay alive.
const program = handler.pipe(
  Effect.flatMap((instance) => instance.RuntimeContext.exports),
  Effect.flatMap((exports) => exports.program),
  Effect.provide(
    Layer.effect(
      Stack,
      Effect.all([
        Config.string("ALCHEMY_STACK_NAME"),
        Config.string("ALCHEMY_STAGE")
      ]).pipe(
        Effect.map(([name, stage]) => ({
          name,
          stage,
          bindings: {},
          resources: {}
        }))
      )
    ).pipe(
      Layer.provideMerge(Credentials.fromEnv()),
      Layer.provideMerge(Region.fromEnv()),
      Layer.provideMerge(BunHttpServer()),
      Layer.provideMerge(platform),
      Layer.provideMerge(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          reifyBoundConfigProvider(ConfigProvider.fromEnv(), process.env)
        )
      ),
    )
  ),
  Effect.scoped
);

console.log("Instance bootstrap starting...");
await Effect.runPromise(program).catch((err) => {
  console.error("Instance bootstrap failed:", err);
  process.exit(1);
});
`,
          ),
        );

    // Zip every emitted file: the entry becomes `index.mjs` (what the systemd
    // unit runs) and shared chunks keep their `*.js` names so the entry's
    // relative imports resolve. Dropping a chunk crashes the process at start.
    const toBytes = (content: string | Uint8Array<ArrayBufferLike>) =>
      typeof content === "string" ? new TextEncoder().encode(content) : content;
    const [entryFile, ...chunkFiles] = bundleOutput.files;
    const archive = yield* zipCode(
      toBytes(entryFile.content),
      chunkFiles.map((file) => ({
        path: file.path,
        content: toBytes(file.content),
      })),
    );
    return { archive, hash: bundleOutput.hash };
  });

  const quoteEnvValue = (value: any) => {
    const text =
      typeof value === "string" ? value : JSON.stringify(value ?? null);
    return `'${text.replaceAll(/'/g, `'""'`).replaceAll(/\n/g, "\\n")}'`;
  };

  const renderEnvFile = (env: Record<string, any>) =>
    Object.entries(env)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${quoteEnvValue(value)}`)
      .join("\n");

  const renderHostedUserData = Effect.fn(function* ({
    unitName,
    bundleKey,
    envKey,
    region,
  }: {
    unitName: string;
    bundleKey: string;
    envKey: string;
    region: string;
  }) {
    const appDir = `/opt/${unitName}`;
    const bucket = yield* Assets.BucketName;
    // User-data runs once via cloud-init's `scripts-user` (once-per-instance),
    // and is skipped on any subsequent boot — so it must NOT carry the work
    // that can fail transiently (bun install over the network, S3 sync). It
    // only writes the setup script + unit and enables the service. The systemd
    // service (Restart=always) runs the setup on every start, so a flaky bun
    // install / S3 read self-heals and the service survives reboots.
    return `#!/bin/bash
set -uo pipefail

mkdir -p "${appDir}"

cat >/usr/local/bin/${unitName}-setup.sh <<'SETUP_EOF'
#!/bin/bash
set -uo pipefail
export HOME=/root

# unzip (needed below) — install if missing.
command -v unzip >/dev/null 2>&1 || {
  (command -v dnf >/dev/null 2>&1 && dnf install -y unzip) \
    || (command -v yum >/dev/null 2>&1 && yum install -y unzip) || true
}

# AWS CLI — preinstalled on Amazon Linux 2023; install v2 otherwise.
command -v aws >/dev/null 2>&1 || {
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscliv2.zip \
    && (cd /tmp && unzip -q -o awscliv2.zip && ./aws/install) || true
}

# bun — retry the network install a few times.
if [ ! -x /root/.bun/bin/bun ]; then
  for attempt in 1 2 3 4 5; do
    curl -fsSL https://bun.sh/install | bash && break
    sleep 5
  done
fi

# Sync the bundle + env from S3 (must succeed for the service to start).
set -e
mkdir -p "${appDir}"
aws s3 cp "s3://${bucket}/${bundleKey}" "${appDir}/bundle.zip" --region "${region}"
aws s3 cp "s3://${bucket}/${envKey}" "${appDir}/env" --region "${region}"
rm -f "${appDir}/index.mjs"
unzip -o "${appDir}/bundle.zip" -d "${appDir}"
SETUP_EOF
chmod +x /usr/local/bin/${unitName}-setup.sh

cat >/etc/systemd/system/${unitName}.service <<'UNIT_EOF'
[Unit]
Description=Alchemy EC2 instance runtime ${unitName}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${appDir}
ExecStartPre=/usr/local/bin/${unitName}-setup.sh
EnvironmentFile=-${appDir}/env
ExecStart=/root/.bun/bin/bun ${appDir}/index.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT_EOF

systemctl daemon-reload
systemctl enable --now ${unitName}.service
`;
  });

  const mergeUserData = (hosted: string, userData?: string) => {
    if (!userData) {
      return hosted;
    }
    return `${hosted}\n\n# User supplied bootstrap\n${userData.replace(
      /^#!\/bin\/bash\s*/,
      "",
    )}`;
  };

  const listAttachedPolicyArns = (roleName: string) =>
    iam
      .listAttachedRolePolicies({
        RoleName: roleName,
      })
      .pipe(
        Effect.map((result) =>
          (result.AttachedPolicies ?? [])
            .map((policy) => policy.PolicyArn)
            .filter((policyArn): policyArn is string => Boolean(policyArn)),
        ),
      );

  const attachManagedPolicies = Effect.fn(function* ({
    roleName,
    managedPolicyArns,
  }: {
    roleName: string;
    managedPolicyArns: string[];
  }) {
    const attached = new Set(yield* listAttachedPolicyArns(roleName));
    for (const policyArn of managedPolicyArns) {
      if (!attached.has(policyArn)) {
        yield* iam.attachRolePolicy({
          RoleName: roleName,
          PolicyArn: policyArn,
        });
      }
    }
  });

  const ensureManagedRole = Effect.fn(function* ({
    id,
    roleName,
    managedPolicyArns,
  }: {
    id: string;
    roleName: string;
    managedPolicyArns: string[];
  }) {
    const { accountId } = yield* AWSEnvironment.current;
    const tags = yield* createInternalTags(id);
    const role = yield* iam
      .createRole({
        RoleName: roleName,
        AssumeRolePolicyDocument: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: {
                Service: "ec2.amazonaws.com",
              },
              Action: "sts:AssumeRole",
            },
          ],
        }),
        Tags: createTagsList(tags),
      })
      .pipe(
        Effect.catchTag("EntityAlreadyExistsException", () =>
          iam.getRole({ RoleName: roleName }).pipe(
            Effect.filterOrFail(
              (existing) => hasTags(tags, existing.Role?.Tags),
              () =>
                new Error(
                  `Role '${roleName}' already exists and is not managed by alchemy`,
                ),
            ),
          ),
        ),
      );

    yield* attachManagedPolicies({
      roleName,
      managedPolicyArns,
    });

    return role.Role?.Arn ?? `arn:aws:iam::${accountId}:role/${roleName}`;
  });

  const ensureManagedInstanceProfile = Effect.fn(function* ({
    id,
    profileName,
    roleName,
  }: {
    id: string;
    profileName: string;
    roleName: string;
  }) {
    const tags = yield* createInternalTags(id);
    yield* iam
      .createInstanceProfile({
        InstanceProfileName: profileName,
        Tags: createTagsList(tags),
      })
      .pipe(Effect.catchTag("EntityAlreadyExistsException", () => Effect.void));

    const profile = yield* iam.getInstanceProfile({
      InstanceProfileName: profileName,
    });
    const currentRoleName = profile.InstanceProfile.Roles?.[0]?.RoleName;

    if (currentRoleName && currentRoleName !== roleName) {
      yield* iam
        .removeRoleFromInstanceProfile({
          InstanceProfileName: profileName,
          RoleName: currentRoleName,
        })
        .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
    }

    if (currentRoleName !== roleName) {
      yield* iam.addRoleToInstanceProfile({
        InstanceProfileName: profileName,
        RoleName: roleName,
      });
    }

    const refreshed = yield* iam.getInstanceProfile({
      InstanceProfileName: profileName,
    });
    return {
      instanceProfileName: refreshed.InstanceProfile.InstanceProfileName,
      instanceProfileArn: refreshed.InstanceProfile.Arn,
    };
  });

  const attachHostedBindings = Effect.fn(function* ({
    roleName,
    policyName,
    assetPrefix,
    bindings,
  }: {
    roleName: string;
    policyName: string;
    assetPrefix: string;
    bindings: ResourceBinding<Ec2HostedBinding>[];
  }) {
    const activeBindings = bindings.filter(
      (binding: ResourceBinding<Ec2HostedBinding> & { action?: string }) =>
        binding.action !== "delete",
    );

    const env = activeBindings
      .map((binding) => binding?.data?.env)
      .reduce((acc, value) => ({ ...acc, ...value }), {});

    const policyStatements = activeBindings.flatMap(
      (binding) =>
        binding?.data?.policyStatements?.map((statement) => ({
          ...statement,
          Sid: statement.Sid?.replace(/[^A-Za-z0-9]+/gi, ""),
        })) ?? [],
    );

    policyStatements.push({
      Sid: undefined,
      Effect: "Allow",
      Action: ["s3:GetObject"],
      Resource: [`arn:aws:s3:::${yield* Assets.BucketName}/${assetPrefix}/*`],
    });

    yield* iam.putRolePolicy({
      RoleName: roleName,
      PolicyName: policyName,
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: policyStatements,
      }),
    });

    return env;
  });

  const uploadHostedArtifacts = Effect.fn(function* ({
    bundleKey,
    envKey,
    archive,
    env,
  }: {
    bundleKey: string;
    envKey: string;
    archive: Uint8Array<ArrayBufferLike>;
    env: Record<string, any>;
  }) {
    const assets = yield* Assets;
    const contentHash = yield* sha256(archive);
    const uploadedAssetKey = yield* assets.uploadAsset(contentHash, archive);
    yield* s3.copyObject({
      Bucket: yield* assets.bucketName,
      Key: bundleKey,
      CopySource: `${yield* assets.bucketName}/${uploadedAssetKey}`,
    });
    yield* s3.putObject({
      Bucket: yield* assets.bucketName,
      Key: envKey,
      Body: renderEnvFile(env),
      ContentType: "text/plain; charset=utf-8",
    });
  });

  const resolveHostedRuntime = Effect.fn(function* ({
    id,
    news,
    bindings,
    output,
  }: {
    id: string;
    news: Ec2HostedProps;
    bindings: ResourceBinding<Ec2HostedBinding>[];
    output?: Ec2HostedRuntimeState;
  }) {
    if (!news.main) {
      return {
        userData: news.userData,
        roleName: output?.roleName,
        roleArn: output?.roleArn,
        policyName: output?.policyName,
        instanceProfileName:
          news.instanceProfileName ?? output?.instanceProfileName,
        instanceProfileArn: output?.instanceProfileArn,
        managedIam: output?.managedIam ?? false,
        runtimeUnitName: output?.runtimeUnitName,
        assetPrefix: output?.assetPrefix,
        code: output?.code,
      } satisfies Ec2HostedRuntimeState;
    }

    if (
      news.instanceProfileName &&
      (news.roleManagedPolicyArns?.length ?? 0) > 0
    ) {
      return yield* Effect.fail(
        new Error(
          `${resourceType} does not support roleManagedPolicyArns with a custom instanceProfileName in host mode`,
        ),
      );
    }

    const { region } = yield* AWSEnvironment.current;
    const runtimeUnitName =
      output?.runtimeUnitName ?? (yield* createRuntimeUnitName(id));
    const assetPrefix = output?.assetPrefix ?? `ec2/${runtimeUnitName}`;
    const bundleKey = `${assetPrefix}/bundle.zip`;
    const envKey = `${assetPrefix}/env`;
    const policyName = output?.policyName ?? (yield* createPolicyName(id));

    const managedIam = !news.instanceProfileName;
    let roleName: string;
    let roleArn: string | undefined;
    let instanceProfileName: string | undefined;
    let instanceProfileArn: string | undefined;

    if (managedIam) {
      roleName = output?.roleName ?? (yield* createRoleName(id));
      roleArn =
        output?.roleArn ??
        (yield* ensureManagedRole({
          id,
          roleName,
          managedPolicyArns: news.roleManagedPolicyArns ?? [],
        }));
      const profileName =
        output?.instanceProfileName ?? (yield* createManagedProfileName(id));
      const profile = yield* ensureManagedInstanceProfile({
        id,
        profileName,
        roleName,
      });
      instanceProfileName = profile.instanceProfileName;
      instanceProfileArn = profile.instanceProfileArn;
    } else {
      const profile = yield* iam.getInstanceProfile({
        InstanceProfileName: news.instanceProfileName!,
      });
      const role = profile.InstanceProfile.Roles?.[0];
      if (!role?.RoleName) {
        return yield* Effect.fail(
          new Error(
            `Instance profile '${news.instanceProfileName}' must have a role attached for host mode`,
          ),
        );
      }
      roleName = role.RoleName;
      roleArn = role.Arn;
      instanceProfileName = profile.InstanceProfile.InstanceProfileName;
      instanceProfileArn = profile.InstanceProfile.Arn;
    }

    const bindingEnv = yield* attachHostedBindings({
      roleName,
      policyName,
      assetPrefix,
      bindings,
    });
    const env = {
      ...bindingEnv,
      ...alchemyEnv,
      ...(news.port !== undefined ? { PORT: news.port } : {}),
      ...news.env,
    };

    const { archive, hash } = yield* bundleProgram(id, news);
    yield* uploadHostedArtifacts({
      bundleKey,
      envKey,
      archive,
      env,
    });

    const hostedUserData = yield* renderHostedUserData({
      unitName: runtimeUnitName,
      bundleKey,
      envKey,
      region,
    });

    return {
      userData: mergeUserData(hostedUserData, news.userData),
      roleName,
      roleArn,
      policyName,
      instanceProfileName,
      instanceProfileArn,
      managedIam,
      runtimeUnitName,
      assetPrefix,
      code: {
        hash,
      },
    } satisfies Ec2HostedRuntimeState;
  });

  const cleanupHostedRuntime = Effect.fn(function* ({
    output,
    session,
  }: {
    output: Ec2HostedCleanupState;
    session?: Pick<ScopedPlanStatusSession, "note">;
  }) {
    if (output.roleName && output.policyName) {
      yield* iam
        .deleteRolePolicy({
          RoleName: output.roleName,
          PolicyName: output.policyName,
        })
        .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
    }

    if (output.managedIam && output.instanceProfileName && output.roleName) {
      const attachedPolicyArns = yield* listAttachedPolicyArns(
        output.roleName,
      ).pipe(Effect.catch(() => Effect.succeed([])));
      yield* iam
        .removeRoleFromInstanceProfile({
          InstanceProfileName: output.instanceProfileName,
          RoleName: output.roleName,
        })
        .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
      yield* iam
        .deleteInstanceProfile({
          InstanceProfileName: output.instanceProfileName,
        })
        .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
      for (const policyArn of attachedPolicyArns) {
        yield* iam
          .detachRolePolicy({
            RoleName: output.roleName,
            PolicyArn: policyArn,
          })
          .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
      }
      yield* iam
        .deleteRole({
          RoleName: output.roleName,
        })
        .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
    }

    if (output.assetPrefix) {
      for (const key of [
        `${output.assetPrefix}/bundle.zip`,
        `${output.assetPrefix}/env`,
      ]) {
        yield* s3
          .deleteObject({
            Bucket: yield* Assets.BucketName,
            Key: key,
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }
    }

    if (session) {
      yield* session.note(`Cleaned hosted assets for ${resourceType}`);
    }
  });

  const buildEc2NetworkData = ({
    subnetId,
    securityGroupIds,
    associatePublicIpAddress,
    privateIpAddress,
  }: Pick<
    Ec2HostedProps,
    | "subnetId"
    | "securityGroupIds"
    | "associatePublicIpAddress"
    | "privateIpAddress"
  >) => {
    const groups = normalizeSecurityGroups(securityGroupIds);
    const usePrimaryNetworkInterface =
      subnetId !== undefined ||
      associatePublicIpAddress !== undefined ||
      privateIpAddress !== undefined;

    return {
      usePrimaryNetworkInterface,
      groups,
      networkInterfaces: usePrimaryNetworkInterface
        ? [
            {
              DeviceIndex: 0,
              SubnetId: subnetId,
              Groups: groups.length > 0 ? groups : undefined,
              AssociatePublicIpAddress: associatePublicIpAddress,
              PrivateIpAddress: privateIpAddress,
              DeleteOnTermination: true,
            },
          ]
        : undefined,
    };
  };

  const buildLaunchTemplateData = (
    news: Pick<
      Ec2HostedProps,
      | "imageId"
      | "instanceType"
      | "keyName"
      | "subnetId"
      | "securityGroupIds"
      | "associatePublicIpAddress"
      | "privateIpAddress"
      | "availabilityZone"
      | "tags"
    >,
    runtime: Pick<Ec2HostedRuntimeState, "userData" | "instanceProfileName">,
  ) => {
    const encodedUserData = runtime.userData
      ? Buffer.from(runtime.userData).toString("base64")
      : undefined;
    const network = buildEc2NetworkData(news);
    const instanceTags = {
      ...news.tags,
    };

    return {
      ImageId: news.imageId,
      InstanceType: news.instanceType,
      KeyName: news.keyName as string | undefined,
      IamInstanceProfile: runtime.instanceProfileName
        ? {
            Name: runtime.instanceProfileName,
          }
        : undefined,
      UserData: encodedUserData,
      Placement: news.availabilityZone
        ? {
            AvailabilityZone: news.availabilityZone,
          }
        : undefined,
      NetworkInterfaces: network.networkInterfaces,
      SubnetId: network.usePrimaryNetworkInterface ? undefined : news.subnetId,
      SecurityGroupIds: network.usePrimaryNetworkInterface
        ? undefined
        : network.groups.length > 0
          ? network.groups
          : undefined,
      PrivateIpAddress: network.usePrimaryNetworkInterface
        ? undefined
        : news.privateIpAddress,
      TagSpecifications:
        Object.keys(instanceTags).length > 0
          ? [
              {
                ResourceType: "instance",
                Tags: createTagsList(instanceTags),
              },
            ]
          : undefined,
    };
  };

  return {
    normalizeSecurityGroups,
    buildLaunchTemplateData,
    resolveHostedRuntime,
    cleanupHostedRuntime,
  };
};
