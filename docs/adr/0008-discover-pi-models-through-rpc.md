# Discover Pi models through RPC

T3 Code will query each Pi runtime instance through `get_available_models`, show its configured models in the standard picker, switch models through `set_model`, and expose only the thinking levels Pi reports for the selected model. This keeps Pi's provider and model configuration authoritative while allowing custom Pi models to work without duplicate T3 configuration.
