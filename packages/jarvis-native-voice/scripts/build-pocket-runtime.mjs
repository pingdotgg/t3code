// oxlint-disable t3code/no-global-process-runtime -- standalone native build script.
// Builds the production Pocket TTS daemon from pinned sources. Every source
// edit is an exact-match replacement that fails loudly if the pinned runtime
// drifts, so compatibility is verified rather than blindly copied.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const executeFile = NodeUtil.promisify(NodeChildProcess.execFile);

const PINNED = {
  runtimeRepository: "https://github.com/VolgaGerm/PocketTTS.cpp",
  runtimeCommit: "e801e7d6c2692121a39e80ae525cb5265174a495",
  ortVersion: "1.23.2",
};

const root = NodePath.resolve(import.meta.dirname, "..");
const nativeDir = NodePath.join(root, "native", "pocket");
const buildRoot = NodePath.join(nativeDir, "build");
const sourceDir = NodePath.join(buildRoot, "source");
const installDir = NodePath.join(buildRoot, "install");

const edits = [
  {
    name: "mixed precision (INT8 language model, FP32 flow and decoder)",
    old: '        std::string sfx = cfg_.precision == "int8" ? "_int8" : "";',
    new: '        std::string sfx = cfg_.precision != "fp32" ? "_int8" : "";\n        std::string audio_sfx = cfg_.precision == "int8" ? "_int8" : "";',
  },
  {
    name: "mixed precision flow network",
    old: '"/flow_lm_flow" + sfx',
    new: '"/flow_lm_flow" + audio_sfx',
  },
  {
    name: "mixed precision audio decoder",
    old: '"/mimi_decoder" + sfx',
    new: '"/mimi_decoder" + audio_sfx',
  },
  {
    name: "three-frame production chunks",
    old: "int lsd_steps = 1, num_threads = 0, first_chunk_frames = 1, max_chunk_frames = 15;",
    new: "int lsd_steps = 1, num_threads = 0, first_chunk_frames = 1, max_chunk_frames = 3;",
  },
  {
    name: "in-memory voice state only (no disk cache)",
    old: "    bool voice_cache = true;",
    new: "    bool voice_cache = false;",
  },
  {
    name: "bundle contract: no legacy space padding for short inputs",
    old: '    if (nwords < 5)\n        text = "        " + text;  // 8 spaces, matching Python',
    new: '    if (false)\n        text = "        " + text;  // disabled: bundle pad_with_spaces_for_short_inputs is false',
  },
  {
    name: "voice bias: prepend the bundle BOS vector after encoding",
    old: `        while (r.shape.size() > 3) r = r.squeeze(0);
        if (r.shape.size() < 3) r.reshape({1, r.shape[0], r.shape[1]});`,
    new: `        while (r.shape.size() > 3) r = r.squeeze(0);
        if (r.shape.size() < 3) r.reshape({1, r.shape[0], r.shape[1]});
        {
            const std::string bos_path = cfg_.models_dir + "/bos_before_voice.f32";
            std::ifstream bos_file(bos_path, std::ios::binary);
            if (!bos_file) throw std::runtime_error("Pocket voice bias is missing: " + bos_path);
            std::vector<float> bos(1024);
            bos_file.read(reinterpret_cast<char*>(bos.data()), bos.size() * sizeof(float));
            if (static_cast<size_t>(bos_file.gcount()) != bos.size() * sizeof(float))
                throw std::runtime_error("Pocket voice bias is corrupt: " + bos_path);
            Tensor bos_tensor(std::move(bos), std::vector<int64_t>({1, 1, 1024}));
            r = Tensor::concat({bos_tensor, r}, 1);
        }`,
  },
  {
    name: "bounded streaming queue with error propagation",
    old: `struct ptt_stream_ctx {
    std::thread thread;
    std::mutex mtx;
    std::condition_variable cv;
    std::deque<std::pair<float*, size_t>> chunks;
    bool done = false;
    bool aborted = false;
};`,
    new: `struct ptt_stream_ctx {
    std::thread thread;
    std::mutex mtx;
    std::condition_variable cv;
    std::condition_variable producer_cv;
    std::deque<std::pair<float*, size_t>> chunks;
    static constexpr size_t max_chunks = 16;
    bool done = false;
    bool aborted = false;
    bool failed = false;
    std::string error;
};`,
  },
  {
    name: "producer backpressure and typed stream errors",
    old: `    ctx->thread = std::thread([tts, t = std::string(text), v = std::string(voice), ctx]() {
        try {
            tts->stream(t, v, [ctx](const float* samples, size_t n) -> bool {
                float* copy = static_cast<float*>(malloc(n * sizeof(float)));
                if (!copy) return false;
                std::memcpy(copy, samples, n * sizeof(float));
                {
                    std::lock_guard<std::mutex> lock(ctx->mtx);
                    if (ctx->aborted) { free(copy); return false; }
                    ctx->chunks.push_back({copy, n});
                }
                ctx->cv.notify_one();
                return true;
            });
        } catch (const std::exception& e) {
            std::cerr << "[pocket-tts] stream error: " << e.what() << "\\n";
        }`,
    new: `    ctx->thread = std::thread([tts, t = std::string(text), v = std::string(voice), ctx]() {
        try {
            tts->stream(t, v, [ctx](const float* samples, size_t n) -> bool {
                float* copy = static_cast<float*>(malloc(n * sizeof(float)));
                if (!copy) return false;
                std::memcpy(copy, samples, n * sizeof(float));
                {
                    std::unique_lock<std::mutex> lock(ctx->mtx);
                    ctx->producer_cv.wait(lock, [ctx]{ return ctx->chunks.size() < ptt_stream_ctx::max_chunks || ctx->aborted; });
                    if (ctx->aborted) { free(copy); return false; }
                    ctx->chunks.push_back({copy, n});
                }
                ctx->cv.notify_one();
                return true;
            });
        } catch (const std::exception& e) {
            std::lock_guard<std::mutex> lock(ctx->mtx);
            ctx->failed = true;
            ctx->error = e.what();
        }`,
  },
  {
    name: "wake the producer when the consumer drains",
    old: `    if (!ctx->chunks.empty()) {
        auto [ptr, len] = ctx->chunks.front();
        ctx->chunks.pop_front();
        *out_samples = ptr;
        *out_len = static_cast<int>(len);
        return 1;
    }
    return 0;`,
    new: `    if (ctx->failed && ctx->chunks.empty()) return -1;
    if (!ctx->chunks.empty()) {
        auto [ptr, len] = ctx->chunks.front();
        ctx->chunks.pop_front();
        lock.unlock();
        ctx->producer_cv.notify_one();
        *out_samples = ptr;
        *out_len = static_cast<int>(len);
        return 1;
    }
    if (ctx->failed) return -1;
    return 0;`,
  },
  {
    name: "typed stream error accessor",
    old: `void ptt_stream_end(void* stream_ctx) {`,
    new: `const char* ptt_stream_error(void* stream_ctx) {
    if (!stream_ctx) return "";
    auto* ctx = static_cast<ptt_stream_ctx*>(stream_ctx);
    std::lock_guard<std::mutex> lock(ctx->mtx);
    return ctx->error.c_str();
}

void ptt_stream_end(void* stream_ctx) {`,
  },
  {
    name: "wake blocked reads and producers on stream end",
    old: `void ptt_stream_end(void* stream_ctx) {
    if (!stream_ctx) return;
    auto* ctx = static_cast<ptt_stream_ctx*>(stream_ctx);
    {
        std::lock_guard<std::mutex> lock(ctx->mtx);
        ctx->aborted = true;
    }
    ctx->cv.notify_all();`,
    new: `void ptt_stream_end(void* stream_ctx) {
    if (!stream_ctx) return;
    auto* ctx = static_cast<ptt_stream_ctx*>(stream_ctx);
    {
        std::lock_guard<std::mutex> lock(ctx->mtx);
        ctx->aborted = true;
    }
    ctx->cv.notify_all();
    ctx->producer_cv.notify_all();`,
  },
  {
    name: "fixed production inference budget (no environment overrides)",
    old: `        cfg.temperature = temperature;
        cfg.lsd_steps = lsd_steps;
        cfg.num_threads = num_threads;
        return new pocket_tts::PocketTTS(cfg);`,
    new: `        cfg.temperature = temperature;
        cfg.lsd_steps = lsd_steps;
        cfg.num_threads = num_threads;
        cfg.voice_cache = false;
        cfg.first_chunk_frames = 1;
        cfg.max_chunk_frames = 3;
        return new pocket_tts::PocketTTS(cfg);`,
  },
];

