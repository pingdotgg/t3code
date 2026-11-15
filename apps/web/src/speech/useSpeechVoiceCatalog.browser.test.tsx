import {
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId, type SpeechSynthesisVoices } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
import { usePreparedConnection } from "../state/session";
import {
  downloadEnvironmentSpeechVoice,
  getEnvironmentSpeechVoices,
  selectEnvironmentSpeechVoice,
} from "@t3tools/client-runtime/voice-input";
import { useSpeechVoiceCatalog } from "./useSpeechVoiceCatalog";

vi.mock("../state/session", () => ({
  usePreparedConnection: vi.fn(),
  useEnvironmentScope: () => true,
}));
vi.mock("@t3tools/client-runtime/voice-input", () => ({
  getEnvironmentSpeechVoices: vi.fn(),
  downloadEnvironmentSpeechVoice: vi.fn(),
  selectEnvironmentSpeechVoice: vi.fn(),
  cancelEnvironmentSpeechVoiceDownload: vi.fn(),
  removeEnvironmentSpeechVoice: vi.fn(),
}));
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
