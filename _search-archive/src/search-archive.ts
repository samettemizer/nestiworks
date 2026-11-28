import type { Dirent } from "node:fs";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";

export type Mode = "archive" | "full";

export const USER = "User message";
export const REPLY = "Model reply";
export const THINKING = "Model thinking";
export const TITLE = "Session title";
export const DEFAULT_LIMIT = 50;
const SNIPPET_WIDTH = 150;
const COLUMN_CAP = 40;

export interface Unit {
	location: string;
	text: string;
	at: number;
}

export interface Row {
	/** Session JSONL path and the cwd recorded in its header, for resuming it. */
	file: string;
	cwd: string;
	session: string;
	project: string;
	title: string;
	at: number;
	location: string;
	note: string;
}

export interface Matcher {
	test(text: string): boolean;
	snippet(text: string, width?: number): string;
}

/** Lowercase, strip diacritics (İ, ş, ğ, é, …) and fold dotless ı, so matching ignores case and accents. */
export function normalize(text: string): string {
	return text.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/ı/g, "i");
}

const WORD = "[\\p{L}\\p{N}]";
const SEP = "[^\\p{L}\\p{N}]+";

/**
 * Every query word must start a word of the text, in any order. Punctuation inside a query word
 * matches any punctuation or space, with its parts adjacent (`git-commit` finds `git commit`).
 */
export function compileQuery(query: string): Matcher | undefined {
	const patterns = query
		.split(/\s+/)
		.map(word => normalize(word).split(new RegExp(SEP, "u")).filter(Boolean))
		.filter(parts => parts.length > 0)
		.map(parts => new RegExp(`(?<!${WORD})${parts.join(SEP)}`, "u"));
	if (patterns.length === 0) return undefined;
	const finders = patterns.map(p => new RegExp(p.source, "gu"));
	return {
		test: text => {
			const norm = normalize(text);
			return patterns.every(p => p.test(norm));
		},
		snippet: (text, width = SNIPPET_WIDTH) => snippet(text, finders, width, true),
	};
}

/**
 * The pattern as a case-insensitive regular expression, matched against the raw text (no accent
 * folding, no word-prefix rule). Throws `SyntaxError` for an invalid pattern.
 */
export function compileRegex(pattern: string): Matcher {
	const re = new RegExp(pattern, "i");
	const finder = new RegExp(pattern, "gi");
	return {
		test: text => re.test(text),
		snippet: (text, width = SNIPPET_WIDTH) => snippet(text, [finder], width, false),
	};
}

/**
 * Single-line excerpt of about `width` characters centered on the earliest non-empty hit of the global
 * `patterns`; `fold` matches them against the case- and accent-folded text.
 */
function snippet(text: string, patterns: RegExp[], width: number, fold: boolean): string {
	const chars = Array.from(text.replace(/\s+/g, " ").trim());
	if (chars.length <= width) return chars.join("");
	// Fold per character so a hit in the folded text maps back to an original position.
	let norm = "";
	const origin: number[] = [];
	chars.forEach((c, i) => {
		const n = !fold ? c : c.charCodeAt(0) < 128 ? c.toLowerCase() : normalize(c);
		norm += n;
		for (let k = 0; k < n.length; k++) origin.push(i);
	});
	let from = 0;
	let to = 0;
	let best = Number.POSITIVE_INFINITY;
	for (const p of patterns) {
		// matchAll steps past zero-length matches, so patterns like `a*` cannot loop.
		for (const m of norm.matchAll(p)) {
			if (m.index >= best) break;
			if (m[0].length === 0) continue;
			best = m.index;
			from = origin[m.index];
			to = origin[m.index + m[0].length - 1] + 1;
			break;
		}
	}
	const start = Math.max(0, Math.min(chars.length - width, Math.floor((from + to - width) / 2)));
	const end = start + width;
	return `${start > 0 ? "…" : ""}${chars.slice(start, end).join("").trim()}${end < chars.length ? "…" : ""}`;
}

function blockText(content: unknown, type: string, key: string): string {
	if (typeof content === "string") return type === "text" ? content : "";
	if (!Array.isArray(content)) return "";
	return content
		.filter(b => b?.type === type && typeof b[key] === "string")
		.map(b => b[key] as string)
		.join("\n");
}

function values(v: unknown, out: string[] = []): string[] {
	if (typeof v === "string") out.push(v);
	else if (typeof v === "number" || typeof v === "boolean") out.push(String(v));
	else if (Array.isArray(v)) for (const x of v) values(x, out);
	else if (v && typeof v === "object") for (const x of Object.values(v)) values(x, out);
	return out;
}

