/**
 * Stand-in for `@deepseek-ai/dsh-tools`.
 *
 * The real `defineTool` normalizes and validates a definition; the plugin only
 * relies on it to return the definition it was handed, so identity is a
 * faithful stub for registration-level tests. Schema *validation* of the tool
 * definitions is not modelled here — the manual `tests/manual/real-api.mjs`
 * test drives the real implementation out of `app.asar` for that.
 */
export function defineTool(definition) {
    return definition;
}
