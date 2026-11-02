use axum::{extract::State, routing::get, Json, Router};

use crate::{
    diagnostics::{DiagnosticsSnapshot, DiagnosticsState},
    legacy,
};

async fn health() -> &'static str {
    "ok"
}

async fn get_diagnostics(State(state): State<DiagnosticsState>) -> Json<DiagnosticsSnapshot> {
    Json(state.snapshot())
}

pub fn router(diagnostics: DiagnosticsState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/diagnostics", get(get_diagnostics))
        .route("/v1/momentum/diagnostics", get(get_diagnostics))
        .with_state(diagnostics)
        .merge(legacy::router())
}
