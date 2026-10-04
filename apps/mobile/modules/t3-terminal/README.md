# Android terminal renderer

Retained from T3 Code. This Expo module uses Ghostty's VT parser through JNI and
renders terminal snapshots in an Android Canvas. Our mobile app uses it to display
Codex command output. It does not spawn a local shell or provide a PTY backend.

The Android shared libraries and headers are pinned in `native/libghostty-vt/VERSION`.
To rebuild, set `ANDROID_NDK_HOME` and run:

```sh
apps/mobile/modules/t3-terminal/scripts/build-libghostty-android.sh
```

See `THIRD_PARTY_NOTICES.md` and `native/libghostty-vt/LICENSE` for attribution.
