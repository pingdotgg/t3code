//! `server.listTextGeneratorModels`: the models of a saved or an unsaved text generator, with
//! an optional one-prompt test (`TextGenerators.ts`). The client's "Add text generator" wizard
//! needs it to save. `crate::text_generation` holds the service.

use conn_contract::{ListTextGeneratorModelsInput, TextGeneratorError, lit};

use super::Deps;
use crate::table::{Failure, MethodTable};

pub(super) fn register(table: &mut MethodTable, deps: &Deps) {
    let Some(generators) = deps.text_generators.clone() else {
        return;
    };
    table.unary(
        "server.listTextGeneratorModels",
        move |_, input: ListTextGeneratorModelsInput| {
            let generators = generators.clone();
            async move {
                // `TextGeneratorBaseUrl` refuses these at decode, before the handler.
                if let Some(config) = &input.config
                    && !crate::text_generation::valid_base_url(&config.base_url)
                {
                    return Err(Failure::die(
                        "invalid payload for `server.listTextGeneratorModels`: baseUrl must be an http or https URL without credentials, query or fragment",
                    ));
                }
                generators
                    .list_models(input)
                    .await
                    .map(|result| conn_contract::to_json(&result))
                    .map_err(|detail| {
                        Failure::fail(&TextGeneratorError {
                            tag: lit::TextGeneratorError,
                            detail,
                        })
                    })
            }
        },
    );
}
