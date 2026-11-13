use std::{net::SocketAddr, sync::Arc};

use conn_server::{method_table, methods::Deps, router};

/// Usage: `conn-server [--listen <addr>]`. Default `127.0.0.1:0` picks a free port.
fn main() {
    let mut args = std::env::args().skip(1);
    let mut listen: SocketAddr = "127.0.0.1:0".parse().expect("valid default address");
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--listen" => {
                let value = args.next().expect("--listen needs an address");
                listen = value.parse().expect("--listen takes host:port");
            }
            other => panic!("unknown argument `{other}`"),
        }
    }

    // One thread: a container serves a handful of clients, and each worker thread costs
    // stack and allocator arenas.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    runtime.block_on(async move {
        let table = Arc::new(method_table(&Deps::default()));
        let listener = tokio::net::TcpListener::bind(listen).await.expect("bind");
        let addr = listener.local_addr().expect("local addr");
        println!("conn-server listening on http://{addr}");
        println!("methods: {}", table.coverage());
        axum::serve(listener, router(table)).await.expect("serve");
    });
}
