/**
 * dsh-doc-router — 文档读取路由与版面感知 PDF 提取。
 *
 * 两个工具 + 一个全局技能：
 * - `doc_route`    先判格式与版面，给出该用哪条管线的确定性结论。
 * - `pdf_markdown` PyMuPDF 版面感知转换，正确合并多栏正文（markitdown 会切碎它）。
 * - 技能 `doc-routing`  告诉模型「遇到非纯文本文件先路由」，注册进 runtime 层，
 *                       因此对**所有工作区**生效，不依赖工作区里的 skills/ 目录。
 *
 * 设计要点：
 * - 判据不依赖模型：格式看魔数，栏数看版面几何，文字层看字符数/页。
 *   多模态只留给「无文字层」和「精确核对公式」两种代码无解的情况。
 * - Python 侧脚本随包分发（lib/docprobe.py），PyMuPDF 缺失时降级而不是崩。
 * - 子进程走 execFile 且 shell:false，只有真实可执行文件会被启动。
 * - 所有注册都经 ctx.effect，重载/卸载不留残留。
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';

/** Plugin id, matching the package name. */
export const name = 'dsh-doc-router';
/** The tool registry is a hard dependency; the skills registry is optional. */
export const inject = ['tools'];
/** Configuration schema; every field is optional in `cordis.patch.yml`. */
export const Config = z.object({
    pythonPath: z.string(),
    timeoutMs: z.number().default(120_000),
    maxChars: z.number().default(120_000),
    /**
     * Language for `doc_route`'s advisory notes.
     *
     * The routing verdict itself is language-independent; only the human-readable
     * notes change. Defaults to `en`, because those notes travel with the tool
     * result and this project's primary documentation — the npm README — is
     * English. Set `zh` for Chinese notes.
     */
    noteLanguage: z.union([z.const('zh'), z.const('en')]).default('en'),
});

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE_SCRIPT = join(HERE, 'docprobe.py');

/**
 * The version of the copy that is actually loaded.
 *
 * A DSH host holds the module it loaded in its ESM cache, and a `file:` install
 * is a copy, so "which version am I running?" is genuinely hard to answer from
 * the outside — a stale copy once went unnoticed until a fix appeared to do
 * nothing. Reading the version next to this file answers it from the tool
 * output itself. Never throws: a missing or malformed manifest degrades to
 * "unknown" rather than breaking plugin load.
 */
function readOwnVersion() {
    try {
        const manifest = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));
        return typeof manifest.version === 'string' && manifest.version !== ''
            ? manifest.version
            : 'unknown';
    } catch {
        return 'unknown';
    }
}

const PLUGIN_VERSION = readOwnVersion();

const SKILL_NAME = 'doc-routing';
const SKILL_DESCRIPTION =
    'Use BEFORE reading or converting any non-text document — PDF, Word/docx, Excel/xlsx, ' +
    'PowerPoint/pptx, EPUB, RTF, CSV, HTML, or a scanned/image-only file. Routes to the right ' +
    'extraction tool per format and page layout instead of defaulting to one converter. Trigger ' +
    'whenever a task requires reading a file that is not plain text, even if the user did not ask ' +
    'for a conversion.';
const SKILL_WHEN_TO_USE =
    'A task needs the contents of a PDF, Office document, spreadsheet, presentation, ebook, or ' +
    'scanned page — especially a two- or three-column paper, where the wrong converter shreds the body text.';

