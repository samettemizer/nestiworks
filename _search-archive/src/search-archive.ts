import type { Dirent } from "node:fs";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";

export type Mode = "archive" | "full";

export const USER = "Kullanıcı mesajı";
export const REPLY = "Model yanıtı";
export const THINKING = "Model düşüncesi";
export const TITLE = "Oturum başlığı";
export const DEFAULT_LIMIT = 50;
const SNIPPET_WIDTH = 150;
const CUSTOM_TYPE = "search-archive";

export interface Unit {
	location: string;
	text: string;
	at: number;
}

export interface Row {
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
	return {
		test: text => {
			const norm = normalize(text);
			return patterns.every(p => p.test(norm));
		},
		snippet: (text, width = SNIPPET_WIDTH) => snippet(text, patterns, width),
	};
}

/** Single-line excerpt of about `width` characters centered on the earliest hit. */
function snippet(text: string, patterns: RegExp[], width: number): string {
	const chars = Array.from(text.replace(/\s+/g, " ").trim());
	if (chars.length <= width) return chars.join("");
	// Normalize per character so a hit in the normalized text maps back to an original position.
	let norm = "";
	const origin: number[] = [];
	chars.forEach((c, i) => {
		const n = c.charCodeAt(0) < 128 ? c.toLowerCase() : normalize(c);
		norm += n;
		for (let k = 0; k < n.length; k++) origin.push(i);
	});
	let from = 0;
	let to = 0;
	let best = Number.POSITIVE_INFINITY;
	for (const p of patterns) {
		const m = p.exec(norm);
		if (m && m.index < best && m[0].length > 0) {
			best = m.index;
			from = origin[m.index];
			to = origin[m.index + m[0].length - 1] + 1;
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
				add(toolLabel("Araç çağrısı", name), [...(name ? [name] : []), ...values(b.arguments)].join("\n"));
			}
		}
	} else if (m.role === "toolResult" && mode === "full") {
		const name = typeof m.toolName === "string" && m.toolName ? m.toolName : undefined;
		add(toolLabel("Araç çıktısı", name), blockText(m.content, "text", "text"));
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
	const base = { session: header.id.slice(0, 13), project: tilde(String(header.cwd ?? "")), title };
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

export function parseArgs(args: string): { query: string; all: boolean; limit: number } | undefined {
	const words = args.trim().split(/\s+/).filter(Boolean);
	const query: string[] = [];
	let all = false;
	let limit = DEFAULT_LIMIT;
	for (let i = 0; i < words.length; i++) {
		const w = words[i];
		if (w === "--all") all = true;
		else if (w === "--limit" || w.startsWith("--limit=")) {
			const v = w === "--limit" ? words[++i] : w.slice("--limit=".length);
			if (!v || !/^\d+$/.test(v) || Number(v) < 1) return undefined;
			limit = Number(v);
		} else query.push(w);
	}
	return query.length > 0 ? { query: query.join(" "), all, limit } : undefined;
}

/**
 * One-line markdown table cell that renders as the literal text. ASCII punctuation is backslash-escaped,
 * so a `|` always has an odd run of backslashes before it (cell-safe for omp's parser, cmark-gfm and
 * marked) and no emphasis, code span, HTML or `$` math can form; `]` escaped blocks links. `(`, `)` and
 * `[` stay bare: omp's inline math extension runs before escapes and reads `\(` / `\[` as math openers.
 * A source backslash before them becomes `\\`, which the escape rule consumes first.
 */
export function cell(text: string): string {
	return text.replace(/\s+/g, " ").trim().replace(/[!-'*-/:-@\\-`{-~]/g, "\\$&");
}

export function formatDate(at: number): string {
	return Number.isFinite(at) ? new Date(at).toISOString().slice(5, 16).replace("T", " ") : "";
}

export function renderTable(rows: Row[], mode: Mode): string {
	const full = mode === "full";
	const line = (cells: string[]) => `| ${cells.map(cell).join(" | ")} |`;
	const head = ["Oturum", "Proje", "Başlık", "Tarih (UTC)", ...(full ? ["Konum"] : []), "Not"];
	return [
		line(head),
		`|${head.map(() => " --- ").join("|")}|`,
		...rows.map(r =>
			line([r.session, r.project, r.title, formatDate(r.at), ...(full ? [r.location] : []), r.note]),
		),
	].join("\n");
}

export default function searchArchive(pi: ExtensionAPI) {
	const run = (mode: Mode, command: string) => async (args: string, ctx: ExtensionCommandContext) => {
		const parsed = parseArgs(args);
		const matcher = parsed && compileQuery(parsed.query);
		if (!parsed || !matcher) {
			ctx.ui.notify(`Kullanım: /${command} <sorgu> [--all] [--limit N]`, "warning");
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
		const scope = `kapsam: ${parsed.all ? "tüm projeler" : `bu proje (${cell(tilde(ctx.cwd))})`}`;
		const query = `**"${cell(parsed.query)}"**`;
		const lines = rows.length
			? [`${query} için ${rows.length} sonuç · ${scope}`, "", renderTable(rows, mode)]
			: [`${query} için sonuç bulunamadı · ${scope}`];
		if (limited) lines.push("", `İlk ${parsed.limit} sonuç gösteriliyor; daha fazlası için \`--limit N\`.`);
		pi.sendMessage({ customType: CUSTOM_TYPE, content: lines.join("\n"), display: true, excludeFromContext: true });
		if (rows.length && ctx.ui.supportsEditor === true) ctx.ui.setEditorText(`/resume ${rows[0].session}`);
	};

	pi.registerCommand("search-archive", {
		description: "Search past sessions' user and model messages. Usage: /search-archive <query> [--all] [--limit N]",
		handler: run("archive", "search-archive"),
	});
	pi.registerCommand("search-full", {
		description:
			"Search past sessions including thinking, tool calls and tool output. Usage: /search-full <query> [--all] [--limit N]",
		handler: run("full", "search-full"),
	});
}
