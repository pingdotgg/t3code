import * as jobs from "@distilled.cloud/gcp/jobs_v4";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const MAX_EXTERNAL_ID_LENGTH = 255;
export const MAX_DISPLAY_NAME_LENGTH = 255;
export const MAX_DESCRIPTION_LENGTH = 100_000;
export const MAX_REQUISITION_ID_LENGTH = 255;
export const MAX_TITLE_LENGTH = 500;
export const DEFAULT_LANGUAGE = "en-US";

const markerOf = (
  _labels: Record<string, string>,
  stack: string,
  stage: string,
  id: string,
) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

const fitMarker = (labels: Record<string, string>, maxLength: number) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = markerOf(labels, stack, stage, id);
  while (
    marker.length > maxLength &&
    (stack.length > 1 || stage.length > 1 || id.length > 1)
  ) {
    if (stack.length >= stage.length && stack.length >= id.length) {
      stack = stack.slice(0, -1);
    } else if (stage.length >= id.length) {
      stage = stage.slice(0, -1);
    } else {
      id = id.slice(0, -1);
    }
    marker = markerOf(labels, stack, stage, id);
  }
  return marker.slice(0, maxLength);
};

export const encodeOwnership = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_DESCRIPTION_LENGTH,
): string => {
  const marker = fitMarker(labels, Math.min(8000, maxLength));
  const trimmed = text?.trim();
  const combined =
    trimmed && trimmed.length > 0 ? `${marker}\n${trimmed}` : marker;
  return combined.slice(0, maxLength);
};

export const encodeOwnershipLine = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_EXTERNAL_ID_LENGTH,
): string => {
  const trimmed = text?.replace(/[\r\n]+/g, " ").trim();
  if (!trimmed) return fitMarker(labels, maxLength);
  const minMarker = 24;
  const reserved = Math.min(
    trimmed.length + 1,
    Math.max(0, maxLength - minMarker),
  );
  const marker = fitMarker(labels, maxLength - reserved);
  return `${marker} ${trimmed}`.slice(0, maxLength);
};

export const parseOwnership = (
  text: string | undefined,
): {
  labels: Record<string, string>;
  text: string | undefined;
} => {
  if (!text?.startsWith("[alchemy ")) {
    return { labels: {}, text };
  }
  const end = text.indexOf("]");
  if (end < 0) return { labels: {}, text };
  const labels: Record<string, string> = {};
  for (const part of text.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = text.slice(end + 1).replace(/^[\s\n]+/, "");
  return { labels, text: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (text: string | undefined) => {
  if (
    Object.keys(parseOwnership(text).labels).some((key) =>
      key.startsWith("alchemy-"),
    )
  ) {
    return true;
  }
  return (text ?? "").toLowerCase().includes("alchemy-");
};

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByAlchemy = (id: string, text: string | undefined) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const { labels } = parseOwnership(text);
    if (!hasOwnershipMarker(text)) return false;
    const exact = yield* hasAlchemyLabels(id, labels);
    if (exact) return true;
    return (
      prefixMatch(
        expected[alchemyLabelKeys.stack] ?? "",
        labels[alchemyLabelKeys.stack] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.stage] ?? "",
        labels[alchemyLabelKeys.stage] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.id] ?? "",
        labels[alchemyLabelKeys.id] ?? "",
      )
    );
  });

export const ownershipLabels = (id: string) => createInternalLabels(id);

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const parentOf = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  return parts.slice(0, -2).join("/");
};

export const projectParent = (project: string) => `projects/${project}`;

export const tenantNameOf = (project: string, tenantId: string) => {
  if (tenantId.length === 0) return "";
  if (tenantId.includes("/tenants/")) return tenantId.replace(/\/+$/, "");
  return `projects/${project}/tenants/${lastSegment(tenantId)}`;
};

export const companyNameOf = (parent: string, companyId: string) => {
  if (companyId.length === 0) return "";
  if (companyId.includes("/companies/")) return companyId.replace(/\/+$/, "");
  return `${parent}/companies/${lastSegment(companyId)}`;
};

export const jobNameOf = (parent: string, jobId: string) => {
  if (jobId.length === 0) return "";
  if (jobId.includes("/jobs/")) return jobId.replace(/\/+$/, "");
  return `${parent}/jobs/${lastSegment(jobId)}`;
};