const SKILL_BODY = `# 文档读取路由（doc-routing）

遇到非纯文本文件，**先路由，再读取**。不要凭习惯直接上 \`markitdown\` —— 对多栏 PDF 它会毁掉正文。

## 第一步：调 \`doc_route\` 拿判据

\`\`\`
doc_route({ path: "<文件路径>" })
\`\`\`

判据是确定性的：格式看**魔数**（不是扩展名），栏数看**版面几何**，有无文字层看**字符数/页**。
零模型、零网络，比"看着像双栏"可靠得多。

## 第二步：按 \`recommend\` 执行

| recommend | 用什么 | 为什么 |
|---|---|---|
| \`pdf_markdown\` | **\`pdf_markdown\` 工具** | 多栏正文需版面感知合并；markitdown 会切成 \`| … |\` 表格碎片 |
| \`markitdown\` / \`pypdf\` | \`markitdown\` 工具，兜底 \`pypdf\` | 单栏有文字层，两者皆可 |
| \`render_to_png + read_image\` | 渲染 PNG → \`read_image\` | 无文字层，文本提取只会给 0 字符 |
| \`read_image\` | \`read_image\` | 图片直接看图，不要先 OCR |
| \`read\` | \`read\` | 已是纯文本，**不要转换** |

Office/CSV/HTML 一律 \`markitdown\`。

## 第三步：多模态只做兜底与校验

**不要用多模态判断"这是不是多栏"** —— 那是几何问题，代码又快又准又免费；
一页 150dpi 图约 0.5MB、上千 token，还必须逐页。

只在三种情况渲染成图看：

1. **无文字层**（扫描件）—— 代码无解
2. **需精确核对公式、上下标、希腊字母、单位** —— 文本提取常丢或错，
   例：图里 \`Sr₃Al₂O₆\` 下标正确，文本提取只能给 \`Sr3Al2O6\`
3. **需理解图表 / 版式 / 图注归属**

## 硬约束

- 学术论文（Nature / Science / 物理学报）多为 **2–3 栏** → \`pdf_markdown\`
- 期刊 SI 附录、公文、报告多为 **单栏** → \`markitdown\`
- 只读内容时**不要**生成 \`.md\` 落盘；落盘只在用户要产物时
- 用户没提到的文件**不要去扫、不要批量转换**
`;

/**
 * Register the routing tools and the doc-routing skill.
 * @param ctx - the plugin context.
 * @param config - validated plugin configuration.
 */
