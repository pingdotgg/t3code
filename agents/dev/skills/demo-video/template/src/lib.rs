//! T3 Code × agentctl Sandboxes: how to set it up and what using it looks like.
//!
//! This file is the video's content: its scenes in order, their text, and its shots. The look,
//! the drawn scenes and the shot that plays a recording are in `kit.rs`.
//!
//! Scenes: Title → Diagram (how the pieces fit) → Setup (typed terminal) → Manifest (agent.yaml)
//! → footage shots (create a Sandbox, a thread on the agent's own desktop, stop/start/delete) →
//! Recap. Shots play the cut segments in `FFRAMES_FOOTAGE_DIR`.
mod kit;

use fframes::{Duration, FFramesContext, Frame, Overlap, Scene, Svgr, include_media_dir};
use kit::*;

pub use kit::{DemoVideo, HEIGHT, WIDTH};

include_media_dir!(pub struct DemoMedia, "media");

pub fn video() -> DemoVideo {
    let mut scenes: Vec<Box<dyn Scene>> = vec![
        Box::new(TitleCard {
            name: "TitleScene",
            title: "T3 Code × agentctl",
            subtitle: "Coding agents in their own Sandboxes, driven from one app",
            chip: "Setup and a walkthrough",
            seconds: 5.0,
        }),
        Box::new(DiagramScene),
        Box::new(TerminalScene {
            name: "SetupScene",
            heading: "Set it up",
            window_title: "Terminal",
            lines: SETUP,
            caption: "Once, on your computer: four things to install and clone",
        }),
        Box::new(CodeCard {
            name: "ManifestScene",
            heading: "Altinn Studio's desktop Agent",
            file: "altinn-studio/agents/desktop/agent.yaml",
            lines: MANIFEST,
            caption: "Sandboxes show up in T3 Code when their manifest gives SSH access",
            seconds: 9.0,
        }),
    ];
    scenes.extend(shots().into_iter().map(|s| Box::new(s) as Box<dyn Scene>));
    scenes.push(Box::new(StepsCard {
        name: "RecapScene",
        heading: "That's the whole setup",
        steps: &[
            ("node scripts/fork/install-desktop.ts", "the T3 Code fork's desktop app"),
            ("agentctl ssh-config install", "so SSH reaches agentctl-NAME"),
            ("New Sandbox → your manifests folder", "e.g. altinn-studio, with access: ssh"),
        ],
        links: &["github.com/martinothamar/t3code", "github.com/Altinn/altinn-studio/tree/main/agents"],
        seconds: 10.0,
    }));
    DemoVideo::new(scenes)
}

// ---------------------------------------------------------------------------------------
// Setup and manifest

const SETUP: &[Line] = &[
    Line::Comment("# agentctl, from github.com/digdir/digdir-agents"),
    Line::Command("agentctl claude login"),
    Line::Output("claude authentication stored"),
    Line::Comment("# 1. The T3 Code fork's desktop app"),
    Line::Command("git clone https://github.com/martinothamar/t3code && cd t3code"),
    Line::Command("node scripts/fork/install-desktop.ts"),
    Line::Comment("# 2. Let SSH reach Sandboxes as agentctl-NAME"),
    Line::Command("agentctl ssh-config install"),
    Line::Comment("# 3. Manifests to create Sandboxes from, tokens in .env"),
    Line::Command("git clone https://github.com/Altinn/altinn-studio"),
    Line::Command("cd altinn-studio/agents/desktop && cp .env.sample .env"),
];

const MANIFEST: &[(&str, bool)] = &[
    ("apiVersion: agents.platform/v1alpha1", false),
    ("kind: Agent", false),
    ("metadata:", false),
    ("  name: altinn-desktop", false),
    ("spec:", false),
    ("  sandbox:", false),
    ("    image:", false),
    ("      reference: ghcr.io/altinn/altinn-studio/agent-desktop:latest", false),
    ("  …", false),
    ("  access:", true),
    ("    - type: ssh    # T3 Code connects over SSH", true),
    ("    - type: vnc    # and you can watch its desktop", true),
];

// ---------------------------------------------------------------------------------------
// Diagram: how the pieces fit, a scene drawn for this video

#[derive(Debug)]
struct DiagramScene;
const DIAGRAM_SECONDS: f32 = 13.0;

