import {
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type PiperRuntimeStatus,
  type SpeechSynthesisVoices,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useEnvironments, type EnvironmentPresentation } from "../state/environments";
import { SpeechOutputSettings } from "../components/settings/SpeechOutputSettings";
import { render } from "../../test/render";
import { useEnvironmentScope, usePreparedConnection } from "../state/session";
import {
  installEnvironmentSpeechRuntime,
  downloadEnvironmentSpeechVoice,
  getEnvironmentSpeechVoices,
  selectEnvironmentSpeechVoice,
} from "@t3tools/client-runtime/voice-input";
import { useSpeechVoiceCatalog } from "./useSpeechVoiceCatalog";

vi.mock(import("../state/environments"), { spy: true });
vi.mock(import("../state/session"), { spy: true });
vi.mock(import("@t3tools/client-runtime/voice-input"), { spy: true });
vi.mock("./runEnvironmentSpeech", () => ({ runEnvironmentSpeech: Effect.runPromise }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function connection(id: string): PreparedConnection {
  const target = new PrimaryConnectionTarget({
    environmentId: EnvironmentId.make(id),
    label: id,
    httpBaseUrl: window.location.origin,
    wsBaseUrl: "ws://localhost",
  });
  return { ...target, target, socketUrl: target.wsBaseUrl, httpAuthorization: null };
}

it("clears pending downloads when switching environments before returning", async () => {
  vi.mocked(useEnvironmentScope).mockReturnValue(true);
  const a = connection("a");
  const b = connection("b");
  const empty: SpeechSynthesisVoices = { voices: [] };
  const download = deferred<SpeechSynthesisVoices>();
  const completed = deferred<void>();
  vi.mocked(usePreparedConnection).mockImplementation((id) =>
    Option.some(id === a.environmentId ? a : b),
  );
  vi.mocked(getEnvironmentSpeechVoices).mockImplementation(() => Effect.succeed(empty));
  vi.mocked(downloadEnvironmentSpeechVoice).mockImplementation(() =>
    Effect.promise(() => download.promise),
  );
  vi.mocked(selectEnvironmentSpeechVoice).mockImplementation(() => Effect.succeed(empty));
  function Catalog({ environmentId }: { environmentId: EnvironmentId }) {
    const catalog = useSpeechVoiceCatalog(environmentId);
    return (
      <>
        <p role="status">{catalog.downloading ? "Downloading" : "Ready"}</p>
        <button
          onClick={() => void catalog.run("voice", "download").then(() => completed.resolve())}
        >
          Download
        </button>
      </>
    );
  }
  await using screen = await render(<Catalog environmentId={a.environmentId} />, {
    // The hook reads its environment directly and does not use routes.
    router: false,
  });
  await screen.getByRole("button", { name: "Download" }).click();
  await expect.element(screen.getByRole("status")).toHaveTextContent("Downloading");
  await screen.rerender(<Catalog environmentId={b.environmentId} />);
  await expect.element(screen.getByRole("status")).toHaveTextContent("Ready");
  download.resolve(empty);
  await completed.promise;
  await screen.rerender(<Catalog environmentId={a.environmentId} />);
  await expect.element(screen.getByRole("status")).toHaveTextContent("Ready");
});

it("starts off, checks the selected environment, and offers managed Piper installation", async () => {
  vi.mocked(useEnvironmentScope).mockReturnValue(true);
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  const prepared = connection("speech-server");
  const environment = {
    environmentId: prepared.environmentId,
    label: "Speech server",
    connection: { phase: "connected" },
    serverConfig: {
      settings: DEFAULT_SERVER_SETTINGS,
      environment: { capabilities: { voiceSynthesis: true } },
    },
  } as unknown as EnvironmentPresentation;
  vi.mocked(useEnvironments).mockReturnValue({
    environments: [environment],
    isReady: true,
    networkStatus: "online",
    presentationById: new Map(),
  } as ReturnType<typeof useEnvironments>);
  vi.mocked(usePreparedConnection).mockReturnValue(Option.some(prepared));
  let runtime: PiperRuntimeStatus = { state: "not-installed", platform: "linux-x64" };
  vi.mocked(getEnvironmentSpeechVoices).mockImplementation(() =>
    Effect.succeed({ voices: [], runtime }),
  );
  vi.mocked(installEnvironmentSpeechRuntime).mockImplementation(() =>
    Effect.sync(() => {
      runtime = { state: "ready", platform: "linux-x64" };
      return { voices: [], runtime };
    }),
  );
  await using screen = await render(<SpeechOutputSettings />);
  expect(getClientSettings().speechOutputDestination).toBeNull();
  await expect
    .element(screen.getByRole("button", { name: "Download Piper" }))
    .not.toBeInTheDocument();
  await screen.getByRole("combobox", { name: "Read aloud with" }).click();
  await page.getByRole("option", { name: "Speech server", exact: true }).click();
  await expect.element(screen.getByRole("button", { name: "Download Piper" })).toBeVisible();
  expect(getClientSettings().speechOutputDestination).toEqual({
    environmentId: prepared.environmentId,
    engine: "piper",
  });
  await screen.getByRole("button", { name: "Download Piper" }).click();
  await expect.element(screen.getByRole("button", { name: "Remove Piper" })).toBeVisible();
  await screen.getByRole("combobox", { name: "Read aloud with" }).click();
  await page.getByRole("option", { name: "Off", exact: true }).click();
  expect(getClientSettings().speechOutputDestination).toBeNull();
  await screen.getByRole("combobox", { name: "Playback speed" }).click();
  await page.getByRole("option", { name: "1.5×", exact: true }).click();
  expect(getClientSettings().speechPlaybackRate).toBe(1.5);
});
