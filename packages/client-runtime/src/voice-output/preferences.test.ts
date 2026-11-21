import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ProjectSettingsOverrides,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { createSpeechProjectSettingsWriter, speechPlaybackSelection } from "./preferences.ts";

it("distinguishes mixed voices from different synthesis targets without treating inherited voices as different", () => {
  const destination = { environmentId: EnvironmentId.make("speech-a"), engine: "piper" as const };
  const first = { destination, playbackRate: 1 as const };
  expect(
    speechPlaybackSelection([first, { ...first, destination: { ...destination, voice: null } }]),
  ).toEqual({ mixedDestination: false, mixedTarget: false, mixedRate: false });
  expect(
    speechPlaybackSelection([
      first,
      { ...first, destination: { ...destination, voice: "voice-b" } },
    ]),
  ).toEqual({ mixedDestination: true, mixedTarget: false, mixedRate: false });
  expect(
    speechPlaybackSelection([
      first,
      {
        ...first,
        destination: { ...destination, environmentId: EnvironmentId.make("speech-b") },
        playbackRate: 1.5,
      },
    ]),
  ).toEqual({ mixedDestination: true, mixedTarget: true, mixedRate: true });
  expect(
    speechPlaybackSelection([
      { ...first, destination: null },
      { ...first, destination: { engine: "system", environmentId: null } },
    ]).mixedTarget,
  ).toBe(true);
});

it("keeps confirmed speech changes during propagation without restoring them after a project reset", async () => {
  const environmentId = EnvironmentId.make("speech-server");
  const projectId = ProjectId.make("speech-project");
  const target = { environmentId, projectId };
  const destination = { environmentId, engine: "openai" as const };
  let snapshot = DEFAULT_SERVER_SETTINGS;
  let persisted = snapshot;
  const read = () => snapshot;
  const write = async (value: ProjectSettingsOverrides) => {
    persisted = applyServerSettingsPatch(persisted, {
      projectSettingsOverrides: { [projectId]: value },
    });
    return persisted.projectSettingsOverrides[projectId] ?? {};
  };
  const save = createSpeechProjectSettingsWriter();
  await save(target, { speechPlaybackDestination: destination }, read, write);
  await save(target, { speechPlaybackRate: 1.5 }, read, write);
  expect(persisted.projectSettingsOverrides[projectId]).toEqual({
    speechPlaybackDestination: destination,
    speechPlaybackRate: 1.5,
  });
  snapshot = applyServerSettingsPatch(persisted, {
    projectSettingsOverrides: { [projectId]: null },
  });
  persisted = snapshot;
  await save(target, { speechPlaybackRate: 2 }, read, write);
  expect(persisted.projectSettingsOverrides[projectId]).toEqual({ speechPlaybackRate: 2 });
});
