//! Core services shared by the Olaz host.
//!
//! This crate deliberately has no WebView2 dependency: everything here can be
//! tested on any platform, which matters because the Windows host is the only
//! place the renderer itself can run.

pub mod asar;
pub mod error;
pub mod runtime;

pub use asar::AsarArchive;
pub use error::{Error, Result};
pub use runtime::Runtime;

/// Crate version, shown in diagnostics.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
