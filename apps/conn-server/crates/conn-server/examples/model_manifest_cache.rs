//! Prints the `model-manifest.json` text this server writes for a fetched manifest, for
//! `tools/model-manifest-diff.mjs`: `model_manifest_cache <manifest.json> <fetchedAtMs>`.
//! Exits 1 when the manifest does not decode as T3's schema.

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (Some(path), Some(fetched_at)) = (args.first(), args.get(1)) else {
        eprintln!("usage: model_manifest_cache <manifest.json> <fetchedAtMs>");
        std::process::exit(2);
    };
    let Ok(fetched_at) = fetched_at.parse::<i64>() else {
        eprintln!("fetchedAtMs is not a whole number");
        std::process::exit(2);
    };
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) => {
            eprintln!("{path}: {error}");
            std::process::exit(2);
        }
    };
    let decoded = conn_server::model_manifest::decode_manifest_text(&text);
    let compact = conn_server::model_manifest::compact_json(&text);
    match (decoded, compact) {
        (Some(_), Some(compact)) => print!(
            "{}",
            conn_server::model_manifest::cache_text(fetched_at, &compact)
        ),
        _ => {
            eprintln!("{path} does not decode as a model manifest");
            std::process::exit(1);
        }
    }
}
