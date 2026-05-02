import { v } from "convex/values";

import { mutation, query } from "./_generated/server.js";

const projectFields = {
  repoName: v.string(),
  sandboxWorkspaceRoot: v.string(),
  defaultBranch: v.string(),
  githubOwner: v.string(),
  githubRepo: v.string(),
  linearTeamId: v.optional(v.string()),
  linearProjectId: v.optional(v.string()),
  t3ProjectId: v.optional(v.string()),
} as const;

function projectReturn() {
  return v.object({
    id: v.id("projects"),
    repoName: v.string(),
    sandboxWorkspaceRoot: v.string(),
    defaultBranch: v.string(),
    githubOwner: v.string(),
    githubRepo: v.string(),
    linearTeamId: v.optional(v.string()),
    linearProjectId: v.optional(v.string()),
    t3ProjectId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  });
}

function toProject(row: any) {
  return {
    id: row._id,
    repoName: row.repoName,
    sandboxWorkspaceRoot: row.sandboxWorkspaceRoot,
    defaultBranch: row.defaultBranch,
    githubOwner: row.githubOwner,
    githubRepo: row.githubRepo,
    ...(row.linearTeamId !== undefined ? { linearTeamId: row.linearTeamId } : {}),
    ...(row.linearProjectId !== undefined ? { linearProjectId: row.linearProjectId } : {}),
    ...(row.t3ProjectId !== undefined ? { t3ProjectId: row.t3ProjectId } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const upsertProject = mutation({
  args: projectFields,
  returns: projectReturn(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("projects")
      .withIndex("by_repo", (q: any) =>
        q.eq("githubOwner", args.githubOwner).eq("githubRepo", args.githubRepo),
      )
      .unique();

    if (existing !== null) {
      await ctx.db.patch(existing._id, {
        repoName: args.repoName,
        sandboxWorkspaceRoot: args.sandboxWorkspaceRoot,
        defaultBranch: args.defaultBranch,
        updatedAt: now,
        ...(args.linearTeamId !== undefined ? { linearTeamId: args.linearTeamId } : {}),
        ...(args.linearProjectId !== undefined ? { linearProjectId: args.linearProjectId } : {}),
        ...(args.t3ProjectId !== undefined ? { t3ProjectId: args.t3ProjectId } : {}),
      });
      const updated = await ctx.db.get(existing._id);
      return toProject(updated);
    }

    const projectId = await ctx.db.insert("projects", {
      ...args,
      createdAt: now,
      updatedAt: now,
    });
    const created = await ctx.db.get(projectId);
    return toProject(created);
  },
});

export const listProjects = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(projectReturn()),
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("projects").take(args.limit ?? 100);
    return rows.map(toProject);
  },
});

export const getProjectByRepo = query({
  args: {
    githubOwner: v.string(),
    githubRepo: v.string(),
  },
  returns: v.union(v.null(), projectReturn()),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("projects")
      .withIndex("by_repo", (q: any) =>
        q.eq("githubOwner", args.githubOwner).eq("githubRepo", args.githubRepo),
      )
      .unique();
    return row === null ? null : toProject(row);
  },
});