export function apply(ctx, config) {
    const python = resolvePython(config);
    const run = (args, signal) =>
        runProbe(python, PROBE_SCRIPT, args, { timeoutMs: config.timeoutMs, signal });

    ctx.effect(
        () =>
            ctx.tools.register(
                defineTool({
                    name: 'doc_route',
                    description:
                        'Decide how to read a non-text document BEFORE converting it. Sniffs the real ' +
                        'format by magic bytes, and for PDFs measures the text layer and the page column ' +
                        'layout, then returns the recommended extraction pipeline. Use this first on any ' +
                        'PDF, Office file, or other non-text input.',
                    timeoutMs: config.timeoutMs + 60_000,
                    parameters: {
                        path: {
                            type: 'string',
                            required: true,
                            description: 'Absolute or workspace-relative path to the document.',
                        },
                    },
                    output: {
                        schema: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                path: { type: 'string', required: true },
                                format: { type: 'string', required: true },
                                recommend: { type: 'array', items: { type: 'string' }, required: true },
                                pages: { type: 'integer' },
                                text_layer: { type: 'boolean' },
                                columns: { type: 'string' },
                                column_estimate: { type: 'integer' },
                                notes: { type: 'string' },
                                probe: { type: 'string' },
                            },
                        },
                        render: (_args, value) => {
                            const bits = [`Routed ${value.path} — format: ${value.format}`];
                            if (value.pages !== undefined)
                                bits.push(`pages: ${value.pages}`);
                            if (value.text_layer !== undefined)
                                bits.push(`text layer: ${value.text_layer ? 'yes' : 'NO (scanned)'}`);
                            if (value.columns !== undefined)
                                bits.push(
                                    `columns: ${value.columns}` +
                                        (value.column_estimate !== undefined
                                            ? ` (est ${value.column_estimate})`
                                            : ''),
                                );
                            const lines = [
                                bits.join(', '),
                                `Recommended pipeline: ${value.recommend.join(' → ')}`,
                            ];
                            if (value.notes !== undefined && value.notes !== '')
                                lines.push('', value.notes);
                            if (value.probe !== undefined && value.probe !== '')
                                lines.push('', `Probe detail: ${value.probe}`);
                            // Reported here, and only here: this tool is the entry
                            // point, so it is where "which version is loaded?" gets
                            // asked. pdf_markdown must not carry it — its output is
                            // the converted document itself.
                            lines.push('', `dsh-doc-router v${PLUGIN_VERSION}`);
                            return [{ type: 'text', text: lines.join('\n') }];
                        },
                    },
                    presentCall: (args) => ({
                        card: 'generic',
                        title: `Route document: ${shortName(args.path)}`,
                        kind: 'read',
                        rawInput: args.path,
                    }),
                    async execute(args, exec) {
                        const target = await resolveInput(ctx, args.path, exec);
                        const probed = await run(
                            ['route', target, '--lang', config.noteLanguage],
                            exec.signal,
                        );
                        if (probed.error !== undefined) throw new Error(String(probed.error));

                        const result = {
                            path: args.path,
                            format: String(probed.format ?? 'unknown'),
                            recommend: Array.isArray(probed.recommend)
                                ? probed.recommend.map(String)
                                : ['markitdown'],
                        };
                        if (typeof probed.pages === 'number') result.pages = probed.pages;
                        if (typeof probed.text_layer === 'boolean')
                            result.text_layer = probed.text_layer;
                        if (typeof probed.columns === 'string') result.columns = probed.columns;
                        if (typeof probed.column_estimate === 'number')
                            result.column_estimate = probed.column_estimate;
                        if (Array.isArray(probed.notes) && probed.notes.length > 0)
                            result.notes = probed.notes.join('\n');
                        if (probed.page_profile !== undefined)
                            result.probe = JSON.stringify(probed.page_profile);
                        return result;
                    },
                }),
            ),
        'dsh-doc-router: doc_route tool',
    );

    ctx.effect(
        () =>
            ctx.tools.register(
                defineTool({
                    name: 'pdf_markdown',
                    description:
                        'Convert a PDF to Markdown with layout-aware column handling (PyMuPDF). Use this ' +
                        'for multi-column papers — where MarkItDown shreds body text into table rows — ' +
                        'and whenever document structure (headings, superscripts, italics) matters. ' +
                        'Call doc_route first if you are unsure whether the PDF is multi-column. ' +
                        'Only accepts real PDFs; other formats are rejected with the pipeline to use instead.',
                    timeoutMs: config.timeoutMs + 60_000,
                    parameters: {
                        path: {
                            type: 'string',
                            required: true,
                            description: 'Absolute or workspace-relative path to the PDF.',
                        },
                        pages: {
                            type: 'string',
                            description:
                                'Restrict to pages, e.g. "1-3" or "1,4,7". Omit for the whole document.',
                        },
                        output: {
                            type: 'string',
                            description:
                                'Write the Markdown to this path instead of returning it inline. Use for long documents.',
                        },
                    },
                    output: {
                        schema: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                path: { type: 'string', required: true },
                                chars: { type: 'integer', required: true },
                                pagesUsed: { type: 'string', required: true },
                                truncated: { type: 'boolean', required: true },
                                markdown: { type: 'string' },
                                outputPath: { type: 'string' },
                                notes: { type: 'string' },
                            },
                        },
                        render: (_args, value) => {
                            const lines = [
                                value.outputPath === undefined
                                    ? `Converted ${value.path} (${value.pagesUsed}) — ${value.chars} characters of Markdown.`
                                    : `Converted ${value.path} (${value.pagesUsed}) — wrote ${value.chars} characters to ${value.outputPath}.`,
                            ];
                            if (value.truncated) {
                                lines.push(
                                    `[Output truncated to ${config.maxChars} characters. Re-run with an "output" path to capture the whole document.]`,
                                );
                            }
                            if (value.notes !== undefined && value.notes !== '')
                                lines.push(value.notes);
                            if (value.markdown !== undefined && value.markdown !== '')
                                lines.push('', value.markdown);
                            return [{ type: 'text', text: lines.join('\n') }];
                        },
                    },
                    presentCall: (args) => ({
                        card: 'generic',
                        title: `PDF → Markdown: ${shortName(args.path)}`,
                        kind: 'read',
                        rawInput: args.path,
                    }),
                    async execute(args, exec) {
                        const target = await resolveInput(ctx, args.path, exec);
                        const probeArgs = ['markdown', target];
                        if (args.pages !== undefined && args.pages.trim() !== '') {
                            probeArgs.push('--pages', args.pages.trim());
                        }
                        const probed = await run(probeArgs, exec.signal);
                        if (probed.error !== undefined) throw new Error(String(probed.error));

                        const markdown = String(probed.markdown ?? '');
                        const result = {
                            path: args.path,
                            chars: markdown.length,
                            pagesUsed: Array.isArray(probed.pages_used)
                                ? `pages ${probed.pages_used.join(',')}`
                                : `all ${String(probed.pages_total ?? '?')} pages`,
                            truncated: false,
                        };
                        if (args.output !== undefined && args.output.trim() !== '') {
                            result.outputPath = await writeOutput(
                                ctx,
                                args.output.trim(),
                                markdown,
                                exec,
                            );
                            result.notes = `The full Markdown is on disk at ${result.outputPath}; read it with the file tools instead of converting again.`;
                        } else if (markdown.length > config.maxChars) {
                            result.truncated = true;
                            result.markdown = markdown.slice(0, config.maxChars);
                        } else {
                            result.markdown = markdown;
                        }
                        return result;
                    },
                }),
            ),
        'dsh-doc-router: pdf_markdown tool',
    );

    // The skill goes into the runtime layer, so it applies to every workspace
    // without a per-workspace skills/ directory. Registered only when the skills
    // registry is present, so the plugin still loads in a composition without it.
    const skills = ctx.get('skills');
    if (skills !== undefined) {
        ctx.effect(
            () =>
                skills.register({
                    name: SKILL_NAME,
                    description: SKILL_DESCRIPTION,
                    whenToUse: SKILL_WHEN_TO_USE,
                    source: 'runtime',
                    invocation: { modelInvocable: true, userInvocable: true },
                    content: SKILL_BODY,
                }),
            'dsh-doc-router: doc-routing skill',
        );
    }
}

