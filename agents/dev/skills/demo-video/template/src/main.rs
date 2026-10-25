use fframes::cli::clap; // the derive below expands to `clap::...`
use fframes::{
    CombinedMediaProvider, EncoderOptions, MediaDirectory, MediaProvider, RenderOptions,
    StaticMediaProvider, cli,
};
use fframes_skia_renderer::{
    SkiaFFramesRenderer, SkiaPipelineConcurrencyPolicy, SkiaPipelineConfig, SkiaCpuCtx,
    vulkan::SkiaVulkanCtx,
};
use std::path::PathBuf;
use std::process::ExitCode;
use demo_video::{DemoMedia, HEIGHT, WIDTH};

/// Flags of this video next to the standard ones of `fframes::cli` (render, frame, strip,
/// inspect, audio, ...). Run `cargo run --release -- --help`.
#[derive(Debug, clap::Args)]
struct VideoArgs {}

/// Footage (mp4/mov/webm/mkv) is read at runtime from this folder, never compiled in:
/// `include_media_dir!` rejects video files. It holds the cut segments that `scripts/cut.sh`
/// writes, `../footage/seg` beside the project. Override with `FFRAMES_FOOTAGE_DIR`.
fn footage_dir() -> PathBuf {
    std::env::var_os("FFRAMES_FOOTAGE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../footage/seg")))
}

fn main() -> ExitCode {
    let args = cli::parse::<VideoArgs>();

    // Fonts (and images/audio) compiled into the binary from `media/`.
    let media = DemoMedia::prepare().expect("media");
    // Footage loaded at runtime; files are opened lazily by the decoder, not read into memory.
    let footage = MediaDirectory::read_folder(footage_dir()).expect("footage folder");
    let dynamic = footage.process_media_source().expect("footage media");
    let all = CombinedMediaProvider::from([&media as &dyn MediaProvider, &dynamic]);

    let video = demo_video::video();
    let options = RenderOptions {
        media: Some(&all),
        video_encoder_options: EncoderOptions {
            preferred_encoder: Some("libx264"),
            codec_params: Some(&[("crf", "18"), ("preset", "medium")]),
            ..Default::default()
        },
        default_font: "Inter",
        ..Default::default()
    };
    let runner = cli::new(&video, options).args(args);

    // FFRAMES_BACKEND = vulkan (default; Skia on Vulkan, Mesa lavapipe here since there is no
    // GPU) | skia-cpu (Skia raster) | cpu (built-in tiny-skia renderer).
    let backend = std::env::var("FFRAMES_BACKEND").unwrap_or_else(|_| "vulkan".to_owned());
    match backend.as_str() {
        "cpu" => runner.run(),
        "skia-cpu" => {
            let ctx = SkiaCpuCtx::new(WIDTH, HEIGHT);
            let config = SkiaPipelineConfig {
                concurrency_policy: SkiaPipelineConcurrencyPolicy::MaxPerformance,
                ..Default::default()
            };
            runner
                .backend(SkiaFFramesRenderer::new_cpu(&ctx, config).expect("skia cpu renderer"))
                .run()
        }
        _ => {
            let gpu = SkiaVulkanCtx::new(WIDTH, HEIGHT).expect("Vulkan context");
            let config = SkiaPipelineConfig {
                concurrency_policy: SkiaPipelineConcurrencyPolicy::MaxPerformance,
                ..Default::default()
            };
            runner
                .backend(SkiaFFramesRenderer::new_vulkan(&gpu, config).expect("skia renderer"))
                // `preview` opens the real-time player window (on DISPLAY).
                .preview(fframes_native_player::cli_preview)
                .run()
        }
    }
}