/** Searchable texts of one `message` entry, each labeled with where it lives. */
export function messageUnits(entry: { timestamp?: unknown; message?: unknown }, mode: Mode): Unit[] {
	const m = entry.message as Record<string, unknown> | undefined;
	if (!m || typeof m !== "object") return [];
	const at = typeof m.timestamp === "number" ? m.timestamp : Date.parse(String(entry.timestamp));
	const units: Unit[] = [];
	const add = (location: string, text: string) => {
		if (text.trim()) units.push({ location, text, at });
	};
	if (m.role === "user") {
		if (m.attribution !== "agent") add(USER, blockText(m.content, "text", "text"));
	} else if (m.role === "assistant") {
		if (mode === "full") add(THINKING, blockText(m.content, "thinking", "thinking"));
		add(REPLY, blockText(m.content, "text", "text"));
		if (mode === "full" && Array.isArray(m.content)) {
			for (const b of m.content) {
				if (b?.type !== "toolCall") continue;
				const name = typeof b.name === "string" && b.name ? b.name : undefined;
				add(toolLabel("Tool call", name), [...(name ? [name] : []), ...values(b.arguments)].join("\n"));
			}
		}
	} else if (m.role === "toolResult" && mode === "full") {
		const name = typeof m.toolName === "string" && m.toolName ? m.toolName : undefined;
		add(toolLabel("Tool output", name), blockText(m.content, "text", "text"));
	}
	return units;
}

function toolLabel(kind: string, name: string | undefined): string {
	return name ? `${kind} (${name})` : kind;
}

const JSON_STRING = String.raw`"(?:[^"\\]|\\.)*"`;
const FLAT = String.raw`(?:${JSON_STRING}|[^"{}[\]])`;
/**
 * A tool result entry: a top-level `message` key whose object starts with `"role":"toolResult"`.
 * Strings are consumed whole and only flat objects (`runtime`) may precede `message`, so braces or
 * quotes inside strings and nested objects (tool-call arguments) cannot fake it; a line it does not
 * recognize is simply parsed.
 */
export const TOOL_RESULT_LINE = new RegExp(
	String.raw`^\{(?:${FLAT}|\{${FLAT}*\})*?"message":\{"role":"toolResult"`,
);

function parse(line: string): Record<string, unknown> | undefined {
	try {
		const v = JSON.parse(line);
		return v && typeof v === "object" ? v : undefined;
	} catch {
		return undefined;
	}
}

export function tilde(path: string): string {
	const home = homedir();
	if (path === home) return "~";
	return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

export interface SessionHeader {
	id: string;
	cwd: string;
	timestamp?: string;
	title?: string;
}

/**
 * Stream one session file and return its matching rows (newest first), or undefined when it is not a
 * session or `accept` rejects its header. Malformed lines are skipped; the file is never written.
 */
export async function scanSession(
	file: string,
	matcher: Matcher,
	mode: Mode,
	accept: (header: SessionHeader) => boolean,
): Promise<Row[] | undefined> {
	const input = createReadStream(file, { encoding: "utf8" });
	const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
	let header: SessionHeader | undefined;
	let slotTitle: string | undefined;
	let changedTitle: string | undefined;
	const hits: Unit[] = [];
	try {
		for await (const line of lines) {
			if (!header) {
				const e = parse(line);
				if (!e) continue;
				if (e.type === "title") {
					if (typeof e.title === "string") slotTitle = e.title;
					continue;
				}
				if (e.type !== "session" || typeof e.id !== "string") return undefined;
				header = e as unknown as SessionHeader;
				if (!accept(header)) return undefined;
				continue;
			}
			// Cheap prefilter: every message / title_change line contains its top-level `type` verbatim.
			// Nested content can add false positives, so the parsed `type` decides.
			if (!line.includes('"type":"message"') && !line.includes('"type":"title_change"')) continue;
			// Tool results (the bulk of a file) are only searched by full search.
			if (mode === "archive" && TOOL_RESULT_LINE.test(line)) continue;
			const e = parse(line);
			if (e?.type === "title_change") {
				if (typeof e.title === "string") changedTitle = e.title;
			} else if (e?.type === "message") {
				for (const unit of messageUnits(e, mode)) if (matcher.test(unit.text)) hits.push(unit);
			}
		}
	} finally {
		lines.close();
		input.destroy();
	}
	if (!header) return undefined;
	const title = slotTitle ?? changedTitle ?? (typeof header.title === "string" ? header.title : "");
	const cwd = String(header.cwd ?? "");
	const base = { file, cwd, session: header.id.slice(0, 13), project: tilde(cwd), title };
	const rows: Row[] = hits.map(h => ({ ...base, at: h.at, location: h.location, note: matcher.snippet(h.text) }));
	if (title && matcher.test(title)) {
		rows.push({ ...base, at: Date.parse(String(header.timestamp)), location: TITLE, note: matcher.snippet(title) });
	}
	// Newest first; rows without a date last. File order is chronological, so reversing first keeps
	// later-written rows ahead on equal dates (stable sort).
	const key = (r: Row) => (Number.isFinite(r.at) ? r.at : Number.NEGATIVE_INFINITY);
	return rows.reverse().sort((a, b) => (key(a) === key(b) ? 0 : key(b) > key(a) ? 1 : -1));
}

/** Top-level `<root>/<project>/*.jsonl` files, most recently modified first. */
export async function listSessionFiles(root: string): Promise<string[]> {
	let projects: Dirent[];
	try {
		projects = await readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const p of projects) {
		if (!p.isDirectory()) continue;
		const dir = join(root, p.name);
		try {
			for (const f of await readdir(dir, { withFileTypes: true })) {
				if (f.isFile() && f.name.endsWith(".jsonl")) files.push(join(dir, f.name));
			}
		} catch {}
	}
	const dated = await Promise.all(
		files.map(async file => ({ file, mtime: await stat(file).then(s => s.mtimeMs, () => 0) })),
	);
	return dated.sort((a, b) => b.mtime - a.mtime).map(d => d.file);
}

export interface SearchOptions {
	root: string;
	cwd: string;
	all: boolean;
	excludeId: string | undefined;
	matcher: Matcher;
	mode: Mode;
	limit: number;
}

/** Rows grouped by session (newest first); stops once a row beyond `limit` proves there are more. */
export async function search(o: SearchOptions): Promise<{ rows: Row[]; limited: boolean }> {
	const cwd = resolve(o.cwd);
	const accept = (h: SessionHeader) =>
		h.id !== o.excludeId && (o.all || (typeof h.cwd === "string" && resolve(h.cwd) === cwd));
	const rows: Row[] = [];
	for (const file of await listSessionFiles(o.root)) {
		rows.push(...((await scanSession(file, o.matcher, o.mode, accept)) ?? []));
		if (rows.length > o.limit) break;
	}
	return { rows: rows.slice(0, o.limit), limited: rows.length > o.limit };
}

/** Raw double-quote-aware tokens; an unclosed quote stays literal. */
const TOKEN = /(?:"[^"]*"|[^\s"]+|")+/g;

