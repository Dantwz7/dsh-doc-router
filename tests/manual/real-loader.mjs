/**
 * Node module-resolution hook that maps the plugin's bare `@deepseek-ai/*`
 * imports to the **real** packages inside the DSH `app.asar`, instead of the
 * local stubs used by `npm test`.
 *
 * This is the one load-time surface the stub tests cannot cover: if the real
 * `defineTool` or the real schemastery rejects our definitions, it throws here —
 * exactly as it would during a cold DSH start.
 *
 * Requires Electron-as-node, because only that runtime can read inside an asar
 * archive. See tests/manual/README.md.
 *
 * Override the default location with `DSH_ASAR_DSH_ROOT` when DSH is installed
 * somewhere other than the default Windows path.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const ASAR_DSH_ROOT =
    process.env.DSH_ASAR_DSH_ROOT ?? 'D:/1/Deepseek Harness/resources/app.asar/dsh/';

const require = createRequire(ASAR_DSH_ROOT);

const REAL = new Map();
for (const name of [
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/schemastery',
    '@deepseek-ai/cordis',
]) {
    try {
        REAL.set(name, pathToFileURL(require.resolve(name)).href);
    } catch (error) {
        console.error(`[real-loader] could not resolve ${name}: ${error.message}`);
    }
}

if (REAL.size === 0) {
    console.error(
        `[real-loader] nothing resolved under ${ASAR_DSH_ROOT}.\n` +
            '[real-loader] Set DSH_ASAR_DSH_ROOT to <install>/resources/app.asar/dsh/',
    );
}

export async function resolve(specifier, context, next) {
    const mapped = REAL.get(specifier);
    if (mapped !== undefined) return { url: mapped, shortCircuit: true };
    return next(specifier, context);
}
