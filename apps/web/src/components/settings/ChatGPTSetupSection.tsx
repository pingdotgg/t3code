import { SettingsRow } from "./settingsLayout";

export function ChatGPTSetupSection() {
  return (
    <section aria-label="ChatGPT Web browser setup">
      <SettingsRow
        title="ChatGPT account"
        description="ChatGPT opens in T3 Code’s shared browser for the thread using this provider."
      >
        <p role="status">
          Start a ChatGPT Web thread to open the shared browser. If the first request asks you to
          sign in, complete sign-in there and retry. If ChatGPT asks for verification, complete it
          in that visible tab; the request cooldown then applies. Agent browser access must be
          enabled for the project, and T3 Code desktop must be connected to the environment.
        </p>
      </SettingsRow>
    </section>
  );
}
