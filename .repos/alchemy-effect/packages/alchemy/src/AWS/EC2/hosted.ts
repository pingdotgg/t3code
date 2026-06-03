import * as iam from "@distilled.cloud/aws/iam";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as rolldown from "rolldown";
import * as Bundle from "../../Bundle/Bundle.ts";
import { findCwdForBundle } from "../../Bundle/TempRoot.ts";
import type { ScopedPlanStatusSession } from "../../Cli/Cli.ts";
import * as Output from "../../Output.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import type { PlatformProps } from "../../Platform.ts";
import type { ResourceBinding } from "../../Resource.ts";
import type { ProcessContext } from "../../Server/Process.ts";
import { createInternalTags, createTagsList, hasTags } from "../../Tags.ts";
import { sha256 } from "../../Util/sha256.ts";
import { zipCode } from "../../Util/zip.ts";
import { Assets } from "../Assets.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";

export interface Ec2HostedBinding {
  env?: Record<string, any>;
  policyStatements?: PolicyStatement[];
}

export interface Ec2HostedProps extends PlatformProps {
  imageId: string;
  instanceType: string;
  keyName?: string;
  instanceProfileName?: string;
  userData?: string;
  subnetId?: any;
  securityGroupIds?: readonly any[];
  associatePublicIpAddress?: boolean;
  privateIpAddress?: string;
  availabilityZone?: string;
  tags?: Record<string, string>;
  main?: string;
  handler?: string;
  port?: number;
  env?: Record<string, any>;
  build?: {
    input?: Partial<rolldown.InputOptions>;
    output?: Partial<rolldown.OutputOptions>;
  };
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
 * long-lived program (`exports.program`) and collect background work via `run`.
 */
export interface Ec2HostRuntimeContext extends ProcessContext {
  exports: Effect.Effect<{
    readonly program: Effect.Effect<void, never, any>;
  }>;
}

export const createEc2HostRuntimeContext =
  (type: string) =>
  (id: string): Ec2HostRuntimeContext => {
    const runners: Effect.Effect<void, never, any>[] = [];
    const env: Record<string, any> = {};

    return {
      Type: type,
      id,
      env,
      set: (bindingId: string, output: Output.Output) =>
        Effect.sync(() => {
          const key = bindingId.replaceAll(/[^a-zA-Z0-9]/g, "_");
          env[key] = output.pipe(Output.map((value) => JSON.stringify(value)));
          return key;
        }),
      get: <T>(key: string) =>
        Config.string(key).pipe(
          Effect.flatMap((value) =>
            Effect.try({
              try: () => JSON.parse(value) as T,
              catch: (error) => error as Error,
            }),
          ),
          Effect.catch((cause) =>
            Effect.die(
              new Error(`Failed to get environment variable: ${key}`, {
                cause,
              }),
            ),
          ),
        ),
      run: (effect: Effect.Effect<void, never, any>) =>
        Effect.sync(() => {
          runners.push(effect);
        }),
      exports: Effect.sync(() => ({
        program: Effect.all(runners, { concurrency: "unbounded" }),
      })),
    } satisfies Ec2HostRuntimeContext;
  };

export const createEc2HostedSupport = ({
  accountId,
  region,
  stackName,
  stage,
  fs,
  virtualEntryPlugin,
  assets,
  resourceType,
}: {
  accountId: string;
  region: string;
  stackName: string;
  stage: string;
  fs: FileSystem.FileSystem;
  virtualEntryPlugin: (
    content: (importPath: string) => string,
  ) => rolldown.Plugin;
  assets: typeof Assets.Service | undefined;
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
    const realMain = yield* fs.realPath(props.main);
    const cwd = yield* findCwdForBundle(realMain);

    const buildBundle = Effect.fnUntraced(function* (
      entry: string,
      plugins?: rolldown.RolldownPluginOption,
    ) {
      return yield* Bundle.build(
        {
          ...props.build?.input,
          input: entry,
          cwd,
          platform: "node",
          plugins: [props.build?.input?.plugins, plugins],
        },
        {
          ...props.build?.output,
          format: "esm",
          sourcemap: props.build?.output?.sourcemap ?? false,
          minify: props.build?.output?.minify ?? true,
          entryFileNames: "index.js",
        },
      );
    });

    const bundleOutput = props.isExternal
      ? yield* buildBundle(realMain)
      : yield* buildBundle(
          realMain,
          virtualEntryPlugin(
            (importPath) => `
import { NodeServices } from "@effect/platform-node";
import { Stack } from "alchemy/Stack";
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
  NodeServices.layer,
  FetchHttpClient.layer,
  Logger.layer([Logger.consolePretty()]),
);

const program = handler.pipe(
  Effect.flatMap((instance) => instance.RuntimeContext.exports.program),
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
      Layer.provideMerge(platform),
      Layer.provideMerge(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv()
        )
      ),
    )
  ),
  Effect.scoped
);

await Effect.runPromise(program);
`,
          ),
        );

    const mainFile = bundleOutput.files[0];
    const code =
      typeof mainFile.content === "string"
        ? new TextEncoder().encode(mainFile.content)
        : mainFile.content;

    const archive = yield* zipCode(code);
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

  const renderHostedUserData = ({
    unitName,
    bundleKey,
    envKey,
  }: {
    unitName: string;
    bundleKey: string;
    envKey: string;
  }) => {
    const appDir = `/opt/${unitName}`;
    return `#!/bin/bash
set -euo pipefail

PKG_INSTALL=""
if command -v dnf >/dev/null 2>&1; then
  PKG_INSTALL="dnf install -y"
elif command -v yum >/dev/null 2>&1; then
  PKG_INSTALL="yum install -y"
fi

if [ -n "$PKG_INSTALL" ]; then
  $PKG_INSTALL unzip curl awscli
fi

mkdir -p "${appDir}"

export HOME=/root
if [ ! -x /root/.bun/bin/bun ]; then
  curl -fsSL https://bun.sh/install | bash
fi

cat >/usr/local/bin/${unitName}-sync.sh <<'EOF'
#!/bin/bash
set -euo pipefail
mkdir -p "${appDir}"
aws s3 cp "s3://${assets?.bucketName}/${bundleKey}" "${appDir}/bundle.zip" --region "${region}"
aws s3 cp "s3://${assets?.bucketName}/${envKey}" "${appDir}/env" --region "${region}"
rm -f "${appDir}/index.mjs"
unzip -o "${appDir}/bundle.zip" -d "${appDir}"
EOF
chmod +x /usr/local/bin/${unitName}-sync.sh

cat >/etc/systemd/system/${unitName}.service <<'EOF'
[Unit]
Description=Alchemy EC2 instance runtime ${unitName}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${appDir}
ExecStartPre=/usr/local/bin/${unitName}-sync.sh
EnvironmentFile=${appDir}/env
ExecStart=/root/.bun/bin/bun ${appDir}/index.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

/usr/local/bin/${unitName}-sync.sh
systemctl daemon-reload
systemctl enable --now ${unitName}.service
`;
  };

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
      Resource: [`arn:aws:s3:::${assets?.bucketName}/${assetPrefix}/*`],
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
    if (!assets) {
      return yield* Effect.fail(
        new Error(
          `${resourceType} host mode requires the AWS assets bucket. Run bootstrap first.`,
        ),
      );
    }

    const contentHash = yield* sha256(archive);
    const uploadedAssetKey = yield* assets.uploadAsset(contentHash, archive);
    yield* s3.copyObject({
      Bucket: assets.bucketName,
      Key: bundleKey,
      CopySource: `${assets.bucketName}/${uploadedAssetKey}`,
    });
    yield* s3.putObject({
      Bucket: assets.bucketName,
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
    if (!assets) {
      return yield* Effect.fail(
        new Error(
          `${resourceType} host mode requires the AWS assets bucket. Run bootstrap first.`,
        ),
      );
    }

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

    const hostedUserData = renderHostedUserData({
      unitName: runtimeUnitName,
      bundleKey,
      envKey,
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

    if (assets && output.assetPrefix) {
      for (const key of [
        `${output.assetPrefix}/bundle.zip`,
        `${output.assetPrefix}/env`,
      ]) {
        yield* s3
          .deleteObject({
            Bucket: assets.bucketName,
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
      KeyName: news.keyName,
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
