/**
 * SkillPlacement - where a skill lives and where it is used: in a project, in Global, or in
 * Global but used only in some projects.
 *
 * | from \ to        | project              | global              | only these projects      |
 * | ---------------- | -------------------- | ------------------- | ------------------------ |
 * | a project's      | move the folder      | move the folder     | into the library, link   |
 * | Global           | move the folder      | -                   | into the library, link   |
 * | in the library   | move it, drop links  | move it, drop links | add and remove links     |
 *
 * A skill used in only some projects is one folder in the library (`SkillLibrary`) with a link to
 * it in each of those projects, so there is one copy to edit. A skill whose real folder is outside
 * every agent folder, such as a synced library's, is never moved: its library entry is a link to it.
 *
 * Every transition re-reads the folders it works on, replaces nothing that is in the way
 * (`destinationTaken`), and undoes the steps it has taken when a later one fails, so a failure
 * leaves the skill where it was. What an agent used it through (its own link, its settings) goes
 * with the skill: Codex's switch-off is keyed by the real SKILL.md, so it follows a moved folder
 * (`PlacementView.followMove`). The skill's source record in the `skills` CLI's lock
 * (`SkillLockFiles`) moves with it between a project and Global, or is dropped when the lock
 * can't take it, which the result says (`sourceDropped`).
 *
 * The agents of a skill used in only some projects are switched through its project links: a link
 * in each project's folder for an agent that doesn't read the shared one (`addLibraryLinks`,
 * `removeLibraryLinks`). A link that goes is taken out of the project's git worktrees too.
 *
 * @module SkillPlacement
 */
import {
  SkillOutcomeReason,
  type ProviderInstanceId,
  type SkillAgentState,
  type SkillOutcome,
  type SkillPlacement,
  type SkillScope,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  STANDARD_SKILL_FOLDER,
  ownProjectFolderFor,
  skillFoldersFor,
} from "@t3tools/provider-core/server/AgentSkillFolders";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import type * as SkillCatalog from "./SkillCatalog.ts";
import { projectPrefixOf, updateExclude, worktreesOf } from "./SkillGitExclude.ts";
import { LIBRARY_FOLDER, libraryLinksOf, linkLeadsTo, type LibraryLink } from "./SkillLibrary.ts";
import { createLink, removeLink, type RemoveLinkResult } from "./SkillLinks.ts";
import { moveRecord, type LockScope, type MoveRecordResult } from "./SkillLockFiles.ts";
import { moveFolder } from "./SkillMove.ts";

type Blocked = SkillOutcome["blocked"][number];

/** What a placement did to one skill, before it is told to a client. */
export interface PlacementChange {
  /** A folder or link was made, moved or removed. */
  readonly wrote: boolean;
  /** Agents the change didn't reach. */
  readonly blocked: readonly Blocked[];
  /** Something about the skill as a whole kept the change from being complete. */
  readonly reason?: SkillOutcomeReason | undefined;
  /** Agents that gained or lost the skill without being asked. */
  readonly affected?: readonly ProviderInstanceId[] | undefined;
  /** Agents whose skill list changed; their `$` picker is refreshed. */
  readonly touched?: readonly ProviderInstanceId[] | undefined;
  /** The skill's source record couldn't go along with it, so the skill no longer has one. */
  readonly sourceDropped?: boolean | undefined;
}

/** A step found the placement can't be done; what was done before it is undone. */
class SkillPlacementRefused extends Schema.TaggedError<SkillPlacementRefused>()(
  "SkillPlacementRefused",
  { reason: SkillOutcomeReason },
) {}

const isRefused = Schema.is(SkillPlacementRefused);

const skipped = (reason: SkillOutcomeReason): PlacementChange => ({
  wrote: false,
  blocked: [],
  reason,
});

/** An agent that sees the skill, whether or not its own settings have it switched off. */
const sees = (state: SkillAgentState) => state !== "none";

/** What the placement is about: where the list was read, and everything looked up for it. */
export interface PlacementView {
  /** The project the list was read for. */
  readonly cwd: string | undefined;
  readonly all: ReadonlyArray<SkillCatalog.ResolvedSkill>;
  /**
   * Called once the skill's real folder has moved to `home`, so the agents' own settings that name
   * the old place can name the new one. Agents it couldn't carry over are returned.
   */
  readonly followMove?: (home: string) => Effect.Effect<readonly Blocked[]>;
}

