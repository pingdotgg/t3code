import type { EnvironmentSpeechModel, EnvironmentSpeechStatus } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BookOpenIcon, MicIcon, SparklesIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Dialog, DialogClose } from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup, WizardSteps } from "../ui/wizard";

export function VoiceInputSetup(props: {
  open: boolean;
  step: number;
  status: EnvironmentSpeechStatus | null;
  model: EnvironmentSpeechModel | null;
  downloading: boolean;
  error: string | null;
  onOpenChange(open: boolean): void;
  onDownload(): void;
  onCancelDownload(): void;
  onStartRecording(): void;
}) {
  const navigate = useNavigate();
  const status = props.status?.supported ? props.status : null;
  const model = props.model;
  const progress =
    model?.downloaded === undefined ? null : Math.round((model.downloaded / model.size) * 100);
  const openSettings = (hash: string) => {
    props.onOpenChange(false);
    void navigate({ to: "/settings/voice", hash });
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <WizardPopup>
        <WizardHeader
          title="Set up voice input"
          description="Transcribe speech on your selected T3 environment and add the text to your draft."
        >
          <WizardSteps steps={["Model", "Make it yours"]} currentStep={props.step} />
        </WizardHeader>
        <WizardPanel>
          {props.step === 0 ? (
            <section className="space-y-3 text-sm">
              <div className="rounded-lg border border-border/70 bg-card/60 p-4">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-medium">{status?.model ?? "English transcription model"}</h3>
                  {status?.modelId === "handy-computer/parakeet-unified-en-0.6b-gguf" ? (
                    <span className="text-xs font-medium text-primary">
                      Recommended for English
                    </span>
                  ) : null}
                </div>
                <p className="mt-2 text-muted-foreground">
                  Download {status ? Math.round(status.size / 1024 / 1024) : 697} MB to your
                  selected T3 environment. Microphone audio is sent to that environment for
                  transcription, including when it is remote.
                </p>
              </div>
              {props.downloading ? (
                <p role="status" className="flex items-center gap-2 text-muted-foreground">
                  <Spinner size="xs" />
                  {model?.state === "verifying"
                    ? "Verifying model…"
                    : progress === null
                      ? "Downloading model…"
                      : `Downloading model ${progress}%`}
                </p>
              ) : null}
              {props.error ? (
                <p role="alert" className="text-destructive">
                  {props.error}
                </p>
              ) : null}
              <button
                type="button"
                className="text-sm text-primary hover:underline"
                onClick={() => openSettings("local-voice-input")}
              >
                Choose another model or language in Voice settings
              </button>
            </section>
          ) : (
            <section className="space-y-4 text-sm">
              <p className="text-muted-foreground">
                Voice input is ready. You can personalize it now or start recording and come back
                later.
              </p>
              <div className="space-y-3">
                <p className="flex gap-3">
                  <BookOpenIcon className="mt-0.5 size-4 shrink-0 text-primary" />
                  <span>
                    <strong>Dictionary</strong> helps recognize names and technical terms.
                  </span>
                </p>
                <p className="flex gap-3">
                  <MicIcon className="mt-0.5 size-4 shrink-0 text-primary" />
                  <span>
                    <strong>Correction word</strong> helps post-processing revise something you just
                    said.
                  </span>
                </p>
                <p className="flex gap-3">
                  <SparklesIcon className="mt-0.5 size-4 shrink-0 text-primary" />
                  <span>
                    <strong>Post-processing</strong> can polish the finished transcript.
                  </span>
                </p>
              </div>
              <button
                type="button"
                className="text-sm text-primary hover:underline"
                onClick={() => openSettings("dictionary")}
              >
                Explore these features in Voice settings
              </button>
            </section>
          )}
        </WizardPanel>
        <WizardFooter>
          {props.step === 0 ? (
            <>
              {props.downloading ? (
                <Button variant="outline" onClick={props.onCancelDownload}>
                  Cancel download
                </Button>
              ) : (
                <DialogClose render={<Button variant="outline" />}>Not now</DialogClose>
              )}
              <Button disabled={props.downloading || !status} onClick={props.onDownload}>
                {props.downloading ? "Downloading…" : "Download model"}
              </Button>
            </>
          ) : (
            <Button onClick={props.onStartRecording}>Start recording</Button>
          )}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}
