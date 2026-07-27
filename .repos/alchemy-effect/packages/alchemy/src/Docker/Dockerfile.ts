/**
 * Inline Dockerfile content for container platforms.
 *
 * Container platform props accept `dockerfile: string | { content: Input<string> }`:
 * a plain string is always a **path** (relative to `context`); an object with a
 * `content` key is **inline Dockerfile content**. `Dockerfile.inline` is the
 * ergonomic way to produce the latter — a tagged template whose interpolations
 * ride the normal {@link Output} machinery, so referencing another resource's
 * attributes (e.g. an {@link ECR.Image}'s `imageUri`) creates a real dependency
 * edge and re-resolves on change.
 *
 * The returned value is a plain JSON-serializable object (no symbols or
 * brands) so it round-trips through persisted state unchanged; the structural
 * `content` key is the discriminant.
 *
 * @example Base plus system packages, still bundling your Effect program
 * ```typescript
 * import * as Dockerfile from "alchemy/Docker/Dockerfile";
 *
 * const worker = yield* AWS.ECS.Task(
 *   "Transcoder",
 *   {
 *     cluster,
 *     main: import.meta.url,
 *     dockerfile: Dockerfile.inline`
 *       FROM oven/bun:1
 *       RUN apt-get update && apt-get install -y ffmpeg
 *     `,
 *   },
 *   impl,
 * );
 * ```
 *
 * @example Deriving from another resource's image (dependency edge for free)
 * ```typescript
 * const base = yield* AWS.ECR.Image("MlBase", { context: "./ml-base" });
 *
 * const trainer = yield* AWS.ECS.Task(
 *   "Trainer",
 *   {
 *     cluster,
 *     main: import.meta.url,
 *     dockerfile: Dockerfile.inline`
 *       FROM ${base.imageUri}
 *       RUN pip install -r /opt/requirements.txt
 *     `,
 *   },
 *   impl,
 * );
 * ```
 */
import type { Input } from "../Input.ts";
import * as Output from "../Output.ts";

/**
 * Inline Dockerfile content. A plain, state-serializable object; the
 * structural `content` key distinguishes it from a path string wherever
 * `dockerfile` props accept `string | InlineDockerfile`.
 *
 * Never interpolate secrets: anything in Dockerfile content is baked into
 * image layers. `Input<string>` excludes `Redacted` values at the type level.
 */
export interface InlineDockerfile {
  readonly content: Input<string>;
}

/** Structural guard for {@link InlineDockerfile} vs a path string. */
export const isInlineDockerfile = (value: unknown): value is InlineDockerfile =>
  typeof value === "object" && value !== null && "content" in value;

/**
 * Tagged template producing {@link InlineDockerfile}. Interpolations may be
 * plain strings or `Output<string>`s (resolved at deploy time via
 * `Output.interpolate`); with no interpolations the content is a plain string.
 */
export const inline = (
  template: TemplateStringsArray,
  ...args: Array<Input<string>>
): InlineDockerfile => ({
  content:
    args.length === 0
      ? template.raw.join("")
      : Output.interpolate(template, ...args),
});
