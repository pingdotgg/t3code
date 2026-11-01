/**
 * Pinned local dev ports.
 *
 * The stress suite drives this stack while rewriting its files, so the
 * addresses it probes must survive every reload — including the windows
 * where the stack module doesn't even parse and the CLI prints no outputs
 * at all. Pinning the ports (with `strictPort`, so a collision fails loudly
 * instead of silently serving somewhere else) makes every assertion in the
 * suite independent of stdout parsing.
 *
 * `DEV_STRESS_PORT_BASE` moves the whole block if 8790+ is taken.
 */
const base = Number(process.env.DEV_STRESS_PORT_BASE ?? 8790);

export const PORTS = {
  /** `EchoWorker` — Effect-native Worker whose source the stack imports. */
  echo: base,
  /** `ApiWorker` — path-`main` Worker the stack never imports. */
  api: base + 1,
  /** `ExtraWorker` — added and removed by the graph-churn phase. */
  extra: base + 2,
  /** The `AWS.Website.StaticSite` dev-command child server. */
  awsSite: base + 3,
  /** `MicrovmWorker` — the Cloudflare Worker that mounts an AWS MicroVM. */
  microvm: base + 4,
  /**
   * Where the graph-churn phase re-lands the extra worker after renaming
   * its logical id. A rename is a create + a delete, and the engine may run
   * the create first — so the new generation must not want the old one's
   * `strictPort`.
   */
  extraAlt: base + 5,
  /**
   * The ECS services' host ports are FIXED (bridge networking publishes the
   * literal container port, and the port is baked into the Dockerfiles) —
   * `DEV_STRESS_PORT_BASE` does not move them.
   */
  /** The context-built `EcsService` (see site/ecs/Dockerfile). */
  ecs: 8796,
  /** The inline-Dockerfile `EcsInlineService`. */
  ecsInline: 8797,
  /**
   * The hosted EC2 instance's app port. Also fixed: floci's host-routing
   * mux publishes the security-group port LITERALLY, and the suite reaches
   * the box at `http://<instanceId>.localhost.floci.io:<port>`.
   */
  ec2: 8798,
} as const;
