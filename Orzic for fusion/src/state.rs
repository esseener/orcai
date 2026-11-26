use crate::agents::omp;
use crate::connectors;
use crate::{acceptance, route};
use serde_json::json;

pub fn build(force_models: bool) -> serde_json::Value {
    let models = omp::list_models(force_models).unwrap_or_default();
    json!({
        "omp": omp::read_status(),
        "models": models,
        "connectors": connectors::list_all(),
        "acceptance": {
            "cwd": route::latest_cwd(),
            "last": acceptance::last(),
            "auto": acceptance::auto_settings_all(),
        },
    })
}