function applyEdits(source) {
  let text = source;
  for (const edit of edits) {
    const count = text.split(edit.old).length - 1;
    if (count !== 1) {
      throw new Error(
        `Production edit "${edit.name}" expected exactly one match, found ${count}. Inspect the pinned runtime before adapting.`,
      );
    }
    text = text.replace(edit.old, edit.new);
  }
  return text;
}

async function run(command, args, options = {}) {
  await executeFile(command, args, { stdio: "inherit", ...options });
}

async function main() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "linux" && arch !== "x64")
    throw new Error(`Pocket builds support linux-x64, got ${arch}.`);
  if (platform === "darwin" && arch !== "arm64" && arch !== "x64") {
    throw new Error(`Pocket builds support darwin arm64/x64, got ${arch}.`);
  }
  if (platform === "win32" && arch !== "x64")
    throw new Error(`Pocket builds support win-x64, got ${arch}.`);
  await NodeFSP.mkdir(buildRoot, { recursive: true });
  if (!NodeFS.existsSync(NodePath.join(sourceDir, ".git"))) {
    await NodeFSP.rm(sourceDir, { recursive: true, force: true });
    await run("git", ["clone", PINNED.runtimeRepository, sourceDir]);
  }
  await run("git", ["-C", sourceDir, "fetch", "origin", PINNED.runtimeCommit]);
  await run("git", ["-C", sourceDir, "checkout", PINNED.runtimeCommit]);
  const head = (await executeFile("git", ["-C", sourceDir, "rev-parse", "HEAD"])).stdout.trim();
  if (head !== PINNED.runtimeCommit) throw new Error(`Pinned Pocket runtime mismatch: ${head}`);
  const upstream = await NodeFSP.readFile(NodePath.join(sourceDir, "pocket_tts.cpp"), "utf8");
  const patched = applyEdits(upstream);
  const daemonSource = await NodeFSP.readFile(NodePath.join(nativeDir, "daemon_main.cpp"), "utf8");
  const staging = NodePath.join(buildRoot, "daemon");
  await NodeFSP.rm(staging, { recursive: true, force: true });
  await NodeFSP.mkdir(staging, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(staging, "pocket_tts.cpp"), patched);
  await NodeFSP.writeFile(NodePath.join(staging, "daemon_main.cpp"), daemonSource);
  await NodeFSP.copyFile(
    NodePath.join(nativeDir, "CMakeLists.txt"),
    NodePath.join(staging, "CMakeLists.txt"),
  );
  const buildDir = NodePath.join(buildRoot, `${platform}-${arch}`);
  const jobs = String(Math.max(1, Math.min(4, NodeOS.cpus().length)));
  await run("cmake", [
    "-S",
    staging,
    "-B",
    buildDir,
    "-DCMAKE_BUILD_TYPE=Release",
    `-DORT_VERSION=${PINNED.ortVersion}`,
  ]);
  await run("cmake", ["--build", buildDir, "--config", "Release", "-j", jobs]);
  await NodeFSP.mkdir(installDir, { recursive: true });
  const binary = platform === "win32" ? "jarvis-pocket-tts.exe" : "jarvis-pocket-tts";
  const installBin = NodePath.join(installDir, "bin");
  const installLib = NodePath.join(installDir, "lib");
  await NodeFSP.mkdir(installBin, { recursive: true });
  await NodeFSP.mkdir(installLib, { recursive: true });
  await NodeFSP.copyFile(NodePath.join(buildDir, binary), NodePath.join(installBin, binary));
  const ortLibDir = NodePath.join(buildDir, "_deps", "onnxruntime-src", "lib");
  for (const lib of await NodeFSP.readdir(ortLibDir)) {
    if (!lib.startsWith("libonnxruntime")) continue;
    const source = NodePath.join(ortLibDir, lib);
    const destination = NodePath.join(installLib, lib);
    const stat = await NodeFSP.lstat(source);
    await NodeFSP.rm(destination, { force: true });
    if (stat.isSymbolicLink()) {
      await NodeFSP.symlink(await NodeFSP.readlink(source), destination);
    } else {
      await NodeFSP.copyFile(source, destination);
    }
  }
  console.log(`Pocket daemon built: ${NodePath.join(installBin, binary)}`);
}

await main();
