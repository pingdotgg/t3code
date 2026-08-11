import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { VoiceCredentialEditor, VoiceUsageNotice } from "./VoiceSettingsPanel";

const noop = () => undefined;

describe("VoiceCredentialEditor", () => {
  it("renders an accessible write-only password field and stored-key removal", () => {
    const markup = renderToStaticMarkup(
      <VoiceCredentialEditor
        environmentLabel="Work Mac"
        loadState={{
          kind: "ready",
          status: { configured: true, source: "stored" },
        }}
        writeAccess="granted"
        apiKey=""
        mutationAction={null}
        notice={null}
        onApiKeyChange={noop}
        onSave={noop}
        onRemove={noop}
        onRetryStatus={noop}
      />,
    );

    expect(markup).toContain('for="voice-openai-api-key"');
    expect(markup).toContain('id="voice-openai-api-key"');
    expect(markup).toContain('type="password"');
    expect(markup).toMatch(/autocomplete="off"/i);
    expect(markup).toContain("Write-only");
    expect(markup).toContain("Remove stored key");
    expect(markup).not.toMatch(/sk-[A-Za-z0-9]/);
  });

  it("keeps host environment credentials read-only from the web panel", () => {
    const markup = renderToStaticMarkup(
      <VoiceCredentialEditor
        environmentLabel="Server"
        loadState={{
          kind: "ready",
          status: { configured: true, source: "environment" },
        }}
        writeAccess="granted"
        apiKey=""
        mutationAction={null}
        notice={null}
        onApiKeyChange={noop}
        onSave={noop}
        onRemove={noop}
        onRetryStatus={noop}
      />,
    );

    expect(markup).toContain("Host-provided keys cannot be removed here");
    expect(markup).not.toContain("Remove stored key");
  });

  it("disables writes and explains access:write for standard remote sessions", () => {
    const onSave = vi.fn();
    const markup = renderToStaticMarkup(
      <VoiceCredentialEditor
        environmentLabel="Remote server"
        loadState={{
          kind: "unavailable",
          message: "Credential status is hidden because this session lacks access:write.",
        }}
        writeAccess="denied"
        apiKey=""
        mutationAction={null}
        notice={null}
        onApiKeyChange={noop}
        onSave={onSave}
        onRemove={noop}
        onRetryStatus={noop}
      />,
    );

    expect(markup).toContain("Standard remote client links cannot manage this key");
    expect(markup).toContain("access:write");
    expect(markup.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(2);
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("VoiceUsageNotice", () => {
  it("discloses billing, OpenAI data flow, and the settings-only boundary", () => {
    const markup = renderToStaticMarkup(<VoiceUsageNotice />);

    expect(markup).toContain("OpenAI bills Realtime API usage");
    expect(markup).toContain("microphone audio and the work context");
    expect(markup).toContain("never requests microphone access or starts a session");
    expect(markup).toContain("Voice selection will be available from the voice panel");
  });
});