export const parseTenantName = (name: string, fallbackProject: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const tenantsAt = parts.lastIndexOf("tenants");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1]
        ? parts[projectsAt + 1]!
        : fallbackProject,
    tenantId:
      tenantsAt >= 0 && parts[tenantsAt + 1]
        ? parts[tenantsAt + 1]!
        : lastSegment(name),
    name,
  };
};

export const parseCompanyName = (name: string, fallbackProject: string) => {
  const parsed = parseTenantName(name, fallbackProject);
  const parts = name.split("/").filter((part) => part.length > 0);
  const companiesAt = parts.lastIndexOf("companies");
  const tenantsAt = parts.lastIndexOf("tenants");
  return {
    ...parsed,
    parent:
      tenantsAt >= 0 && parts[tenantsAt + 1]
        ? parts.slice(0, tenantsAt + 2).join("/")
        : parentOf(name),
    companyId:
      companiesAt >= 0 && parts[companiesAt + 1]
        ? parts[companiesAt + 1]!
        : lastSegment(name),
  };
};

export const parseJobName = (name: string, fallbackProject: string) => {
  const parsed = parseTenantName(name, fallbackProject);
  const parts = name.split("/").filter((part) => part.length > 0);
  const jobsAt = parts.lastIndexOf("jobs");
  const tenantsAt = parts.lastIndexOf("tenants");
  return {
    ...parsed,
    parent:
      tenantsAt >= 0 && parts[tenantsAt + 1]
        ? parts.slice(0, tenantsAt + 2).join("/")
        : parentOf(name),
    jobId:
      jobsAt >= 0 && parts[jobsAt + 1] ? parts[jobsAt + 1]! : lastSegment(name),
  };
};

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sameBoolean = (
  left: boolean | undefined,
  right: boolean | undefined,
) => (left ?? false) === (right ?? false);

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  jsonEqual(
    [...(left ?? [])].slice().sort(),
    [...(right ?? [])].slice().sort(),
  );

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const replaceOnIdentity = (input: {
  previousId?: string;
  nextId?: string;
  previousParent?: string;
  nextParent?: string;
  extra?: boolean;
}) => {
  if (input.extra === true) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if (
    input.previousId !== undefined &&
    input.nextId !== undefined &&
    input.previousId !== input.nextId
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  if (
    input.previousParent !== undefined &&
    input.nextParent !== undefined &&
    input.previousParent !== input.nextParent
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  return undefined;
};

export const toGeneratedName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  maxLength = 80,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) {
      return requested.slice(0, maxLength);
    }
    if (existing !== undefined && existing.length > 0) {
      return existing.slice(0, maxLength);
    }
    const generated = yield* createPhysicalName({
      id,
      maxLength,
      lowercase: true,
    });
    const next = /^[a-z]/.test(generated)
      ? generated
      : `j${generated}`.slice(0, maxLength);
    return next.length >= 4 ? next : `${next}xxxx`.slice(0, maxLength);
  });

const emptyList = <A>() => Effect.succeed([] as A[]);

export const retryTransient = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) =>
        error._tag === "Conflict" ||
        error._tag === "BadRequest" ||
        error._tag === "NotFound",
      times: 8,
      schedule: Schedule.exponential("250 millis"),
    }),
  );

export class DeleteNotConfirmed extends Data.TaggedError(
  "GCP.Jobs.DeleteNotConfirmed",
)<{}> {}

/** Poll until the resource is gone; fails if it is still readable after ~60s. */
export const waitUntilGone = <A, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
) =>
  get.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (value) => value === undefined,
      times: 30,
    }),
    Effect.flatMap((value): Effect.Effect<void, DeleteNotConfirmed> =>
      value === undefined ? Effect.void : Effect.fail(new DeleteNotConfirmed()),
    ),
  );

const collectPages = <Page, Item, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly Item[] | null | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk): Item[] => Array.from(chunk)),
  );

