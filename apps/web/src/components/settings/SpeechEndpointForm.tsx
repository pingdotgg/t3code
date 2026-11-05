import { SpeechEndpointConfig } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SecretInput } from "./SecretInput";

const isSpeechEndpointConfig = Schema.is(SpeechEndpointConfig);

export function SpeechEndpointForm(props: {
  readonly current: SpeechEndpointConfig | null;
  readonly disabled: boolean;
  readonly environmentLabel: string;
  readonly onSave: (endpoint: SpeechEndpointConfig | null) => Promise<boolean>;
}) {
  const [mode, setMode] = useState(props.current ? "endpoint" : "local");
  const [url, setUrl] = useState(props.current?.url ?? "");
  const [model, setModel] = useState(props.current?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sameDestination = url.trim() === props.current?.url;
  const configuredKey = sameDestination && !clearKey && Boolean(props.current?.apiKey);
  const disabled = props.disabled || busy;

  const save = async () => {
    const endpoint =
      mode === "local"
        ? null
        : {
            url: url.trim(),
            model: model.trim(),
            apiKey: apiKey.trim() || (configuredKey ? props.current!.apiKey : ""),
          };
    if (endpoint && !isSpeechEndpointConfig(endpoint)) {
      setError(
        "Enter a full HTTP or HTTPS transcription URL and a model name. Put credentials in API key, not in the URL.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (await props.onSave(endpoint)) {
        setApiKey("");
        setClearKey(false);
      } else setError("Could not save the speech endpoint. Reconnect and try again.");
    } catch {
      setError("Could not save the speech endpoint. Reconnect and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Select value={mode} disabled={disabled} onValueChange={(value) => value && setMode(value)}>
        <SelectTrigger size="sm" aria-label="Speech engine">
          <SelectValue>{mode === "local" ? "Local models" : "Custom endpoint"}</SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          <SelectItem value="local">Local models</SelectItem>
          <SelectItem value="endpoint">Custom endpoint</SelectItem>
        </SelectPopup>
      </Select>
      {mode === "endpoint" ? (
        <>
          <p className="text-xs text-muted-foreground">
            Use an OpenAI-compatible Whisper or Parakeet server. {props.environmentLabel} sends your
            recording to this URL when you finish speaking. Localhost refers to that T3
            environment's machine.
          </p>
          <label className="flex flex-col gap-1 text-xs">
            Transcription URL
            <Input
              aria-label="Transcription URL"
              value={url}
              disabled={disabled}
              placeholder="http://localhost:8000/v1/audio/transcriptions"
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            Model name
            <Input
              aria-label="Speech endpoint model"
              value={model}
              disabled={disabled}
              placeholder="parakeet"
              onChange={(event) => setModel(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            API key (optional)
            <SecretInput
              aria-label="Speech endpoint API key"
              value={apiKey}
              configured={configuredKey}
              disabled={disabled}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
          {configuredKey ? (
            <Button
              variant="ghost"
              size="xs"
              disabled={disabled}
              onClick={() => {
                setClearKey(true);
                setApiKey("");
              }}
            >
              Remove stored API key
            </Button>
          ) : null}
          <p className="text-xs text-muted-foreground">
            The key is stored securely on {props.environmentLabel}. Saving allows this device's
            audio to be forwarded to the URL above; other devices must confirm it separately.
          </p>
        </>
      ) : props.current ? (
        <p className="text-xs text-muted-foreground">
          Switch back to a downloaded model on {props.environmentLabel}.
        </p>
      ) : null}
      {mode === "endpoint" || props.current ? (
        <Button size="sm" disabled={disabled} onClick={() => void save()}>
          {busy ? "Saving…" : mode === "endpoint" ? "Save and use endpoint" : "Use local models"}
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
