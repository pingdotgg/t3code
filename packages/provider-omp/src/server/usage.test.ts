import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { resolveOmpSessionsDir } from "./usage.ts";

it.effect("resolves profile roots, explicit session overrides and existing XDG data roots", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    const env = { HOME: home, OMP_PROFILE: "personal", PI_CODING_AGENT_DIR: "/ignored-agent" };
    expect(resolveOmpSessionsDir(env, home, path, "--profile work")).toBe(
      path.join(home, ".omp/profiles/work/agent/sessions"),
    );
    expect(resolveOmpSessionsDir(env, home, path)).toBe(
      path.join(home, ".omp/profiles/personal/agent/sessions"),
    );
    expect(
      resolveOmpSessionsDir({ ...env, PI_CODING_AGENT_SESSION_DIR: "~/explicit" }, home, path),
    ).toBe(path.join(home, "explicit"));
    const dataHome = path.join(home, "data");
    const profileData = path.join(dataHome, "omp/profiles/personal");
    yield* fs.makeDirectory(profileData, { recursive: true });
    expect(resolveOmpSessionsDir({ ...env, XDG_DATA_HOME: dataHome }, home, path)).toBe(
      path.join(profileData, "sessions"),
    );
    expect(resolveOmpSessionsDir({ HOME: home, PI_PROFILE: "legacy" }, home, path)).toBe(
      path.join(home, ".omp/profiles/legacy/agent/sessions"),
    );
    expect(
      resolveOmpSessionsDir(
        { ...env, PI_CODING_AGENT_DIR: path.join(home, "custom") },
        home,
        path,
        "--profile default",
      ),
    ).toBe(path.join(home, "custom/sessions"));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
