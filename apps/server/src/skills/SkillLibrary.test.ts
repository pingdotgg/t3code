import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  HostProcessArguments,
  HostProcessEnvironment,
  HostProcessIsExecutable,
} from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as SkillLibrary from "./SkillLibrary.ts";

const SKILL = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nUse ${name}.\n`;

const claude: ServerProvider = {
  driver: ProviderDriverKind.make("claudeAgent"),
  instanceId: ProviderInstanceId.make("claude"),
  enabled: true,
  installed: true,
  version: "2.1.0",
  status: "ready",
  checkedAt: "2026-10-09T00:00:00Z",
  auth: { status: "authenticated" },
  models: [],
  skills: [],
  slashCommands: [],
};

/**
 * A temp HOME, a registered project and a local source with two skills (one
 * with a script), plus the service built against them. The real `skills` CLI
 * runs through the `t3 skills-cli` subcommand of this checkout's bin.ts.
 */
const withLibrary = <A, E>(
  body: (input: {
    readonly library: SkillLibrary.SkillLibrary["Service"];
    readonly home: string;
    readonly project: string;
    readonly source: string;
    readonly providers: Ref.Ref<ReadonlyArray<ServerProvider>>;
    readonly refreshed: Ref.Ref<ReadonlyArray<string>>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-skill-library-" });
    const home = path.join(base, "home");
    const project = path.join(base, "project");
    const source = path.join(base, "source");
    yield* fileSystem.makeDirectory(home, { recursive: true });
    yield* fileSystem.makeDirectory(project, { recursive: true });
    yield* fileSystem.makeDirectory(path.join(source, "review", "bin"), { recursive: true });
    yield* fileSystem.makeDirectory(path.join(source, "notes"), { recursive: true });
    yield* fileSystem.writeFileString(
      path.join(source, "review", "SKILL.md"),
      SKILL("review", "Review a change."),
    );
    yield* fileSystem.writeFileString(path.join(source, "review", "bin", "run"), "#!/bin/sh\n");
    yield* fileSystem.chmod(path.join(source, "review", "bin", "run"), 0o755);
    yield* fileSystem.writeFileString(
      path.join(source, "notes", "SKILL.md"),
      SKILL("notes", "Take notes."),
    );

    const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([claude]);
    const refreshed = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (entry: string) =>
      Ref.update(refreshed, (entries) => [...entries, entry]).pipe(
        Effect.andThen(Ref.get(providers)),
      );
    const stub: Pick<
      ProviderRegistry.ProviderRegistry["Service"],
      "getProviders" | "refreshInstance" | "refreshWorkspaceSnapshot"
    > = {
      getProviders: Ref.get(providers),
      refreshInstance: (instanceId) => record(`instance:${instanceId}`),
      refreshWorkspaceSnapshot: ({ instanceId, cwd }) => record(`workspace:${instanceId}:${cwd}`),
    };
    // SkillLibrary reads provider snapshots and asks for rescans, nothing else.
    const registry = stub as ProviderRegistry.ProviderRegistry["Service"];
    const realProject = yield* fileSystem.realPath(project);
    const projects = ProjectService.ProjectService.of({
      getByWorkspaceRoot: (root: string) =>
        Effect.succeed(
          path.resolve(root) === project || path.resolve(root) === realProject
            ? Option.some({
                id: ProjectId.make("project"),
                title: "Project",
                workspaceRoot: project,
              })
            : Option.none(),
        ),
    } as unknown as ProjectService.ProjectService["Service"]);

    const entry = path.resolve(import.meta.dirname, "../bin.ts");
    const library = yield* SkillLibrary.SkillLibrary.pipe(
      Effect.provide(
        SkillLibrary.layer.pipe(
          Layer.provide(ProcessRunner.layer),
          Layer.provide(Layer.succeed(ProviderRegistry.ProviderRegistry, registry)),
          Layer.provide(Layer.succeed(ProjectService.ProjectService, projects)),
        ),
      ),
      Effect.provideService(HostProcessEnvironment, {
        ...process.env,
        HOME: home,
        XDG_STATE_HOME: "",
      }),
      Effect.provideService(HostProcessArguments, [process.execPath, entry]),
      Effect.provideService(HostProcessIsExecutable, false),
    );
    return yield* body({ library, home, project, source, providers, refreshed });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect(
  "previews a source without installing it",
  () =>
    withLibrary(({ library, home, source }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const preview = yield* library.preview({ source });
        assert.deepEqual(
          preview.skills.map((skill) => [skill.name, skill.description, skill.scripts]),
          [
            ["notes", "Take notes.", false],
            ["review", "Review a change.", true],
          ],
        );
        assert.deepEqual(
          preview.skills[1]?.files.map((file) => [file.path, file.executable]),
          [
            ["SKILL.md", false],
            ["bin/run", true],
          ],
        );
        assert.isFalse(yield* fileSystem.exists(`${home}/.agents`));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  120_000,
);

it.effect(
  "installs into a project, reports the source, and removes it again",
  () =>
    withLibrary(({ library, project, source, providers, refreshed }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* library.install({
          source,
          skills: ["review"],
          target: { kind: "project", cwd: project },
        });
        assert.deepEqual(result.outcomes, [{ name: "review", status: "installed" }]);
        // Claude reads only `.claude/skills`, so it gets a link there.
        const claudeLink = path.join(project, ".claude", "skills", "review", "SKILL.md");
        assert.isTrue(yield* fileSystem.exists(claudeLink));
        assert.isFalse(yield* fileSystem.exists(path.join(project, ".agents/skills/notes")));
        assert.deepEqual(yield* Ref.get(refreshed), [`workspace:claude:${project}`]);

        yield* Ref.set(providers, [
          {
            ...claude,
            workspaceSnapshots: [
              {
                cwd: project,
                checkedAt: "2026-10-09T00:00:00Z",
                slashCommands: [],
                skills: [{ name: "review", path: claudeLink, scope: "project", enabled: true }],
              },
            ],
          },
        ]);
        const inspected = yield* library.inspect({ cwd: project });
        assert.equal(inspected.folders.length, 1);
        const folder = inspected.folders[0];
        assert.equal(folder?.path, claudeLink);
        assert.equal(
          folder?.folder,
          yield* fileSystem.realPath(path.join(project, ".agents/skills/review")),
        );
        assert.isTrue(folder?.scripts);
        // A project lock keeps a local source relative to the project, so it travels with it.
        assert.deepEqual(folder?.installed, {
          target: { kind: "project", cwd: project },
          source: path.relative(yield* fileSystem.realPath(project), source),
        });

        const updated = yield* library.update({
          name: "review",
          target: { kind: "project", cwd: project },
        });
        assert.deepEqual(updated.outcomes, [{ name: "review", status: "installed" }]);

        yield* library.remove({ name: "review", target: { kind: "project", cwd: project } });
        assert.isFalse(yield* fileSystem.exists(path.join(project, ".agents/skills/review")));
        assert.isFalse(yield* fileSystem.exists(path.join(project, ".claude/skills/review")));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  180_000,
);

it.effect(
  "refuses folders that aren't projects and skills the CLI didn't install",
  () =>
    withLibrary(({ library, home, source }) =>
      Effect.gen(function* () {
        const notProject = yield* library
          .install({ source, skills: ["review"], target: { kind: "project", cwd: home } })
          .pipe(Effect.flip);
        assert.equal(notProject.reason, "projectNotRegistered");
        const notInstalled = yield* library
          .remove({ name: "review", target: { kind: "environment" } })
          .pipe(Effect.flip);
        assert.equal(notInstalled.reason, "notInstalled");
      }),
    ),
  60_000,
);
