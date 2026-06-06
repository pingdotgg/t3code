import argparse
import json


def make_model(args):
    from faster_whisper import WhisperModel

    return WhisperModel(args.model, device=args.device, download_root=args.cache_dir)


def command_download(args):
    make_model(args)
    print(json.dumps({"ok": True}))


def command_smoke_test(args):
    make_model(args)
    print(json.dumps({"ok": True}))


def command_transcribe(args):
    model = make_model(args)
    language = None if args.language == "auto" else args.language
    prompt = args.prompt if args.prompt else None
    segments, info = model.transcribe(args.audio, language=language, initial_prompt=prompt)
    text = " ".join(segment.text.strip() for segment in segments).strip()
    print(json.dumps({"text": text, "language": getattr(info, "language", None)}))


def main():
    parser = argparse.ArgumentParser(description="T3 Voice Input faster-whisper helper")
    subparsers = parser.add_subparsers(dest="command", required=True)

    def add_common(subparser):
        subparser.add_argument("--model", required=True)
        subparser.add_argument("--cache-dir", required=True)
        subparser.add_argument("--device", required=True)

    download = subparsers.add_parser("download")
    add_common(download)
    download.set_defaults(handler=command_download)

    smoke_test = subparsers.add_parser("smoke-test")
    add_common(smoke_test)
    smoke_test.set_defaults(handler=command_smoke_test)

    transcribe = subparsers.add_parser("transcribe")
    add_common(transcribe)
    transcribe.add_argument("--audio", required=True)
    transcribe.add_argument("--language", default="auto")
    transcribe.add_argument("--prompt", default="")
    transcribe.set_defaults(handler=command_transcribe)

    args = parser.parse_args()
    args.handler(args)


if __name__ == "__main__":
    main()