/**
 * Locate a Python interpreter: explicit config, then `DOC_ROUTER_PYTHON`, then
 * the packaged DSH runtime, then whatever is on PATH. The packaged runtime is
 * the one that carries PyMuPDF/pymupdf4llm, so it is worth probing before
 * falling back.
 *
 * `DSH_HOME` and `DSH_PRIMARY_RUNTIME` are injected per shell call by
 * `dsh-shell-env`, so the host process usually has neither — the plugin's own
 * module path is the reliable anchor for the harness home.
 *
 * `DOC_ROUTER_PYTHON` exists for environments without a DSH runtime to anchor
 * on (CI, containers, a bare `npm`-installed copy), where the interpreter must
 * be named explicitly.
 *
 * An explicitly configured interpreter is returned as-is, **without an
 * existence check**, so a bare command name (`python3`) works and a typo fails
 * loudly with the path the user asked for instead of silently running a
 * different interpreter. Only auto-discovered candidates are existence-checked.
 * @param config - validated plugin configuration.
 * @returns an interpreter path or bare command name.
 */
export function resolvePython(config) {
    const names = process.platform === 'win32' ? ['python.exe'] : ['bin/python3', 'bin/python'];
    if (typeof config.pythonPath === 'string' && config.pythonPath !== '') {
        return config.pythonPath;
    }
    if (typeof process.env.DOC_ROUTER_PYTHON === 'string' && process.env.DOC_ROUTER_PYTHON !== '') {
        return process.env.DOC_ROUTER_PYTHON;
    }
    const candidates = [];
    for (const base of [process.env.DSH_PRIMARY_RUNTIME, process.env.DSH_BUNDLED_PRIMARY_RUNTIME]) {
        if (base === undefined || base === '') continue;
        for (const name of names) candidates.push(join(base, 'python', name));
    }
    for (const home of [process.env.DSH_HOME, dshHomeFromOwnPath(), join(homedir(), '.dsh')]) {
        if (home === undefined || home === '') continue;
        const runtimes = join(home, 'dsh-runtimes');
        for (const name of names) {
            candidates.push(join(runtimes, 'dsh-primary-runtime', 'dependencies', 'python', name));
        }
        // The runtime directory's name is an implementation detail; scan for it
        // so a renamed runtime does not silently downgrade to a bare `python`.
        let entries = [];
        try {
            entries = readdirSync(runtimes, { withFileTypes: true });
        } catch {
            entries = [];
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            for (const name of names) {
                candidates.push(join(runtimes, entry.name, 'dependencies', 'python', name));
            }
        }
    }
    for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate;
    }
    return process.platform === 'win32' ? 'python' : 'python3';
}

/**
 * Derive `$DSH_HOME` from this plugin's own location: a profile-installed
 * package lives at `$DSH_HOME/profiles/<name>/node_modules/<pkg>/lib`, so the
 * `profiles` ancestor's parent is the harness home.
 * @returns the harness home, or undefined when the layout is unfamiliar.
 */
export function dshHomeFromOwnPath() {
    let dir = HERE;
    for (let i = 0; i < 8; i += 1) {
        const parent = dirname(dir);
        if (parent === dir) break;
        if (basename(dir) === 'profiles') return parent;
        dir = parent;
    }
    return undefined;
}

/**
 * Run docprobe.py and parse its JSON answer.
 * @param python - interpreter to launch.
 * @param script - absolute path to docprobe.py.
 * @param args - mode and arguments.
 * @param options - timeout and cancellation.
 * @returns the parsed JSON object, including a possible `error` field.
 */