/** A skill kept in the library, whose registered projects' links the catalog found. */
export type LibrarySkill = SkillCatalog.ResolvedSkill & {
  readonly library: NonNullable<SkillCatalog.ResolvedSkill["library"]>;
};

/** The projects a library skill is used in: where the shared folder has its link. */
export const projectsOfLibrarySkill = (skill: LibrarySkill) => [
  ...new Set(
    skill.library.links
      .filter((link) => link.folder === STANDARD_SKILL_FOLDER)
      .map((link) => link.project),
  ),
];

export interface PlacementDeps {
  readonly catalog: SkillCatalog.SkillCatalog["Service"];
  readonly platform: NodeJS.Platform;
  readonly environment: NodeJS.ProcessEnv;
  readonly home: string;
  /** The registered projects' workspace roots. */
  readonly registeredRoots: Effect.Effect<ReadonlyArray<string>>;
  /** Gives the agents a link, by the rules of turning a skill on. */
  readonly enable: (
    skill: SkillCatalog.ResolvedSkill,
    agents: ReadonlySet<ProviderInstanceId>,
    projectRoot: string | undefined,
  ) => Effect.Effect<{ readonly wrote: boolean; readonly blocked: readonly Blocked[] }>;
}

/** Steps to undo, last first, when a later one fails. */
const makeJournal = () => {
  const undo: Array<Effect.Effect<void>> = [];
  return {
    /** A step that fails while undoing is skipped: the rest still run. */
    add: <E>(step: Effect.Effect<unknown, E>) => {
      undo.push(Effect.ignore(step));
    },
    rollback: Effect.suspend(() =>
      Effect.forEach(undo.toReversed(), (step) => step, { discard: true }),
    ),
  };
};
type Journal = ReturnType<typeof makeJournal>;

