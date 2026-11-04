---
title: "Product usage data and telemetry"
description: "Learn what T3 Code usage events contain, where telemetry goes, how to opt out, and which browser, mobile, and diagnostic controls remain separate."
updated: 2026-11-04
sources:
  - label: "Product usage data"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/telemetry.md"
  - label: "Product analytics architecture"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/internals/product-analytics.md"
  - label: "Managed policy"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/managed-policy.md"
  - label: "Background service environment"
    url: "https://github.com/pingdotgg/t3code/blob/main/docs/user/background-service.md"
  - label: "Privacy policy source"
    url: "https://github.com/pingdotgg/t3code/blob/main/apps/marketing/src/pages/privacy-policy.astro"
faq:
  - question: "Does T3 Code collect telemetry?"
    answer: "T3 Code sends product usage events by default to ingest.t3.codes, with events forwarded to PostHog. It also sends relay connection traces to Axiom."
  - question: "Does T3 Code telemetry include my code or prompts?"
    answer: "T3 Code product events exclude prompts, responses, file contents, authentication tokens, conversation IDs, raw provider events, and child-agent output. Other features, including provider requests, have separate data flows."
  - question: "How do I turn off T3 Code telemetry?"
    answer: "Set T3CODE_TELEMETRY_ENABLED=false in the environment of the T3 Code server before starting it, then restart it. Browser clients do not read this server environment variable."
  - question: "How do I stop T3 Code mobile crash reports?"
    answer: "In the T3 Code mobile app, turn off Send crash reports under Settings > About T3 Code > Diagnostics. This control is separate from the server telemetry environment variable."
---

T3 Code sends product usage events by default to `ingest.t3.codes`, which keeps an event copy and forwards events to PostHog. Events describe product use and measurements, and exclude prompts, responses, file contents, and authentication tokens. Set `T3CODE_TELEMETRY_ENABLED=false` where the server runs and restart it to stop product events and server relay tracing.

## What information is in a usage event?

Usage events describe which features and providers run, how work ends, and available measurements. They use hashed account or installation identifiers. The server can also report hashed T3 Connect, OpenAI, and Claude account identifiers, plus random identifiers for connected devices, to associate installations with their use.

| Included category       | Examples                                                          |
| ----------------------- | ----------------------------------------------------------------- |
| Agent selection         | Provider, public model name where eligible, reasoning effort      |
| Execution configuration | Permission mode and release channel                               |
| Results                 | Turn and request results, duration                                |
| Usage measurements      | Token counts where the provider supplies them                     |
| Identity association    | Hashed account or installation identifiers and device identifiers |

Child-agent token counts are reported separately from main-agent counts. Missing provider measurements remain unknown rather than proving that no work occurred. Model names are sent only when they match eligible public vendor catalogs. User-configured model names are excluded.

Product events do not include prompts, responses, source file contents, authentication tokens, conversation IDs, raw provider events, or child-agent output. Feature tracking uses allowed methods and fixed variants rather than arbitrary titles, paths, or text. The analytics design also keeps PostHog person profiles disabled.

Hashing account identifiers does not mean there is no association between events. Their purpose includes recognizing related installations. Use the specific payload exclusions when assessing collection, rather than assuming that every event is unrelated to every other one.

## Who sends the events and where do they go?

The environment server owns analytics delivery, identity, and the opt-out for connected clients. Clients do not load the PostHog browser SDK. Client-use events require an authenticated connection, so opening the hosted app without connecting does not count as product use.

The ingest endpoint archives events and forwards some to PostHog. Relay connection tracing is a separate diagnostic flow to Axiom. The [privacy policy](/privacy-policy) also describes operational information that online services can process, including connection events and errors.

These statements concern analytics and diagnostics. They do not change what a coding provider receives when you ask an agent to work. The [security and privacy guide](/learn/safety/security-and-privacy) explains that broader data flow.

## Turn off events on the server you use

Set this before starting the server:

```sh
export T3CODE_TELEMETRY_ENABLED=false
```

For the desktop app on macOS or Linux, export the variable in your shell profile, such as `~/.zshrc`, and restart the app. On Windows, set it as a user environment variable and restart the app.

For an installed background service, put the literal assignment in its service environment file, normally `~/.t3/service.env`:

```dotenv
T3CODE_TELEMETRY_ENABLED=false
```

Restart that service with `t3 service restart`. A variable set in another terminal does not establish what the running service inherited. Apply the setting to the host environment that sends events, including a remote host when that is where your agents run.

Administrators can set `limits.telemetry` to `false` through [managed policy](/learn/safety/managed-policy). That disables server and desktop product events and relay traces. Policy cannot force them on.

## Which diagnostics have separate controls?

Browser clients do not read the server's telemetry variables. A browser connected to the server, including the hosted web app, can still send its own relay traces even when managed policy disables the host's tracing.

Relay tracing also stops when `T3CODE_OTEL_SDK_DISABLED` or `OTEL_SDK_DISABLED` disables OpenTelemetry export. That is a tracing control, not a substitute for checking every data flow of an enabled feature.

Mobile apps send crash and error reports with the error message, stack trace, app version, device model, and OS version. Each launch sends startup timings, and reports include a random installation ID. Reports travel through the T3 Connect relay to Axiom.

Mobile reports exclude threads, prompts, and connection details, but an error message can quote a value the app was processing. Turn off **Send crash reports** in **Settings > About T3 Code > Diagnostics** to stop them. Check this separately from the server opt-out.

## Export diagnostics to a receiver you control

In **Settings > Maintenance > Diagnostics**, choose an environment and enter each signal's OTLP HTTP endpoint under **OpenTelemetry export**. Save and restart that environment's server. The receiver must be reachable from the server machine.

**Test** sends an empty export from the server. Authentication headers go only to the signal's currently running endpoint, and checks do not follow redirects. For a new authenticated endpoint, save and restart before testing it.

Environment variables can override saved endpoints. A signal marked **Set by environment** names the controlling variable, and testing checks the running endpoint. Review that state before assuming the text field describes the destination currently receiving diagnostics.

## Next steps

Return to [permissions and privacy](/learn/safety) to review related controls. Consult the [T3 Code FAQ](/learn/start/faq) and [open source license guide](/learn/open-source/mit-license) for broader product questions.
