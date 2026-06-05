#!/usr/bin/env node
// @effect-diagnostics globalConsole:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalFetch:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics nodeBuiltinImport:off

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

export interface HealthCheckConfig {
  readonly localBaseUrl: string;
  readonly publicBaseUrl: string;
  readonly externalIntakeHealthPath: string;
  readonly alertEndpointUrl?: string | undefined;
  readonly alertSecret?: string | undefined;
  readonly notifyOnFailure: boolean;
  readonly alertStatePath: string;
  readonly serverServiceName: string;
  readonly tunnelServiceName: string;
  readonly timeoutMs: number;
}

export interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly details: string;
}

export interface HealthMonitorState {
  readonly status: "passing" | "failing";
  readonly updatedAt: string;
  readonly failingCheckNames?: ReadonlyArray<string> | undefined;
}

export type HealthAlertStatus = "failing" | "recovered";

function envValue(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name] === undefined ? undefined : stripInlineEnvComment(env[name]).trim();
  return value && value.length > 0 ? value : undefined;
}

function stripInlineEnvComment(value: string): string {
  const commentIndex = value.search(/\s#/);
  return commentIndex === -1 ? value : value.slice(0, commentIndex).trimEnd();
}

export function parseEnvFileContents(contents: string): ReadonlyArray<readonly [string, string]> {
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .flatMap((line) => {
      const separatorIndex = line.indexOf("=");
      if (separatorIndex <= 0) {
        return [];
      }

      const key = line.slice(0, separatorIndex).trim();
      const value = stripInlineEnvComment(line.slice(separatorIndex + 1));
      return key.length > 0 ? [[key, value] as const] : [];
    });
}

export function loadLocalEnvFiles(env: NodeJS.ProcessEnv = process.env): void {
  for (const fileName of [".env.local", ".env"]) {
    if (!existsSync(fileName)) {
      continue;
    }

    for (const [key, value] of parseEnvFileContents(readFileSync(fileName, "utf8"))) {
      if (env[key] === undefined) {
        env[key] = value;
      }
    }
  }
}

export function defaultHealthCheckConfig(env: NodeJS.ProcessEnv = process.env): HealthCheckConfig {
  const localBaseUrl = envValue(env, "T3CODE_HEALTH_LOCAL_BASE_URL") ?? "http://127.0.0.1:3773";
  return {
    localBaseUrl,
    publicBaseUrl:
      envValue(env, "T3CODE_HEALTH_PUBLIC_BASE_URL") ??
      envValue(env, "T3CODE_PUBLIC_BASE_URL") ??
      localBaseUrl,
    externalIntakeHealthPath:
      envValue(env, "T3CODE_HEALTH_EXTERNAL_INTAKE_PATH") ?? "/api/external-intake/health",
    alertEndpointUrl: envValue(env, "T3CODE_HEALTH_ALERT_URL"),
    alertSecret: envValue(env, "T3_OPS_ALERT_SECRET"),
    notifyOnFailure: env.T3CODE_HEALTH_NOTIFY === "1",
    alertStatePath:
      env.T3CODE_HEALTH_ALERT_STATE_PATH ?? "logs/orchestrator-health-monitor-state.json",
    serverServiceName: env.T3CODE_HEALTH_SERVER_SERVICE ?? "t3code-server",
    tunnelServiceName: env.T3CODE_HEALTH_TUNNEL_SERVICE ?? "cloudflared-t3code",
    timeoutMs: Number(env.T3CODE_HEALTH_TIMEOUT_MS ?? "10000"),
  };
}

export function classifyBridgeStatus(status: number) {
  if (status === 401) {
    return {
      ok: true,
      details: "bridge route exists and rejected unauthenticated request with 401",
    };
  }
  if (status === 503) {
    return {
      ok: false,
      details: "bridge route exists but local server is missing T3_EXECUTION_BRIDGE_SHARED_SECRET",
    };
  }
  if (status === 404) {
    return {
      ok: false,
      details: "bridge route returned 404; running server build or tunnel target is stale",
    };
  }
  return {
    ok: false,
    details: `bridge route returned unexpected HTTP ${status}`,
  };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, label: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal })
    .finally(() => clearTimeout(timeout))
    .catch((error: unknown) => {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`${label} timed out after ${timeoutMs}ms`);
      }
      throw error;
    });
}