export const makeSkillPlacement = Effect.fnUntraced(function* (deps: PlacementDeps) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | VcsProcess.VcsProcess
  >();
  const inContext = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | VcsProcess.VcsProcess>,
  ) => effect.pipe(Effect.provideContext(context));
  const libraryDirectory = path.join(deps.home, LIBRARY_FOLDER);

  const realPath = (target: string) =>
    fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => target));

  /** Anything at the path, even a link that leads nowhere. Doubt counts as taken. */
  const occupied = (target: string) =>
    fileSystem.readLink(target).pipe(
      Effect.as(true),
      Effect.catchTags({
        PlatformError: (error) => Effect.succeed(error.reason._tag !== "NotFound"),
      }),
    );

  const reaching = (
    skill: SkillCatalog.ResolvedSkill,
    all: ReadonlyArray<SkillCatalog.ResolvedSkill>,
  ) => all.filter((other) => other.name === skill.name && other.home === skill.home);

  const agentsWith = (skills: ReadonlyArray<SkillCatalog.ResolvedSkill>) =>
    new Set(
      skills.flatMap((skill) =>
        skill.agents.filter((agent) => sees(agent.state)).map((agent) => agent.instanceId),
      ),
    );

  /** The links among the skills' entries, with what each points at as written. */
  const linksTo = (skills: ReadonlyArray<SkillCatalog.ResolvedSkill>) =>
    [
      ...new Map(
        skills.flatMap((skill) =>
          skill.entries.flatMap((entry) =>
            entry.target === undefined ? [] : [[entry.path, entry.target] as const],
          ),
        ),
      ),
    ].map(([linkPath, target]) => ({ path: linkPath, target }));

  /** Removes links that are still what was inspected, and remembers how to put each back. */
  const unlink = Effect.fnUntraced(function* (
    journal: Journal,
    links: ReadonlyArray<{ readonly path: string; readonly target: string }>,
  ) {
    const results = new Map<string, RemoveLinkResult | "failed">();
    for (const link of links) {
      const result = yield* inContext(
        removeLink({ path: link.path, expectedTarget: link.target }),
      ).pipe(Effect.catchTags({ SkillLinkError: () => Effect.succeed("failed" as const) }));
      results.set(link.path, result);
      if (result === "removed") journal.add(fileSystem.symlink(link.target, link.path));
    }
    return results;
  });

  /** Makes a link to the library entry, which has to lead to `home`, and remembers to remove it. */
  const linkTo = Effect.fnUntraced(function* (
    journal: Journal,
    input: { readonly link: string; readonly target: string; readonly home: string },
    scope: SkillScope,
  ) {
    const result = yield* inContext(
      createLink({
        link: input.link,
        home: input.home,
        scope,
        platform: deps.platform,
        target: input.target,
      }),
    );
    if (result === "created") {
      journal.add(inContext(removeLink({ path: input.link, expectedTarget: input.target })));
    }
    return result;
  });

  /**
   * Links each project to the library entry: always in the shared folder, and in each of `folders`
   * for the agents that don't read it. A shared link that can't be made refuses the placement; an
   * agent's own is reported as blocked. Lines for the links made go into the project's exclude file.
   */
  const linkProjects = Effect.fnUntraced(function* (
    journal: Journal,
    input: {
      readonly projects: ReadonlyArray<string>;
      readonly name: string;
      readonly entry: string;
      readonly home: string;
      readonly folders: ReadonlyArray<string>;
      readonly agentsOf: (folder: string) => readonly ProviderInstanceId[];
    },
  ) {
    const blocked: Blocked[] = [];
    for (const project of input.projects) {
      const made: string[] = [];
      for (const folder of [STANDARD_SKILL_FOLDER, ...input.folders]) {
        const link = path.join(project, folder, input.name);
        const result = yield* linkTo(
          journal,
          { link, target: input.entry, home: input.home },
          "project",
        );
        if (result === "created") made.push(link);
        else if (result === "taken" || result === "notAllowed") {
          if (folder === STANDARD_SKILL_FOLDER) {
            return yield* new SkillPlacementRefused({
              reason: result === "taken" ? "destinationTaken" : "linkNotAllowed",
            });
          }
          for (const instanceId of input.agentsOf(folder)) {
            blocked.push({
              instanceId,
              reason: result === "taken" ? "entryTaken" : "linkNotAllowed",
            });
          }
        }
      }
      if (made.length > 0) {
        yield* inContext(updateExclude({ projectRoot: project, links: made, action: "add" }));
        journal.add(
          inContext(updateExclude({ projectRoot: project, links: made, action: "remove" })),
        );
      }
    }
    return blocked;
  });

  /**
   * Removes the library skill's links that the project's other git worktrees got when they were
   * made, which only the links that lead to `entry` count as. A link that is a folder there, or
   * leads somewhere else, stays.
   */
  const unlinkInWorktrees = Effect.fnUntraced(function* (
    journal: Journal,
    links: ReadonlyArray<LibraryLink>,
    entry: string,
  ) {
    for (const project of new Set(links.map((link) => link.project))) {
      const own = yield* realPath(project);
      const worktrees = yield* inContext(worktreesOf(project));
      // Each worktree holds the whole repository, so the project's folder is under its root.
      const prefix = yield* inContext(projectPrefixOf(project));
      for (const worktree of worktrees) {
        // The checkout the project is in (or is inside) keeps what it has.
        const real = yield* realPath(worktree);
        if (own === real || own.startsWith(`${real}${path.sep}`)) continue;
        const found: Array<{ path: string; target: string }> = [];
        for (const link of links.filter((item) => item.project === project)) {
          const created = path.join(worktree, prefix, link.folder, path.basename(link.path));
          const target = yield* fileSystem.readLink(created).pipe(
            Effect.map((value): string | undefined => value),
            Effect.orElseSucceed(() => undefined),
          );
          if (target !== undefined && linkLeadsTo(path, { path: created, target }, entry)) {
            found.push({ path: created, target });
          }
        }
        yield* unlink(journal, found);
      }
    }
  });

  /**
   * Removes a library skill's links from these projects (and from their git worktrees), and their
   * lines from the exclude files. What happened to each link is told; a link that is gone counts
   * as removed.
   */
  const unlinkProjects = Effect.fnUntraced(function* (
    journal: Journal,
    links: ReadonlyArray<LibraryLink>,
    entry: string,
  ) {
    const results = yield* unlink(journal, links);
    const gone = links.filter((link) => {
      const result = results.get(link.path);
      return result === "removed" || result === "gone";
    });
    yield* unlinkInWorktrees(journal, gone, entry);
    for (const project of new Set(gone.map((link) => link.project))) {
      const paths = gone.filter((link) => link.project === project).map((link) => link.path);
      yield* inContext(updateExclude({ projectRoot: project, links: paths, action: "remove" }));
      journal.add(inContext(updateExclude({ projectRoot: project, links: paths, action: "add" })));
    }
    return results;
  });

  /** Whether any of the links was left in place or couldn't be removed. */
  const anyStuck = (links: ReadonlyArray<LibraryLink>, results: ReadonlyMap<string, string>) =>
    links.some(
      (link) => results.get(link.path) === "changed" || results.get(link.path) === "failed",
    );

  /**
   * The skill's source record goes along; a failure is logged and never undoes the placement.
   * Whether the record had to be dropped is told, since the skill then has no source any more.
   */
  const moveSourceRecord = (input: {
    readonly name: string;
    readonly from: LockScope;
    readonly to: LockScope;
    readonly folder: string;
  }) =>
    inContext(moveRecord({ ...input, environment: deps.environment, home: deps.home })).pipe(
      Effect.map((result: MoveRecordResult) => result === "dropped"),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.as(
              Effect.logWarning("could not move a skill's source record", {
                name: input.name,
                cause: Cause.pretty(cause),
              }),
              false,
            ),
      ),
    );

  /** Who gained or lost the skill, read from the folders after the placement. */
  const settle = Effect.fnUntraced(function* (input: {
    readonly view: PlacementView;
    readonly skill: SkillCatalog.ResolvedSkill;
    readonly had: ReadonlySet<ProviderInstanceId>;
    readonly home: string;
    readonly blocked: readonly Blocked[];
    readonly reason?: SkillOutcomeReason | undefined;
    readonly sourceDropped?: boolean | undefined;
  }) {
    const after = yield* deps.catalog.resolve({
      cwd: input.view.cwd,
      skills: [
        { scope: "global", name: input.skill.name },
        { scope: "project", name: input.skill.name },
      ],
    });
    const has = agentsWith(after.filter((item) => item.home === input.home));
    const unreached = new Set(input.blocked.map((item) => item.instanceId));
    const touched = [...new Set([...input.had, ...has])];
    return {
      wrote: true,
      blocked: input.blocked,
      reason: input.reason,
      touched,
      affected: touched.filter((id) => input.had.has(id) !== has.has(id) && !unreached.has(id)),
      ...(input.sourceDropped === true ? { sourceDropped: true } : {}),
    } satisfies PlacementChange;
  });

  /**
   * A project's skill into Global or another project, or Global's into a project: the real folder
   * moves, the links that led to the old place go, and every agent that used the skill gets it
   * at the new place.
   */
  const moveBetween = Effect.fnUntraced(function* (
    skill: SkillCatalog.ResolvedSkill,
    dest: { readonly scope: "global" } | { readonly scope: "project"; readonly cwd: string },
    view: PlacementView,
  ) {
    if (!skill.own) return skipped("linked");
    const folder =
      dest.scope === "global"
        ? skill.standardFolders.global
        : path.join(dest.cwd, STANDARD_SKILL_FOLDER);
    if (folder === undefined) return skipped("failed");
    const destination = path.join(folder, skill.name);
    // Whatever is under the name there, a skill or not, is never merged into or replaced.
    const theirs =
      dest.scope === "global"
        ? view.all
        : yield* deps.catalog.resolve({
            cwd: dest.cwd,
            skills: [{ scope: "project", name: skill.name }],
          });
    if (theirs.some((other) => other.scope === dest.scope && other.name === skill.name)) {
      return skipped("destinationTaken");
    }

    const audience = reaching(skill, view.all);
    const had = agentsWith(audience);
    const stale = linksTo(audience);
    const moved = yield* inContext(
      moveFolder({ from: skill.home, to: destination, platform: deps.platform }),
    ).pipe(Effect.catchTags({ SkillMoveError: () => Effect.succeed("failed" as const) }));
    if (moved === "taken") return skipped("destinationTaken");
    if (moved === "inUse") return skipped("inUse");
    if (moved === "failed") return skipped("failed");

    // The folder is in its new place; the links that led to the old one lead nowhere now. They go
    // before new ones are made, because a new link may need the same path.
    yield* unlink(makeJournal(), stale);
    const real = yield* realPath(destination);
    const landedIn = dest.scope === "global" ? view.cwd : dest.cwd;
    const resolveLanded = () =>
      deps.catalog
        .resolve({ cwd: landedIn, skills: [{ scope: dest.scope, name: skill.name }] })
        .pipe(
          Effect.map((items) =>
            items.find((item) => item.scope === dest.scope && item.home === real),
          ),
        );
    const reason = moved === "movedWithLeftover" ? ("failed" as const) : undefined;

    const from: LockScope =
      skill.scope === "project" && view.cwd !== undefined
        ? { kind: "project", root: view.cwd }
        : { kind: "global" };
    const to: LockScope =
      dest.scope === "global" ? { kind: "global" } : { kind: "project", root: dest.cwd };
    const sourceDropped = yield* moveSourceRecord({ name: skill.name, from, to, folder: real });
    const followed = view.followMove === undefined ? [] : yield* view.followMove(real);

    const landed = yield* resolveLanded();
    if (landed === undefined) {
      return {
        wrote: true,
        blocked: followed,
        reason: "failed",
        touched: [...had],
        ...(sourceDropped ? { sourceDropped } : {}),
      } satisfies PlacementChange;
    }
    // Every agent that used the skill keeps using it. One that reads the new scope's shared folder
    // already does; any other gets a link in its own folder, by the same rules as turning it on.
    const lacking = new Set(
      landed.agents
        .filter((agent) => had.has(agent.instanceId) && agent.state === "none")
        .map((agent) => agent.instanceId),
    );
    const relinked =
      lacking.size === 0
        ? { wrote: false, blocked: [] as readonly Blocked[] }
        : yield* deps.enable(
            landed,
            lacking,
            dest.scope === "project" ? yield* realPath(dest.cwd) : undefined,
          );
    return yield* settle({
      view,
      skill,
      had,
      home: real,
      blocked: [...relinked.blocked, ...followed],
      reason,
      sourceDropped,
    });
  });

  /** One skill into the library, linked into `projects`. */
  const intoLibrary = Effect.fnUntraced(function* (
    journal: Journal,
    skill: SkillCatalog.ResolvedSkill,
    projects: ReadonlyArray<string>,
    view: PlacementView,
  ) {
    const entry = path.join(libraryDirectory, skill.name);
    // A real folder in an agent's own folder is moved; anything else (a synced library's folder)
    // stays where it is and the library gets a link to it.
    if (!skill.own && skill.entries.some((item) => item.target === undefined)) {
      return skipped("linked");
    }
    if (/[\r\n]/.test(skill.name)) return skipped("failed");
    const audience = reaching(skill, view.all);
    const vacated = new Set(audience.flatMap((item) => item.entries.map((e) => e.path)));
    if (yield* occupied(entry)) return skipped("destinationTaken");
    for (const project of projects) {
      const shared = path.join(project, STANDARD_SKILL_FOLDER, skill.name);
      if (!vacated.has(shared) && (yield* occupied(shared))) return skipped("destinationTaken");
    }

    const instances = skill.agents;
    const had = agentsWith(audience);
    const folders = [
      ...new Set(
        instances.flatMap((agent) => {
          const own = had.has(agent.instanceId) ? ownProjectFolderFor(agent.driver) : undefined;
          return own === undefined ? [] : [own];
        }),
      ),
    ];
    const stale = linksTo(audience);

    let reason: SkillOutcomeReason | undefined;
    if (skill.own) {
      const moved = yield* inContext(
        moveFolder({ from: skill.home, to: entry, platform: deps.platform }),
      );
      if (moved === "taken")
        return yield* new SkillPlacementRefused({ reason: "destinationTaken" });
      if (moved === "inUse") return yield* new SkillPlacementRefused({ reason: "inUse" });
      journal.add(inContext(moveFolder({ from: entry, to: skill.home, platform: deps.platform })));
      if (moved === "movedWithLeftover") reason = "failed";
    } else {
      yield* fileSystem.makeDirectory(libraryDirectory, { recursive: true });
      const made = yield* linkTo(
        journal,
        { link: entry, target: skill.home, home: skill.home },
        "global",
      );
      if (made !== "created")
        return yield* new SkillPlacementRefused({ reason: "destinationTaken" });
    }

    // The links that led to the old place go before new ones are made: a new link may need the
    // same path, as when the skill is already in one of the projects.
    yield* unlink(journal, stale);
    const home = yield* realPath(entry);
    const followed = skill.own && view.followMove !== undefined ? yield* view.followMove(home) : [];
    const blocked = yield* linkProjects(journal, {
      projects,
      name: skill.name,
      entry,
      home,
      folders,
      agentsOf: (folder) =>
        instances
          .filter((agent) => ownProjectFolderFor(agent.driver) === folder)
          .map((agent) => agent.instanceId),
    });
    const sourceDropped =
      skill.scope === "project" && view.cwd !== undefined
        ? yield* moveSourceRecord({
            name: skill.name,
            from: { kind: "project", root: view.cwd },
            to: { kind: "global" },
            folder: home,
          })
        : false;
    return yield* settle({
      view,
      skill,
      had,
      home,
      blocked: [...blocked, ...followed],
      reason,
      sourceDropped,
    });
  });

  /** A library skill used in a different set of projects: links are added and taken away. */
  const retarget = Effect.fnUntraced(function* (
    journal: Journal,
    skill: LibrarySkill,
    projects: ReadonlyArray<string>,
    view: PlacementView,
  ) {
    const links = yield* inContext(
      libraryLinksOf({
        roots: yield* deps.registeredRoots,
        name: skill.name,
        entry: skill.library.entry,
      }),
    );
    const current = [...new Set(links.map((link) => link.project))];
    const add = projects.filter((project) => !current.includes(project));
    const remove = current.filter((project) => !projects.includes(project));
    if (add.length === 0 && remove.length === 0) {
      return { wrote: false, blocked: [] } satisfies PlacementChange;
    }
    for (const project of add) {
      if (yield* occupied(path.join(project, STANDARD_SKILL_FOLDER, skill.name))) {
        return skipped("destinationTaken");
      }
    }
    const folders = [...new Set(links.map((link) => link.folder))].filter(
      (folder) => folder !== STANDARD_SKILL_FOLDER,
    );
    const had = agentsWith([skill]);
    const blocked = yield* linkProjects(journal, {
      projects: add,
      name: skill.name,
      entry: skill.library.entry,
      home: skill.home,
      folders,
      agentsOf: (folder) =>
        skill.agents
          .filter((agent) => ownProjectFolderFor(agent.driver) === folder)
          .map((agent) => agent.instanceId),
    });
    const leaving = links.filter((link) => remove.includes(link.project));
    const results = yield* unlinkProjects(journal, leaving, skill.library.entry);
    return yield* settle({
      view,
      skill,
      had,
      home: skill.home,
      blocked,
      reason: anyStuck(leaving, results) ? "changed" : undefined,
    });
  });

  /** A library skill into Global or one project: its links go, and the folder takes the place. */
  const outOfLibrary = Effect.fnUntraced(function* (
    journal: Journal,
    skill: LibrarySkill,
    dest: { readonly scope: "global" } | { readonly scope: "project"; readonly cwd: string },
    view: PlacementView,
  ) {
    const folder =
      dest.scope === "global"
        ? skill.standardFolders.global
        : path.join(dest.cwd, STANDARD_SKILL_FOLDER);
    if (folder === undefined) return skipped("failed");
    const destination = path.join(folder, skill.name);
    const links = yield* inContext(
      libraryLinksOf({
        roots: yield* deps.registeredRoots,
        name: skill.name,
        entry: skill.library.entry,
      }),
    );
    // Another skill with this name is never merged into or replaced. Links of this skill's own
    // that are about to go don't count.
    if (
      dest.scope === "global" &&
      view.all.some(
        (other) =>
          other.scope === "global" && other.name === skill.name && other.library === undefined,
      )
    ) {
      return skipped("destinationTaken");
    }
    if (dest.scope === "project") {
      const theirs = yield* deps.catalog.resolve({
        cwd: dest.cwd,
        skills: [{ scope: "project", name: skill.name }],
      });
      if (theirs.some((other) => other.scope === "project" && other.name === skill.name)) {
        return skipped("destinationTaken");
      }
    }
    const leaving = new Set(links.map((link) => link.path));
    if (!leaving.has(destination) && (yield* occupied(destination))) {
      return skipped("destinationTaken");
    }

    // Agents that used it in any project keep using it where it goes.
    const linkFolders = new Set(links.map((link) => link.folder));
    const had = new Set([
      ...agentsWith([skill]),
      ...skill.agents
        .filter((agent) => skillFoldersFor(agent.driver, "project").some((f) => linkFolders.has(f)))
        .map((agent) => agent.instanceId),
    ]);

    // The links come out first: one of them may be in the way of the folder.
    const unlinked = yield* unlinkProjects(journal, links, skill.library.entry);
    let reason: SkillOutcomeReason | undefined = anyStuck(links, unlinked) ? "changed" : undefined;
    if (skill.own) {
      const moved = yield* inContext(
        moveFolder({ from: skill.library.entry, to: destination, platform: deps.platform }),
      );
      if (moved === "taken")
        return yield* new SkillPlacementRefused({ reason: "destinationTaken" });
      if (moved === "inUse") return yield* new SkillPlacementRefused({ reason: "inUse" });
      journal.add(
        inContext(
          moveFolder({ from: destination, to: skill.library.entry, platform: deps.platform }),
        ),
      );
      if (moved === "movedWithLeftover") reason = "failed";
    } else {
      const made = yield* linkTo(
        journal,
        { link: destination, target: skill.home, home: skill.home },
        dest.scope,
      );
      if (made !== "created")
        return yield* new SkillPlacementRefused({ reason: "destinationTaken" });
      const removed = yield* unlink(journal, [
        { path: skill.library.entry, target: skill.library.target ?? skill.home },
      ]);
      if (removed.get(skill.library.entry) === "failed")
        return yield* new SkillPlacementRefused({ reason: "failed" });
    }

    const real = yield* realPath(destination);
    const followed = skill.own && view.followMove !== undefined ? yield* view.followMove(real) : [];
    const sourceDropped =
      dest.scope === "project"
        ? yield* moveSourceRecord({
            name: skill.name,
            from: { kind: "global" },
            to: { kind: "project", root: dest.cwd },
            folder: real,
          })
        : false;
    const landedIn = dest.scope === "global" ? view.cwd : dest.cwd;
    const landed = (yield* deps.catalog.resolve({
      cwd: landedIn,
      skills: [{ scope: dest.scope, name: skill.name }],
    })).find((item) => item.scope === dest.scope && item.home === real);
    const lacking = new Set(
      (landed?.agents ?? [])
        .filter((agent) => had.has(agent.instanceId) && agent.state === "none")
        .map((agent) => agent.instanceId),
    );
    const relinked =
      landed === undefined || lacking.size === 0
        ? { wrote: false, blocked: [] as readonly Blocked[] }
        : yield* deps.enable(
            landed,
            lacking,
            dest.scope === "project" ? yield* realPath(dest.cwd) : undefined,
          );
    return yield* settle({
      view,
      skill,
      had,
      home: real,
      blocked: [...relinked.blocked, ...followed],
      reason,
      sourceDropped,
    });
  });

  /**
   * Puts one skill where `to` says. The skill is the one the folders hold now; `view.all` is every
   * same-named skill looked up with it.
   */
  const place = (
    skill: SkillCatalog.ResolvedSkill,
    to: SkillPlacement,
    view: PlacementView,
  ): Effect.Effect<PlacementChange> => {
    const journal = makeJournal();
    const library: LibrarySkill | undefined =
      skill.library === undefined ? undefined : { ...skill, library: skill.library };
    const attempt = Effect.gen(function* () {
      if (to.kind === "projects") {
        const projects = [...new Set(to.cwds)];
        return library === undefined
          ? yield* intoLibrary(journal, skill, projects, view)
          : yield* retarget(journal, library, projects, view);
      }
      const dest =
        to.kind === "global"
          ? ({ scope: "global" } as const)
          : ({ scope: "project", cwd: to.cwd } as const);
      if (library !== undefined) return yield* outOfLibrary(journal, library, dest, view);
      if (skill.scope === dest.scope) {
        const same =
          dest.scope === "global" ||
          (view.cwd !== undefined && (yield* realPath(view.cwd)) === (yield* realPath(dest.cwd)));
        if (same) return { wrote: false, blocked: [] };
      }
      return yield* moveBetween(skill, dest, view);
    });
    return attempt.pipe(
      Effect.onExit((exit) => (Exit.isFailure(exit) ? journal.rollback : Effect.void)),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
        const error = Cause.squash(cause);
        return Effect.succeed(skipped(isRefused(error) ? error.reason : "failed"));
      }),
    );
  };

  /**
   * Removes a deleted library skill's links from the registered projects, and their lines from
   * the exclude files. Nothing is undone: the folder they led to is gone.
   */
  const unlinkLibrarySkill = (skill: SkillCatalog.ResolvedSkill) =>
    Effect.gen(function* () {
      if (skill.library === undefined) return;
      const links = yield* inContext(
        libraryLinksOf({
          roots: yield* deps.registeredRoots,
          name: skill.name,
          entry: skill.library.entry,
        }),
      );
      yield* unlinkProjects(makeJournal(), links, skill.library.entry);
    }).pipe(Effect.ignoreCause);

  /**
   * Gives agents that don't read the shared folder a link in their own folder, in every project
   * that uses the library skill. `plan` says which folder serves which agents. A link that is
   * already there is left; something else in the way, or a system that refuses, blocks the agents
   * of that folder.
   */
  const addLibraryLinks = (
    skill: LibrarySkill,
    plan: ReadonlyArray<{
      readonly folder: string;
      readonly agents: readonly ProviderInstanceId[];
    }>,
  ) =>
    Effect.gen(function* () {
      const blocked: Blocked[] = [];
      let wrote = false;
      const journal = makeJournal();
      for (const project of projectsOfLibrarySkill(skill)) {
        const made: string[] = [];
        for (const { folder, agents } of plan) {
          const link = path.join(project, folder, skill.name);
          const result = yield* linkTo(
            journal,
            { link, target: skill.library.entry, home: skill.home },
            "project",
          ).pipe(Effect.catchTags({ SkillLinkError: () => Effect.succeed("failed" as const) }));
          if (result === "created") {
            made.push(link);
            wrote = true;
          } else if (result !== "unchanged") {
            const reason: SkillOutcomeReason =
              result === "taken"
                ? "entryTaken"
                : result === "notAllowed"
                  ? "linkNotAllowed"
                  : "failed";
            for (const instanceId of agents) blocked.push({ instanceId, reason });
          }
        }
        // The link works without its exclude line; it only shows up in git status.
        yield* inContext(updateExclude({ projectRoot: project, links: made, action: "add" })).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("could not keep a skill link out of git", {
                  project,
                  cause: Cause.pretty(cause),
                }),
          ),
        );
      }
      return { wrote, blocked } satisfies { wrote: boolean; blocked: readonly Blocked[] };
    });

  /**
   * Takes those agents' links out of every project that uses the library skill, and out of the
   * projects' git worktrees. A link that is no longer the one that was inspected is left, and
   * blocks the agents of that folder.
   */
  const removeLibraryLinks = (
    skill: LibrarySkill,
    plan: ReadonlyArray<{
      readonly folder: string;
      readonly agents: readonly ProviderInstanceId[];
    }>,
  ) =>
    Effect.gen(function* () {
      const blocked: Blocked[] = [];
      let wrote = false;
      for (const { folder, agents } of plan) {
        const links = skill.library.links.filter((link) => link.folder === folder);
        // A step that fails part way leaves unknown links behind: all of them are reported.
        const results = yield* unlinkProjects(makeJournal(), links, skill.library.entry).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.as(
                  Effect.logWarning("could not remove a skill's links", {
                    name: skill.name,
                    cause: Cause.pretty(cause),
                  }),
                  new Map(links.map((link) => [link.path, "failed" as const])),
                ),
          ),
        );
        for (const link of links) {
          const result = results.get(link.path);
          if (result === "removed" || result === "failed") wrote = true;
          if (result === "changed" || result === "failed") {
            for (const instanceId of agents) blocked.push({ instanceId, reason: result });
          }
        }
      }
      return { wrote, blocked } satisfies { wrote: boolean; blocked: readonly Blocked[] };
    });

  return { place, unlinkLibrarySkill, addLibraryLinks, removeLibraryLinks };
});
