# Voice input

Voice input is available in supported browsers, in the desktop app, and on iOS
26 or newer. Select the microphone button beside Send to record, then select the
checkmark button to transcribe. Select the X button to cancel. The transcript is inserted
into the composer for editing and is never sent automatically.

On web and desktop, the first microphone click opens voice setup if the selected
environment has no transcription model. Download the recommended English model,
or open Voice settings to choose another language or model. After the download,
you can choose a microphone, review the dictionary and post-processing options,
or start recording immediately.

On web and desktop, press Mod+Shift+D to start dictation and Esc to discard it.
The default **Auto** shortcut mode lets you tap to keep recording until the next
press, or hold the keys and release to finish. In Voice settings, choose **Hold**
to record only while the keys are down, or **Toggle** to start and finish with
separate presses. You can change the dictation shortcut in Keybindings settings.

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
**Transcription acceleration** defaults to Auto, which uses a GPU when available.
Choose CPU to avoid GPU use, or select a specific GPU on the transcription
environment. If that GPU fails or becomes unavailable, transcription reports an
error instead of switching to CPU.

**Model unload** defaults to 15 minutes of inactivity on the selected environment.
Choose Never to keep the model ready until the environment stops, or Immediately
to release its memory after each transcription.

Add names, technical terms, and other uncommon vocabulary to the **Dictionary**.
If transcription repeatedly writes a term differently, add that spelling as an alias
under the preferred term. Only preferred terms are sent as recognition hints; aliases
correct matching words and phrases in the transcript.
The words are stored on the selected transcription environment and apply to every
web or desktop client that uses it.

**Remove filler words** deletes common hesitation sounds from completed
transcriptions. It uses conservative language-aware rules so words with a real
meaning in another language are preserved when the transcription language is
uncertain. The setting is stored on the selected transcription environment.

On web and desktop, **Voice post-processing** can polish a completed transcript
with a provider configured on the current project environment. Its model and
prompt are independent from the environment's general text generation model.
Enable it and choose its model and prompt under Settings, then Voice.
If automatic cleanup misses your spoken corrections, add the word or phrase you
use to signal them as an **Explicit correction cue** in Voice settings.
While it runs, the composer shows a post-processing state. Select **Skip** to
stop processing and insert the original transcript instead. If processing fails,
T3 Code preserves the original transcript.

On iOS 26 or newer, transcription uses Apple's on-device speech model instead of
the environment service.