impl Scene for DiagramScene {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(DIAGRAM_SECONDS)
    }

    fn overlap(&self) -> Overlap {
        Overlap::Previous(XFADE)
    }

    fn render_frame<'a>(&'a self, mut frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let total = DIAGRAM_SECONDS + XFADE;
        let opacity = scene_opacity(&frame, total, true, true);

        let laptop = ease_out(&frame, 0.5);
        let sandbox = ease_out(&frame, 1.6);
        let link = ease_out(&frame, 2.6);

        // Things that run inside the Sandbox, appearing one by one.
        let chips: Vec<Svgr> = [
            ("Claude Code · Codex", "the agents, with credentials agentctl mediates", 3.6_f32),
            ("T3 server", "installed over SSH by the app", 4.4),
            ("A desktop", "terminal and Chromium, viewable over noVNC", 5.2),
            ("localtest", "containers started by studioctl", 6.0),
        ]
        .into_iter()
        .enumerate()
        .map(|(i, (name, what, at))| {
            let p = ease_out(&frame, at);
            let y = 372.0 + i as f32 * 112.0;
            fframes::svgr!(
                <g opacity={p} transform={format!("translate({} 0)", (1.0 - p) * 30.0)}>
                    <rect x="1000" y={y} width="680" height="92" rx="16" fill="#151a30" stroke="#ffffff" stroke-opacity="0.08" />
                    <circle cx="1036" cy={y + 46.0} r="7" fill={GREEN} />
                    <text x="1062" y={y + 42.0} font-family={SANS} font-weight="600" font-size="28" fill={TEXT}>{name}</text>
                    <text x="1062" y={y + 74.0} font-family={SANS} font-weight="400" font-size="21" fill={MUTED}>{what}</text>
                </g>
            )
        })
        .collect();

        let captions: [(f32, f32, &'static str); 3] = [
            (0.6, 3.4, "The desktop app runs on your computer"),
            (3.4, 8.6, "Each agentctl Sandbox is its own machine, reached over SSH"),
            (8.6, total - 0.2, "Its threads, terminals and browser all run in the Sandbox"),
        ];
        let caption_svgs: Vec<Svgr> = captions
            .iter()
            .map(|&(s, e, text)| {
                let o = window_opacity(&frame, s, e);
                caption(&mut frame, ctx, text, 990.0, o)
            })
            .collect();

        fframes::svgr!(
            <g opacity={opacity}>
                <text x="960" y="150" text-anchor="middle" font-family={SANS} font-weight="700" font-size="60" fill={TEXT}
                      opacity={ease_out(&frame, 0.1)}>"How it fits together"</text>
                // the laptop
                <g opacity={laptop} transform={format!("translate(0 {})", (1.0 - laptop) * 30.0)}>
                    <rect x="200" y="400" width="520" height="330" rx="24" fill="#1e2440" stroke={ACCENT} stroke-width="2" />
                    <text x="460" y="380" text-anchor="middle" font-family={SANS} font-weight="600" font-size="26" fill={MUTED}>"Your computer"</text>
                    <rect x="250" y="450" width="420" height="230" rx="14" fill="#0d0f17" />
                    <circle cx="276" cy="474" r="6" fill="#ff5f57" />
                    <circle cx="296" cy="474" r="6" fill="#febc2e" />
                    <circle cx="316" cy="474" r="6" fill="#28c840" />
                    <text x="460" y="575" text-anchor="middle" font-family={SANS} font-weight="700" font-size="44" fill={TEXT}>"T3 Code"</text>
                    <text x="460" y="620" text-anchor="middle" font-family={SANS} font-weight="500" font-size="22" fill={MUTED}>"desktop app (the fork)"</text>
                </g>
                // the Sandbox
                <g opacity={sandbox} transform={format!("translate(0 {})", (1.0 - sandbox) * 30.0)}>
                    <rect x="960" y="260" width="760" height="580" rx="28" fill="#10142a" stroke={ACCENT_2} stroke-width="2" stroke-dasharray="10 8" />
                    <text x="1000" y="318" font-family={MONO} font-weight="700" font-size="28" fill={ACCENT_2}>"altinn-desktop-1"</text>
                    <text x="1680" y="318" text-anchor="end" font-family={SANS} font-weight="500" font-size="22" fill={MUTED}>"agentctl Sandbox (microVM)"</text>
                </g>
                {chips}
                // the SSH link
                <g opacity={link.min(1.0)}>
                    <path d={format!("M730 565 H{}", 730.0 + 210.0 * link)} stroke={GREEN} stroke-width="5" stroke-linecap="round" />
                    <path d="M928 553 L944 565 L928 577" fill="none" stroke={GREEN} stroke-width="5" stroke-linecap="round" stroke-linejoin="round" opacity={link} />
                    <text x="835" y="545" text-anchor="middle" font-family={MONO} font-weight="700" font-size="28" fill={GREEN}>"SSH"</text>
                    <text x="835" y="602" text-anchor="middle" font-family={MONO} font-weight="400" font-size="15" fill={MUTED}>"agentctl-altinn-desktop-1"</text>
                </g>
                {caption_svgs}
            </g>
        )
    }
}

