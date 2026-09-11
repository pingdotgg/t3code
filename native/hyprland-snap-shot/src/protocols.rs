// Official BSD-3-Clause protocol definitions are bundled beside the executable.
macro_rules! protocol {
    ($name:ident, $file:literal) => {
        #[allow(unused_imports, dead_code, non_camel_case_types, non_snake_case)]
        pub mod $name {
            use wayland_client;
            use wayland_client::protocol::*;
            use wayland_protocols::ext::foreign_toplevel_list::v1::client::*;
            use wayland_protocols_wlr::foreign_toplevel::v1::client::*;
            pub mod __interfaces {
                use wayland_client::protocol::__interfaces::*;
                use wayland_protocols::ext::foreign_toplevel_list::v1::client::__interfaces::*;
                use wayland_protocols_wlr::foreign_toplevel::v1::client::__interfaces::*;
                wayland_scanner::generate_interfaces!($file);
            }
            use self::__interfaces::*;
            wayland_scanner::generate_client_code!($file);
            #[cfg(test)]
            pub mod server {
                use wayland_protocols::ext::foreign_toplevel_list::v1::server::*;
                use wayland_protocols_wlr::foreign_toplevel::v1::server::*;
                use wayland_server;
                use wayland_server::protocol::*;
                pub mod __interfaces {
                    use wayland_protocols::ext::foreign_toplevel_list::v1::server::__interfaces::*;
                    use wayland_protocols_wlr::foreign_toplevel::v1::server::__interfaces::*;
                    use wayland_server::protocol::__interfaces::*;
                    wayland_scanner::generate_interfaces!($file);
                }
                use self::__interfaces::*;
                wayland_scanner::generate_server_code!($file);
            }
        }
    };
}
protocol!(export, "protocols/hyprland-toplevel-export-v1.xml");
protocol!(mapping, "protocols/hyprland-toplevel-mapping-v1.xml");
