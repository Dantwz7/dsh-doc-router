## What this changes

<!-- One or two sentences. If it fixes an issue, write "Fixes #123". -->

## Why

<!-- The reasoning. For a routing-rule change, state which misclassification this
     fixes and why the new threshold is the right one. -->

## Checklist

- [ ] `npm test` passes (unit tests at minimum; integration too if Python + PyMuPDF are available)
- [ ] `npm run lint` passes
- [ ] `CHANGELOG.md` has an entry under `## [Unreleased]`
- [ ] New behaviour is covered by a test

### If this touches the routing rules (`lib/docprobe.py`)

- [ ] The threshold's rationale is in the docstring, not just the diff
- [ ] The routing table in `README.md` **and** `README.zh.md` still matches the code
- [ ] `npm run fixtures` still self-checks clean, or the fixtures were regenerated deliberately
- [ ] None of the three documented past defects were reintroduced (see CONTRIBUTING.md §4)

### If this touches `package.json`

- [ ] Gate 1 still holds: `dsh.bundle.patch` points at `cordis.patch.yml`
- [ ] Gate 2 still holds: every `@deepseek-ai/dsh*` peer range accepts the current DSH version
- [ ] `npm run verify:package` passes (the `files` allow-list is unchanged or updated on purpose)

### If this changes the public surface (tool names, parameters, result keys)

- [ ] `README.md` and `README.zh.md` are both updated
- [ ] `CHANGELOG.md` calls it out as a breaking or notable change
