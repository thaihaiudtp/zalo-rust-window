//! Errors shared by the Olaz host.

/// Result alias for Olaz host operations.
pub type Result<T> = std::result::Result<T, Error>;

/// Everything that can go wrong while locating, verifying or reading the
/// official Zalo runtime.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("invalid ASAR archive: {0}")]
    Asar(String),

    #[error("ASAR entry not found: {0}")]
    AsarEntryNotFound(String),

    #[error("ASAR entry is unpacked but {0} is missing")]
    AsarUnpackedMissing(String),

    #[error("invalid JSON: {0}")]
    Json(#[from] serde_json::Error),

    #[error("NSIS error: {0}")]
    Nsis(String),

    #[error("7z error: {0}")]
    SevenZ(String),

    #[error("runtime not found; install Zalo PC {expected} or let Olaz download it")]
    RuntimeNotFound { expected: String },

    #[error("runtime is incomplete: {0}")]
    IncompleteRuntime(String),

    #[error("unexpected file size for {path}: expected {expected} bytes, got {actual}")]
    SizeMismatch {
        path: String,
        expected: u64,
        actual: u64,
    },

    #[error("SHA-256 mismatch for {path}: expected {expected}, got {actual}")]
    HashMismatch {
        path: String,
        expected: String,
        actual: String,
    },

    #[error("{0}")]
    Message(String),
}

impl From<nsis::Error> for Error {
    fn from(error: nsis::Error) -> Self {
        Self::Nsis(error.to_string())
    }
}

impl From<sevenz_rust2::Error> for Error {
    fn from(error: sevenz_rust2::Error) -> Self {
        Self::SevenZ(error.to_string())
    }
}

impl Error {
    pub(crate) fn message(text: impl Into<String>) -> Self {
        Self::Message(text.into())
    }
}
