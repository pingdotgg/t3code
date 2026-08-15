# Voice Dictation

Voice dictation follows the Codex composer flow on web, desktop, and the native mobile app:

- **X** cancels and discards the recording.
- **Stop** transcribes and appends the text to the end of the current draft.
- **Send** transcribes, appends the text, and uses the normal message-send path.

Empty and very short recordings are discarded, and recordings stop automatically after five
minutes. A transcript never replaces text that is already in the composer.

## Providers and API Keys

On web and desktop, open **Settings** → **General** → **Voice dictation**, choose **OpenAI** or
**Groq**, save an API key, and select a transcription model. The microphone appears after the
configuration is complete. T3 Code loads the models available to that key, so new models can
appear without an app update.

You can enter a key in the client, or configure it in the environment that runs the connected T3
Code server:

- OpenAI uses `OPENAI_API_KEY`
- Groq uses `GROQ_API_KEY`

When an environment key is available, the API key input indicates that it is already configured.
A key entered in the input overrides the environment key and stays in that client's local
settings. Environment key values are never sent to the client.

Recordings are sent through the connected T3 Code server to the selected provider. Recordings
larger than 25 MB are rejected.

## iPhone and Android

Open **Settings** → **Voice Dictation**, choose **OpenAI** or **Groq**, select a model, and save the
provider's API key. Each provider keeps its own key and model in the device's secure store. OpenAI
defaults to `gpt-4o-transcribe`; Groq defaults to `whisper-large-v3-turbo`. You can also enter a
custom compatible model ID without waiting for an app update.

Native recordings are sent directly from the mobile app to the selected provider. Clearing the
selected provider's saved key removes the microphone from the composer.
