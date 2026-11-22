import type { ReactElement } from "react";
import { PhoneFrame } from "./components/PhoneFrame";
import { ThreadListScreen } from "./screens/ThreadListScreen";
import { ThreadScreen } from "./screens/ThreadScreen";
import { TasksScreen } from "./screens/TasksScreen";
import {
  INSIGHT_VARIANTS,
  SCREENS,
  useLabUrlState,
  type LabUrlState,
  type ScreenId,
  type ThemeChoice,
} from "./urlState";

const THEMES: ReadonlyArray<{ id: ThemeChoice; label: string }> = [
  { id: "dark-mono", label: "Dark Mono" },
  { id: "light", label: "Light" },
  { id: "both", label: "Both" },
];
const SCALES = [0.5, 0.75, 1, 1.25, 1.5];

function renderScreen(url: LabUrlState): ReactElement {
  switch (url.screen) {
    case "thread-question":
      return <ThreadScreen key={url.state} variant="question" scenario={url.state} />;
    case "thread":
      return <ThreadScreen variant="feed" />;
    case "thread-list":
      return <ThreadListScreen />;
    case "tasks":
      return (
        <TasksScreen
          key={`${url.state}-${url.insights}`}
          chart={url.state === "chart"}
          insights={url.insights}
        />
      );
  }
}

export function MobileLab() {
  const [url, update] = useLabUrlState();
  const themes = url.theme === "both" ? (["dark-mono", "light"] as const) : ([url.theme] as const);
  const states: readonly string[] = SCREENS[url.screen].states;
  return (
    <div className="mlab" data-backdrop={url.theme === "light" ? "light" : "dark"}>
      <div className="mlab-toolbar">
        <label>
          Screen
          <select
            value={url.screen}
            onChange={(event) => update({ screen: event.target.value as ScreenId })}
          >
            {Object.entries(SCREENS).map(([id, screen]) => (
              <option key={id} value={id}>
                {screen.label}
              </option>
            ))}
          </select>
        </label>
        {states.length > 0 ? (
          <div className="mlab-segment" role="group" aria-label="State">
            {states.map((state) => (
              <button
                key={state}
                data-active={url.state === state}
                onClick={() => update({ state })}
              >
                {state}
              </button>
            ))}
          </div>
        ) : null}
        {url.screen === "tasks" ? (
          <div className="mlab-segment" role="group" aria-label="Insights">
            {INSIGHT_VARIANTS.map((variant) => (
              <button
                key={variant}
                data-active={url.insights === variant}
                onClick={() => update({ insights: variant })}
              >
                {variant.toUpperCase()}
              </button>
            ))}
          </div>
        ) : null}
        <div className="mlab-segment" role="group" aria-label="Theme">
          {THEMES.map((theme) => (
            <button
              key={theme.id}
              data-active={url.theme === theme.id}
              onClick={() => update({ theme: theme.id })}
            >
              {theme.label}
            </button>
          ))}
        </div>
        <div className="mlab-segment" role="group" aria-label="Scale">
          {SCALES.map((scale) => (
            <button key={scale} data-active={url.scale === scale} onClick={() => update({ scale })}>
              {Math.round(scale * 100)}%
            </button>
          ))}
        </div>
      </div>
      <div className="mlab-stage">
        {themes.map((theme) => (
          <PhoneFrame key={theme} theme={theme} scale={url.scale}>
            {renderScreen(url)}
          </PhoneFrame>
        ))}
      </div>
    </div>
  );
}