/**
 * Flags may sit anywhere. With `--regex`, double-quoted text is one verbatim token (spaces, backslashes
 * and flag-like words kept, quotes dropped); without it the query is split on whitespace.
 */
export function parseArgs(args: string): { query: string; all: boolean; limit: number; regex: boolean } | undefined {
	const tokens = args.match(TOKEN) ?? [];
	const regex = tokens.includes("--regex");
	const words = regex ? tokens : args.trim().split(/\s+/).filter(Boolean);
	const query: string[] = [];
	let all = false;
	let limit = DEFAULT_LIMIT;
	for (let i = 0; i < words.length; i++) {
		const w = words[i];
		if (w === "--all") all = true;
		else if (w === "--regex") continue;
		else if (w === "--limit" || w.startsWith("--limit=")) {
			const v = w === "--limit" ? words[++i] : w.slice("--limit=".length);
			if (!v || !/^\d+$/.test(v) || Number(v) < 1) return undefined;
			limit = Number(v);
		} else query.push(regex ? w.replace(/"([^"]*)"/g, "$1") : w);
	}
	const text = query.join(" ");
	return text ? { query: text, all, limit, regex } : undefined;
}

/** One line: whitespace runs collapsed to single spaces, ends trimmed. */
export function flat(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * One-line inline-markdown text that renders as the literal text (picker labels and notes go through
 * omp's inline markdown). ASCII punctuation is backslash-escaped, so no emphasis, code span, HTML,
 * link or `$` math can form. `(`, `)` and `[` stay bare: omp's inline math extension runs before
 * escapes and reads `\(` / `\[` as math openers. A source backslash before them becomes `\\`, which
 * the escape rule consumes first.
 */
export function cell(text: string): string {
	return flat(text).replace(/[!-'*-/:-@\\-`{-~]/g, "\\$&");
}

export function formatDate(at: number): string {
	return Number.isFinite(at) ? new Date(at).toISOString().slice(5, 16).replace("T", " ") : "";
}

export interface Item {
	label: string;
	description: string;
}

/**
 * Picker rows: `head` names the columns; each label is `i. ` and the row's columns padded to line up
 * (padding capped at COLUMN_CAP, longer values overflow) and its description is the note. `escape`
 * makes a value show literally on the target surface; padding stays outside it. The number keeps
 * labels unique and gives `1.`-`9.` the selector's digit quick-pick.
 */
export function layout(rows: Row[], mode: Mode, escape: (text: string) => string): { head: string; items: Item[] } {
	const full = mode === "full";
	const names = ["Session", "Project", "Title", "Date (UTC)", ...(full ? ["Location"] : [])];
	const table = rows.map(r =>
		[r.session, r.project, r.title, formatDate(r.at), ...(full ? [r.location] : [])].map(flat),
	);
	const widths = names.map((name, c) =>
		Math.min(COLUMN_CAP, Math.max(Bun.stringWidth(name), ...table.map(t => Bun.stringWidth(t[c])))),
	);
	const line = (cells: string[], esc: (text: string) => string) =>
		cells
			.map((t, c) => (c === cells.length - 1 ? esc(t) : esc(t) + " ".repeat(Math.max(0, widths[c] - Bun.stringWidth(t)))))
			.join("  ");
	const number = String(rows.length).length + 2;
	return {
		head: `${" ".repeat(number)}${line(names, flat)}  · Note below`,
		items: table.map((cells, i) => ({
			label: `${i + 1}.`.padEnd(number) + line(cells, escape),
			description: escape(rows[i].note),
		})),
	};
}

export default function searchArchive(pi: ExtensionAPI) {
	const run = (mode: Mode, command: string) => async (args: string, ctx: ExtensionCommandContext) => {
		// omp's prompt history keeps every typed command line; a query typed into this dialog stays out of it.
		let text = args;
		if (!text.trim() && ctx.mode === "tui") {
			const typed = await ctx.ui.input(`/${command}: search past sessions`, "<query> [--all] [--limit N] [--regex]");
			if (!typed?.trim()) return;
			text = typed;
		}
		const parsed = parseArgs(text);
		let matcher: Matcher | undefined;
		try {
			matcher = parsed && (parsed.regex ? compileRegex(parsed.query) : compileQuery(parsed.query));
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error;
			const reason = error.message.replace(/^Invalid regular expression:\s*/, "");
			ctx.ui.notify(`Invalid regular expression "${flat(parsed?.query ?? "")}": ${reason}. Nothing was searched.`, "warning");
			return;
		}
		if (!parsed || !matcher) {
			ctx.ui.notify(
				`Usage: /${command} <query> [--all] [--limit N] [--regex], or /${command} alone to type the query in a dialog (TUI)`,
				"warning",
			);
			return;
		}
		const { rows, limited } = await search({
			root: join(pi.pi.getAgentDir(), "sessions"),
			cwd: ctx.cwd,
			all: parsed.all,
			excludeId: ctx.sessionManager.getSessionId(),
			matcher,
			mode,
			limit: parsed.limit,
		});
		// Shown, never saved: a picker in the TUI, a notification elsewhere; no session entry, no file.
		const scope = `scope: ${parsed.all ? "all projects" : `this project (${tilde(ctx.cwd)})`}`;
		const query = `${parsed.regex ? "regex " : ""}"${flat(parsed.query)}"`;
		if (!rows.length) {
			ctx.ui.notify(`No results for ${query} · ${scope}`, "info");
			return;
		}
		const heading = [`${rows.length} results for ${query} · ${scope}`];
		if (limited) heading.push(`Showing the first ${parsed.limit} results; use --limit N for more.`);
		if (ctx.mode !== "tui") {
			const { head, items } = layout(rows, mode, flat);
			const report = items.flatMap(i => (i.description ? [i.label, `    ${i.description}`] : [i.label]));
			ctx.ui.notify([...heading, "", head, ...report].join("\n"), "info");
			if (ctx.ui.supportsEditor === true) ctx.ui.setEditorText(`/resume ${rows[0].session}`);
			return;
		}
		const { head, items } = layout(rows, mode, cell);
		const picked = await ctx.ui.select([...heading, head].join("\n"), items);
		const row = rows[items.findIndex(i => i.label === picked)];
		if (!row) return;
		// The extension switch has no cwd-change hook, so omp rejects another project's session there;
		// `/resume` moves the process to that project.
		if (resolve(row.cwd) === resolve(ctx.cwd) && !(await ctx.switchSession(row.file)).cancelled) return;
		ctx.ui.setEditorText(`/resume ${row.session}`);
	};

	pi.registerCommand("search-archive", {
		description:
			"Search past sessions' user and model messages. Usage: /search-archive <query> [--all] [--limit N] [--regex]; bare: type the query in a dialog, kept out of prompt history",
		handler: run("archive", "search-archive"),
	});
	pi.registerCommand("search-full", {
		description:
			"Search past sessions including thinking, tool calls and tool output. Usage: /search-full <query> [--all] [--limit N] [--regex]; bare: type the query in a dialog, kept out of prompt history",
		handler: run("full", "search-full"),
	});
}
