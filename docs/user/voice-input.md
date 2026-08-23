# Local voice input

Local voice input is available in the T3 Code desktop app on macOS, Windows x64, and Linux. It is not available in the browser or mobile apps yet.

Select the microphone button beside Send to begin recording. Select the stop button to transcribe, or press Escape to discard the recording. T3 Code inserts the result at the current composer cursor and never sends it automatically.

The first recording asks before downloading Moonshine Streaming Tiny, a 48 MiB English speech model. T3 Code verifies the model before using it. Speech processing runs on the local computer, and microphone audio is kept in memory only for the current recording.

To remove the downloaded model, open Settings, then General, and select Remove model under Local voice input.

On macOS, grant microphone access to T3 Code when prompted. If access was previously denied, enable it under System Settings, Privacy & Security, Microphone.

Windows arm64 is not supported because the transcription runtime does not currently publish a compatible native package.
