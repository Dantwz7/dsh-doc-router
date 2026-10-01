# Manual tests

Not part of `npm test`. These need a real DeepSeek Harness installation, so they
cannot run in CI or on a fresh clone.

## `real-api.mjs`

Loads the **real** `@deepseek-ai/dsh-tools` and `@deepseek-ai/schemastery` out of
the DSH `app.asar` and drives the plugin against them, to prove that:

* the real schemastery accepts the `Config` schema (a rejected schema throws at
  **load time**, which during a cold start is a failed startup, not a failed
  tool call),
* the real `defineTool` accepts both tool definitions,
* both tools and the runtime skill register.

Requires **Electron-as-node**, because plain Node cannot read inside an asar
archive. Electron is a GUI-subsystem binary, so its stdout is not reliably
capturable — the script also writes `tests/.tmp/real-api.log` and sets the exit
code.

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& '<DSH install>\DeepSeek Harness.exe' --expose-internals ./tests/manual/real-api.mjs
```

```bash
# point the resolver at your install if it is not in the default location
export DSH_ASAR_DSH_ROOT='/path/to/resources/app.asar/dsh/'
```

If `DSH_ASAR_DSH_ROOT` is wrong, the resolver reports that it resolved nothing
rather than failing silently.

## Testing the plugin inside a running DSH

The only true end-to-end check is a real session. See the "Testing against a
real DSH install" section of [CONTRIBUTING.md](../../CONTRIBUTING.md) — in
particular the `file:`-install update loop (a `file:` dependency is a copy, and
the running host caches the loaded module, so editing the source does nothing
until you bump the version, reinstall and restart).
