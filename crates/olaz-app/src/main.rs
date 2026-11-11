//! Normal executable entry point.

#![cfg_attr(all(not(debug_assertions), windows), windows_subsystem = "windows")]

fn main() -> anyhow::Result<()> {
    olaz_app::run()
}
