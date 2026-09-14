# Live voice (experimental)

Live voice lets you discuss work in an existing thread with GPT-Live and send coding requests to that thread's selected agent. It is opt-in and experimental. Dictation remains separate: dictation inserts text into your draft, while Live voice is a two-way conversation.

## Set up

The T3 Code server for the selected environment needs an `OPENAI_API_KEY` with access to GPT-Live. Configure it on that server, then restart the server so it receives the setting. Keep the key on the server; do not put it in a browser, mobile app, shared URL, or project source file.

GPT-Live uses separate OpenAI API billing. A ChatGPT or coding-agent subscription does not cover the voice session. The thread's coding agent continues to use its existing provider account and settings.

Use a client build that includes Live voice and allow microphone access when starting a call:

- In a browser, use HTTPS or localhost. A remote server opened through a plain HTTP address cannot request microphone access.
- On desktop, allow microphone access in your operating system's privacy settings. The desktop build must include the platform's microphone permissions.
- On mobile, use a native build with Live voice support and allow microphone access. Keep the app in the foreground during the call.

## Talk about a thread

Open an existing thread in the configured environment and choose **Start voice chat** beside the composer, or **Voice** on mobile. The call stays attached to that environment and thread. Your audio and recent thread context are sent to OpenAI. Speak naturally, and correct anything the assistant misunderstood before relying on it for a coding request.

Coding requests use the thread's selected provider and its existing permission mode. Review provider approvals and questions in the thread as usual. Starting a voice call does not approve those requests.

**Mute** pauses microphone input without ending the call. **End call** stops the voice session. A coding turn that already started continues after the call ends; use the thread's usual interrupt action if you also want to stop the agent.

Leaving the thread or backgrounding the app ends the call. Return to the thread and start a new call when you are ready to continue.
