import { EnvironmentId, DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import type { SpeechAudioPlayer } from "@t3tools/client-runtime/voice-output";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { useEnvironmentScope } from "../state/session";
import { ResponseSpeechButton } from "./ResponseSpeechButton";
import { voiceOutput } from "./voiceOutput";

vi.mock("./useSpeechOutputDestination", async () => ({
  SpeechPlaybackSettingsContext: (await import("react")).createContext(null),
  useSpeechOutputDestination: () => ({
    destination: null,
    playbackRate: 1,
    canManage: true,
    setPlaybackRate: (rate: number) => voiceOutput.setPlaybackRate(rate),
  }),
}));
vi.mock("../state/session", () => ({
  usePreparedConnection: () => Option.none(),
  useEnvironmentScope: vi.fn(),
}));
vi.mock("../state/environments", () => ({
  useEnvironment: () => ({
    serverConfig: { environment: { capabilities: { voiceSynthesis: true } } },
  }),
}));
vi.mock("../hooks/useSettings", () => ({ useEnvironmentSettings: () => DEFAULT_SERVER_SETTINGS }));
vi.mock("./runEnvironmentSpeech", () => ({ runEnvironmentSpeech: vi.fn() }));
vi.mock("./voiceOutput", async () => {
  const { VoiceOutputController } = await import("@t3tools/client-runtime/voice-output");
  const player: SpeechAudioPlayer = {
    play: (_audio, signal, onPlaying) => {
      onPlaying();
      return new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
    setPlaybackRate: () => {},
    pause: () => {},
    resume: async () => {},
  };
  return { voiceOutput: new VoiceOutputController(player), isVoiceRecordingActive: () => false };
});

it("keeps pause, resume, and stop available without connection or synthesis permission", async () => {
  vi.mocked(useEnvironmentScope).mockReturnValue(false);
  const environmentId = EnvironmentId.make("speech");
  const playback = voiceOutput.start("response", "Hello", async () => new Uint8Array([1]));
  try {
    await vi.waitFor(() => expect(voiceOutput.getSnapshot().phase).toBe("playing"));
    await using screen = await render(
      <ResponseSpeechButton environmentId={environmentId} owner="response" text="Hello" />,
      // Playback ownership and connection availability do not depend on routing.
      { router: false },
    );
    await screen.getByRole("combobox", { name: "Playback speed" }).click();
    await page.getByRole("option", { name: "1.5×", exact: true }).click();
    expect(voiceOutput.getSnapshot().phase).toBe("playing");
    await screen.getByRole("button", { name: "Pause response audio" }).click();
    await expect
      .element(screen.getByRole("button", { name: "Resume response audio" }))
      .toBeVisible();
    await screen.getByRole("button", { name: "Resume response audio" }).click();
    await expect
      .element(screen.getByRole("button", { name: "Pause response audio" }))
      .toBeVisible();
    await screen.getByRole("button", { name: "Stop response audio" }).click();
    await expect
      .element(screen.getByRole("button", { name: "Read aloud locally" }))
      .not.toBeInTheDocument();
    expect(voiceOutput.getSnapshot().phase).toBe("idle");
  } finally {
    voiceOutput.stop();
    await playback;
  }
});
