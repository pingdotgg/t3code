#!/usr/bin/env bun
/**
 * Spec-Driven Service Audit Script
 *
 * This script analyzes a distilled AWS service spec and compares it against
 * the alchemy implementation to identify gaps in bindings, resources,
 * event sources, and helpers.
 *
 * Usage:
 *   bun scripts/audit-service.ts dynamodb
 *   bun scripts/audit-service.ts s3
 *   bun scripts/audit-service.ts --json dynamodb
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

// ============ Types ============

interface Operation {
  name: string;
  camelCase: string;
  pascalCase: string;
  category: OperationCategory;
  resourceArity: ResourceArity;
  impliesResource: boolean;
  impliesEventSource: boolean;
  implemented: boolean;
  registeredInProviders: boolean;
  registeredInIndex: boolean;
}

type OperationCategory =
  | "binding" // Data-plane operation that becomes a Binding.Service
  | "resource-lifecycle" // create/update/delete operations that imply a Resource
  | "event-source" // stream/notification operations
  | "helper-candidate" // operations that might become ergonomic helpers
  | "internal"; // operations unlikely to be exposed directly

type ResourceArity =
  | 0 // account/service scoped (e.g., ListBuckets, DescribeLimits)
  | 1 // single resource scoped (e.g., GetObject(Bucket), GetItem(Table))
  | 2 // fixed multi-resource (e.g., CopyObject(SourceBucket, DestBucket))
  | "n"; // variadic resource set (e.g., ExecuteTransaction(TableA, TableB, ...))

interface AuditReport {
  service: string;
  distilledPath: string;
  alchemyPath: string;
  bindingTestPath: string;
  totalOperations: number;
  implementedBindings: Operation[];
  missingBindings: Operation[];
  resourceLifecycleOps: Operation[];
  eventSourceOps: Operation[];
  helperCandidates: Operation[];
  internalOps: Operation[];
  canonicalResources: CanonicalResource[];
  suggestedHelpers: SuggestedHelper[];
  registrationGaps: RegistrationGap[];
  missingBindingTests: string[];
  leastPrivilegeWarnings: LeastPrivilegeWarning[];
}

interface CanonicalResource {
  name: string;
  impliedByOperations: string[];
  hasProvider: boolean;
  suggestedBindings: string[];
}

interface SuggestedHelper {
  name: string;
  pattern: string;
  basedOn: string[];
  existingExample: string | null;
}

interface RegistrationGap {
  type: "provider" | "index" | "policy";
  file: string;
  missing: string[];
}

interface LeastPrivilegeWarning {
  binding: string;
  file: string;
  resourceArity: ResourceArity;
  message: string;
}

// ============ Operation Classification Rules ============

// Resource lifecycle operations create/update/delete the resource ITSELF (Table, Bucket, Queue)
// NOT operations on items within a resource (deleteItem is a binding, deleteTable is lifecycle)
const RESOURCE_LIFECYCLE_PATTERNS = [
  /^createTable$/,
  /^deleteTable$/,
  /^updateTable$/,
  /^createBucket$/,
  /^deleteBucket$/,
  /^createQueue$/,
  /^deleteQueue$/,
  /^createFunction$/,
  /^deleteFunction$/,
  /^updateFunctionCode$/,
  /^updateFunctionConfiguration$/,
  /^createStream$/,
  /^deleteStream$/,
  /^createPipe$/,
  /^deletePipe$/,
  /^updatePipe$/,
  /^createTopic$/,
  /^deleteTopic$/,
  /^createSchedule$/,
  /^deleteSchedule$/,
  /^updateSchedule$/,
  /^createScheduleGroup$/,
  /^deleteScheduleGroup$/,
  /^put[A-Z].*(?:Policy|Configuration|Settings)$/,
];

const EVENT_SOURCE_PATTERNS = [
  /stream/i,
  /kinesis/i,
  /notification/i,
  /subscription/i,
  /^describe.*Stream/,
  /^enable.*Stream/,
  /^disable.*Stream/,
  /StreamingDestination/i,
];

// Operations that are both bindings AND helper candidates (will be classified as bindings first)
// These are data-plane operations that might benefit from higher-level wrappers
const HELPER_CANDIDATE_PATTERNS = [
  /^batch/i,
  /^transact/i,
  /^execute.*Statement/,
];

// Core data-plane bindings (these should always be classified as bindings)
const CORE_BINDING_PATTERNS = [
  /^get(?:Item|Object|Message|Record)$/i,
  /^put(?:Item|Object|Record)$/i,
  /^delete(?:Item|Object|Message)$/i,
  /^update(?:Item)$/i,
  /^query$/i,
  /^scan$/i,
  /^send(?:Message|Record)$/i,
  /^receive(?:Message)$/i,
  /^head(?:Object|Bucket)$/i,
  /^list(?:Objects|ObjectsV2)$/i,
  /^copy(?:Object)$/i,
  /^upload(?:Part)$/i,
  /^complete(?:MultipartUpload)$/i,
  /^create(?:MultipartUpload)$/i,
  /^abort(?:MultipartUpload)$/i,
];

const INTERNAL_PATTERNS = [
  /^describe(?:Endpoints|Limits)$/,
  /^list(?:Tags|Backups|Exports|Imports|GlobalTables|ContributorInsights)$/,
  /^tag/i,
  /^untag/i,
  /Backup/i,
  /Export/i,
  /Import/i,
  /GlobalTable(?!s$)/i,
  /ReplicaAutoScaling/i,
  /ContributorInsights/i,
  /ResourcePolicy/i,
  /ContinuousBackups/i,
];

const ZERO_ARITY_PATTERNS = [
  /^list(?:Tables|Buckets|Queues|Functions|Streams)$/i,
  /^describe(?:Endpoints|Limits|Account)$/i,
];

const FIXED_MULTI_ARITY_PATTERNS = [/^copy/i, /^replicate/i, /^restore.*From/i];

const N_ARITY_PATTERNS = [
  /^batch/i,
  /^transact/i,
  /^execute.*Statement/i,
  /^execute.*Transaction/i,
];

// ============ Utilities ============

function toPascalCase(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function toCamelCase(str: string): string {
  return str.charAt(0).toLowerCase() + str.slice(1);
}

function matchesAnyPattern(name: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(name));
}

function classifyOperation(
  serviceName: string,
  name: string,
): {
  category: OperationCategory;
  resourceArity: ResourceArity;
  impliesResource: boolean;
  impliesEventSource: boolean;
} {
  if (serviceName === "iam") {
    const lifecycleIamOps = new Set([
      "createAccessKey",
      "deleteAccessKey",
      "updateAccessKey",
      "createAccountAlias",
      "deleteAccountAlias",
      "updateAccountPasswordPolicy",
      "deleteAccountPasswordPolicy",
      "createGroup",
      "deleteGroup",
      "updateGroup",
      "createInstanceProfile",
      "deleteInstanceProfile",
      "createLoginProfile",
      "deleteLoginProfile",
      "updateLoginProfile",
      "createOpenIDConnectProvider",
      "deleteOpenIDConnectProvider",
      "createPolicy",
      "deletePolicy",
      "createRole",
      "deleteRole",
      "updateRole",
      "createSAMLProvider",
      "deleteSAMLProvider",
      "updateSAMLProvider",
      "deleteServerCertificate",
      "updateServerCertificate",
      "createServiceSpecificCredential",
      "deleteServiceSpecificCredential",
      "updateServiceSpecificCredential",
      "deleteSigningCertificate",
      "updateSigningCertificate",
      "deleteSSHPublicKey",
      "updateSSHPublicKey",
      "createUser",
      "deleteUser",
      "updateUser",
      "createVirtualMFADevice",
      "deleteVirtualMFADevice",
    ]);

    if (lifecycleIamOps.has(name)) {
      return {
        category: "resource-lifecycle",
        resourceArity:
          name === "updateAccountPasswordPolicy" ||
          name === "deleteAccountPasswordPolicy"
            ? 0
            : 1,
        impliesResource: true,
        impliesEventSource: false,
      };
    }

    return {
      category: "internal",
      resourceArity: matchesAnyPattern(name, ZERO_ARITY_PATTERNS) ? 0 : 1,
      impliesResource: false,
      impliesEventSource: false,
    };
  }

  if (serviceName === "sns") {
    if (name === "createTopic" || name === "deleteTopic") {
      return {
        category: "resource-lifecycle",
        resourceArity: 1,
        impliesResource: true,
        impliesEventSource: false,
      };
    }

    if (name === "subscribe" || name === "unsubscribe") {
      return {
        category: "resource-lifecycle",
        resourceArity: 1,
        impliesResource: true,
        impliesEventSource: true,
      };
    }
  }

  if (serviceName === "kinesis") {
    if (
      name === "registerStreamConsumer" ||
      name === "deregisterStreamConsumer"
    ) {
      return {
        category: "resource-lifecycle",
        resourceArity: 1,
        impliesResource: true,
        impliesEventSource: false,
      };
    }

    if (
      [
        "addTagsToStream",
        "decreaseStreamRetentionPeriod",
        "deleteResourcePolicy",
        "disableEnhancedMonitoring",
        "enableEnhancedMonitoring",
        "increaseStreamRetentionPeriod",
        "mergeShards",
        "putResourcePolicy",
        "removeTagsFromStream",
        "splitShard",
        "startStreamEncryption",
        "stopStreamEncryption",
        "tagResource",
        "untagResource",
        "updateMaxRecordSize",
        "updateShardCount",
        "updateStreamMode",
        "updateStreamWarmThroughput",
      ].includes(name)
    ) {
      return {
        category: "resource-lifecycle",
        resourceArity: 1,
        impliesResource: true,
        impliesEventSource: false,
      };
    }

    if (
      [
        "describeAccountSettings",
        "describeLimits",
        "describeStream",
        "describeStreamConsumer",
        "describeStreamSummary",
        "getRecords",
        "getResourcePolicy",
        "getShardIterator",
        "listShards",
        "listStreamConsumers",
        "listStreams",
        "listTagsForResource",
        "putRecord",
        "putRecords",
        "subscribeToShard",
      ].includes(name)
    ) {
      return {
        category: "binding",
        resourceArity: matchesAnyPattern(name, ZERO_ARITY_PATTERNS) ? 0 : 1,
        impliesResource: false,
        impliesEventSource: false,
      };
    }

    if (name === "listTagsForStream" || name === "updateAccountSettings") {
      return {
        category: "internal",
        resourceArity: 1,
        impliesResource: false,
        impliesEventSource: false,
      };
    }
  }

  if (serviceName === "rds-data") {
    return {
      category: "binding",
      resourceArity: 1,
      impliesResource: false,
      impliesEventSource: false,
    };
  }

  if (serviceName === "secrets-manager") {
    if (["createSecret", "deleteSecret", "updateSecret"].includes(name)) {
      return {
        category: "resource-lifecycle",
        resourceArity: 1,
        impliesResource: true,
        impliesEventSource: false,
      };
    }

    if (name === "listSecrets" || name === "getRandomPassword") {
      return {
        category: "binding",
        resourceArity: 0,
        impliesResource: false,
        impliesEventSource: false,
      };
    }

    if (
      [
        "getSecretValue",
        "putSecretValue",
        "describeSecret",
        "listSecretVersionIds",
        "getResourcePolicy",
        "putResourcePolicy",
        "deleteResourcePolicy",
        "updateSecretVersionStage",
        "validateResourcePolicy",
      ].includes(name)
    ) {
      return {
        category: "binding",
        resourceArity: 1,
        impliesResource: false,
        impliesEventSource: false,
      };
    }
  }

  if (serviceName === "rds") {
    if (
      [
        "createDBCluster",
        "deleteDBCluster",
        "modifyDBCluster",
        "enableHttpEndpoint",
        "disableHttpEndpoint",
        "startDBCluster",
        "stopDBCluster",
        "rebootDBCluster",
        "createDBClusterEndpoint",
        "deleteDBClusterEndpoint",
        "modifyDBClusterEndpoint",
        "createDBClusterParameterGroup",
        "deleteDBClusterParameterGroup",
        "modifyDBClusterParameterGroup",
        "createDBInstance",
        "deleteDBInstance",
        "modifyDBInstance",
        "createDBParameterGroup",
        "deleteDBParameterGroup",
        "modifyDBParameterGroup",
        "createDBProxy",
        "deleteDBProxy",
        "modifyDBProxy",
        "createDBProxyEndpoint",
        "deleteDBProxyEndpoint",
        "modifyDBProxyEndpoint",
        "modifyDBProxyTargetGroup",
        "registerDBProxyTargets",
        "deregisterDBProxyTargets",
        "createDBSubnetGroup",
        "deleteDBSubnetGroup",
        "modifyDBSubnetGroup",
        "createGlobalCluster",
        "deleteGlobalCluster",
        "modifyGlobalCluster",
      ].includes(name)
    ) {
      return {
        category: "resource-lifecycle",
        resourceArity: 1,
        impliesResource: true,
        impliesEventSource: false,
      };
    }

    if (
      [
        "describeDBClusters",
        "describeDBInstances",
        "describeDBSubnetGroups",
        "describeDBClusterParameterGroups",
        "describeDBParameterGroups",
        "describeDBProxies",
        "describeDBProxyEndpoints",
        "describeDBProxyTargetGroups",
        "describeDBProxyTargets",
        "listTagsForResource",
      ].includes(name)
    ) {
      return {
        category: "binding",
        resourceArity: 1,
        impliesResource: false,
        impliesEventSource: false,
      };
    }
  }

  if (serviceName === "eventbridge") {
    if (
      [
        "createEventBus",
        "deleteEventBus",
        "updateEventBus",
        "putRule",
        "deleteRule",
        "putPermission",
        "removePermission",
      ].includes(name)
    ) {
      return {
        category: "resource-lifecycle",
        resourceArity:
          name === "putPermission" || name === "removePermission" ? 1 : 1,
        impliesResource: true,
        impliesEventSource: name === "putRule" || name === "deleteRule",
      };
    }

    if (
      [
        "describeEventBus",
        "listEventBuses",
        "describeRule",
        "listRules",
        "listTargetsByRule",
        "listRuleNamesByTarget",
        "putEvents",
        "testEventPattern",
      ].includes(name)
    ) {
      return {
        category: "binding",
        resourceArity:
          name === "listEventBuses" || name === "testEventPattern" ? 0 : 1,
        impliesResource: false,
        impliesEventSource: false,
      };
    }
  }

  if (serviceName === "pipes") {
    if (
      [
        "createPipe",
        "describePipe",
        "updatePipe",
        "deletePipe",
        "startPipe",
        "stopPipe",
      ].includes(name)
    ) {
      return {
        category: "resource-lifecycle",
        resourceArity: 1,
        impliesResource: true,
        impliesEventSource: true,
      };
    }

    if (["listPipes", "listTagsForResource"].includes(name)) {
      return {
        category: "binding",
        resourceArity: name === "listPipes" ? 0 : 1,
        impliesResource: false,
        impliesEventSource: false,
      };
    }
  }

  if (serviceName === "scheduler") {
    if (
      [
        "createSchedule",
        "getSchedule",
        "updateSchedule",
        "deleteSchedule",
        "createScheduleGroup",
        "getScheduleGroup",
        "deleteScheduleGroup",
      ].includes(name)
    ) {
      return {
        category: "resource-lifecycle",
        resourceArity: 1,
        impliesResource: true,
        impliesEventSource: true,
      };
    }

    if (
      ["listSchedules", "listScheduleGroups", "listTagsForResource"].includes(
        name,
      )
    ) {
      return {
        category: "binding",
        resourceArity: name === "listTagsForResource" ? 1 : 0,
        impliesResource: false,
        impliesEventSource: false,
      };
    }
  }

  const impliesEventSource = matchesAnyPattern(name, EVENT_SOURCE_PATTERNS);
  const impliesResource = matchesAnyPattern(name, RESOURCE_LIFECYCLE_PATTERNS);
  const isCoreBinding = matchesAnyPattern(name, CORE_BINDING_PATTERNS);

  let category: OperationCategory;
  if (matchesAnyPattern(name, INTERNAL_PATTERNS)) {
    category = "internal";
  } else if (isCoreBinding) {
    // Core bindings take priority - these are the main data-plane operations
    category = "binding";
  } else if (impliesResource) {
    category = "resource-lifecycle";
  } else if (impliesEventSource) {
    category = "event-source";
  } else if (matchesAnyPattern(name, HELPER_CANDIDATE_PATTERNS)) {
    category = "helper-candidate";
  } else {
    category = "binding";
  }

  let resourceArity: ResourceArity;
  if (matchesAnyPattern(name, ZERO_ARITY_PATTERNS)) {
    resourceArity = 0;
  } else if (matchesAnyPattern(name, N_ARITY_PATTERNS)) {
    resourceArity = "n";
  } else if (matchesAnyPattern(name, FIXED_MULTI_ARITY_PATTERNS)) {
    resourceArity = 2;
  } else {
    resourceArity = 1;
  }

  return { category, resourceArity, impliesResource, impliesEventSource };
}

async function inferImplementedResourceArity(
  alchemyPath: string,
  pascalCase: string,
  fallback: ResourceArity,
): Promise<ResourceArity> {
  const file = path.join(alchemyPath, `${pascalCase}.ts`);

  try {
    const content = await fs.readFile(file, "utf-8");
    const serviceSignatureMatch = content.match(
      /Binding\.Service<[\s\S]*?,\s*(\([\s\S]*?\)\s*=>\s*Effect\.Effect<)/,
    );

    if (!serviceSignatureMatch) {
      return fallback;
    }

    const signature = serviceSignatureMatch[1];

    if (/\(\s*\)\s*=>\s*Effect\.Effect</.test(signature)) {
      return 0;
    }

    if (/\(\s*\.\.\.[^)]+\)\s*=>\s*Effect\.Effect</.test(signature)) {
      return "n";
    }

    if (/\([^)]*,[^)]*\)\s*=>\s*Effect\.Effect</.test(signature)) {
      return 2;
    }

    if (/\([^)]*\)\s*=>\s*Effect\.Effect</.test(signature)) {
      return 1;
    }
  } catch {
    // Fall back to heuristic classification.
  }

  return fallback;
}

function formatArity(arity: ResourceArity): string {
  return `arity=${arity}`;
}

// ============ File Parsing ============

async function extractDistilledOperations(
  distilledPath: string,
  moduleSpecifier?: string,
): Promise<string[]> {
  try {
    const content = await fs.readFile(distilledPath, "utf-8");
    const operations: string[] = [];
    const regex = /^export const ([a-z][a-zA-Z0-9]*): API\.OperationMethod</gm;

    let match;
    while ((match = regex.exec(content)) !== null) {
      operations.push(match[1]);
    }

    return operations;
  } catch {
    if (!moduleSpecifier) {
      throw new Error(`Could not read distilled spec: ${distilledPath}`);
    }

    const mod = await import(moduleSpecifier);
    return Object.keys(mod)
      .filter((key) => /^[a-z]/.test(key))
      .sort();
  }
}

async function getAlchemyFiles(alchemyPath: string): Promise<Set<string>> {
  const files = new Set<string>();
  try {
    const entries = await fs.readdir(alchemyPath);
    for (const entry of entries) {
      if (entry.endsWith(".ts") && entry !== "index.ts") {
        files.add(entry.replace(".ts", ""));
      }
    }
  } catch {
    // Directory doesn't exist
  }
  return files;
}

async function getIndexExports(indexPath: string): Promise<Set<string>> {
  const exports = new Set<string>();
  try {
    const content = await fs.readFile(indexPath, "utf-8");
    const regex = /export \* from ["']\.\/([^"']+)["']/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      const name = match[1].replace(".ts", "").replace(".js", "");
      exports.add(name);
    }
  } catch {
    // File doesn't exist
  }
  return exports;
}

async function getProvidersRegistrations(
  providersPath: string,
  service: string,
): Promise<{ resources: Set<string>; bindings: Set<string> }> {
  const resources = new Set<string>();
  const bindings = new Set<string>();

  try {
    const content = await fs.readFile(providersPath, "utf-8");

    // Match DynamoDB.TableProvider(), S3.BucketProvider(), etc.
    const resourceRegex = new RegExp(
      `${service}\\.([A-Z][a-zA-Z0-9]+)Provider\\(\\)`,
      "g",
    );
    let match;
    while ((match = resourceRegex.exec(content)) !== null) {
      resources.add(match[1]);
    }

    // Match DynamoDB.GetItemPolicyLive, S3.GetObjectPolicyLive, etc.
    // Note: The binding name is like "GetItem" and the export is "GetItemPolicyLive"
    const bindingRegex = new RegExp(
      `${service}\\.([A-Z][a-zA-Z0-9]+)PolicyLive`,
      "g",
    );
    while ((match = bindingRegex.exec(content)) !== null) {
      bindings.add(match[1]);
    }
  } catch {
    // File doesn't exist
  }

  return { resources, bindings };
}

async function getBindingTestDescribes(
  bindingTestPath: string,
): Promise<{ exists: boolean; describes: Set<string> }> {
  const describes = new Set<string>();

  try {
    const content = await fs.readFile(bindingTestPath, "utf-8");
    const regex = /describe\(\s*["']([A-Z][A-Za-z0-9]+)["']/g;

    let match;
    while ((match = regex.exec(content)) !== null) {
      describes.add(match[1]);
    }

    return { exists: true, describes };
  } catch {
    return { exists: false, describes };
  }
}

async function getLeastPrivilegeWarnings(
  alchemyPath: string,
  operations: Operation[],
): Promise<LeastPrivilegeWarning[]> {
  const warnings: LeastPrivilegeWarning[] = [];
  const wildcardResourcePattern = /Resource:\s*\[\s*["']\*["']\s*\]/;

  for (const op of operations) {
    if (!op.implemented || op.resourceArity === 0) {
      continue;
    }

    if (
      op.category !== "binding" &&
      op.category !== "helper-candidate" &&
      op.category !== "event-source"
    ) {
      continue;
    }

    const file = path.join(alchemyPath, `${op.pascalCase}.ts`);
    try {
      const content = await fs.readFile(file, "utf-8");
      if (wildcardResourcePattern.test(content)) {
        warnings.push({
          binding: op.pascalCase,
          file,
          resourceArity: op.resourceArity,
          message:
            'Resource-bound binding uses `Resource: ["*"]`; bind the canonical resource(s) explicitly so the policy stays least-privilege.',
        });
      }
    } catch {
      // Ignore missing or unreadable files; other audit checks will surface those.
    }
  }

  return warnings.sort((a, b) => a.binding.localeCompare(b.binding));
}

// ============ Resource Inference ============

function inferCanonicalResources(
  operations: Operation[],
  existingFiles: Set<string>,
): CanonicalResource[] {
  const resourceMap = new Map<
    string,
    { operations: string[]; bindings: string[] }
  >();

  for (const op of operations) {
    if (op.category === "resource-lifecycle") {
      let resourceName: string | undefined;

      if (
        ["registerStreamConsumer", "deregisterStreamConsumer"].includes(
          op.camelCase,
        )
      ) {
        resourceName = "StreamConsumer";
      } else if (["putRule", "deleteRule"].includes(op.camelCase)) {
        resourceName = "Rule";
      } else if (["putPermission", "removePermission"].includes(op.camelCase)) {
        resourceName = "Permission";
      } else if (
        [
          "addTagsToStream",
          "createStream",
          "decreaseStreamRetentionPeriod",
          "deleteResourcePolicy",
          "deleteStream",
          "disableEnhancedMonitoring",
          "enableEnhancedMonitoring",
          "increaseStreamRetentionPeriod",
          "mergeShards",
          "putResourcePolicy",
          "removeTagsFromStream",
          "splitShard",
          "startStreamEncryption",
          "stopStreamEncryption",
          "tagResource",
          "untagResource",
          "updateMaxRecordSize",
          "updateShardCount",
          "updateStreamMode",
          "updateStreamWarmThroughput",
        ].includes(op.camelCase)
      ) {
        resourceName = "Stream";
      }

      // Extract resource name from operation like createTable -> Table
      const match =
        resourceName === undefined
          ? op.camelCase.match(
              /^(create|delete|update|describe)([A-Z][a-zA-Z]+)/,
            )
          : undefined;
      if (resourceName || match) {
        const resolvedResourceName = resourceName ?? match![2];
        if (!resourceMap.has(resolvedResourceName)) {
          resourceMap.set(resolvedResourceName, {
            operations: [],
            bindings: [],
          });
        }
        resourceMap.get(resolvedResourceName)!.operations.push(op.camelCase);
      }
    } else if (op.category === "binding" && op.resourceArity === 1) {
      // Associate binding with likely resource
      // e.g., getItem, putItem, deleteItem -> Table (DynamoDB convention)
      // This is heuristic and service-specific
      const commonResources = [
        "Table",
        "Bucket",
        "Queue",
        "Stream",
        "Function",
      ];
      for (const res of commonResources) {
        if (!resourceMap.has(res)) {
          resourceMap.set(res, { operations: [], bindings: [] });
        }
        resourceMap.get(res)!.bindings.push(op.pascalCase);
      }
    }
  }

  const results: CanonicalResource[] = [];
  for (const [name, data] of resourceMap) {
    if (data.operations.length > 0) {
      results.push({
        name,
        impliedByOperations: data.operations,
        hasProvider: existingFiles.has(name),
        suggestedBindings: data.bindings.slice(0, 10), // Limit for readability
      });
    }
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

// ============ Helper Suggestions ============

function suggestHelpers(
  operations: Operation[],
  service: string,
): SuggestedHelper[] {
  const suggestions: SuggestedHelper[] = [];

  // Pattern: Stream-based helpers like notifications(bucket), messages(queue), changes(table)
  const streamOps = operations.filter((op) => op.impliesEventSource);
  if (streamOps.length > 0) {
    const helperName =
      service.toLowerCase() === "dynamodb"
        ? "changes"
        : service.toLowerCase() === "sqs"
          ? "messages"
          : service.toLowerCase() === "s3"
            ? "notifications"
            : "events";

    suggestions.push({
      name: `${helperName}(resource)`,
      pattern: "Event stream subscription helper",
      basedOn: streamOps.map((op) => op.camelCase),
      existingExample:
        service.toLowerCase() === "s3"
          ? "alchemy/src/AWS/S3/BucketNotifications.ts"
          : service.toLowerCase() === "sqs"
            ? "alchemy/src/AWS/SQS/QueueEventSource.ts"
            : null,
    });
  }

  // Pattern: Batch operations -> typed batch helpers
  const batchOps = operations.filter(
    (op) =>
      op.camelCase.startsWith("batch") || op.camelCase.startsWith("transact"),
  );
  if (batchOps.length > 0) {
    suggestions.push({
      name: "batch operations",
      pattern: "Typed batch/transaction wrappers",
      basedOn: batchOps.map((op) => op.camelCase),
      existingExample: null,
    });
  }

  return suggestions;
}

// ============ Main Audit Logic ============

async function auditService(serviceName: string): Promise<AuditReport> {
  const serviceNameLower = serviceName.toLowerCase();
  const serviceNameUpper =
    serviceName.charAt(0).toUpperCase() + serviceName.slice(1);

  // Map common service names to their distilled paths and alchemy paths
  const serviceConfig: Record<string, { distilled: string; alchemy: string }> =
    {
      dynamodb: { distilled: "dynamodb", alchemy: "DynamoDB" },
      s3: { distilled: "s3", alchemy: "S3" },
      sqs: { distilled: "sqs", alchemy: "SQS" },
      lambda: { distilled: "lambda", alchemy: "Lambda" },
      kinesis: { distilled: "kinesis", alchemy: "Kinesis" },
      ec2: { distilled: "ec2", alchemy: "EC2" },
      ecs: { distilled: "ecs", alchemy: "ECS" },
      cloudfront: { distilled: "cloudfront", alchemy: "CloudFront" },
      cloudwatch: { distilled: "cloudwatch", alchemy: "CloudWatch" },
      eventbridge: { distilled: "eventbridge", alchemy: "EventBridge" },
      iam: { distilled: "iam", alchemy: "IAM" },
      pipes: { distilled: "pipes", alchemy: "Pipes" },
      sns: { distilled: "sns", alchemy: "SNS" },
      scheduler: { distilled: "scheduler", alchemy: "Scheduler" },
      rds: { distilled: "rds", alchemy: "RDS" },
      "rds-data": { distilled: "rds-data", alchemy: "RDSData" },
      "secrets-manager": {
        distilled: "secrets-manager",
        alchemy: "SecretsManager",
      },
      apigateway: { distilled: "api-gateway", alchemy: "ApiGateway" },
    };

  const config = serviceConfig[serviceNameLower] || {
    distilled: serviceNameLower,
    alchemy: serviceNameUpper,
  };

  const preferredDistilledPath = path.resolve(
    `.vendor/distilled/@distilled.cloud/aws/src/services/${config.distilled}.ts`,
  );
  const fallbackDistilledPath = path.resolve(
    `vendor/distilled/packages/aws/src/services/${config.distilled}.ts`,
  );
  const resolvedDistilledPath = await fs
    .access(preferredDistilledPath)
    .then(() => preferredDistilledPath)
    .catch(() =>
      fs
        .access(fallbackDistilledPath)
        .then(() => fallbackDistilledPath)
        .catch(() => undefined),
    );
  const distilledPath =
    resolvedDistilledPath ?? `@distilled.cloud/aws/${config.distilled}`;
  const alchemyPath = path.resolve(
    `packages/alchemy/src/AWS/${config.alchemy}`,
  );
  const bindingTestPath = path.resolve(
    `packages/alchemy/test/AWS/${config.alchemy}/Bindings.test.ts`,
  );
  const indexPath = path.join(alchemyPath, "index.ts");
  const providersPath = path.resolve("packages/alchemy/src/AWS/Providers.ts");

  // Extract data
  const distilledOps = await extractDistilledOperations(
    resolvedDistilledPath ?? preferredDistilledPath,
    `@distilled.cloud/aws/${config.distilled}`,
  );
  const alchemyFiles = await getAlchemyFiles(alchemyPath);
  const indexExports = await getIndexExports(indexPath);
  const providerRegs = await getProvidersRegistrations(
    providersPath,
    config.alchemy,
  );
  const bindingTestCoverage = await getBindingTestDescribes(bindingTestPath);

  // Classify operations
  const operations: Operation[] = await Promise.all(
    distilledOps.map(async (name) => {
      const pascalCase = toPascalCase(name);
      const classification = classifyOperation(serviceNameLower, name);
      const implemented = alchemyFiles.has(pascalCase);
      const resourceArity = implemented
        ? await inferImplementedResourceArity(
            alchemyPath,
            pascalCase,
            classification.resourceArity,
          )
        : classification.resourceArity;

      return {
        name,
        camelCase: name,
        pascalCase,
        ...classification,
        resourceArity,
        implemented,
        registeredInProviders: providerRegs.bindings.has(pascalCase),
        registeredInIndex: indexExports.has(pascalCase),
      };
    }),
  );

  // Group by category
  const implementedBindings = operations.filter(
    (op) => op.category === "binding" && op.implemented,
  );
  const missingBindings = operations.filter(
    (op) => op.category === "binding" && !op.implemented,
  );
  const resourceLifecycleOps = operations.filter(
    (op) => op.category === "resource-lifecycle",
  );
  const eventSourceOps = operations.filter(
    (op) => op.category === "event-source",
  );
  const helperCandidates = operations.filter(
    (op) => op.category === "helper-candidate",
  );
  const internalOps = operations.filter((op) => op.category === "internal");

  // Infer resources and helpers
  const canonicalResources = inferCanonicalResources(operations, alchemyFiles);
  const suggestedHelpers = suggestHelpers(operations, serviceName);
  const leastPrivilegeWarnings = await getLeastPrivilegeWarnings(
    alchemyPath,
    operations,
  );

  // Find registration gaps
  const registrationGaps: RegistrationGap[] = [];

  const implementedButNotInIndex = implementedBindings.filter(
    (op) => !op.registeredInIndex,
  );
  if (implementedButNotInIndex.length > 0) {
    registrationGaps.push({
      type: "index",
      file: indexPath,
      missing: implementedButNotInIndex.map((op) => op.pascalCase),
    });
  }

  const implementedButNotInProviders = implementedBindings.filter(
    (op) => !op.registeredInProviders,
  );
  if (implementedButNotInProviders.length > 0) {
    registrationGaps.push({
      type: "policy",
      file: providersPath,
      missing: implementedButNotInProviders.map(
        (op) => `${op.pascalCase}PolicyLive`,
      ),
    });
  }

  const missingBindingTests = bindingTestCoverage.exists
    ? implementedBindings
        .filter((op) => !bindingTestCoverage.describes.has(op.pascalCase))
        .map((op) => op.pascalCase)
    : implementedBindings.map((op) => op.pascalCase);

  return {
    service: serviceName,
    distilledPath,
    alchemyPath,
    bindingTestPath,
    totalOperations: operations.length,
    implementedBindings,
    missingBindings,
    resourceLifecycleOps,
    eventSourceOps,
    helperCandidates,
    internalOps,
    canonicalResources,
    suggestedHelpers,
    registrationGaps,
    missingBindingTests,
    leastPrivilegeWarnings,
  };
}

// ============ Report Formatting ============

function formatReport(report: AuditReport): string {
  const lines: string[] = [];

  lines.push(`\n${"=".repeat(80)}`);
  lines.push(`SERVICE AUDIT: ${report.service.toUpperCase()}`);
  lines.push(`${"=".repeat(80)}\n`);

  lines.push(`Distilled spec: ${report.distilledPath}`);
  lines.push(`Alchemy path:   ${report.alchemyPath}`);
  lines.push(`Binding tests:  ${report.bindingTestPath}`);
  lines.push(`Total operations in distilled: ${report.totalOperations}\n`);

  // Summary
  lines.push(`${"─".repeat(80)}`);
  lines.push("SUMMARY");
  lines.push(`${"─".repeat(80)}`);
  lines.push(
    `  Implemented bindings:     ${report.implementedBindings.length}`,
  );
  lines.push(`  Missing bindings:         ${report.missingBindings.length}`);
  lines.push(
    `  Resource lifecycle ops:   ${report.resourceLifecycleOps.length}`,
  );
  lines.push(`  Event source ops:         ${report.eventSourceOps.length}`);
  lines.push(`  Helper candidates:        ${report.helperCandidates.length}`);
  lines.push(`  Internal ops (skip):      ${report.internalOps.length}`);
  lines.push(
    `  Missing binding tests:    ${report.missingBindingTests.length}`,
  );
  lines.push(
    `  Least-privilege warnings: ${report.leastPrivilegeWarnings.length}`,
  );
  lines.push("");

  // Implemented bindings
  if (report.implementedBindings.length > 0) {
    lines.push(`${"─".repeat(80)}`);
    lines.push("IMPLEMENTED BINDINGS");
    lines.push(`${"─".repeat(80)}`);
    for (const op of report.implementedBindings) {
      const arity = `[${formatArity(op.resourceArity)}]`;
      const regStatus = op.registeredInProviders
        ? "✓ registered"
        : "⚠ NOT in Providers.ts";
      lines.push(`  ✓ ${op.pascalCase}.ts ${arity} ${regStatus}`);
    }
    lines.push("");
  }

  // Missing bindings (priority list)
  if (report.missingBindings.length > 0) {
    lines.push(`${"─".repeat(80)}`);
    lines.push("MISSING BINDINGS (implement these)");
    lines.push(`${"─".repeat(80)}`);

    // Group by arity
    const arity1 = report.missingBindings.filter(
      (op) => op.resourceArity === 1,
    );
    const arity0 = report.missingBindings.filter(
      (op) => op.resourceArity === 0,
    );
    const arity2 = report.missingBindings.filter(
      (op) => op.resourceArity === 2,
    );
    const arityN = report.missingBindings.filter(
      (op) => op.resourceArity === "n",
    );

    if (arity1.length > 0) {
      lines.push("  Single-resource bindings (arity=1):");
      for (const op of arity1.slice(0, 20)) {
        lines.push(`    • ${op.pascalCase} (${op.camelCase})`);
      }
      if (arity1.length > 20) {
        lines.push(`    ... and ${arity1.length - 20} more`);
      }
    }

    if (arity0.length > 0) {
      lines.push("  Service-scoped bindings (arity=0):");
      for (const op of arity0) {
        lines.push(`    • ${op.pascalCase} (${op.camelCase})`);
      }
    }

    if (arity2.length > 0) {
      lines.push("  Fixed multi-resource bindings (arity=2):");
      for (const op of arity2) {
        lines.push(`    • ${op.pascalCase} (${op.camelCase})`);
      }
    }

    if (arityN.length > 0) {
      lines.push("  Variadic resource bindings (arity=n):");
      for (const op of arityN) {
        lines.push(`    • ${op.pascalCase} (${op.camelCase})`);
      }
    }
    lines.push("");
  }

  // Canonical resources
  if (report.canonicalResources.length > 0) {
    lines.push(`${"─".repeat(80)}`);
    lines.push("CANONICAL RESOURCES (IaC resources to implement)");
    lines.push(`${"─".repeat(80)}`);
    for (const res of report.canonicalResources) {
      const status = res.hasProvider ? "✓ has provider" : "⚠ MISSING provider";
      lines.push(`  ${res.name}: ${status}`);
      lines.push(`    Implied by: ${res.impliedByOperations.join(", ")}`);
    }
    lines.push("");
  }

  // Event source operations
  if (report.eventSourceOps.length > 0) {
    lines.push(`${"─".repeat(80)}`);
    lines.push("EVENT SOURCE OPERATIONS");
    lines.push(`${"─".repeat(80)}`);
    for (const op of report.eventSourceOps) {
      const impl = op.implemented ? "✓" : "○";
      lines.push(`  ${impl} ${op.camelCase}`);
    }
    lines.push("");
  }

  // Helper suggestions
  if (report.suggestedHelpers.length > 0) {
    lines.push(`${"─".repeat(80)}`);
    lines.push("SUGGESTED HELPERS");
    lines.push(`${"─".repeat(80)}`);
    for (const helper of report.suggestedHelpers) {
      lines.push(`  ${helper.name}`);
      lines.push(`    Pattern: ${helper.pattern}`);
      lines.push(`    Based on: ${helper.basedOn.join(", ")}`);
      if (helper.existingExample) {
        lines.push(`    Example: ${helper.existingExample}`);
      }
    }
    lines.push("");
  }

  // Registration gaps
  if (report.registrationGaps.length > 0) {
    lines.push(`${"─".repeat(80)}`);
    lines.push("REGISTRATION GAPS (fix these)");
    lines.push(`${"─".repeat(80)}`);
    for (const gap of report.registrationGaps) {
      lines.push(`  ${gap.type.toUpperCase()} (${gap.file}):`);
      for (const item of gap.missing) {
        lines.push(`    • ${item}`);
      }
    }
    lines.push("");
  }

  if (report.missingBindingTests.length > 0) {
    lines.push(`${"─".repeat(80)}`);
    lines.push("MISSING BINDING TESTS (add describe blocks)");
    lines.push(`${"─".repeat(80)}`);
    lines.push(`  In: ${report.bindingTestPath}`);
    for (const binding of report.missingBindingTests) {
      lines.push(`    • describe("${binding}", ...)`);
    }
    lines.push("");
  }

  if (report.leastPrivilegeWarnings.length > 0) {
    lines.push(`${"─".repeat(80)}`);
    lines.push("LEAST-PRIVILEGE WARNINGS");
    lines.push(`${"─".repeat(80)}`);
    for (const warning of report.leastPrivilegeWarnings) {
      lines.push(
        `  ⚠ ${warning.binding}.ts [${formatArity(warning.resourceArity)}] (${warning.file})`,
      );
      lines.push(`    ${warning.message}`);
    }
    lines.push("");
  }

  // Helper candidate operations
  if (report.helperCandidates.length > 0) {
    lines.push(`${"─".repeat(80)}`);
    lines.push("HELPER CANDIDATE OPERATIONS (consider wrapping)");
    lines.push(`${"─".repeat(80)}`);
    for (const op of report.helperCandidates) {
      const impl = op.implemented ? "✓" : "○";
      lines.push(
        `  ${impl} ${op.camelCase} [${formatArity(op.resourceArity)}]`,
      );
    }
    lines.push("");
  }

  lines.push(`${"=".repeat(80)}`);
  lines.push("END OF AUDIT");
  lines.push(`${"=".repeat(80)}\n`);

  return lines.join("\n");
}

// ============ CLI ============

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log("Usage: bun scripts/audit-service.ts [--json] <service>");
    console.log("Example: bun scripts/audit-service.ts dynamodb");
    process.exit(1);
  }

  const jsonOutput = args.includes("--json");
  const serviceName = args.filter((a) => !a.startsWith("--"))[0];

  if (!serviceName) {
    console.error("Error: No service name provided");
    process.exit(1);
  }

  try {
    const report = await auditService(serviceName);

    if (jsonOutput) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatReport(report));
    }
  } catch (error) {
    console.error(`Error auditing service ${serviceName}:`, error);
    process.exit(1);
  }
}

main();
