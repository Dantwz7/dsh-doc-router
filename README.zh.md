# dsh-doc-router

[![npm](https://img.shields.io/npm/v/dsh-doc-router.svg)](https://www.npmjs.com/package/dsh-doc-router)
[![CI](https://github.com/Dantwz7/dsh-doc-router/actions/workflows/ci.yml/badge.svg)](https://github.com/Dantwz7/dsh-doc-router/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#许可证)
[![node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen.svg)](package.json)

[English](https://github.com/Dantwz7/dsh-doc-router/blob/main/README.md) | 中文

> **先路由，再读取。** 一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
> 插件：先探明文件的**真实格式**与 PDF 的**页面版面**，再把它交给该用的那条管线；
> 对多栏论文做版面感知转换，而不是把正文切碎。

[为什么](#为什么需要它) · [提供什么](#提供什么) · [安装](#安装) · [快速开始](#快速开始) · [路由是怎么判的](#路由是怎么判的) · [配置](#配置) · [实测证据](#实测证据) · [故障排查](#故障排查) · [开发](#开发) · [路线图](#路线图) · [许可证](#许可证)

---

## 为什么需要它

默认转换器会把多栏论文做错，而且错得不轻。以一篇 Nature Letter
（`nmat4749.pdf`，双栏，7 页）为例，在 PyMuPDF 1.28.2 / MarkItDown 0.2.0 下实测：

| 管线 | 输出 | 多栏处理 |
|---|---|---|
| `pymupdf4llm`（版面感知） | 第 1 页 **6 533** 字符 | ✅ 两栏按阅读顺序合并；标题→`#`、上标→`<sup>`、`_in situ_` 斜体全部保留 |
| `pypdf` | 全 7 页 30 632 字符 | ⚠️ 正文可读，但**结构全丢** |
| MarkItDown | 全 7 页 45 266 字符 | ❌ 正文碎成数百行 `\| … \|` 表格 |

同一失败**可以在 clone 后自己复现**。用本仓库的
[`two-column-reading-order.pdf`](https://github.com/Dantwz7/dsh-doc-router/blob/main/tests/fixtures/two-column-reading-order.pdf)
与 [`three-column.pdf`](https://github.com/Dantwz7/dsh-doc-router/blob/main/tests/fixtures/three-column.pdf)
（两栏 / 三栏内容各自带标记的合成页），MarkItDown 0.1.5 会把**每一栏同时**竖着读下去：

| 夹具 | `pdf_markdown` | MarkItDown 0.1.5 |
|---|---|---|
| `two-column-reading-order.pdf` | `L01…L15`，然后 `R01…R15` | `L01 R01 L02 R02 …` —— **29 次跨栏跳变** |
| `three-column.pdf` | `L01…L15`、`M01…M15`，然后 `R01…R15` | `L01 M01 R01 L02 …` —— **44 次跨栏跳变** |

整个论点就这一行：一条管线保住了栏，另一条把它们交错在一起。
`npm test` 断言的是上表两个 `pdf_markdown` 单元格里的阅读顺序。

所以让模型「随便挑个转换器」的后果，是拿到一份被悄悄弄坏的原文，而且**看起来像是成功了**。
解法不是找一个更好的转换器，而是**路由**：先看文件，再选管线。

## 提供什么

| 产物 | 作用 |
|---|---|
| **`doc_route` 工具** | 判类并给出该用的管线：格式、页数、有无文字层、单栏/多栏，以及判据背后的逐页证据 |
| **`pdf_markdown` 工具** | 用 PyMuPDF 做版面感知的 PDF→Markdown；支持页码区间与落盘 |
| **`doc-routing` 技能** | 注册进 **runtime** 技能层，因此对**所有工作区**生效，不依赖工作区里的 `skills/` 目录；它告诉模型「读之前先路由」 |

所有判据都是**确定性的**：零模型调用、零网络、零 token。

## 安装

### 版本要求

| | |
|---|---|
| **DSH** | `>=0.2.0-rc.1 <0.3.0-0` |
| **Node** | `^22.19.0 || >=24.0.0` |
| **Python** | 3.9+ —— 只有 PDF 版面探测与 `pdf_markdown` 需要 |
| **PyMuPDF** | `pip install pymupdf4llm` —— **可选**，见[许可证](#许可证) |

解释器查找顺序，命中即止：

1. `config.pythonPath`
2. 环境变量 `DOC_ROUTER_PYTHON`
3. DSH 打包的运行时
4. `~/.dsh/dsh-runtimes` 下的运行时
5. `PATH` 上的 `python`

显式指定的解释器**原样采用**，所以裸命令名（如 `python3`）也能用；
而写错路径时，报错会**明确报出你指定的那个路径**，不会变成一个谜。

### 从 npm 安装（推荐）

```bash
plugin_manager action=install_bundle target="dsh-doc-router@0.6.0"
```

**请写精确版本。** DSH 的包管理器有最小发布年龄策略，只写包名可能悄悄解析到旧版本。
装完请重启 DSH。

### 从 DSH 命令行安装

```bash
dsh plugin --profile <你的 profile> add dsh-doc-router@0.6.0
```

`<你的 profile>` 必须是 DSH **实际启动**的那个。拿不准就用上面的 `plugin_manager`，
它会自动作用于当前 profile。这个子命令有两个反直觉之处：

- **`--profile` 写错不会报错，而是新建一个。** 该名字会被初始化成一个全新的空
  profile，包装进那里，于是插件永远到不了你正在跑的那个 profile。当前 profile 就是
  `$DSH_HOME/profiles` 下那个 `package.json` 里列着你的插件的目录。
- **`--help` 不是空跑。** `dsh plugin --profile <名字> --help` 会先把那个 profile
  初始化出来，再打印 pnpm 的帮助。

### 从本地源码目录安装

```bash
plugin_manager action=install_bundle target="file:<仓库绝对路径>"
```

`file:` 安装是**拷贝**，所以**改源码不会生效**：必须升版本号 → 移除 bundle →
重装 → **重启 DSH**。详见
[CONTRIBUTING.md](https://github.com/Dantwz7/dsh-doc-router/blob/main/CONTRIBUTING.md#5-testing-against-a-real-dsh-install)。

### 启用版面探测

```bash
<插件解析到的 python> -m pip install pymupdf4llm
```

没有 PyMuPDF 时插件**照常加载**，`doc_route` 仍能按格式判类；
只有版面探测与 `pdf_markdown` 会停用，并且两者都会明确说明原因，而不是含糊地失败。

## 快速开始

先路由，再转换。下面的例子全部取自本仓库自带的合成夹具，因此**每一行都可以在 clone 后复现**。

### 1. 先路由

```text
doc_route({ path: "tests/fixtures/two-column.pdf" })

→ Routed tests/fixtures/two-column.pdf — format: pdf, pages: 1, text layer: yes, columns: multi-column (est 2)
  Recommended pipeline: pdf_markdown

  多栏正文（估 2 栏）→ markitdown 会把正文切成表格碎片，pypdf 会丢结构
  需精确核对公式/上下标/数字时，再对该页渲染成图校验

  Probe detail: {"1":"0.91/2col"}

  dsh-doc-router v0.6.0
```

> 上面两行提示语是中文，因为这一段是在 `noteLanguage: 'zh'` 下跑的。**`0.4.0` 起
> 默认是英文**——见[配置](#配置)。判据行、`recommend`、`probe` 三个字段与语言无关。

### 2. 再转换

```text
pdf_markdown({ path: "tests/fixtures/two-column.pdf" })

→ Converted tests/fixtures/two-column.pdf (all 1 pages) — 3391 characters of Markdown. …

pdf_markdown({ path: "tests/fixtures/two-column.pdf", pages: "1", output: "paper.md" })

→ Converted tests/fixtures/two-column.pdf (pages 1) — wrote 3391 characters to paper.md.
```

两个工具都接受**相对工作区**的路径。当内联输出会超过 `maxChars` 时，
`pdf_markdown` 会截断并**明确告知**，而不是灌爆上下文——要完整文档就传 `output` 落盘。

### 真实判据（来自本仓库的夹具）

下表每一行都是在仓库自带的夹具上跑 `doc_route` 得到的：

| 夹具 | 判据 | 管线 |
|---|---|---|
| `two-column.pdf` | pdf · 1 页 · 有文字层 · **多栏（估 2 栏）** | `pdf_markdown` |
| `three-column.pdf` | pdf · 1 页 · 有文字层 · **多栏（估 3 栏）** | `pdf_markdown` |
| `two-column-watermark.pdf` | pdf · 1 页 · 有文字层 · **多栏（估 2 栏——不是 3）** | `pdf_markdown` |
| `unknown-columns.pdf` | pdf · 3 页 · 有文字层 · **unknown** | `pdf_markdown`（安全侧） |
| `dense-script-column.pdf` | pdf · 1 页 · 有文字层 · **多栏（估 2 栏）** | `pdf_markdown` |
| `single-column.pdf` | pdf · 1 页 · 有文字层 · 单栏 | `markitdown` → `pypdf` |
| `scanned.pdf` | pdf · 1 页 · **无文字层** | `render_to_png` → `read_image` |
| `sample.docx` | docx | `markitdown` |
| `sample.png` | png | `read_image` |
| `sample.txt` | text | `read` |

`pdf_markdown` 会拒绝非 PDF，并直接告诉你该用哪条管线：

```text
pdf_markdown({ path: "tests/fixtures/sample.docx" })
→ pdf_markdown only converts PDFs — detected docx. Recommended pipeline: markitdown
  (run doc_route for the full verdict)
```

> [!NOTE]
> **关于提示语的语言。** 判据行、`recommend`、`probe` 三个字段与语言无关。
> 所有**给人或给模型看的文本**都由 [`noteLanguage`](#配置) 选择：判据之后的
> 自由文本提示语、`pdf_markdown` 的拒绝信息、以及 `doc-routing` 技能正文。
> **`0.4.0` 起默认 `en`**，`zh` 保持旧行为。

## 路由是怎么判的

所有判据都是**确定性的**：零模型调用、零网络、零 token。

| 判断 | 依据 |
|---|---|
| 格式 | 文件头**魔数**，从不看扩展名。ZIP 容器会进内部看目录结构，区分 docx / xlsx / pptx / epub / odt；识别带/不带 BOM 的 **UTF-16/UTF-32 纯文本**，并以控制字符比例作护栏，避免把二进制误判为文本 |
| 有无文字层 | 字符数/页 < **120** → 视为扫描件 |
| 单栏/多栏 | 逐条横带合并文本区间，数被「内部空白」隔开的段数；**任一正文页多栏即判多栏**。边缘块（出版商的竖排水印、页眉页脚）不计入：它们虽窄，却纵贯整页，会落进每一条横带 |

最后一条是刻意的不对称下注：`pymupdf4llm` 对单栏同样适用，而漏判会把多栏交给
会毁掉正文的转换器。一种误判很便宜，另一种不是。

同一个下注也决定了**测不出栏数**时怎么办——某页正文只有一个大块、或全是短到不成正文的
碎片，就给不出可用的横带证据。这种判定如实报为 `unknown`，并路由到 `pdf_markdown`，
**绝不**被说成单栏：猜「单栏」是昂贵的方向，测不准的文件走便宜的那条。

「短到不成正文」是按**内容量**而不是**码点数**量的。只有短于 25 个*拉丁等数码点*的块
才会被丢掉，其中**一个汉字算两个**——因为一个中文词是 1-2 个字，而一个英文词约 5 个字母。
若按码点数直接计，这个过滤在中文 PDF 上会**成倍地更激进**，可能把整整一栏正文丢掉；
详见
[`dense-script-column.pdf`](https://github.com/Dantwz7/dsh-doc-router/blob/main/tests/fixtures/README.md#dense-script-columnpdf-the-filters-unit-not-just-its-value)。

### 判据给出的路由

| 判据 | 管线 |
|---|---|
| 多栏 + 有文字层 | `pdf_markdown` |
| 单栏 + 有文字层 | `markitdown`（兜底 `pypdf`） |
| 栏数测不出（`unknown`）+ 有文字层 | `pdf_markdown`，安全侧 |
| 无文字层 | 渲染 PNG → `read_image` |
| docx / xlsx / pptx / epub / odt / csv / html / json / xml | `markitdown` |
| 图片 | `read_image` |
| 文本 / rtf | `read`，完全不转换 |

<details>
<summary><b>为什么多模态不参与常规路径</b></summary>

格式与栏数是**几何问题**。代码又快又准又免费；而一页 150dpi 图约 0.5MB、
上千 token，还必须逐页渲染。所以图像只留给代码无解的三件事：

1. **无文字层**（扫描件）；
2. **精确核对公式、上下标、希腊字母、单位**——文本提取在这些地方错得要紧
   （图里 `Sr₃Al₂O₆` 下标正确，文本提取只能给 `Sr3Al2O6`）；
3. **理解图表、版式，或判断图注归属**。

</details>

<details>
<summary><b>三个容易退回的路由缺陷</b></summary>

1. 「数左右各多少文本块」→ Nature 首页左栏只有 2 块，误判单栏。改为逐行找栏沟。
2. 「只找页面中部那一条沟」→ 3 栏版面（Science）中间是正文列，漏判。改为数栏数。
3. 「多页取多数」→ Science 参考文献页单栏 + 图页平票，倒向单栏。改为「任一页多栏即多栏」，
   并排除 <300 字符的纯图页。

另有两个缺陷由一次真实语料试用发现，在 `0.2.1` 修复；两者都有回归测试，
经过写在 [CHANGELOG.md](CHANGELOG.md) 里：

4. 出版商的竖排水印（窄而纵贯整页）被算作额外一栏，使双栏论文报成**三**栏——
   74 份语料里命中 **18** 份。
5. `columns: unknown` 与 `single-column` 共用分支，被路由到 `markitdown`，
   而提示语断言「单栏」。这是插件**唯一一处**与自身「不对称下注」相矛盾的地方。

</details>

## 配置

所有字段均可选。

| 字段 | 默认值 | 作用 |
|---|---|---|
| `pythonPath` | *（未设置）* | 要启动的解释器，原样采用——优先级最高 |
| `timeoutMs` | `120000` | 探测超时（毫秒） |
| `maxChars` | `120000` | 内联 Markdown 上限；超出时 `pdf_markdown` 会截断并明确告知 |
| `noteLanguage` | `en` | 所有给人/给模型看的文本的语言——提示语、`pdf_markdown` 拒绝信息、技能正文：`en` 或 `zh` |

下面是由 [`cordis.patch.yml`](cordis.patch.yml) 插入的 `doc-router`
条目的 `config` 块：

```yaml
- insert:
    - id: doc-router
      name: dsh-doc-router
      config:
        pythonPath: C:\path\to\python.exe   # 可选；优先级最高的解释器
        timeoutMs: 120000                    # 可选；探测超时（毫秒）
        maxChars: 120000                     # 可选；内联 Markdown 上限
        noteLanguage: en                     # 可选；'en'（默认）或 'zh'
```

`noteLanguage` 只影响给人/给模型看的文本。判据、`recommend`、`probe` 三个字段与语言无关，
两种语言下的路由结果完全一致。

## 实测证据

路由规则在**真实语料 71 篇已发表 PDF + 1 个 DOCX**（ACS / Wiley / Science / Nature /
Sci. Adv. / arXiv，2–83 页，含中文目录与文件名）上跑过：

| 检查项 | 结果 |
|---|---|
| 路由文件数 | 72 |
| 判为多栏 | **47 篇——逐篇肉眼核对全部确为多栏，0 例漏判** |
| 判为单栏 | 22 篇——无一例其实是多栏 |
| 栏数高估 | 18 例 → **`0.2.1` 已修** |
| `unknown` 版面 | 2 例 → **`0.2.1` 已改走安全侧** |
| 「成功但结果是垃圾」 | **0 例** |
| 短块过滤修复改动的判据数 | **71 篇中 0 篇**（全语料修复前后各跑一遍） |
| 阈值单位（拉丁等数码点）修复改动的判据数 | **71 篇中 0 篇**；含 26 篇中文文档的更大目录树 121 篇中 **1 篇**（一张单页图，已渲染核对） |

47 篇里有 1 篇是真正的**三栏** Science 论文（三个等宽 164pt 栏，摘要横跨前两栏），
所以 `est 3` 这条分支有真实输入在跑，不只是合成夹具。

同一页 Science 论文，两条路径对比：

| | `pdf_markdown` | MarkItDown |
|---|---|---|
| 字符数 | 5 959 | 11 987 |
| `\| --- \|` 表格分隔线 | **0** | 24 |
| 词间空格丢失 | **0** | 36（如 `constants.Theresultantcoherentgrowthof`） |

| 开销与可靠性（同一语料） | 实测 |
|---|---|
| `doc_route`，单文件 | 约 0.4 秒 |
| `pdf_markdown`，普通论文 | 约 7.7 秒 |
| `pdf_markdown`，83 页论文 | 约 29.7 秒 |
| 路径失败——**非 ASCII 路径**上 72 次路由 + 44 次转换 | **0 例** |

> [!NOTE]
> 上面的交错现象可以在 clone 后用一份合成夹具复现。
> 而本节表格用的是**真实已发表论文**——那是更严苛的检验，且这些论文无法再分发，
> 所以其精确数字是**记录**，不是可复现的。
> 详见 [tests/fixtures/README.md](https://github.com/Dantwz7/dsh-doc-router/blob/main/tests/fixtures/README.md)。
>
> 不过语料层面的总数是**一条命令就能重跑**的：把你手上的语料交给
> `python -B scripts/validate-routing.py <语料目录> --json out.json`，它会打印逐文件判据表和总数。
> 该脚本随仓库一起分发
> （[`scripts/validate-routing.py`](https://github.com/Dantwz7/dsh-doc-router/blob/main/scripts/validate-routing.py)），
> 导入的正是工具所用的 `lib/docprobe.py`，因此不可能给出与工具不一致的判据。
> 当初那一次运行以**逐文件清单**的形式保留下来（71 篇的路径、大小、页数、判据、栏数估计、
> 每页字符数），所以这些数字是**可以对差**的，而不只是「请相信」。

## 故障排查

| 你看到的现象 | 怎么办 |
|---|---|
| `docprobe failed … Microsoft Store … exit code 9009` | `PATH` 上的 `python` 是 Windows 应用商店的占位程序。把 `pythonPath`（或 `DOC_ROUTER_PYTHON`）指向真正的解释器。 |
| `PyMuPDF is not installed` | 插件解析到的解释器不是你装 PyMuPDF 的那个。显式设置 `pythonPath` 即可确认它选了谁；或者装进打包运行时 `$DSH_HOME/dsh-runtimes/` 下。注意 **DSH 升级可能覆盖该运行时的 `site-packages`**，届时重装 PyMuPDF。 |
| `page selection '99' matched no pages; the document has 1 page(s)` | 页码区间会按真实页数校验。请用 `"3"`、`"1-3"` 或 `"1,4,7"`。 |
| 明明是双栏却判成单栏 | 请带上工具返回里的 `probe` 明细开 issue——它包含逐页的「多栏占比/栏数」证据。若能给一份**合成**的复现样本最好，[`tests/fixtures/generate.py`](https://github.com/Dantwz7/dsh-doc-router/blob/main/tests/fixtures/generate.py) 是个不错的起点。 |

## 开发

**没有构建步骤，也不需要安装依赖。** 裸 clone 下测试直接可跑：

```bash
git clone https://github.com/Dantwz7/dsh-doc-router.git
cd dsh-doc-router
npm test                 # 单元测试到处都能跑；缺 PyMuPDF 时集成测试自动跳过
npm run test:unit        # 完全没有外部依赖
npm run fixtures         # 重新生成 tests/fixtures/（需 Python + PyMuPDF）
npm run verify:package   # 校验 `npm publish` 实际上传了什么
npm run verify:docs      # 校验链接、锚点、结构与 README 判据表
```

```text
lib/index.js        插件本体：工具定义、解释器发现、子进程启动
lib/docprobe.py     stdlib + PyMuPDF：格式嗅探、栏数几何、提取
cordis.patch.yml    bundle 层：把插件插进 DSH 组合
tests/              node --test 套件 + 合成夹具
scripts/            夹具生成、包内容与 README 判据校验
.github/workflows/  CI（unit 与 integration 均在 Linux 与 Windows 上跑）
```

另有一项检查需要真实 DSH 安装：
[`tests/manual/real-api.mjs`](https://github.com/Dantwz7/dsh-doc-router/blob/main/tests/manual/README.md) 会用 `app.asar` 里**真实的**
`defineTool` 与 schemastery 驱动插件——这正是冷启动会失败的加载期表面。

路由规则应当保持确定性。若你改了 `lib/docprobe.py` 里的阈值，请同时更新
docstring 里的理由**和**上面的表格，并补一个覆盖新边界的夹具。
不可退回项与发布流程见 [CONTRIBUTING.md](https://github.com/Dantwz7/dsh-doc-router/blob/main/CONTRIBUTING.md)。

## 路线图

- [x] 发布到 npm，让安装不再需要 `file:` 路径。—— **已完成：
      [`dsh-doc-router`](https://www.npmjs.com/package/dsh-doc-router)
      已上线公共 registry。**
- [x] **本地化探测脚本的提示语。** —— **已完成**：`noteLanguage` 可选中英提示语，
      且 `0.4.0` 起默认改为 `en`，与 npm 渲染的那份 README 对齐。
      两种语言都有断言，其中一条专门验证非默认值确实传到了探测脚本。
- [x] **让夹具真正能证明阅读顺序。** —— **已完成：**
      `two-column-reading-order.pdf` 两栏带可区分标记（`L01…L15` | `R01…R15`），
      测试断言精确序列；结果被交错、两栏互换、栏内乱序或漏栏，现在都会让构建失败。
      `three-column.pdf`（`L01…L15` | `M01…M15` | `R01…R15`）把这一保证扩展到**中间栏**，
      而「只在页面正中找一条沟」的实现恰好漏掉中间栏——真实输入里确实有：
      试用语料中就有一篇真正的三栏 Science 论文。
- [x] **别让「25 字符块过滤」把整栏证据抹掉。** —— **已完成：**
      这个过滤是**不分栏**的：当双栏页的其中一栏全是短块（一张图、一张表、一列短条目），
      那一栏就不提供任何证据，剩下那栏看起来就是一个「确信的单栏页」，
      于是文档被交给 `markitdown`——**正是最不该走的方向**。现在当被丢弃的块落在保留文本区
      之外时，`_column_profile` 改判 `unknown`（→ `pdf_markdown`）。
      只走安全侧：绝不拿丢弃的证据去**断言**多栏。在真实 71 篇语料上重跑，
      **0 篇判据发生变化**，说明阈值当初调优的结果没有回退；`short-column.pdf` 钉住该行为。
- [x] **把块过滤的阈值按「内容量」而不是「码点数」计。** —— **已完成：**
      这个阈值本是**内容**阈值（「大约半行正文」），却按**码点数**计，而同一个码点数
      在不同文字系统里代表的内容量并不相同：一个中文词是 1-2 个字，一个英文词约 5 个字母。
      于是过滤在中文 PDF 上**成倍地更激进**，会丢掉真正的正文——甚至可能是整整一栏。
      现在改计*拉丁等数码点*（`CJK_CHAR_WEIGHT = 2`），拉丁文本因此**逐字符不变**
      （71 篇语料 **0 篇判据变化**），而中文正文得以保留。`dense-script-column.pdf`
      同时钉住两头：中文那一栏被恢复，而它的拉丁对照仍然照旧丢弃。
- [x] **识别 UTF-16/UTF-32 纯文本。** —— **已完成**：嗅探器过去只试 UTF-8，
      于是 UTF-16 文件落进 `unknown`，而它的建议（「试试看，再靠人判断」）
      对一个本身就是纯文本的文件是**误导**。现在会先查 BOM；没有 BOM 时依次试
      `utf-8 → utf-16-le → utf-16-be`，并配一道**控制字符护栏**，
      使「能解码成功」的二进制仍被拒绝。`nul-bytes.bin` 是直接的测试——
      它同时是合法的 UTF-8 **和**合法的 UTF-16LE。
- [x] **探测脚本与插件的契约破了就大声报错。** —— **已完成**：
      过去当探测脚本完全没返回 `recommend` 时，`doc_route` 会兜底成
      `['markitdown']`，把「契约已破」伪装成一个正常结果——而且恰是不对称下注
      禁止的那个方向。现在直接抛错并带上探测脚本路径，且有测试断言此时不返回任何东西。
- [x] **把模型要读的东西全部本地化。** —— **已完成**：`noteLanguage` 过去只覆盖
      探测脚本的提示语。现在 `pdf_markdown` 的拒绝信息与整套 `doc-routing` 技能正文
      （描述、`whenToUse`、正文）都跟随它，英文会话不会再拿到一份中文技能。
- [x] **补齐没被覆盖的格式分支，并给 README 加机器校验。** —— **已完成**：
      新增 19 个夹具（tsv / xml / ipynb / md / 无扩展名 / UTF-16 / UTF-32 / 空文件 /
      两个二进制 / jpeg / gif / webp / odt / epub / mp3），补齐六个格式分支，
      其中 `odt` 与 `epub` 两段代码此前从未在 CI 里执行过。
      `scripts/check-readme-facts.mjs` 现在会拿 `generate.py` 校验 README 的判据表，
      单元测试也断言技能里的工具清单与探测脚本的 `recommend` 标记一致。
- [ ] PDF 后端可插拔，使 AGPL 不可接受的场景能换用宽松许可的引擎。
- [ ] 为导出面补 TypeScript 类型声明。
- [ ] 可选的扫描件 OCR 通路（目前止步于「渲染成 PNG 看图」）。

## 参与贡献

欢迎开 issue 和提 PR。缺陷报告里最有价值的是**该文件的完整 `doc_route` 结果**——
[issue 模板](https://github.com/Dantwz7/dsh-doc-router/blob/main/.github/ISSUE_TEMPLATE/bug_report.yml)要的正是这个。
动手前请先读 [CONTRIBUTING.md](https://github.com/Dantwz7/dsh-doc-router/blob/main/CONTRIBUTING.md) 与[行为准则](https://github.com/Dantwz7/dsh-doc-router/blob/main/CODE_OF_CONDUCT.md)。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。

### ⚠️ PyMuPDF 是 AGPL-3.0 或商业双许可

`pdf_markdown` 与 PDF 版面探测经由 PyMuPDF 完成，Artifex 对它的许可是
**GNU AGPL-3.0 或商业许可**。这个区别很要紧：

- 本插件自身代码仍是 MIT。它**不打包、不链接** PyMuPDF，而是以子进程启动解释器、
  通过 stdio 交换 JSON。
- 如果你**随本插件一起分发 PyMuPDF**（容器镜像、安装包、打包的桌面应用），
  那么**你的**分发包里就含有一个 AGPL-3.0 程序，你必须为其满足 AGPL-3.0，
  或向 Artifex 购买商业许可。
- 如果你把它作为**可被网络访问的服务**的一部分运行，AGPL §13 可能要求你向该服务的
  使用者提供相应源码。

peer 依赖（`@deepseek-ai/dsh-tools` BSD-3-Clause；`@deepseek-ai/cordis` 与
`@deepseek-ai/schemastery` MIT）由 DSH 提供，从不打包。完整说明见 [NOTICE](NOTICE)。
该文件描述的是上游许可事实，**不构成法律意见**。

## 致谢

- [PyMuPDF](https://github.com/pymupdf/PyMuPDF) / `pymupdf4llm` —— 版面感知的 PDF
  提取，AGPL-3.0（见上）。
- [MarkItDown](https://github.com/microsoft/markitdown) —— 非多栏 PDF 的默认转换器。
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —— 本插件所针对的宿主。

商标归各自所有者；本项目与上述各方无隶属或背书关系。
