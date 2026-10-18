# render_tex: WSL LaTeX export tool

This extension adds `render_tex` to Pi without changing its agent loop. The first
version targets this WSL installation: TeX Live 2024 and Ubuntu Poppler.

## Tool input

```json
{"tex_path": "figures/pipeline.tex", "output_dir": "exports"}
```

`tex_path` is required. `output_dir` is optional and defaults to the source file's
directory. Both relative paths are resolved against Pi's project working directory.
Compilation runs in the source directory so relative `\\input` and image paths work.

XeLaTeX is driven by latexmk, with rc files and shell escape disabled. A successful
call returns absolute paths for the complete PDF, one SVG and 300-DPI PNG per page,
and `<stem>.render.log`. Single-page exports use `<stem>.svg/png`; multiple pages
use `<stem>-page-1.svg/png`, etc. XeLaTeX supports Unicode; fonts and TeX packages
must already exist in this environment.

Existing matching outputs are overwritten only after compilation and conversion
have finished. Old files whose names are no longer produced (for example after
reducing the page count) are left alone; the returned paths identify this run's
artifacts. Publishing several files is not an atomic transaction: a filesystem
error while copying may leave some outputs updated. Such a call reports failure.
Intermediate files are removed from a temporary build directory in all cases.

The whole render has a 120-second timeout. Cancellation kills the active process
group, including latexmk's compiler children. Failed calls throw a tool error with
the failed stage and diagnostic log path. Invalid source paths fail before building.
Command output and the TeX log are bounded to their last 64 KiB for diagnostics.
No model request is required for the integration tests.

## Loading

```bash
/home/chen/work/pi-agent-lab/bin/pi-lab -e /home/chen/work/pi-agent-lab/pi/packages/coding-agent/examples/extensions/render-tex.ts
```

The local Pi lab also loads this file through a symlink in its isolated
`state/agent/extensions/` directory, so ordinary `pi-lab` starts include it.

## Source walkthrough

1. `Type.Object(...)` declares the two tool parameters for the model.
2. `pi.registerTool(...)` registers the definition when Pi loads the extension.
3. `execute(...)` gets validated parameters, the cancellation signal and `ctx.cwd`.
4. `renderTex(...)` compiles, converts, publishes and returns paths.
5. The tool result's `content` is model-readable; `details` holds structured data.

Run the focused test from `packages/coding-agent`:

```bash
node ../../node_modules/vitest/dist/cli.js --run test/render-tex.test.ts
```

The integration group skips if this WSL's fixed tools are absent.
