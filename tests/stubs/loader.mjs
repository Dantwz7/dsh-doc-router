/**
 * Node module-resolution hook that aliases the two `@deepseek-ai/*` imports to
 * local stubs, so the plugin can be loaded and driven outside the DSH host
 * module graph.
 *
 * Why stubs instead of real devDependencies: the public `latest` dist-tag of
 * `@deepseek-ai/dsh-tools` is an older build than the `next` tag that DSH
 * actually ships (0.0.1-rc.1 vs 0.2.0-rc.2 at the time of writing), so a plain
 * `npm install` would resolve the wrong version. Stubs keep `npm test` working
 * on a bare clone with no install and no network.
 *
 * Registered by `tests/stubs/register.mjs` via `node --import`.
 */
const ALIASES = new Map([
    ['@deepseek-ai/dsh-tools', './dsh-tools.mjs'],
    ['@deepseek-ai/schemastery', './schemastery.mjs'],
]);

export async function resolve(specifier, context, next) {
    const target = ALIASES.get(specifier);
    if (target !== undefined) {
        return { url: new URL(target, import.meta.url).href, shortCircuit: true };
    }
    return next(specifier, context);
}