// ---------------------------------------------------------------------------------------
// Footage shots

const CREATE: &str = "1 · Create a Sandbox";
const WORK: &str = "2 · Work in it";
const MANAGE: &str = "3 · Stop, start, delete";

// Cam and ring coordinates are source pixels of the 1600x900 recordings: a `desktop`
// screenshot's coordinates scaled by the display's size over the screenshot's.
fn shots() -> Vec<Shot> {
    vec![
        // --- create -------------------------------------------------------------------
        Shot {
            name: "CreateDialog", file: "c1.mp4", len: 14.0, chapter: CREATE, speed: 1.5,
            cams: &[Cam(0.0, 1.0, 800.0, 450.0), Cam(1.6, 1.0, 800.0, 450.0), Cam(2.6, 1.55, 800.0, 430.0),
                    Cam(6.4, 1.55, 800.0, 430.0), Cam(7.4, 1.3, 800.0, 600.0), Cam(12.0, 1.3, 800.0, 600.0),
                    Cam(12.8, 1.55, 840.0, 470.0)],
            captions: &[(0.4, 6.6, "New Sandbox, from a folder of agentctl manifests"),
                        (6.6, 12.4, "T3 Code lists every Agent and variant in it"),
                        (12.4, 14.0, "Create")],
            rings: &[],
            fade_out: false,
        },
        Shot {
            name: "CreateProvision", file: "c2.mp4", len: 10.366, chapter: CREATE, speed: 8.0,
            cams: &[Cam(0.0, 1.45, 620.0, 260.0)],
            captions: &[(0.3, 10.4, "agentctl provisions it, and T3 Code follows along")],
            rings: &[],
            fade_out: false,
        },
        Shot {
            name: "CreateReady", file: "c3.mp4", len: 8.0, chapter: CREATE, speed: 1.0,
            cams: &[Cam(0.0, 1.45, 620.0, 260.0), Cam(8.0, 1.6, 700.0, 220.0)],
            captions: &[(0.3, 8.0, "Ready: it installs its server over SSH and connects")],
            rings: &[],
            fade_out: false,
        },
        Shot {
            name: "CreateThread", file: "c4.mp4", len: 9.0, chapter: CREATE, speed: 1.0,
            cams: &[Cam(0.0, 1.6, 700.0, 220.0), Cam(3.6, 1.6, 900.0, 220.0), Cam(4.8, 1.0, 800.0, 450.0)],
            captions: &[(0.3, 9.0, "The Sandbox is a project now. Start a thread in it")],
            rings: &[],
            fade_out: true,
        },
        // --- work -----------------------------------------------------------------------
        Shot {
            name: "ThreadPrompt", file: "t1.mp4", len: 9.0, chapter: WORK, speed: 1.0,
            cams: &[Cam(0.0, 1.0, 800.0, 450.0), Cam(1.0, 1.7, 905.0, 390.0)],
            captions: &[(0.4, 9.0, "Ask the agent to work on its own desktop, where you can watch")],
            rings: &[],
            fade_out: false,
        },
        Shot {
            name: "ThreadPopup", file: "t2.mp4", len: 10.5, chapter: WORK, speed: 2.0,
            cams: &[Cam(0.0, 1.45, 800.0, 260.0), Cam(7.6, 1.45, 800.0, 260.0), Cam(8.8, 2.3, 1420.0, 745.0)],
            captions: &[(0.3, 7.6, "It opens its desktop with T3 Code's browser tool"),
                        (7.6, 10.5, "A floating preview pops up: Agent has control")],
            rings: &[],
            fade_out: false,
        },
        Shot {
            name: "ThreadPopupWork", file: "t3.mp4", len: 8.0, chapter: WORK, speed: 8.0,
            cams: &[Cam(0.0, 2.3, 1420.0, 745.0)],
            captions: &[(0.0, 8.0, "Inside: the agent's own terminal, in the Sandbox")],
            rings: &[],
            fade_out: false,
        },
        Shot {
            name: "ThreadPanel", file: "t4.mp4", len: 12.8, chapter: WORK, speed: 1.25,
            cams: &[Cam(0.0, 1.6, 1250.0, 300.0), Cam(2.2, 1.6, 1250.0, 300.0), Cam(3.4, 1.0, 800.0, 450.0)],
            captions: &[(0.3, 7.6, "Open it in the right panel, beside the chat"),
                        (7.6, 12.8, "…and give it some room")],
            rings: &[],
            fade_out: false,
        },
        Shot {
            name: "ThreadEnvUp", file: "t5.mp4", len: 13.6, chapter: WORK, speed: 2.5,
            cams: &[Cam(0.0, 1.0, 800.0, 450.0), Cam(1.2, 1.75, 1112.0, 390.0)],
            captions: &[(0.3, 13.6, "studioctl env up starts localtest: four containers in the Sandbox")],
            rings: &[],
            fade_out: false,
        },
        Shot {
            name: "ThreadLocaltest", file: "t6.mp4", len: 14.0, chapter: WORK, speed: 1.0,
            cams: &[Cam(0.0, 1.75, 1112.0, 390.0), Cam(3.2, 1.75, 1112.0, 390.0), Cam(4.6, 1.3, 1080.0, 420.0)],
            captions: &[(0.3, 7.0, "Then it opens localtest in Chromium, on its desktop"),
                        (7.0, 14.0, "App Localtest, served and shown from inside the Sandbox")],
            rings: &[],
            fade_out: false,
        },
        Shot {
            name: "ThreadSummary", file: "t7.mp4", len: 7.666, chapter: WORK, speed: 3.0,
            cams: &[Cam(0.0, 1.3, 1080.0, 420.0), Cam(1.4, 1.0, 800.0, 450.0)],
            captions: &[(0.3, 7.7, "Your computer only ran the T3 Code app")],
            rings: &[],
            fade_out: true,
        },
        // --- manage ---------------------------------------------------------------------
        Shot {
            name: "ManageStop", file: "l1.mp4", len: 14.0, chapter: MANAGE, speed: 1.5,
            cams: &[Cam(0.0, 1.0, 800.0, 450.0), Cam(1.6, 1.45, 930.0, 300.0)],
            captions: &[(0.4, 6.0, "Sandboxes: state, resources and threads"),
                        (6.0, 14.0, "Stop keeps its disk")],
            rings: &[],
            fade_out: false,
        },
        Shot {
            name: "ManageStart", file: "l2.mp4", len: 10.0, chapter: MANAGE, speed: 2.0,
            cams: &[Cam(0.0, 1.45, 930.0, 300.0)],
            captions: &[(0.3, 10.0, "Start it again, and T3 Code reconnects")],
            rings: &[],
            fade_out: false,
        },
        Shot {
            name: "ManageThread", file: "l3.mp4", len: 7.0, chapter: MANAGE, speed: 1.0,
            cams: &[Cam(0.0, 1.0, 800.0, 450.0), Cam(1.6, 1.55, 470.0, 330.0)],
            captions: &[(0.3, 7.0, "Its threads are still there")],
            rings: &[],
            fade_out: false,
        },
        Shot {
            name: "ManageDelete", file: "l4.mp4", len: 12.8, chapter: MANAGE, speed: 1.25,
            cams: &[Cam(0.0, 1.0, 800.0, 450.0), Cam(1.6, 1.45, 930.0, 330.0), Cam(9.0, 1.45, 930.0, 330.0), Cam(10.2, 1.0, 800.0, 450.0)],
            captions: &[(0.3, 12.8, "Delete removes the Sandbox, its disk, project and threads")],
            rings: &[],
            fade_out: true,
        },
    ]
}
