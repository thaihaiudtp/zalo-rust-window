//! The pinned official Zalo PC runtime.

use serde::{Deserialize, Serialize};

/// Zalo PC version this build is tested with.
pub const RUNTIME_VERSION: &str = "26.11.11";

/// Official installer for [`RUNTIME_VERSION`].
pub const INSTALLER_URL: &str =
    "https://res-download-pc.zadn.vn/win/ZaloSetup-26.11.11.exe";

/// SHA-256 of the official installer above.
pub const INSTALLER_SHA256: &str =
    "65ccc7667d2da32a8eaea8cb26b793573455bed9e61e893cf699a52236831c9f";

/// SHA-256 of the `resources/app.asar` inside that installer.
pub const ASAR_SHA256: &str =
    "8e09095fe0dd476f2023702d7fef9dddcddfe1ddffca4bae9956ecf43cb874b0";

/// Size of that `app.asar` in bytes.
pub const ASAR_SIZE: u64 = 181_103_530;

/// Client version the official main process reports (`getClientVersion`).
pub const CLIENT_VERSION: &str = "696";

/// Electron client type (`ZaloPC-<platform>-<type>v<version>`).
pub const CLIENT_TYPE: &str = "24";

/// Platform token used in the official User-Agent.
pub const CLIENT_PLATFORM: &str = "win32";

/// `ZaloPC-win32-24v696`, exactly as the official Windows client sends it.
pub fn user_agent() -> String {
    format!("ZaloPC-{CLIENT_PLATFORM}-{CLIENT_TYPE}v{CLIENT_VERSION}")
}

/// What a verified runtime directory contains.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeManifest {
    /// Zalo PC release, e.g. `26.11.11`.
    pub version: String,
    /// API client version (`696`), used in the User-Agent and page query.
    pub client_version: String,
    /// Electron client type (`24`).
    pub client_type: String,
    /// SHA-256 of `app.asar`.
    pub asar_sha256: String,
    /// Size of `app.asar` in bytes.
    pub asar_size: u64,
    /// Unix milliseconds when the runtime was installed.
    pub installed_at_ms: u64,
}

impl RuntimeManifest {
    /// Manifest for the pinned Windows release.
    pub fn pinned() -> Self {
        Self {
            version: RUNTIME_VERSION.to_string(),
            client_version: CLIENT_VERSION.to_string(),
            client_type: CLIENT_TYPE.to_string(),
            asar_sha256: ASAR_SHA256.to_string(),
            asar_size: ASAR_SIZE,
            installed_at_ms: now_ms(),
        }
    }

    /// User-Agent this runtime reports.
    pub fn user_agent(&self) -> String {
        format!(
            "ZaloPC-{}-{}v{}",
            CLIENT_PLATFORM, self.client_type, self.client_version
        )
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_agent_matches_windows_client() {
        assert_eq!(user_agent(), "ZaloPC-win32-24v696");
        assert_eq!(RuntimeManifest::pinned().user_agent(), user_agent());
    }
}
