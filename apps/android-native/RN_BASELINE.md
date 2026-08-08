# React Native Android baseline

Reference device: Samsung SM-S938B, Android 16, 1080×2340 physical resolution, 420 dpi override.

The baseline uses the currently installed `com.t3tools.t3code` release on the physical device. Measurements were collected through ADB on 2026-08-08 without copying user content or modifying live thread data.

## Scenarios

| Scenario         | Dataset                          | Measurement                                                      |
| ---------------- | -------------------------------- | ---------------------------------------------------------------- |
| Cold start       | Existing authenticated app state | Process start to activity draw; five force-stopped runs.         |
| Home list        | 11 projects, 50 active threads   | Frame timing during five upward and five downward 300 ms swipes. |
| Streaming thread | Existing current thread          | Frame timing while one controlled assistant update arrives.      |

Results are recorded only after the device is awake and unlocked; lock-screen launches are invalid because Android reports the three-second activity wait timeout instead of an app paint.

## Results

### Cold start

`am start -W -S` reported successful launches of 616, 471, 461, 464, and 501 ms.
The median was **471 ms**; the slowest run was **616 ms**. Android did not report a
separate `ThisTime` value for this activity.

### Home list

Android's modern frame-timeline classifier reported:

| Metric                |               Result |
| --------------------- | -------------------: |
| Total frames          |                  420 |
| Janky frames          |            2 (0.48%) |
| p50 / p90 / p95 / p99 | 13 / 17 / 17 / 17 ms |
| Missed vsync          |                    0 |
| Slow UI thread        |                    0 |
| Slow draw commands    |                    2 |

The synthetic ADB swipes reported 774 high-input-latency events, so that counter is
not used as an app-rendering signal. Android's legacy classifier marked 47.62% of
frames as janky; the frame-timeline classifier is the reference result on this
variable-refresh-rate device.

### Streaming thread

The controlled current-thread update rendered two measured frames. Both crossed the
jank deadline; p50–p99 was 57 ms, with one missed vsync, one slow UI-thread frame,
and two slow draw commands. This is a directional reference only because two frames
are not a statistically useful sample. A future 500+ thread fixture and sustained
streaming run should be compared separately rather than inferred from live user data.
