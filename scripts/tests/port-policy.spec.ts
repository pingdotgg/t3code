import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const assert = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message);
  }
};

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(currentDir, "..", "..");

const run = (
  scriptPath: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  },
): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync("bash", [scriptPath, ...args], {
    cwd: options?.cwd ?? repoRoot,
    encoding: "utf8",
    env: options?.env ?? process.env,
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

const expectSuccess = (
  scriptPath: string,
  args: string[],
  message: string,
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  },
): { stdout: string; stderr: string } => {
  const result = run(scriptPath, args, options);
  if (result.status !== 0) {
    throw new Error(`${message}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }

  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

const expectFailure = (
  scriptPath: string,
  args: string[],
  message: string,
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  },
): { stdout: string; stderr: string } => {
  const result = run(scriptPath, args, options);
  if (result.status === 0) {
    throw new Error(`${message}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }

  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

const createAdoptedRepo = (): string => {
  const tempRoot = mkdtempSync(join(tmpdir(), "ai-starter-pro-port-policy-"));
  mkdirSync(join(tempRoot, ".git"));

  const manifestPath = join(repoRoot, ".template", "adoption", "minimal-files.txt");
  const manifestLines = readFileSync(manifestPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

  for (const relPath of manifestLines) {
    const sourcePath = join(repoRoot, relPath);
    const targetPath = join(tempRoot, relPath);
    if (relPath.endsWith("/")) {
      if (existsSync(sourcePath)) {
        cpSync(sourcePath, targetPath.slice(0, -1), { recursive: true });
      }
      continue;
    }

    mkdirSync(dirname(targetPath), { recursive: true });
    cpSync(sourcePath, targetPath);
  }

  writeFileSync(
    join(tempRoot, "package.json"),
    JSON.stringify(
      {
        name: "adopted-demo",
        private: true,
        scripts: {
          preflight: "bun run scripts/preflight/runner.ts",
        },
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(tempRoot, "docs", "project.md"),
    [
      "# Project Brief",
      "",
      "- **Product name**: Demo Project",
      "- **App name**: demo",
      "- **Stack**: A",
      "- **Primary users**: Internal team",
      "- **Doppler project name**: demo-project",
      "- **Environment tiers**: 3",
    ].join("\n"),
  );

  writeFileSync(
    join(tempRoot, "review.md"),
    [
      "# Review Brief",
      "",
      "- **Repository type**: template",
      "- **Current priority**: reliability",
      "- **Review depth**: standard",
      "- **Blocking criteria**: failing validation",
    ].join("\n"),
  );

  writeFileSync(
    join(tempRoot, ".cursor", "BUGBOT.md"),
    [
      "# Bugbot Project Brief",
      "",
      "- **Repository mode**: TEMPLATE",
      "- **Team/owner**: Demo Team",
      "1. Reliability",
      "2. Security",
      "3. Developer experience",
      "- Include: `scripts/**`",
      "- Exclude: `generated/**`",
    ].join("\n"),
  );

  return tempRoot;
};

const tests = [
  {
    name: "check-port-policy accepts explicit unique ports above the minimum",
    run: () => {
      const scriptPath = join(repoRoot, "scripts", "check-port-policy.sh");
      expectSuccess(
        scriptPath,
        ["--port", "app=12000", "--port", "api=12001"],
        "expected explicit non-default ports to pass",
      );
    },
  },
  {
    name: "check-port-policy rejects missing, duplicate, and low ports",
    run: () => {
      const scriptPath = join(repoRoot, "scripts", "check-port-policy.sh");
      expectFailure(scriptPath, [], "missing ports should fail");
      expectFailure(
        scriptPath,
        ["--port", "app=9999", "--port", "api=12001"],
        "ports below 10000 should fail",
      );
      expectFailure(
        scriptPath,
        ["--port", "app=12000", "--port", "api=12000"],
        "duplicate ports should fail",
      );
    },
  },
  {
    name: "setup-domain dry-run renders the configured explicit ports",
    run: () => {
      const scriptPath = join(repoRoot, "scripts", "setup-domain.sh");
      const result = expectSuccess(
        scriptPath,
        ["demo", "--app-port", "12000", "--api-port", "12001", "--dry-run"],
        "setup-domain dry-run should succeed",
      );
      assert(
        result.stdout.includes("reverse_proxy localhost:12000"),
        "dry-run output should include the app port",
      );
      assert(
        result.stdout.includes("reverse_proxy localhost:12001"),
        "dry-run output should include the api port",
      );
      assert(
        result.stdout.includes("demo.test"),
        "dry-run output should include the generated domains",
      );
    },
  },
  {
    name: "setup-domain rejects missing or invalid explicit ports before touching the system",
    run: () => {
      const scriptPath = join(repoRoot, "scripts", "setup-domain.sh");
      expectFailure(
        scriptPath,
        ["demo", "--app-port", "12000", "--dry-run"],
        "missing api port should fail",
      );
      expectFailure(
        scriptPath,
        ["demo", "--app-port", "9999", "--api-port", "12001", "--dry-run"],
        "low ports should fail",
      );
      expectFailure(
        scriptPath,
        ["demo", "--app-port", "12000", "--api-port", "12000", "--dry-run"],
        "duplicate ports should fail",
      );
    },
  },
  {
    name: "setup-domain works when the checker is readable but not executable",
    run: () => {
      const tempRoot = createAdoptedRepo();
      try {
        const checkerPath = join(tempRoot, "scripts", "check-port-policy.sh");
        chmodSync(checkerPath, 0o644);

        const scriptPath = join(tempRoot, "scripts", "setup-domain.sh");
        const result = expectSuccess(
          scriptPath,
          ["demo", "--app-port", "12000", "--api-port", "12001", "--dry-run"],
          "setup-domain should not require the checker to be executable",
          { cwd: tempRoot },
        );
        assert(
          result.stdout.includes("reverse_proxy localhost:12000"),
          "dry-run output should still include the app port when checker is non-executable",
        );
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    },
  },
  {
    name: "verify-template-adoption passes for a repo with the enforced port-policy assets",
    run: () => {
      const tempRoot = createAdoptedRepo();
      try {
        const scriptPath = join(repoRoot, "scripts", "verify-template-adoption.sh");
        expectSuccess(
          scriptPath,
          ["--target", tempRoot, "--profile", "minimal"],
          "adopted repo should pass minimal verification",
          { cwd: repoRoot },
        );
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    },
  },
  {
    name: "adopt-template-rules check mode supports directory manifest entries",
    run: () => {
      const tempRoot = mkdtempSync(join(tmpdir(), "ai-starter-pro-adopt-dir-"));
      try {
        mkdirSync(join(tempRoot, ".git"));
        const manifestPath = join(tempRoot, "manifest.txt");
        writeFileSync(manifestPath, "scripts/preflight/\n");
        const scriptPath = join(repoRoot, "scripts", "adopt-template-rules.sh");
        expectSuccess(
          scriptPath,
          ["--target", tempRoot, "--manifest", manifestPath],
          "adoption apply mode should copy directory manifest entries",
          { cwd: repoRoot },
        );
        expectSuccess(
          scriptPath,
          ["--target", tempRoot, "--manifest", manifestPath, "--mode", "check"],
          "adoption check mode should compare directory manifest entries",
          { cwd: repoRoot },
        );
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    },
  },
  {
    name: "verify-template-adoption falls back to grep when ripgrep is unavailable",
    run: () => {
      const tempRoot = createAdoptedRepo();
      try {
        const scriptPath = join(repoRoot, "scripts", "verify-template-adoption.sh");
        expectSuccess(
          scriptPath,
          ["--target", tempRoot, "--profile", "minimal"],
          "adopted repo should pass without ripgrep on PATH",
          {
            cwd: repoRoot,
            env: {
              ...process.env,
              PATH: "/usr/bin:/bin",
            },
          },
        );
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    },
  },
  {
    name: "verify-template-adoption fails when the adopted port-policy checker no longer enforces the policy",
    run: () => {
      const tempRoot = createAdoptedRepo();
      try {
        const checkerPath = join(tempRoot, "scripts", "check-port-policy.sh");
        writeFileSync(checkerPath, "#!/usr/bin/env bash\nset -euo pipefail\nexit 0\n");

        const scriptPath = join(repoRoot, "scripts", "verify-template-adoption.sh");
        expectFailure(
          scriptPath,
          ["--target", tempRoot, "--profile", "minimal"],
          "verification should fail when port-policy enforcement is bypassed",
          { cwd: repoRoot },
        );
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    },
  },
];

export default tests;
