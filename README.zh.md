# dsh-doc-router

**先路由，再读取。** 一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
插件：先探明文件的**真实格式**与 PDF 的**页面版面**，再决定用哪条管线读它；
对多栏论文做版面感知转换，而不是把正文切碎。

[![npm](https://img.shields.io/npm/v/dsh-doc-router.svg)](https://www.npmjs.com/package/dsh-doc-router)
[![CI](https://github.com/Dantwz7/dsh-doc-router/actions/workflows/ci.yml/badge.svg)](https://github.com/Dantwz7/dsh-doc-router/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#许可证)

[English →](README.md)

---

## 它解决什么问题

默认转换器会把多栏论文做错，而且错得不轻。以一篇 Nature Letter
（`nmat4749.pdf`，双栏，7 页）为例，在作者机器上以 PyMuPDF 1.28.2 / MarkItDown 0.2.0 实测：

| 管线 | 输出 | 多栏处理 |
|---|---|---|
| `pymupdf4llm`（版面感知） | 第 1 页 **6 533** 字符 | ✅ 两栏按阅读顺序合并；标题→`#`、上标→`<sup>`、`_in situ_` 斜体全部保留 |
| `pypdf` | 全 7 页 30 632 字符 | ⚠️ 正文可读，但**结构全丢** |
| MarkItDown | 全 7 页 45 266 字符 | ❌ 正文碎成数百行 `\| … \|` 表格 |

所以让模型「随便挑个转换器」的后果，是拿到一份被悄悄弄坏的原文。
解法不是找一个更好的转换器，而是**路由**：先看文件，再选管线。

## 提供什么

| 产物 | 作用 |
|---|---|
| **`doc_route` 工具** | 判据：格式（魔数）、页数、有无文字层、单栏/多栏，并给出判据背后的逐页证据 |
| **`pdf_markdown` 工具** | 用 PyMuPDF 做版面感知的 PDF→Markdown；支持页码区间与落盘 |
| **`doc-routing` 技能** | 注册进 **runtime** 技能层，因此对**所有工作区**生效，不依赖工作区里的 `skills/` 目录；它告诉模型「读之前先路由」 |

## 安装

```bash
plugin_manager action=install_bundle target="dsh-doc-router@0.2.1"
```

**请写精确版本。** DSH 的包管理器有最小发布年龄策略，只写包名可能悄悄解析到旧版本。

然后确认插件解析到的那个解释器里装了 PyMuPDF：

```bash
<插件解析到的 python> -m pip install pymupdf4llm
```

没有 PyMuPDF 时插件**照常加载**，`doc_route` 仍能按格式判类；只有版面探测与
`pdf_markdown` 会停用，并且两者都会明确说明原因，而不是含糊地失败。

### 从本地源码目录安装

```bash
plugin_manager action=install_bundle target="file:<仓库绝对路径>"
```

`file:` 安装是**拷贝**，所以**改源码不会生效**：必须升版本号 → 移除 bundle →
重装 → **重启 DSH**。详见
[CONTRIBUTING.md](CONTRIBUTING.md#5-testing-against-a-real-dsh-install)。

## 用法

```text
doc_route({ path: "paper.pdf" })
→ Routed paper.pdf — format: pdf, pages: 7, text layer: yes, columns: multi-column (est 2)
  Recommended pipeline: pdf_markdown
  多栏正文（估 2 栏）→ markitdown 会把正文切成表格碎片，pypdf 会丢结构

pdf_markdown({ path: "paper.pdf", pages: "1-3" })
→ Converted paper.pdf (pages 1,2,3) — 18422 characters of Markdown. …

pdf_markdown({ path: "paper.pdf", output: "paper.md" })
→ Converted paper.pdf (all 7 pages) — wrote 41203 characters to paper.md.
```

两个工具都接受**相对工作区**的路径；`pdf_markdown` 对内联返回的长文本会按
`maxChars` 截断（而不是灌爆上下文）——要完整文档就传 `output` 落盘。

## 路由是怎么判的

所有判据都是**确定性的**：零模型调用、零网络、零 token。

| 判断 | 依据 |
|---|---|
| 格式 | 文件头**魔数**，从不看扩展名。ZIP 容器会进内部看目录结构，区分 docx / xlsx / pptx / epub / odt |
| 有无文字层 | 字符数/页 < 120 → 视为扫描件 |
| 单栏/多栏 | 逐条横带合并文本区间，数被「内部空白」隔开的段数；**任一正文页多栏即判多栏**。边缘块（出版商的竖排水印、页眉页脚）不计入：它们虽窄，却纵贯整页，会落进每一条横带 |

最后一条是刻意的不对称下注：`pymupdf4llm` 对单栏同样适用，而漏判会把多栏交给
会毁掉正文的转换器。一种误判很便宜，另一种不是。

同一个下注也决定了**测不出栏数**时怎么办——某页正文只有一个大块、或全是碎片短块，
就给不出可用的横带证据。这种判定如实报为 `unknown`，并路由到 `pdf_markdown`，
**绝不**被说成单栏：猜「单栏」是昂贵的方向，测不准的文件走便宜的那条。

判据给出的路由：

| 判据 | 管线 |
|---|---|
| 多栏 + 有文字层 | `pdf_markdown` |
| 单栏 + 有文字层 | `markitdown`（兜底 `pypdf`） |
| 栏数测不出（`unknown`）+ 有文字层 | `pdf_markdown`，安全侧 |
| 无文字层 | 渲染 PNG → `read_image` |
| docx / xlsx / pptx / epub / odt / csv / html / json / xml | `markitdown` |
| 图片 | `read_image` |
| 文本 / rtf | `read`，完全不转换 |

### 为什么多模态不参与常规路径

格式与栏数是**几何问题**。代码又快又准又免费；而一页 150dpi 图约 0.5MB、
上千 token，还必须逐页渲染。所以图像只留给代码无解的三件事：

1. **无文字层**（扫描件）；
2. **精确核对公式、上下标、希腊字母、单位**——文本提取在这些地方错得要紧
   （图里 `Sr₃Al₂O₆` 下标正确，文本提取只能给 `Sr3Al2O6`）；
3. **理解图表、版式，或判断图注归属**。

### 验证

10 份真实 PDF 全部判类正确：Nature / Science 的 letter、Nature Materials 与
《物理学报》论文、3 份期刊 SI 附录、1 份单栏期刊简介；其中包含一份三栏的
Science 版面。

开发中修掉的三个判据缺陷（都容易退回）：

1. 「数左右各多少文本块」→ Nature 首页左栏只有 2 块，误判单栏。改为逐行找栏沟。
2. 「只找页面中部那一条沟」→ 3 栏版面（Science）中间是正文列，漏判。改为数栏数。
3. 「多页取多数」→ Science 参考文献页单栏 + 图页平票，倒向单栏。改为「任一页多栏即多栏」，
   并排除 <300 字符的纯图页。

## 依赖要求

| | |
|---|---|
| **Node** | `^22.19.0 || >=24.0.0` |
| **DSH** | `>=0.2.0-rc.1 <0.3.0-0`（`@deepseek-ai/dsh*` 的 peer 区间） |
| **Python** | 3.9+，仅 PDF 版面探测与 `pdf_markdown` 需要 |
| **PyMuPDF** | `pip install pymupdf4llm` —— **可选**，见[许可证](#许可证) |

解释器查找顺序：`config.pythonPath` → `DOC_ROUTER_PYTHON` → DSH 打包的运行时
→ `~/.dsh/dsh-runtimes` → `PATH` 上的 `python`。显式指定的解释器**原样采用**，
所以裸命令名（如 `python3`）也能用，而写错路径会**明确报出你指定的那个路径**。

## 配置

```yaml
# cordis.patch.yml
- id: doc-router
  name: dsh-doc-router
  config:
    pythonPath: C:\path\to\python.exe   # 可选；优先级最高
    timeoutMs: 120000                    # 可选；探测超时
    maxChars: 120000                     # 可选；内联 Markdown 上限
```

## 故障排查

**`docprobe failed … Microsoft Store … exit code 9009`** —— `PATH` 上的 `python`
是 Windows 应用商店的占位程序。把 `pythonPath`（或 `DOC_ROUTER_PYTHON`）指向真正的解释器。

**`PyMuPDF is not installed`** —— 插件解析到的解释器不是你装 PyMuPDF 的那个。
显式设置 `pythonPath` 即可确认它选了谁；或者装进打包运行时
`$DSH_HOME/dsh-runtimes/` 下。注意 **DSH 升级可能覆盖该运行时的 site-packages**，
届时重装 PyMuPDF。

**明明是双栏却判成单栏** —— 请带上工具返回里的 `probe` 明细开 issue，
它包含逐页的「多栏占比/栏数」证据。若能给一份**合成**的复现样本最好，
`tests/fixtures/generate.py` 是个不错的起点。

## 开发

**没有构建步骤，也不需要安装依赖**：裸 clone 下 `npm test` 直接可跑。

```bash
git clone https://github.com/Dantwz7/dsh-doc-router.git
cd dsh-doc-router
npm test                 # 单元测试到处都能跑；缺 PyMuPDF 时集成测试自动跳过
npm run test:unit        # 无外部依赖
npm run fixtures         # 重新生成 tests/fixtures/（需 Python + PyMuPDF）
```

fixtures 全部由本仓库合成生成，**不转载任何已发表论文**，见
[tests/fixtures/README.md](tests/fixtures/README.md)。

另有一项检查需要真实 DSH 安装：`tests/manual/real-api.mjs` 会用 `app.asar` 里
**真实的** `defineTool` 与 schemastery 驱动插件——这正是冷启动会失败的加载期表面。
见 [tests/manual/README.md](tests/manual/README.md)。

路由规则的不可退回项、DSH 的两道闸门与发布流程，见 [CONTRIBUTING.md](CONTRIBUTING.md)。

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

## 路线图

- [ ] 发布到 npm，让安装不再需要 `file:` 路径。
- [ ] PDF 后端可插拔，使 AGPL 不可接受的场景能换用宽松许可的引擎。
- [ ] 为导出面补 TypeScript 类型声明。
- [ ] 可选的扫描件 OCR 通路（目前止步于「渲染成 PNG 看图」）。
