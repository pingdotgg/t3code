/**
 * Split the live AWS suite into disjoint quota-aware lanes.
 *
 * The quota lane contains every binding test, every Lambda service test, and
 * every test whose local import graph reaches a Lambda fixture. The
 * network lanes contain every test whose local import graph creates a VPC.
 * AWS accounts default to five VPCs per Region, so those files must not inherit
 * the otherwise-safe high service concurrency. Tests that hold two VPCs live
 * at once run in a separate sequential lane; never overlap it with `network`.
 * The distributed lane contains the complement, so it can retain very high
 * file concurrency without stampeding either shared control plane.
 *
 * Examples (wrap live invocations in the coordinator's hard timeout):
 *
 *   bun scripts/aws-test-lanes.ts inventory
 *   bun scripts/aws-test-lanes.ts network-heavy --profile testing --concurrency 1 --retry 0
 *   bun scripts/aws-test-lanes.ts network --profile testing --concurrency 3 --retry 0
 *   bun scripts/aws-test-lanes.ts quota --profile testing --concurrency 24 --retry 0
 *   bun scripts/aws-test-lanes.ts distributed --profile testing --concurrency 128 --retry 0
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";

type Lane = "network-heavy" | "network" | "quota" | "distributed";

const alchemyDir = resolve(import.meta.dir, "..");
const awsTestDir = resolve(alchemyDir, "test", "AWS");

const isTestFile = (name: string) =>
  name.endsWith(".test.ts") || name.endsWith(".test.tsx");

const isTypeScriptFile = (name: string) =>
  name.endsWith(".ts") || name.endsWith(".tsx");

const walk = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory()
      ? walk(path)
      : isTypeScriptFile(entry.name)
        ? [path]
        : [];
  });

const resolveLocalImport = (from: string, specifier: string) => {
  if (!specifier.startsWith(".")) return undefined;

  const base = resolve(dirname(from), specifier);
  const candidates = extname(base)
    ? [base, base.replace(/\.js$/, ".ts"), base.replace(/\.jsx$/, ".tsx")]
    : [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        resolve(base, "index.ts"),
        resolve(base, "index.tsx"),
      ];

  return candidates.find(
    (candidate) =>
      candidate.startsWith(`${awsTestDir}${sep}`) &&
      existsSync(candidate) &&
      statSync(candidate).isFile(),
  );
};

const files = walk(awsTestDir).sort();
const tests = files.filter((file) => isTestFile(file));
const reverseImports = new Map<string, Set<string>>();
const lambdaSources = new Set<string>();
const networkSources = new Set<string>();

const importPattern =
  /(?:from\s*|import\s*\(|new\s+URL\s*\()\s*["']([^"']+)["']/g;

const isEc2ResourceModule = (specifier: string) =>
  specifier === "@/AWS/EC2" ||
  /^@\/AWS\/EC2\/(?:Vpc|Network)(?:\.ts)?$/.test(specifier);

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Keep executable tokens while masking comments and string/template contents.
// This prevents prose such as "AWS Partner Network (...)" from becoming a
// scarce-capacity seed. Imports are parsed separately from the original text.
const maskCommentsAndStrings = (source: string) => {
  const chars = [...source];
  let state: "code" | "line" | "block" | "single" | "double" | "template" =
    "code";

  for (let index = 0; index < chars.length; index++) {
    const char = chars[index];
    const next = chars[index + 1];

    if (state === "code") {
      if (char === "/" && next === "/") {
        state = "line";
        chars[index] = chars[index + 1] = " ";
        index++;
      } else if (char === "/" && next === "*") {
        state = "block";
        chars[index] = chars[index + 1] = " ";
        index++;
      } else if (char === "'") {
        state = "single";
        chars[index] = " ";
      } else if (char === '"') {
        state = "double";
        chars[index] = " ";
      } else if (char === "`") {
        state = "template";
        chars[index] = " ";
      }
      continue;
    }

    if (state === "line") {
      if (char === "\n" || char === "\r") state = "code";
      else chars[index] = " ";
      continue;
    }

    if (state === "block") {
      if (char === "*" && next === "/") {
        chars[index] = chars[index + 1] = " ";
        index++;
        state = "code";
      } else if (char !== "\n" && char !== "\r") {
        chars[index] = " ";
      }
      continue;
    }

    const quote = state === "single" ? "'" : state === "double" ? '"' : "`";
    if (char === "\\") {
      chars[index] = " ";
      if (index + 1 < chars.length) {
        chars[index + 1] = " ";
        index++;
      }
    } else if (char === quote) {
      chars[index] = " ";
      state = "code";
    } else if (char !== "\n" && char !== "\r") {
      chars[index] = " ";
    }
  }
  return chars.join("");
};

/**
 * Find calls that can allocate a regional VPC without matching comments,
 * strings, or unrelated identifiers such as `ServiceNetwork` and
 * `listHostedZonesByVpc`. Import aliases are resolved so `Vpc as TestVpc`,
 * EC2 namespace imports, and the top-level AWS namespace remain visible.
 */