async function checkFetch(name: string, url: string, timeoutMs: number): Promise<CheckResult> {
  try {
    const response = await fetchWithTimeout(url, {}, timeoutMs, name);
    return {
      name,
      ok: response.ok,
      details: `${url} -> HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      name,
      ok: false,
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkBridge(config: HealthCheckConfig): Promise<CheckResult> {
  const url = `${config.publicBaseUrl.replace(/\/$/, "")}/api/execution/runs/status`;
  try {
    const response = await fetchWithTimeout(
      url,
      { method: "POST" },
      config.timeoutMs,
      "bridge route",
    );
    const classification = classifyBridgeStatus(response.status);
    return {
      name: "bridge auth",
      ok: classification.ok,
      details: `${url} -> HTTP ${response.status}; ${classification.details}`,
    };
  } catch (error) {
    return {
      name: "bridge auth",
      ok: false,
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkExternalIntakeHealth(config: HealthCheckConfig): Promise<CheckResult> {
  const path = config.externalIntakeHealthPath.startsWith("/")
    ? config.externalIntakeHealthPath
    : `/${config.externalIntakeHealthPath}`;
  const url = `${config.publicBaseUrl.replace(/\/$/, "")}${path}`;
  try {
    const response = await fetchWithTimeout(url, {}, config.timeoutMs, "external intake health");
    const detailsPrefix = `${url} -> HTTP ${response.status}`;
    if (!response.ok) {
      return {
        name: "external intake health",
        ok: false,
        details: detailsPrefix,
      };
    }

    const body = (await response.json().catch(() => null)) as unknown;
    const ok =
      typeof body === "object" &&
      body !== null &&
      "ok" in body &&
      (body as { readonly ok?: unknown }).ok === true;
    return {
      name: "external intake health",
      ok,
      details: ok ? `${detailsPrefix}; ok=true` : `${detailsPrefix}; response missing ok=true`,
    };
  } catch (error) {
    return {
      name: "external intake health",
      ok: false,
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

function runCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly timeoutMs: number; readonly env?: NodeJS.ProcessEnv },
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ code: 1, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

async function checkWindowsService(serviceName: string, timeoutMs: number): Promise<CheckResult> {
  if (process.platform !== "win32") {
    return {
      name: `windows service ${serviceName}`,
      ok: true,
      details: "skipped on non-Windows platform",
    };
  }

  const result = await runCommand(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      [
        `$service = Get-Service -Name '${serviceName.replaceAll("'", "''")}' -ErrorAction SilentlyContinue`,
        "if (-not $service) { Write-Output 'missing'; exit 1 }",
        "Write-Output ($service.Name + ':' + $service.Status + ':' + $service.StartType)",
        "exit ([int]($service.Status -ne 'Running'))",
      ].join("; "),
    ],
    { timeoutMs },
  );
  return {
    name: `windows service ${serviceName}`,
    ok: result.code === 0,
    details:
      result.code === 0
        ? result.stdout.trim() || "service is running"
        : (result.stderr || result.stdout || `powershell exited ${result.code}`).trim(),
  };
}

async function checkT3ServerRuntime(config: HealthCheckConfig): Promise<CheckResult> {
  if (process.platform !== "win32") {
    return {
      name: "T3 server runtime",
      ok: true,
      details: "skipped on non-Windows platform",
    };
  }

  const result = await runCommand(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      [
        `$service = Get-Service -Name '${config.serverServiceName.replaceAll("'", "''")}' -ErrorAction SilentlyContinue`,
        `$task = Get-ScheduledTask -TaskName '${config.serverServiceName.replaceAll("'", "''")}' -ErrorAction SilentlyContinue`,
        "$listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 3773 -State Listen -ErrorAction SilentlyContinue",
        "$processes = @(Get-CimInstance Win32_Process -Filter \"name = 'node.exe'\" | Where-Object { $_.CommandLine -like '*apps\\server\\dist\\bin.mjs*' })",
        "$serviceStatus = if ($service) { [string]$service.Status } else { 'missing' }",
        "$taskState = if ($task) { [string]$task.State } else { 'missing' }",
        "$listenerStatus = if ($listener) { 'listening' } else { 'not-listening' }",
        "$processStatus = if ($processes.Count -gt 0) { 'process-running' } else { 'process-missing' }",
        'Write-Output "service=$serviceStatus task=$taskState listener=$listenerStatus process=$processStatus"',
        "exit ([int](-not ($listener -and $processes.Count -gt 0)))",
      ].join("; "),
    ],
    { timeoutMs: config.timeoutMs },
  );

  return {
    name: "T3 server runtime",
    ok: result.code === 0,
    details:
      result.code === 0
        ? result.stdout.trim() || "server process is running and port 3773 is listening"
        : (result.stderr || result.stdout || `powershell exited ${result.code}`).trim(),
  };
}

