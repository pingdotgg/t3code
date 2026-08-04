# Voice Dictation

Voice dictation records from the message composer and inserts the transcription into your draft.
It is available in the web and desktop clients on browsers that support microphone recording.

Enable it in **Settings** → **Beta features** → **Voice dictation**. The composer then shows a
microphone action. Select it to start recording and stop it when you are finished. Recordings stop
automatically after five minutes.

## Providers and API Keys

Choose **OpenAI** or **Groq**. T3 Code supplies the provider's transcription endpoint. After an
API key is available, T3 Code loads the models that key can access from the provider and lets you
select the transcription model. Model IDs are not bundled into T3 Code, so newly available models
can appear without an app update.

You can enter a key in the client, or configure it in the environment that runs the connected T3
Code server:

- OpenAI uses `OPENAI_API_KEY`
- Groq uses `GROQ_API_KEY`

When an environment key is available, the API key input indicates that it is already configured.
A key entered in the input overrides the environment key and stays in that client's local
settings. Environment key values are never sent to the client.

Recordings are sent through the connected T3 Code server to the selected provider. Recordings
larger than 25 MB are rejected.
