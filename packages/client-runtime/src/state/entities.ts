import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ScopedProjectRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export class InvalidScopedProjectKeyError extends Schema.TaggedErrorClass<InvalidScopedProjectKeyError>()(
  "InvalidScopedProjectKeyError",
  {
    key: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid scoped project atom key: ${JSON.stringify(this.key)}.`;
  }
}

export class InvalidScopedThreadKeyError extends Schema.TaggedErrorClass<InvalidScopedThreadKeyError>()(
  "InvalidScopedThreadKeyError",
  {
    key: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid scoped thread atom key: ${JSON.stringify(this.key)}.`;
  }
}

export class InvalidScopedProjectRefCollectionKeyError extends Schema.TaggedErrorClass<InvalidScopedProjectRefCollectionKeyError>()(
  "InvalidScopedProjectRefCollectionKeyError",
  {
    key: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Invalid scoped project reference collection atom key: ${JSON.stringify(this.key)}.`;
  }
}

const decodeProjectRefCollectionKey = Schema.decodeUnknownSync(
  Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
);

export function projectKey(ref: ScopedProjectRef): string {
  return `${ref.environmentId}\u0000${ref.projectId}`;
}

export function threadKey(ref: ScopedThreadRef): string {
  return `${ref.environmentId}\u0000${ref.threadId}`;
}

export function projectRefCollectionKey(refs: ReadonlyArray<ScopedProjectRef>): string {
  return JSON.stringify(refs.map((ref) => [ref.environmentId, ref.projectId]));
}

export function parseProjectKey(key: string): ScopedProjectRef {
  const separator = key.indexOf("\u0000");
  if (separator < 0) {
    throw new InvalidScopedProjectKeyError({ key });
  }
  return {
    environmentId: EnvironmentId.make(key.slice(0, separator)),
    projectId: ProjectId.make(key.slice(separator + 1)),
  };
}

export function parseProjectRefCollectionKey(key: string): ReadonlyArray<ScopedProjectRef> {
  let entries: ReadonlyArray<readonly [string, string]>;
  try {
    entries = decodeProjectRefCollectionKey(JSON.parse(key));
  } catch (cause) {
    throw new InvalidScopedProjectRefCollectionKeyError({ key, cause });
  }
  return entries.map(([environmentId, projectId]) => ({
    environmentId: EnvironmentId.make(environmentId),
    projectId: ProjectId.make(projectId),
  }));
}

export function parseThreadKey(key: string): ScopedThreadRef {
  const separator = key.indexOf("\u0000");
  if (separator < 0) {
    throw new InvalidScopedThreadKeyError({ key });
  }
  return {
    environmentId: EnvironmentId.make(key.slice(0, separator)),
    threadId: ThreadId.make(key.slice(separator + 1)),
  };
}

export function projectRefsEqual(
  left: ReadonlyArray<ScopedProjectRef>,
  right: ReadonlyArray<ScopedProjectRef>,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (ref, index) =>
        ref.environmentId === right[index]?.environmentId &&
        ref.projectId === right[index]?.projectId,
    )
  );
}

export function threadRefsEqual(
  left: ReadonlyArray<ScopedThreadRef>,
  right: ReadonlyArray<ScopedThreadRef>,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (ref, index) =>
        ref.environmentId === right[index]?.environmentId &&
        ref.threadId === right[index]?.threadId,
    )
  );
}

export function arrayElementsEqual<A>(left: ReadonlyArray<A>, right: ReadonlyArray<A>): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
