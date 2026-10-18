/** LaTeX rendering for the current WSL / TeX Live 2024 installation. */
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LATEXMK = "/usr/local/texlive/2024/bin/x86_64-linux/latexmk";
const PDFINFO = "/usr/bin/pdfinfo";
const PDFTOCAIRO = "/usr/bin/pdftocairo";
const TIMEOUT_MS = 120_000;
const LOG_LIMIT = 65_536;

export interface RenderTexInput {
	tex_path: string;
	output_dir?: string;
}

export interface RenderTexResult {
	tex_path: string;
	output_dir: string;
	pages: number;
	pdf: string;
	svg: string[];
	png: string[];
	log: string;
}

/** Run argument arrays directly, and cancel the entire LaTeX process group. */
async function runCommand(command: string, args: string[], cwd: string, signal: AbortSignal): Promise<string> {
	signal.throwIfAborted();
	return new Promise((resolveCommand, reject) => {
		const child = spawn(command, args, {
			cwd,
			shell: false,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, LC_ALL: "C", PATH: `${dirname(LATEXMK)}:${process.env.PATH ?? ""}` },
		});
		let output = "";
		const collect = (data: Buffer) => {
			output = (output + data.toString()).slice(-LOG_LIMIT);
		};
		const cancel = () => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
			}
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		signal.addEventListener("abort", cancel, { once: true });
		if (signal.aborted) cancel();
		child.once("error", (error) => {
			signal.removeEventListener("abort", cancel);
			reject(error);
		});
		child.once("close", (code) => {
			signal.removeEventListener("abort", cancel);
			if (signal.aborted) {
				reject(new Error(`Cancelled or exceeded ${TIMEOUT_MS / 1000}s timeout.\n${output}`));
			} else if (code !== 0) {
				reject(new Error(`${basename(command)} exited with code ${code}.\n${output}`));
			} else {
				resolveCommand(output);
			}
		});
	});
}

export async function renderTex(
	input: RenderTexInput,
	cwd: string,
	abortSignal?: AbortSignal,
): Promise<RenderTexResult> {
	const texPath = resolve(cwd, input.tex_path);
	if (extname(texPath).toLowerCase() !== ".tex") throw new Error("tex_path must point to a .tex file.");
	if (!(await stat(texPath)).isFile()) throw new Error(`Not a file: ${texPath}`);
	const outputDir = input.output_dir === undefined ? dirname(texPath) : resolve(cwd, input.output_dir);
	const stem = basename(texPath, extname(texPath));
	const logPath = join(outputDir, `${stem}.render.log`);
	const signal = abortSignal
		? AbortSignal.any([abortSignal, AbortSignal.timeout(TIMEOUT_MS)])
		: AbortSignal.timeout(TIMEOUT_MS);
	signal.throwIfAborted();
	await mkdir(outputDir, { recursive: true });
	const workDir = await mkdtemp(join(tmpdir(), "pi-render-tex-"));
	let stage = "compile";
	let log = `Source: ${texPath}\nOutput: ${outputDir}\nEngine: XeLaTeX\nPNG DPI: 300\n`;
	try {
		log += await runCommand(
			LATEXMK,
			[
				"-norc",
				"-xelatex",
				"-latexoption=-no-shell-escape",
				"-latexoption=-halt-on-error",
				"-latexoption=-interaction=nonstopmode",
				"-latexoption=-file-line-error",
				`-outdir=${workDir}`,
				texPath,
			],
			dirname(texPath),
			signal,
		);
		const compiledPdf = join(workDir, `${stem}.pdf`);
		stage = "inspect PDF";
		const info = await runCommand(PDFINFO, [compiledPdf], workDir, signal);
		log += `\n${info}`;
		const pages = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1]);
		if (!Number.isInteger(pages) || pages < 1) throw new Error("Cannot determine PDF page count.");
		const result: RenderTexResult = {
			tex_path: texPath,
			output_dir: outputDir,
			pages,
			pdf: join(outputDir, `${stem}.pdf`),
			svg: [],
			png: [],
			log: logPath,
		};
		const publications = [{ source: compiledPdf, target: result.pdf }];
		for (let page = 1; page <= pages; page++) {
			const name = pages === 1 ? stem : `${stem}-page-${page}`;
			const svg = join(workDir, `${name}.svg`);
			const pngPrefix = join(workDir, name);
			stage = `SVG page ${page}`;
			log += await runCommand(
				PDFTOCAIRO,
				["-svg", "-f", String(page), "-l", String(page), compiledPdf, svg],
				workDir,
				signal,
			);
			stage = `PNG page ${page}`;
			log += await runCommand(
				PDFTOCAIRO,
				["-png", "-r", "300", "-singlefile", "-f", String(page), "-l", String(page), compiledPdf, pngPrefix],
				workDir,
				signal,
			);
			result.svg.push(join(outputDir, `${name}.svg`));
			result.png.push(join(outputDir, `${name}.png`));
			publications.push({ source: svg, target: result.svg[page - 1] });
			publications.push({ source: `${pngPrefix}.png`, target: result.png[page - 1] });
		}
		stage = "publish files";
		// Validate every staged artifact before overwriting previous exports.
		for (const file of publications) {
			signal.throwIfAborted();
			if ((await stat(file.source)).size === 0) throw new Error(`Empty artifact: ${file.source}`);
		}
		for (const file of publications) {
			signal.throwIfAborted();
			await copyFile(file.source, file.target);
		}
		await writeFile(logPath, `${log}\nSuccess: ${pages} page(s).\n`);
		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const texLog = await readFile(join(workDir, `${stem}.log`), "utf8").catch(() => "");
		await writeFile(logPath, `${log}\nFailed at ${stage}: ${message}\n${texLog.slice(-LOG_LIMIT)}`);
		throw new Error(`render_tex failed at ${stage}: ${message.slice(-4000)}\nLog: ${logPath}`);
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
}

const renderTexTool = defineTool({
	name: "render_tex",
	label: "Render LaTeX",
	description:
		"Compile an existing .tex file with XeLaTeX in this WSL, then export PDF, SVG and 300-DPI PNG. " +
		"Paths are relative to the current project directory. Output defaults to the source directory. " +
		"Multi-page SVG/PNG use -page-N names. Overwrites matching outputs. " +
		"No shell escape; 120-second total timeout. Returns artifact paths and a compilation log.",
	parameters: Type.Object({
		tex_path: Type.String({ description: "Path to an existing .tex file", minLength: 1 }),
		output_dir: Type.Optional(
			Type.String({ description: "Export directory; defaults to the .tex directory", minLength: 1 }),
		),
	}),
	executionMode: "sequential",
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const details = await renderTex(params, ctx.cwd, signal);
		return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(renderTexTool);
}