const createsVpc = (source: string) => {
  const resourceCalls = new Set<string>();
  const ec2Namespaces = new Set<string>();
  const awsNamespaces = new Set<string>();

  const namedImportPattern =
    /import\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(namedImportPattern)) {
    const [, bindings, specifier] = match;
    if (isEc2ResourceModule(specifier)) {
      for (const binding of bindings.split(",")) {
        const parts = binding
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/);
        if (parts[0] === "Vpc" || parts[0] === "Network") {
          resourceCalls.add(parts[1] ?? parts[0]);
        }
      }
    } else if (specifier === "@/AWS") {
      for (const binding of bindings.split(",")) {
        const parts = binding.trim().split(/\s+as\s+/);
        if (parts[0] === "EC2") {
          ec2Namespaces.add(parts[1] ?? parts[0]);
        }
      }
    }
  }

  const namespaceImportPattern =
    /import\s*\*\s*as\s*(\w+)\s*from\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(namespaceImportPattern)) {
    const [, alias, specifier] = match;
    if (isEc2ResourceModule(specifier)) ec2Namespaces.add(alias);
    else if (specifier === "@/AWS") awsNamespaces.add(alias);
  }

  const defaultImportPattern =
    /import\s+(\w+)\s+from\s*["'](@\/AWS\/EC2\/(?:Vpc|Network)(?:\.ts)?)["']/g;
  for (const match of source.matchAll(defaultImportPattern)) {
    resourceCalls.add(match[1]);
  }

  const targets = [
    ...[...resourceCalls].map(escapeRegExp),
    ...[...ec2Namespaces].map(
      (alias) => `${escapeRegExp(alias)}\\.(?:Vpc|Network)`,
    ),
    ...[...awsNamespaces].map(
      (alias) => `${escapeRegExp(alias)}\\.EC2\\.(?:Vpc|Network)`,
    ),
  ];
  const code = maskCommentsAndStrings(source);
  if (/\bcreate(?:Default)?Vpc\s*\(/.test(code)) return true;
  if (targets.length === 0) return false;
  return new RegExp(`\\b(?:${targets.join("|")})(?:<[^>]+>)?\\s*\\(`).test(
    code,
  );
};

for (const file of files) {
  const source = readFileSync(file, "utf8");

  // Lambda fixtures use either the focused module or the AWS namespace.
  if (
    /@\/AWS\/Lambda(?:["'/]|$)|AWS\.Lambda\.Function(?:<[^>]+>)?\s*\(/.test(
      source,
    )
  ) {
    lambdaSources.add(file);
  }

  // Include direct provider resources, the EC2 Network composite, distilled
  // default-VPC helpers, and every local fixture importing one of them. This
  // is based on the import graph rather than service names because Batch,
  // AppRunner, DMS, EFS, RDS, and many others all consume EC2 capacity.
  if (createsVpc(source)) {
    networkSources.add(file);
  }

  for (const match of source.matchAll(importPattern)) {
    const imported = resolveLocalImport(file, match[1]);
    if (imported === undefined) continue;
    const importers = reverseImports.get(imported) ?? new Set<string>();
    importers.add(file);
    reverseImports.set(imported, importers);
  }
}

// Mark every local importer that can reach a scarce fixture. Walking the
// reverse graph avoids false negatives from cycles between fixture modules.
const lambdaReachable = new Set(lambdaSources);
const networkReachable = new Set(networkSources);

const expandImporters = (reachable: Set<string>, sources: Set<string>) => {
  const pending = [...sources];
  while (pending.length > 0) {
    const imported = pending.pop()!;
    for (const importer of reverseImports.get(imported) ?? []) {
      if (reachable.has(importer)) continue;
      reachable.add(importer);
      pending.push(importer);
    }
  }
};

expandImporters(lambdaReachable, lambdaSources);
expandImporters(networkReachable, networkSources);

// These files hold two custom VPCs simultaneously. Run this lane sequentially
// and never at the same time as `network`: default VPC (1) + heavy file (2)
// stays below the regional default quota of 5. The ordinary network lane at
// concurrency 3 likewise peaks at default VPC (1) + three custom VPCs (3).
const networkHeavyPaths = new Set([
  resolve(awsTestDir, "EC2", "VpcPeeringConnection.test.ts"),
  resolve(awsTestDir, "Route53", "ZoneVpcAssociation.test.ts"),
]);
const networkHeavy = tests.filter(
  (file) => networkReachable.has(file) && networkHeavyPaths.has(file),
);
const network = tests.filter(
  (file) => networkReachable.has(file) && !networkHeavyPaths.has(file),
);
const networkSet = new Set([...networkHeavy, ...network]);

const quota = tests.filter(
  (file) =>
    !networkSet.has(file) &&
    (/Bindings\.test\.tsx?$/.test(file) ||
      file.includes(`${sep}AWS${sep}Lambda${sep}`) ||
      lambdaReachable.has(file)),
);
const quotaSet = new Set(quota);
const distributed = tests.filter(
  (file) => !networkSet.has(file) && !quotaSet.has(file),
);

const lanes: Record<Lane, string[]> = {
  "network-heavy": networkHeavy,
  network,
  quota,
  distributed,
};
const command = process.argv[2] ?? "inventory";

if (command === "inventory") {
  process.stdout.write(
    `${JSON.stringify(
      {
        total: tests.length,
        networkHeavy: networkHeavy.length,
        network: network.length,
        quota: quota.length,
        distributed: distributed.length,
        overlap:
          [...networkHeavy, ...network, ...quota, ...distributed].length -
          new Set([...networkHeavy, ...network, ...quota, ...distributed]).size,
        covered: new Set([
          ...networkHeavy,
          ...network,
          ...quota,
          ...distributed,
        ]).size,
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

if (
  command === "list-network-heavy" ||
  command === "list-network" ||
  command === "list-quota" ||
  command === "list-distributed"
) {
  const lane = command.slice("list-".length) as Lane;
  process.stdout.write(
    `${lanes[lane].map((file) => relative(alchemyDir, file)).join("\n")}\n`,
  );
  process.exit(0);
}

if (
  command !== "network-heavy" &&
  command !== "network" &&
  command !== "quota" &&
  command !== "distributed"
) {
  process.stderr.write(
    "Usage: aws-test-lanes.ts <inventory|list-network-heavy|list-network|list-quota|list-distributed|network-heavy|network|quota|distributed> [alchemy-test options...]\n",
  );
  process.exit(2);
}

const lane = command as Lane;
const testFiles = lanes[lane].map((file) => relative(alchemyDir, file));
const args = process.argv.slice(3);

process.stderr.write(
  `AWS ${lane} lane: ${testFiles.length}/${tests.length} files\n`,
);

const child = Bun.spawn(["bun", "alchemy-test", ...testFiles, ...args], {
  cwd: alchemyDir,
  env: process.env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

let terminating = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (terminating) return;
    terminating = true;
    child.kill(signal);
  });
}

process.exit(await child.exited);