export const getTenant = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : jobs
        .getProjectsTenants({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const getCompany = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : jobs
        .getProjectsTenantsCompanies({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const getJob = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : jobs
        .getProjectsTenantsJobs({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const listTenants = (project: string) =>
  collectPages(
    jobs.listProjectsTenants.pages({
      parent: projectParent(project),
      pageSize: 100,
    }),
    (page) => page.tenants,
  ).pipe(Effect.catchTag("NotFound", () => emptyList<jobs.Tenant>()));

export const listCompanies = (parent: string) =>
  parent.length === 0
    ? emptyList<jobs.Company>()
    : collectPages(
        jobs.listProjectsTenantsCompanies.pages({
          parent,
          pageSize: 100,
        }),
        (page) => page.companies,
      ).pipe(Effect.catchTag("NotFound", () => emptyList<jobs.Company>()));

export const listJobs = (parent: string, companyName: string) =>
  parent.length === 0 || companyName.length === 0
    ? emptyList<jobs.Job>()
    : collectPages(
        jobs.listProjectsTenantsJobs.pages({
          parent,
          filter: `companyName = "${companyName}" AND status = "ALL"`,
          pageSize: 100,
          jobView: "JOB_VIEW_FULL",
        }),
        (page) => page.jobs,
      ).pipe(Effect.catchTag("NotFound", () => emptyList<jobs.Job>()));

export const listOwnedTenants = (project: string) =>
  listTenants(project).pipe(
    Effect.map((tenants) =>
      tenants.filter((tenant) => hasOwnershipMarker(tenant.externalId)),
    ),
  );

export const listOwnedCompanies = (project: string) =>
  Effect.gen(function* () {
    const tenants = yield* listTenants(project);
    const pages = yield* Effect.forEach(
      tenants,
      (tenant) =>
        tenant.name ? listCompanies(tenant.name) : emptyList<jobs.Company>(),
      { concurrency: 4 },
    );
    return pages
      .flat()
      .filter(
        (company) =>
          hasOwnershipMarker(company.displayName) ||
          hasOwnershipMarker(company.externalId),
      );
  });

export const listOwnedJobs = (project: string) =>
  Effect.gen(function* () {
    const tenants = yield* listTenants(project);
    const companies = yield* Effect.forEach(
      tenants,
      (tenant) =>
        tenant.name ? listCompanies(tenant.name) : emptyList<jobs.Company>(),
      { concurrency: 4 },
    );
    const listed = companies.flat();
    const pages = yield* Effect.forEach(
      listed,
      (company) => {
        const parent = company.name ? parentOf(company.name) : "";
        return company.name
          ? listJobs(parent, company.name)
          : emptyList<jobs.Job>();
      },
      { concurrency: 4 },
    );
    return pages
      .flat()
      .filter(
        (job) =>
          hasOwnershipMarker(job.description) ||
          hasOwnershipMarker(job.requisitionId),
      );
  });

export const findOwnedTenant = (project: string, id: string) =>
  Effect.gen(function* () {
    const tenants = yield* listTenants(project);
    for (const tenant of tenants) {
      if (yield* ownedByAlchemy(id, tenant.externalId)) {
        return tenant;
      }
    }
    return undefined;
  });

export const findOwnedCompany = (parent: string, id: string) =>
  Effect.gen(function* () {
    const companies = yield* listCompanies(parent);
    for (const company of companies) {
      if (
        (yield* ownedByAlchemy(id, company.displayName)) ||
        (yield* ownedByAlchemy(id, company.externalId))
      ) {
        return company;
      }
    }
    return undefined;
  });

export const findOwnedJob = (parent: string, id: string) =>
  Effect.gen(function* () {
    const companies = yield* listCompanies(parent);
    for (const company of companies) {
      if (!company.name) continue;
      const listed = yield* listJobs(parent, company.name);
      for (const job of listed) {
        if (
          (yield* ownedByAlchemy(id, job.description)) ||
          (yield* ownedByAlchemy(id, job.requisitionId))
        ) {
          return job;
        }
      }
    }
    return undefined;
  });

export const deleteJob = (name: string) =>
  name.length === 0
    ? Effect.void
    : jobs
        .deleteProjectsTenantsJobs({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));

export const deleteCompany = (name: string) =>
  Effect.gen(function* () {
    if (name.length === 0) return;
    const parent = parentOf(name);
    const listed = yield* listJobs(parent, name);
    yield* Effect.forEach(
      listed,
      (job) => (job.name ? deleteJob(job.name) : Effect.void),
      { concurrency: 4 },
    );
    yield* retryTransient(
      jobs
        .deleteProjectsTenantsCompanies({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void)),
    );
  });

export const deleteTenant = (name: string) =>
  Effect.gen(function* () {
    if (name.length === 0) return;
    const companies = yield* listCompanies(name);
    yield* Effect.forEach(
      companies,
      (company) => (company.name ? deleteCompany(company.name) : Effect.void),
      { concurrency: 4 },
    );
    yield* retryTransient(
      jobs
        .deleteProjectsTenants({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void)),
    );
  });
