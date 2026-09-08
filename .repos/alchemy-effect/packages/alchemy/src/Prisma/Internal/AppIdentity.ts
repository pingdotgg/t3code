import * as Effect from "effect/Effect";

/** Refuse to patch an App observed under a different immutable identity. */
export const ensureAppImmutableIdentity = (
  app: {
    id: string;
    projectId: string;
    region: { id: string };
  },
  projectId: string,
  regionId: string,
) =>
  app.projectId === projectId && app.region.id === regionId
    ? Effect.void
    : Effect.fail(
        new Error(
          `Prisma App '${app.id}' has immutable identity project '${app.projectId}' / region '${app.region.id}', but this resource requires project '${projectId}' / region '${regionId}'. Refusing to patch or claim the mismatched App; replace it or import the correct App ID.`,
        ),
      );
