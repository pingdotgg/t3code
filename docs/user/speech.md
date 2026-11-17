# Speech

Read a completed assistant response aloud using the speaker action beside it.
Speech works in the web, desktop, and mobile apps and is separate from
[voice input](./voice-input.md).

## Choose where speech is generated

Open **Settings → Speech → Read aloud with**. It starts **Off**. Choose **System voices**
for speech on this device, an environment for Piper, or OpenAI or ElevenLabs under
**Cloud via** an environment.

Use the settings scope selector to edit the defaults for environments or a project.
Destination, voice and speed follow the conversation's project settings, inheriting
the environment defaults until you override them. The reset action restores that
inheritance; selecting **Off** disables speech for that scope. Different projects
can use different voices and destinations, including when open side by side.
Existing device preferences remain the fallback until scoped defaults are saved.
A selection with different values shows **Mixed**. If targets use different
engines or environments, choose a common destination before editing voices.
Changing speed preserves each target’s destination.

API keys, Piper installation and voice downloads belong to the environment chosen
for synthesis. Changing a project's playback preference does not change another
project's settings or that environment's credentials. Update older connected environments
before using a custom voice from a project preference.

The chosen environment generates the speech; your device plays the audio. A phone
connected to another machine does not need its own Piper installation. If the
environment or service is unavailable, playback fails instead of switching destinations.

## System voices

**System voices** uses the speech engine and voices installed on the listening
device, without uploading text to a T3 Code environment. Some system voices may
use the operating system's online speech service. Use **System default** when you
want a portable choice across devices; a specific voice must be available on each
device that plays the response. Your operating system manages voice installation.

## Local playback

Choose an environment, then download Piper when prompted. T3 Code checks that
machine's platform and installs Piper for you; no manual Python or command-line
setup is needed. Unsupported platforms show an explanation.

Choose a language and voice, then **Download & use voice**. Once Piper and the
voice are installed on that environment, local playback works without internet
and sends no response text to a cloud service. Other devices connected to the
environment use the same installed voices. You can cancel downloads or remove a
voice. Removing Piper keeps the voices for a later installation.

## Cloud playback

Choose OpenAI or ElevenLabs via the environment whose key you want to use.
If it needs a key, a dialog opens. The destination changes only after the key is
saved successfully. Cancelling, closing the dialog, or reloading before saving
keeps the previous destination. A provider with a saved key can be selected directly.

Keys belong to that environment. Anyone with playback access can use the saved
key; changing keys or voices requires settings access. Where
[secret providers](./secrets.md) are available, choose a vault and enter a reference
instead of saving the key itself. Unlock the vault on the chosen environment first.

OpenAI shares its key with OpenAI transcription. Changing or removing that key
affects both features. For ElevenLabs, the voice selector loads the voices in
your account after the key is configured. The key needs **Voices: Read** permission;
you can load more voices or retry if the list fails to load.

Cloud playback sends response text to the selected service and incurs API charges.
It uses that service's API account, independently of your coding agent subscription.

## Control playback

Use the speaker action to pause or resume, or Stop to finish listening. Starting
another response or dictating stops the current reading. Code blocks and images
are omitted; link labels and inline code are read.

For long responses, the next segment is prepared while the current one plays.
Only one segment is prepared ahead; stopping discards it and cancels pending work.
Adjust **Playback speed** from 0.5× to 2× in Speech settings or beside active audio.
Speed changes apply immediately to generated audio without synthesizing it again.
With system voices, speed changes apply to the next segment. Android system speech
has a Stop control rather than pause/resume. On mobile, leaving the app stops playback.
