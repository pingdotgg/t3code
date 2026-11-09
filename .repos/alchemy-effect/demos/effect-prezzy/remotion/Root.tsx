import { Composition } from "remotion";
import { deck, loopDeck } from "../deck.ts";
import { VIDEO } from "../shared/types.ts";
import { calculateIntroMetadata, Intro, IntroLive } from "./intro/Intro.tsx";
import { calculateSceneMetadata, Scene } from "./scene/Scene.tsx";
import { Slide } from "./slides/Slide.tsx";

/** One composition per deck item; composition ids are the deck ids. */
export const Root = () => (
  <>
    {/* `pnpm dev`: the intro, hot-reloaded as intro/steps.ts and snippets change. */}
    <Composition
      id="intro-live"
      component={IntroLive}
      durationInFrames={VIDEO.fps * 180}
      fps={VIDEO.fps}
      width={VIDEO.width}
      height={VIDEO.height}
    />
    {[...deck, ...loopDeck].map((item) =>
      item.kind === "intro" ? (
        <Composition
          key={item.id}
          id={item.id}
          component={Intro}
          calculateMetadata={calculateIntroMetadata}
          durationInFrames={1}
          fps={VIDEO.fps}
          width={VIDEO.width}
          height={VIDEO.height}
          defaultProps={{ source: item.id }}
        />
      ) : item.kind === "slide" ? (
        <Composition
          key={item.id}
          id={item.id}
          component={Slide}
          durationInFrames={Math.round((item.seconds ?? 2) * VIDEO.fps)}
          fps={VIDEO.fps}
          width={VIDEO.width}
          height={VIDEO.height}
          defaultProps={{ layout: item.layout, props: item.props }}
        />
      ) : (
        <Composition
          key={item.id}
          id={item.id}
          component={Scene}
          calculateMetadata={calculateSceneMetadata}
          durationInFrames={1}
          fps={VIDEO.fps}
          width={VIDEO.width}
          height={VIDEO.height}
          defaultProps={{ id: item.id }}
        />
      ),
    )}
  </>
);
