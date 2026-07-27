// Release builds attach to the Windows GUI subsystem so launching the app
// from Explorer never flashes a console window. Debug builds keep the console
// so `tauri dev` can print logs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    sergecode_windows_lib::run()
}
