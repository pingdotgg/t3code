# Voice input

Voice input is available in supported browsers, in the desktop app, and on iOS
26 or newer. Select the microphone button beside Send to record, then select the
checkmark button to transcribe. Select the X button to cancel. The transcript is inserted
into the composer for editing and is never sent automatically.

On web and desktop, T3 Code transcribes every recording on the environment selected
under Settings, then Voice. The primary environment is used by default, regardless
of which environment owns the current thread. In the same settings, download and
select a transcription model. Models vary in download size, supported languages,
speed, and accuracy. If the selected environment is remote, the audio is sent to
that machine for transcription.

Models marked Streaming show a live preview while you speak. The tentative ending
may change as the model hears more. Stop recording to finish and insert the text;
cancel to discard the preview without changing your draft. Other models transcribe
after recording stops.

In Voice settings, you can also choose the microphone used by this browser or
app, switch between downloaded models, or remove models from the environment.

Add names, technical terms, and other uncommon vocabulary under **Custom words**.
The words are stored on the selected transcription environment and apply to every
web or desktop client that uses it.

**Remove filler words** deletes common hesitation sounds from completed
transcriptions. It uses conservative language-aware rules so words with a real
meaning in another language are preserved when the transcription language is
uncertain. The setting is stored on the selected transcription environment.

On web and desktop, **Voice post-processing** can polish a completed transcript
with a provider configured on the current project environment. Its model and
prompt are independent from the environment's general text generation model.
While it runs, the composer shows a post-processing state. Select **Skip** to
stop processing and insert the original transcript instead. If processing fails,
T3 Code preserves the original transcript.

On iOS 26 or newer, transcription uses Apple's on-device speech model instead of
the environment service.
