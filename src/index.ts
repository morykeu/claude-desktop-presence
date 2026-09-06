/**
 * Entrypoint daemona.
 *
 * TODO (P7):
 *  - načíst config, spustit smyčku s pollIntervalMs
 *  - neodchycené výjimky nesmí shodit daemon → zalogovat a pokračovat
 *  - přepínač --debug: výpis stavu do konzole každý tick
 *  - graceful shutdown: SIGINT/SIGTERM → clearActivity + destroy + čistý exit
 *
 * Degradace (SPEC §7/1): když selžou všechny log extraktory, daemon musí dál fungovat
 * na "běží / neběží" + elapsed čas.
 */

export {};
