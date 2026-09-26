# Motion preferences across entry points

Proposed invariant: a request for reduced motion changes how an action reaches its destination, not the destination, available content, focus or selection. Apply it to programmatic navigation and reveal actions whether they begin in search, settings, a preview, a menu or a keyboard shortcut.

Apple’s [Motion](https://developer.apple.com/design/human-interface-guidelines/motion) guidance calls for purposeful, optional motion and feedback that preserves information. Its [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility) guidance supports adapting motion to people’s preferences. The cross-entry-point constraint here is a proposed application of those principles, not a requirement for identical native animations.

Web and Electron read the browser’s reduced-motion preference; React Native uses the device accessibility preference. Read the current preference when starting an action, or subscribe to changes. Do not cache it for the lifetime of a screen. A missing preference API must not prevent navigation. Existing instant reveals and animation APIs that already honor the platform setting need no replacement.

Reduce unnecessary spatial animation while retaining an immediate destination indicator, focus, selection and meaningful input acknowledgement. Direct manipulation, including dragging and continuous scrolling while a key is held, still follows the person’s input. Native system transitions may adapt differently from web transitions. Neither exception permits a custom programmatic jump to ignore the preference.

Acceptance cases:

- Revealing the same target through search, preview inspection or a keyboard/menu route reaches the same content with normal and reduced motion.
- Reduced motion removes the custom animated travel without hiding content or suppressing the action’s focus or selection changes.
- Changing the preference while the client remains open applies to the next action.
- If the preference API is unavailable, navigation still completes using a safe fallback.

These are behavioral constraints across clients and connection modes; the preference belongs to the client displaying the action, independently of the provider or remote environment.
