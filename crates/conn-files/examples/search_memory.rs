//! Runs one listing, one path search and one content search over a folder, for measuring what
//! they cost: `/usr/bin/time -l cargo run --release -p conn-files --example search_memory -- <dir>`.

use std::{path::PathBuf, time::Instant};

use conn_contract::{ProjectSearchContentsInput, ProjectSearchEntriesInput};
use conn_files::{entries, search};

fn main() {
    let Some(root) = std::env::args().nth(1).map(PathBuf::from) else {
        eprintln!("usage: search_memory <dir>");
        std::process::exit(2);
    };
    let started = Instant::now();
    let listed = entries::list_all(&root);
    println!(
        "listEntries: {} entries, truncated {}, {:?}",
        listed.entries.len(),
        listed.truncated,
        started.elapsed()
    );
    drop(listed);
    let started = Instant::now();
    let found = search::search_entries(
        &root,
        &ProjectSearchEntriesInput {
            cwd: String::new(),
            query: "server".into(),
            limit: 80,
            kind: None,
            image_only: None,
        },
    );
    println!(
        "searchEntries: {} entries, {:?}",
        found.entries.len(),
        started.elapsed()
    );
    let started = Instant::now();
    let grep = search::search_contents(
        &root,
        &ProjectSearchContentsInput {
            cwd: String::new(),
            query: "spawn_blocking".into(),
            limit: 500,
            case_sensitive: false,
            whole_word: false,
            use_regex: false,
        },
    );
    println!(
        "searchContents: {} matches, truncated {}, {:?}",
        grep.matches.len(),
        grep.truncated,
        started.elapsed()
    );
}
