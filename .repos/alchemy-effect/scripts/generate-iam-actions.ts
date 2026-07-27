/**
 * Generate `packages/alchemy/src/AWS/IAM/actions.generated.ts` — a SHALLOW
 * string-literal union type `IamAction` built from distilled's per-service
 * operation names.
 *
 * Coordinator-run (like generate-api-reference.ts):
 *
 *   bun scripts/generate-iam-actions.ts
 *
 * Source of truth: `distilled/packages/aws/src/services/*.ts`. For each
 * service module we extract
 *
 *   - the sigv4 signing name (`T.AwsAuthSigv4({ name: "..." })`), which is the
 *     best distilled-local approximation of the IAM action service prefix
 *     (a small override map corrects the known mismatches, e.g.
 *     `monitoring` -> `cloudwatch`), and
 *   - every `operationName: "X"` registered via `API.make`.
 *
 * The emitted type is a flat union of fully-expanded literals
 * (`"s3:GetObject" | "s3:*" | ... | (string & {})`) — deliberately NO
 * template-literal type computation, per the DSL-track type-level cost
 * ceiling (processes/AWS/design/dsl-abstractions.md, risk #5). The
 * `(string & {})` escape hatch means unknown/condition-only IAM actions are
 * never a hard break; the union exists purely for autocomplete.
 *
 * Note: distilled operation names approximate IAM actions but are not 1:1
 * (IAM has actions with no API operation and vice versa) — see the open
 * question in dsl-abstractions.md. The escape hatch covers the gap.
 */

const SERVICES_DIR = new URL(
  "../distilled/packages/aws/src/services/",
  import.meta.url,
).pathname;
const OUT_FILE = new URL(
  "../packages/alchemy/src/AWS/IAM/actions.generated.ts",
  import.meta.url,
).pathname;

/**
 * sigv4 signing name -> IAM action service prefix, for the known cases where
 * the two differ. Everything else uses the (lowercased) signing name as-is.
 */
const PREFIX_OVERRIDES: Record<string, string> = {
  // CloudWatch metrics sign as "monitoring" but IAM actions are `cloudwatch:*`.
  monitoring: "cloudwatch",
  // IoT data planes sign with dedicated names but share the `iot:` prefix.
  iotdata: "iot",
  ioteventsdata: "iotevents",
  IoTSecuredTunneling: "iot",
  "iot-jobs-data": "iot",
};

const { readdir } = await import("node:fs/promises");
const { readFileSync, writeFileSync } = await import("node:fs");
const { join } = await import("node:path");

const files = (await readdir(SERVICES_DIR)).filter(
  (f) => f.endsWith(".ts") && f !== "index.ts",
);

/** IAM action prefix -> operation names */
const byPrefix = new Map<string, Set<string>>();
let totalOps = 0;
const skipped: string[] = [];

for (const file of files.sort()) {
  const source = readFileSync(join(SERVICES_DIR, file), "utf8");
  const nameMatch = source.match(/AwsAuthSigv[24]\(\{\s*name:\s*"([^"]+)"/);
  if (!nameMatch) {
    skipped.push(file);
    continue;
  }
  const sigv4Name = nameMatch[1]!;
  const prefix = (PREFIX_OVERRIDES[sigv4Name] ?? sigv4Name).toLowerCase();
  const ops = byPrefix.get(prefix) ?? new Set<string>();
  byPrefix.set(prefix, ops);
  for (const match of source.matchAll(/operationName:\s*"([A-Za-z0-9_]+)"/g)) {
    if (!ops.has(match[1]!)) {
      ops.add(match[1]!);
      totalOps++;
    }
  }
}

const prefixes = [...byPrefix.keys()].sort();
const lines: string[] = [
  "// AUTO-GENERATED FILE — DO NOT EDIT.",
  "//",
  "// Regenerate with: bun scripts/generate-iam-actions.ts",
  "//",
  `// Source: distilled/packages/aws/src/services/*.ts (${files.length - skipped.length} service modules,`,
  `// ${prefixes.length} IAM action prefixes, ${totalOps} operations).`,
  "//",
  "// A SHALLOW literal union (no template-literal type computation) of",
  "// `service:Operation` IAM action names, plus `service:*` per service and a",
  "// `(string & {})` escape hatch so arbitrary action strings always remain",
  "// assignable. Exists purely for editor autocomplete on",
  "// `PolicyStatement.Action`.",
  "",
  "export type IamAction =",
];
for (const prefix of prefixes) {
  lines.push(`  | "${prefix}:*"`);
  for (const op of [...byPrefix.get(prefix)!].sort()) {
    lines.push(`  | "${prefix}:${op}"`);
  }
}
lines.push("  | (string & {});", "");

writeFileSync(OUT_FILE, lines.join("\n"));
console.log(
  `wrote ${OUT_FILE}: ${prefixes.length} prefixes, ${totalOps} operations, ${lines.length} lines`,
);
if (skipped.length > 0) {
  console.log(`skipped (no AwsAuthSigv4 name): ${skipped.join(", ")}`);
}
