import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RenderTexInput, RenderTexResult } from "../examples/extensions/render-tex.ts";
import { loadExtensions } from "../src/core/extensions/loader.ts";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";

const extensionPath = fileURLToPath(new URL("../examples/extensions/render-tex.ts", import.meta.url));
const available = ["/usr/local/texlive/2024/bin/x86_64-linux/latexmk", "/usr/bin/pdfinfo", "/usr/bin/pdftocairo"].every(
	existsSync,
);

async function renderTex(input: RenderTexInput, cwd: string, signal?: AbortSignal): Promise<RenderTexResult> {
	const loaded = await loadExtensions([extensionPath], cwd);
	expect(loaded.errors).toEqual([]);
	const tool = loaded.extensions[0].tools.get("render_tex");
	if (!tool) throw new Error("render_tex was not registered");
	const result = await tool.definition.execute("test-call", input, signal, undefined, { cwd } as ExtensionToolContext);
	return result.details as RenderTexResult;
}

describe.skipIf(!available)("render_tex (WSL integration)", () => {
	let cwd: string;
	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), "pi render test "));
	});
	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	it("registers through Pi's real extension loader", async () => {
		const loaded = await loadExtensions([extensionPath], cwd);
		expect(loaded.errors).toEqual([]);
		expect(loaded.extensions).toHaveLength(1);
		expect(loaded.extensions[0].tools.has("render_tex")).toBe(true);
	});

	it("exports one page beside the source, resolves includes, and replaces previous output", async () => {
		await writeFile(join(cwd, "body.tex"), "Relative include works.");
		await writeFile(
			join(cwd, "single figure.tex"),
			"\\documentclass{article}\n\\usepackage[paperwidth=5cm,paperheight=5cm,margin=5mm]{geometry}\n" +
				"\\pagestyle{empty}\n\\begin{document}\\input{body.tex}\\end{document}\n",
		);
		await writeFile(join(cwd, "single figure.pdf"), "old output");
		const result = await renderTex({ tex_path: "single figure.tex" }, cwd);
		expect(result.pages).toBe(1);
		expect(result.output_dir).toBe(cwd);
		expect(result.svg).toEqual([join(cwd, "single figure.svg")]);
		expect(result.png).toEqual([join(cwd, "single figure.png")]);
		expect((await readFile(result.pdf)).subarray(0, 5).toString()).toBe("%PDF-");
		expect(await readFile(result.svg[0], "utf8")).toContain("<svg");
		expect((await readFile(result.png[0])).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
		expect((await readdir(cwd)).some((name) => /\.(aux|xdv|fls|fdb_latexmk)$/.test(name))).toBe(false);
	}, 30_000);

	it("exports every page into a directory relative to the project cwd", async () => {
		await writeFile(
			join(cwd, "multi.tex"),
			"\\documentclass{article}\\usepackage[paperwidth=3cm,paperheight=3cm,margin=3mm]{geometry}" +
				"\\begin{document}First\\newpage Second\\end{document}",
		);
		const result = await renderTex({ tex_path: join(cwd, "multi.tex"), output_dir: "exports/nested" }, cwd);
		expect(result.pages).toBe(2);
		expect(dirname(result.pdf)).toBe(join(cwd, "exports/nested"));
		for (const suffix of ["svg", "png"] as const) {
			expect(result[suffix]).toEqual([1, 2].map((page) => join(cwd, `exports/nested/multi-page-${page}.${suffix}`)));
			for (const path of result[suffix]) expect((await readFile(path)).length).toBeGreaterThan(100);
		}
	}, 30_000);

	it("reports compilation failure with a log, preserving the old PDF", async () => {
		await writeFile(
			join(cwd, "broken.tex"),
			"\\documentclass{article}\\begin{document}\\undefinedCommand\\end{document}",
		);
		await writeFile(join(cwd, "broken.pdf"), "keep previous export");
		await expect(renderTex({ tex_path: "broken.tex" }, cwd)).rejects.toThrow("failed at compile");
		expect(await readFile(join(cwd, "broken.render.log"), "utf8")).toContain("Undefined control sequence");
		expect(await readFile(join(cwd, "broken.pdf"), "utf8")).toBe("keep previous export");
	}, 30_000);

	it("rejects missing or non-TeX input", async () => {
		await expect(renderTex({ tex_path: "missing.tex" }, cwd)).rejects.toThrow("ENOENT");
		await expect(renderTex({ tex_path: "input.txt" }, cwd)).rejects.toThrow(".tex file");
	});

	it("cancels an active compiler and reports the compile stage", async () => {
		await writeFile(
			join(cwd, "loop.tex"),
			"\\documentclass{article}\\begin{document}\\loop\\iftrue\\repeat\\end{document}",
		);
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), 600);
		try {
			await expect(renderTex({ tex_path: "loop.tex" }, cwd, abort.signal)).rejects.toThrow("Cancelled");
			expect(await readFile(join(cwd, "loop.render.log"), "utf8")).toContain("Failed at compile");
		} finally {
			clearTimeout(timer);
		}
	}, 10_000);
});
