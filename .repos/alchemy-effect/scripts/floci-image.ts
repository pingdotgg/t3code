/**
 * Point the floci-backed suites at a locally built emulator when one exists.
 *
 * `pnpm floci:build` tags the `submodules/floci` checkout as `floci:dev`;
 * that is how an emulator patch gets exercised before its release image is
 * published to GHCR. When no such image exists the env is left unset so the
 * floci package resolves the pinned release image — hard-defaulting to a
 * missing ref would fail every suite's `docker run` before a test can run.
 *
 * Must run before any child `bun test` is spawned: `ensureFloci` reads
 * `ALCHEMY_FLOCI_IMAGE` in the child, and a container running a different
 * image than the resolved one is recreated.
 */
export const preferLocalFlociImage = (label: string): void => {
  if (process.env.ALCHEMY_FLOCI_IMAGE) return;
  const devImage = Bun.spawnSync(["docker", "image", "inspect", "floci:dev"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if (devImage.exitCode === 0) {
    process.env.ALCHEMY_FLOCI_IMAGE = "floci:dev";
    console.log(`${label}: using locally built floci:dev image`);
  } else {
    console.log(
      `${label}: no local floci:dev image (pnpm floci:build) — using the pinned release image`,
    );
  }
};
