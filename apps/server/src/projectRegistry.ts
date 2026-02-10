import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  type ProjectAddInput,
  type ProjectAddResult,
  type ProjectListResult,
  type ProjectRecord,
  type ProjectRemoveInput,
  projectAddInputSchema,
  projectRecordSchema,
  projectRemoveInputSchema,
} from "@t3tools/contracts";

function normalizeCwd(rawCwd: string): string {
  const resolved = path.resolve(rawCwd.trim());
  const normalized = path.normalize(resolved);
  if (process.platform === "win32") {
    return normalized.toLowerCase();
  }
  return normalized;
}

function isDirectory(cwd: string): boolean {
  try {
    return fs.statSync(cwd).isDirectory();
  } catch {
    return false;
  }
}

function inferProjectName(cwd: string): string {
  const name = path.basename(cwd);
  return name.length > 0 ? name : "project";
}

export class ProjectRegistry {
  private readonly stateDir: string;
  private readonly filePath: string;
  private projects: ProjectRecord[];

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.filePath = path.join(this.stateDir, "projects.json");
    fs.mkdirSync(this.stateDir, { recursive: true });
    this.projects = this.loadFromDisk();
  }

  list(): ProjectListResult {
    return this.projects.map((project) => ({ ...project }));
  }

  add(raw: ProjectAddInput): ProjectAddResult {
    const input = projectAddInputSchema.parse(raw);
    const normalizedCwd = normalizeCwd(input.cwd);
    if (!isDirectory(normalizedCwd)) {
      throw new Error(`Project path does not exist: ${normalizedCwd}`);
    }

    const existing = this.projects.find((project) => normalizeCwd(project.cwd) === normalizedCwd);
    if (existing) {
      return { project: { ...existing }, created: false };
    }

    const now = new Date().toISOString();
    const project: ProjectRecord = {
      id: randomUUID(),
      cwd: normalizedCwd,
      name: inferProjectName(normalizedCwd),
      createdAt: now,
      updatedAt: now,
    };

    this.projects = [project, ...this.projects];
    this.persist();
    return { project: { ...project }, created: true };
  }

  remove(raw: ProjectRemoveInput): void {
    const input = projectRemoveInputSchema.parse(raw);
    const next = this.projects.filter((project) => project.id !== input.id);
    if (next.length === this.projects.length) {
      return;
    }

    this.projects = next;
    this.persist();
  }

  private loadFromDisk(): ProjectRecord[] {
    const loaded = this.readPersistedProjects();
    const deduped = new Map<string, ProjectRecord>();
    const normalizedProjects: ProjectRecord[] = [];

    for (const project of loaded) {
      const normalizedCwd = normalizeCwd(project.cwd);
      if (!isDirectory(normalizedCwd)) {
        continue;
      }
      if (deduped.has(normalizedCwd)) {
        continue;
      }

      const normalizedProject: ProjectRecord = {
        ...project,
        cwd: normalizedCwd,
        name:
          project.name.trim().length > 0 ? project.name.trim() : inferProjectName(normalizedCwd),
      };
      deduped.set(normalizedCwd, normalizedProject);
      normalizedProjects.push(normalizedProject);
    }

    const changed =
      normalizedProjects.length !== loaded.length ||
      normalizedProjects.some((project, index) => {
        const source = loaded[index];
        if (!source) return true;
        return (
          source.id !== project.id ||
          source.cwd !== project.cwd ||
          source.name !== project.name ||
          source.createdAt !== project.createdAt ||
          source.updatedAt !== project.updatedAt
        );
      });

    if (changed) {
      this.projects = normalizedProjects;
      this.persist();
    }

    return normalizedProjects;
  }

  private readPersistedProjects(): ProjectRecord[] {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as { projects?: unknown };
      if (!parsed || !Array.isArray(parsed.projects)) {
        return [];
      }

      const projects: ProjectRecord[] = [];
      for (const candidate of parsed.projects) {
        const row = projectRecordSchema.safeParse(candidate);
        if (!row.success) {
          continue;
        }
        projects.push(row.data);
      }
      return projects;
    } catch {
      return [];
    }
  }

  private persist(): void {
    const payload = JSON.stringify(
      {
        version: 1,
        projects: this.projects,
      },
      null,
      2,
    );
    const tempFile = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tempFile, payload);
    fs.renameSync(tempFile, this.filePath);
  }
}