function runProbe(python, script, args, options) {
    return new Promise((resolve, reject) => {
        execFile(
            python,
            [script, ...args],
            {
                timeout: options.timeoutMs,
                signal: options.signal,
                maxBuffer: 64 * 1024 * 1024,
                windowsHide: true,
                // Without this, a Windows console code page can mangle the
                // Chinese notes and any non-ASCII document text.
                env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
            },
            (error, stdout, stderr) => {
                const text = String(stdout ?? '').trim();
                if (text !== '') {
                    try {
                        resolve(JSON.parse(text));
                        return;
                    } catch {
                        // fall through to the transport error below
                    }
                }
                // stderr carries the real reason (missing interpreter, missing
                // PyMuPDF, an import error), so surface it rather than only
                // execFile's bare "Command failed".
                const detail = [String(stderr ?? '').trim(), text]
                    .filter((part) => part !== '')
                    .join(' | ')
                    .slice(0, 600);
                if (error !== null) {
                    reject(
                        new Error(
                            `docprobe failed via "${python}": ${error.message}` +
                                (detail === '' ? '' : ` — ${detail}`),
                        ),
                    );
                    return;
                }
                reject(new Error(`docprobe returned no JSON via "${python}"`));
            },
        );
    });
}

/**
 * Resolve a caller path against the session workspace, like the built-in file
 * tools, and prove it is a regular file before spawning anything.
 * @param ctx - plugin context, for the filesystem seam.
 * @param raw - the caller's path.
 * @param exec - tool execution context (cwd + signal).
 * @returns the absolute process path.
 */
async function resolveInput(ctx, raw, exec) {
    const trimmed = raw.trim();
    if (trimmed === '') throw new Error('path is empty');
    const cwd = exec.agent?.session.header.cwd;
    const fs = ctx.get('fs');
    if (fs !== undefined) {
        const opts = cwd === undefined ? { signal: exec.signal } : { cwd, signal: exec.signal };
        const target = await fs.resolve(expandHome(trimmed), opts);
        const processPath = fs.processPath(target);
        const info = await fs.stat(target, exec.signal);
        if (info === undefined) throw new Error(`path not found: ${processPath}`);
        if (info.type === 'directory')
            throw new Error(`path is a directory, not a file: ${processPath}`);
        if (info.type !== 'file')
            throw new Error(`path is not a regular file: ${processPath}`);
        return processPath;
    }
    const expanded = expandHome(trimmed);
    const absolute = isAbsolute(expanded)
        ? expanded
        : resolvePath(cwd ?? process.cwd(), expanded);
    if (!existsSync(absolute)) throw new Error(`path not found: ${absolute}`);
    // Without the fs seam there is no stat to consult, and a directory would
    // otherwise reach the probe and come back as a bare PermissionError.
    if (statSync(absolute).isDirectory()) {
        throw new Error(`path is a directory, not a file: ${absolute}`);
    }
    return absolute;
}

/**
 * Write the Markdown, preferring the filesystem seam so the session sandbox
 * policy applies. Mirrors `dsh-tool-fs` and `dsh-markitdown`.
 * @param ctx - plugin context.
 * @param rawOutput - the caller's output path.
 * @param markdown - content to write.
 * @param exec - tool execution context.
 * @returns the process path written.
 */
async function writeOutput(ctx, rawOutput, markdown, exec) {
    const fs = ctx.get('fs');
    if (fs !== undefined) {
        const sandbox = ctx.get('sandboxPolicy');
        const policy = sandbox?.resolve(
            exec.agent?.session === undefined ? undefined : { session: exec.agent.session },
        );
        const target = await fs.resolve(expandHome(rawOutput), {
            ...(policy?.workspaceRoot === undefined ? {} : { cwd: policy.workspaceRoot }),
            signal: exec.signal,
        });
        // Observe an existing file first: an unobserved write becomes a
        // create-if-absent intent, which would fail on a real file.
        const info = await fs.stat(target, exec.signal);
        if (info !== undefined) {
            try {
                await fs.readText(target, exec.signal);
            } catch {
                // Unreadable (binary or oversized) — let the guarded write report it.
            }
        }
        await fs.writeText(target, markdown, undefined, exec.signal, policy);
        return fs.processPath(target);
    }
    const expanded = expandHome(rawOutput);
    const absolute = isAbsolute(expanded) ? expanded : resolvePath(process.cwd(), expanded);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, markdown, 'utf8');
    return absolute;
}

function expandHome(path) {
    if (path === '~') return process.env.HOME ?? process.env.USERPROFILE ?? path;
    if (path.startsWith('~/') || path.startsWith('~\\')) {
        const home = process.env.HOME ?? process.env.USERPROFILE;
        if (home !== undefined) return resolvePath(home, path.slice(2));
    }
    return path;
}

function shortName(input) {
    const trimmed = String(input ?? '').trim();
    const parts = trimmed.split(/[\\/]/);
    return parts[parts.length - 1] || trimmed;
}