export async function runHealthChecks(config: HealthCheckConfig) {
  const results: CheckResult[] = [];
  results.push(await checkT3ServerRuntime(config));
  results.push(await checkWindowsService(config.tunnelServiceName, config.timeoutMs));
  results.push(await checkFetch("local T3", config.localBaseUrl, config.timeoutMs));
  results.push(await checkFetch("public T3", config.publicBaseUrl, config.timeoutMs));
  results.push(await checkBridge(config));
  results.push(await checkExternalIntakeHealth(config));
  return results;
}

function printResults(results: ReadonlyArray<CheckResult>) {
  for (const result of results) {
    console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}: ${result.details}`);
  }
}

export function readHealthMonitorState(path: string): HealthMonitorState | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<HealthMonitorState>;
    if (parsed.status !== "passing" && parsed.status !== "failing") {
      return null;
    }
    if (typeof parsed.updatedAt !== "string") {
      return null;
    }
    return {
      status: parsed.status,
      updatedAt: parsed.updatedAt,
      ...(Array.isArray(parsed.failingCheckNames)
        ? { failingCheckNames: parsed.failingCheckNames.filter((name) => typeof name === "string") }
        : {}),
    };
  } catch {
    return null;
  }
}

export function writeHealthMonitorState(path: string, state: HealthMonitorState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

export function determineHealthAlert(input: {
  readonly previous: HealthMonitorState | null;
  readonly results: ReadonlyArray<CheckResult>;
}): HealthAlertStatus | null {
  const failing = input.results.filter((result) => !result.ok);
  if (failing.length > 0) {
    return input.previous?.status === "failing" ? null : "failing";
  }

  return input.previous?.status === "failing" ? "recovered" : null;
}

function stateFromResults(
  results: ReadonlyArray<CheckResult>,
  checkedAt: string,
): HealthMonitorState {
  const failing = results.filter((result) => !result.ok);
  return failing.length === 0
    ? {
        status: "passing",
        updatedAt: checkedAt,
      }
    : {
        status: "failing",
        updatedAt: checkedAt,
        failingCheckNames: failing.map((result) => result.name),
      };
}

async function postHealthAlert(input: {
  readonly config: HealthCheckConfig;
  readonly status: HealthAlertStatus;
  readonly checkedAt: string;
  readonly results: ReadonlyArray<CheckResult>;
}) {
  const { config, status, checkedAt, results } = input;
  const failing = results.filter((result) => !result.ok);
  if (config.alertEndpointUrl === undefined || config.alertSecret === undefined) {
    console.warn("WARN ops alert: set T3CODE_HEALTH_ALERT_URL and T3_OPS_ALERT_SECRET");
    return;
  }

  const response = await fetchWithTimeout(
    config.alertEndpointUrl,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.alertSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        checkedAt,
        status,
        summary:
          status === "recovered"
            ? "All orchestrator health checks are passing again."
            : `${failing.length} orchestrator health check${failing.length === 1 ? "" : "s"} failed.`,
        results,
      }),
    },
    config.timeoutMs,
    "ops health alert",
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.warn(`WARN ops alert: ${config.alertEndpointUrl} -> HTTP ${response.status} ${body}`);
    return;
  }
  console.log(`PASS ops alert: posted ${status} alert to ${config.alertEndpointUrl}`);
}

async function notifyHealthAlert(config: HealthCheckConfig, results: ReadonlyArray<CheckResult>) {
  if (!config.notifyOnFailure) {
    return;
  }

  const checkedAt = new Date().toISOString();
  const previous = readHealthMonitorState(config.alertStatePath);
  const status = determineHealthAlert({ previous, results });
  if (status !== null) {
    await postHealthAlert({ config, status, checkedAt, results });
  }
  writeHealthMonitorState(config.alertStatePath, stateFromResults(results, checkedAt));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadLocalEnvFiles();
  const config = defaultHealthCheckConfig();
  const results = await runHealthChecks(config);
  printResults(results);
  await notifyHealthAlert(config, results);
  process.exitCode = results.every((result) => result.ok) ? 0 : 1;
}
