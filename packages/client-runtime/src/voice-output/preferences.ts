import type {
  ProjectSettingsOverrides,
  ScopedProjectRef,
  ServerSettings,
  SpeechOutputDestination,
  SpeechPlaybackRate,
} from "@t3tools/contracts";
import { scopedProjectKey } from "../environment/scoped.ts";

export function speechPlaybackSelection(
  preferences: readonly {
    destination: SpeechOutputDestination | null;
    playbackRate: SpeechPlaybackRate;
  }[],
) {
  const target = (destination: SpeechOutputDestination | null) =>
    destination ? `${destination.engine}:${destination.environmentId}` : "off";
  const full = (destination: SpeechOutputDestination | null) =>
    JSON.stringify([target(destination), destination?.voice ?? null]);
  const first = preferences[0];
  return {
    mixedDestination: preferences.some(
      (value) => full(value.destination) !== full(first?.destination ?? null),
    ),
    mixedTarget: preferences.some(
      (value) => target(value.destination) !== target(first?.destination ?? null),
    ),
    mixedRate: preferences.some((value) => value.playbackRate !== first?.playbackRate),
  };
}

type SpeechProjectPatch = Pick<
  ProjectSettingsOverrides,
  "speechPlaybackDestination" | "speechPlaybackRate"
>;

export function createSpeechProjectSettingsWriter() {
  const projects = new Map<
    string,
    {
      tail: Promise<void>;
      confirmed?: { source: ServerSettings; value: ProjectSettingsOverrides };
    }
  >();
  return (
    target: ScopedProjectRef,
    patch: SpeechProjectPatch,
    read: () => ServerSettings,
    write: (value: ProjectSettingsOverrides) => Promise<ProjectSettingsOverrides | false>,
  ) => {
    const key = scopedProjectKey(target);
    let project = projects.get(key);
    if (!project) {
      project = { tail: Promise.resolve() };
      projects.set(key, project);
    }
    const current = project;
    const operation = current.tail.then(async () => {
      const source = read();
      const base =
        current.confirmed && current.confirmed.source === source
          ? current.confirmed.value
          : source.projectSettingsOverrides[target.projectId];
      const saved = await write({ ...base, ...patch });
      if (saved !== false) current.confirmed = { source, value: saved };
    });
    current.tail = operation.catch(() => {});
    return operation;
  };
}
