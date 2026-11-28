import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import searchArchive, {
	cell,
	compileQuery,
	compileRegex,
	flat,
	formatDate,
	type Item,
	layout,
	type Matcher,
	messageUnits,
	parseArgs,
	REPLY,
	type Row,
	scanSession,
	search,
	THINKING,
	TITLE,
	tilde,
	TOOL_RESULT_LINE,
	USER,
} from "../src/search-archive";

const FIXTURE = join(import.meta.dir, "fixture.jsonl");

function matcher(query: string): Matcher {
	const m = compileQuery(query);
	if (!m) throw new Error(`empty query: ${query}`);
	return m;
}

test("every word must start some word, in any order and position", () => {
	const m = matcher("gcloud logging");
	expect(m.test("Install gcloud first, then enable Cloud Logging.")).toBe(true);
	expect(m.test("Logging is on; gcloud is installed")).toBe(true);
	expect(m.test("Cloud Logging only")).toBe(false);
	expect(m.test("gcloud only")).toBe(false);
});

test("words match as prefixes only", () => {
	expect(matcher("log").test("Cloud Logging")).toBe(true);
	expect(matcher("ogging").test("Cloud Logging")).toBe(false);
	expect(matcher("arch").test("Archive")).toBe(true);
	expect(matcher("chiv").test("archive")).toBe(false);
	expect(matcher("logging").test("log")).toBe(false);
});

test("case and accents (Turkish included) are ignored", () => {
	expect(matcher("istanbul sgu").test("İSTANBUL ŞĞÜ")).toBe(true);
	expect(matcher("İstanbul şğü").test("istanbul sgu")).toBe(true);
	expect(matcher("ılık").test("ILIK su")).toBe(true);
	expect(matcher("ILIK").test("ılık su")).toBe(true);
	expect(matcher("cafe").test("Café au lait")).toBe(true);
	expect(matcher("naive resume").test("Naïve RÉSUMÉ")).toBe(true);
});

test("punctuation inside a query word matches punctuation or space, parts adjacent", () => {
	const m = matcher("git-commit");
	expect(m.test("run git commit now")).toBe(true);
	expect(m.test("run git/commit now")).toBe(true);
	expect(m.test("run git-commit now")).toBe(true);
	expect(m.test("git and then commit")).toBe(false);
	expect(m.test("gitlab commit")).toBe(false);
	expect(matcher("a/b").test("alpha and beta")).toBe(false);
	expect(matcher("a/b").test("alpha beta")).toBe(false);
	expect(matcher("a/b").test("plan a, beta")).toBe(true);
	expect(compileQuery("  -- ** ")).toBeUndefined();
});

test("snippet is one line, centered on the first hit, with ellipsis", () => {
	const m = matcher("needle");
	const text = `${"a ".repeat(200)}\n\nthe NEEDLE here\n${"b ".repeat(200)}`;
	const s = m.snippet(text);
	expect(s.startsWith("…")).toBe(true);
	expect(s.endsWith("…")).toBe(true);
	expect(s).not.toContain("\n");
	expect(s).toContain("the NEEDLE here");
	expect(Array.from(s).length).toBeLessThanOrEqual(152);
	expect(m.snippet("short needle text")).toBe("short needle text");
	// The hit maps back correctly after accented characters.
	const accented = `${"ğüşiöç ".repeat(40)}İĞNE${" x".repeat(100)}`;
	expect(matcher("igne").snippet(accented)).toContain("İĞNE");
});

test("regex mode: case-insensitive JavaScript regex on the raw text, not word prefixes", () => {
	const deploy = compileRegex("deploy.*(staging|prod)");
	expect(deploy.test("Deploy to PROD now")).toBe(true);
	expect(deploy.test("we deploy on Staging")).toBe(true);
	expect(deploy.test("DEPLOY.. prod")).toBe(true);
	expect(deploy.test("deployment notes")).toBe(false);
	const status = compileRegex("error \\d{3}");
	expect(status.test("ERROR 404 from the API")).toBe(true);
	expect(status.test("error 12")).toBe(false);
	expect(compileRegex("LOGGING").test("cloud logging")).toBe(true);
	// Infix hits, which word mode rejects.
	expect(compileRegex("ogging").test("Cloud Logging")).toBe(true);
	expect(matcher("ogging").test("Cloud Logging")).toBe(false);
	// No accent folding: the pattern is literal apart from case.
	expect(compileRegex("café").test("CAFÉ au lait")).toBe(true);
	expect(compileRegex("cafe").test("Café au lait")).toBe(false);
});

test("regex mode: invalid patterns throw SyntaxError", () => {
	for (const p of ["(", "[", "*", "a{2,1}"]) expect(() => compileRegex(p)).toThrow(SyntaxError);
});

test("regex mode: snippet centers on the first hit; zero-length matches are safe", () => {
	const long = `${"b ".repeat(200)}the Café here${" c".repeat(200)}`;
	const s = compileRegex("caf.").snippet(long);
	expect(s).toContain("the Café here");
	expect(s.startsWith("…") && s.endsWith("…")).toBe(true);
	expect(Array.from(s).length).toBeLessThanOrEqual(152);
	// `a*` matches everywhere, empty at first; the excerpt centers on the first non-empty run.
	const stars = compileRegex("a*");
	const runs = `${"b ".repeat(200)}aaaa${" c".repeat(200)}`;
	expect(stars.test("xyz")).toBe(true);
	expect(stars.snippet(runs)).toContain("aaaa");
	// Only empty matches: the excerpt falls back to the start.
	for (const p of ["x*", "^", "(?:)"]) {
		const m = compileRegex(p);
		expect(m.test(runs)).toBe(true);
		const e = m.snippet(runs);
		expect(e.startsWith("b b")).toBe(true);
		expect(Array.from(e).length).toBeLessThanOrEqual(151);
	}
});

test("archive mode: only user-typed and model text; malformed lines skipped", async () => {
	const rows = await scanSession(FIXTURE, matcher("gcloud logging"), "archive", () => true);
	expect(rows?.map(r => [r.location, r.at, r.note])).toEqual([
		[REPLY, Date.parse("2026-11-20T10:01:00Z"), "First install the gcloud CLI, then enable the Cloud Logging API."],
		[USER, Date.parse("2026-11-20T10:00:00Z"), "how do I enable gcloud logging?"],
	]);
	expect(rows?.[0]).toMatchObject({ session: "01aaaaaa-0001", project: "/proj/a", title: "Logging | setup" });
});

test("full mode labels thinking, tool calls and tool output", async () => {
	const rows = await scanSession(FIXTURE, matcher("gcloud logging"), "full", () => true);
	expect(rows?.map(r => r.location)).toEqual([
		"Tool output (bash)",
		"Tool call (bash)",
		REPLY,
		THINKING,
		USER,
	]);
	expect(rows?.[1].note).toBe("bash gcloud logging read --limit 5 30");
	// Tool arguments are matched by value: `--limit 5` and the numeric timeout are searchable.
	expect((await scanSession(FIXTURE, matcher("limit 30"), "full", () => true))?.map(r => r.location)).toEqual([
		"Tool call (bash)",
	]);
	expect(await scanSession(FIXTURE, matcher("permission denied"), "archive", () => true)).toEqual([]);
});

test("title hit row: slot title wins over title_change; dated at session start", async () => {
	const rows = await scanSession(FIXTURE, matcher("setup"), "full", () => true);
	expect(rows).toEqual([
		{
			file: FIXTURE,
			cwd: "/proj/a",
			session: "01aaaaaa-0001",
			project: "/proj/a",
			title: "Logging | setup",
			at: Date.parse("2026-11-20T09:59:00Z"),
			location: TITLE,
			note: "Logging | setup",
		},
	]);
	expect(await scanSession(FIXTURE, matcher("setup"), "full", () => false)).toBeUndefined();
});

test("rows inside a session are strictly newest first, title row included", async () => {
	const rows = await scanSession(FIXTURE, matcher("logging"), "archive", () => true);
	expect(rows?.map(r => [r.location, r.at])).toEqual([
		[REPLY, Date.parse("2026-11-20T10:01:00Z")],
		[USER, Date.parse("2026-11-20T10:00:00Z")],
		[TITLE, Date.parse("2026-11-20T09:59:00Z")],
	]);
	const dir = await mkdtemp(join(tmpdir(), "search-archive-"));
	try {
		// A title newer than some messages sorts between them; an undated row goes last.
		const file = join(dir, "s.jsonl");
		const undated = assistant("bogus", "needle undated");
		await writeFile(
			file,
			[
				{ type: "session", id: "01bbbbbb-0001", timestamp: "2026-11-20T10:00:30Z", cwd: "/p", title: "needle title" },
				assistant("2026-11-20T10:01:00Z", "needle late"),
				{ ...undated, message: { ...undated.message, timestamp: undefined } },
				assistant("2026-11-20T10:00:00Z", "needle early"),
			]
				.map(e => JSON.stringify(e))
				.join("\n"),
		);
		const mixed = await scanSession(file, matcher("needle"), "archive", () => true);
		expect(mixed?.map(r => r.note)).toEqual(["needle late", "needle title", "needle early", "needle undated"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

function assistant(at: string, text: string, extra: object[] = []) {
	return {
		type: "message",
		id: "m",
		parentId: null,
		timestamp: at,
		message: { role: "assistant", content: [{ type: "text", text }, ...extra], timestamp: Date.parse(at) },
	};
}

test("title_change and toolResult are decided by the parsed entry, not nested look-alikes", async () => {
	const dir = await mkdtemp(join(tmpdir(), "search-archive-"));
	try {
		const file = join(dir, "s.jsonl");
		const lookAlike = {
			type: "toolCall",
			id: "t",
			name: "eval",
			arguments: { type: "title_change", title: "fake", message: { role: "toolResult" } },
		};
		await writeFile(
			file,
			[
				{ type: "session", id: "01bbbbbb-0002", timestamp: "2026-11-20T10:00:00Z", cwd: "/p" },
				{ type: "title_change", id: "c", parentId: null, timestamp: "2026-11-20T10:00:01Z", title: "Real title" },
				assistant("2026-11-20T10:01:00Z", "needle in the reply", [lookAlike]),
				{
					type: "message",
					id: "r",
					parentId: "m",
					timestamp: "2026-11-20T10:02:00Z",
					message: { role: "toolResult", toolCallId: "t", toolName: "eval", content: [{ type: "text", text: "needle out" }] },
				},
			]
				.map(e => JSON.stringify(e))
				.join("\n"),
		);
		const archive = await scanSession(file, matcher("needle"), "archive", () => true);
		expect(archive?.map(r => [r.location, r.title])).toEqual([[REPLY, "Real title"]]);
		const full = await scanSession(file, matcher("title change"), "full", () => true);
		expect(full?.map(r => r.location)).toEqual(["Tool call (eval)"]);
		expect((await scanSession(file, matcher("needle"), "full", () => true))?.map(r => r.location)).toEqual([
			"Tool output (eval)",
			REPLY,
		]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("toolResult prefilter matches only top-level tool results", () => {
	const entry = (message: object, extra: object = {}) =>
		JSON.stringify({ type: "message", id: "a", parentId: null, timestamp: "t", runtime: { version: "19.2.1" }, ...extra, message });
	expect(TOOL_RESULT_LINE.test(entry({ role: "toolResult", toolName: "bash", content: [] }))).toBe(true);
	expect(TOOL_RESULT_LINE.test(entry({ role: "toolResult" }, { runtime: undefined }))).toBe(true);
	const lookAlikes = [
		entry({ role: "assistant", content: [{ type: "toolCall", arguments: { message: { role: "toolResult" } } }] }),
		entry({ role: "user", content: 'a }","message":{"role":"toolResult"' }),
		entry({ role: "user", content: "x" }, { id: '"message":{"role":"toolResult"' }),
		entry({ role: "user", content: "}", message: { role: "toolResult" } }),
	];
	for (const line of lookAlikes) expect([line, TOOL_RESULT_LINE.test(line)]).toEqual([line, false]);
});

test("tools without a name get labels without parentheses", () => {
	const at = "2026-11-20T10:00:00Z";
	const call = messageUnits(assistant(at, "", [{ type: "toolCall", id: "t", arguments: { command: "needle" } }]), "full");
	expect(call).toEqual([{ location: "Tool call", text: "needle", at: Date.parse(at) }]);
	const result = messageUnits(
		{ timestamp: at, message: { role: "toolResult", toolName: "", content: [{ type: "text", text: "needle" }] } },
		"full",
	);
	expect(result).toEqual([{ location: "Tool output", text: "needle", at: Date.parse(at) }]);
});

function session(id: string, cwd: string, text: string, at: string): string {
	return [
		{ type: "session", version: 3, id, timestamp: at, cwd },
		{
			type: "message",
			id: "m1",
			timestamp: at,
			message: { role: "assistant", content: [{ type: "text", text }], timestamp: Date.parse(at) },
		},
	]
		.map(e => JSON.stringify(e))
		.join("\n");
}

const CURRENT = "01cccccc-0002-7000-8000-000000000002";

async function sessionsTree(): Promise<string> {
	const agentDir = await mkdtemp(join(tmpdir(), "search-archive-"));
	const root = join(agentDir, "sessions");
	const a = join(root, "-proj-a");
	const b = join(root, "-proj-b");
	await mkdir(join(a, "2026-11-20T09-59-00-000Z_01aaaaaa-0001"), { recursive: true }); // artifact dir, ignored
	await mkdir(b, { recursive: true });
	const files: [string, string, number][] = [
		[join(a, "s1.jsonl"), "", 1000],
		[join(a, "s2.jsonl"), session(CURRENT, "/proj/a", "gcloud logging (current)", "2026-11-21T08:00:00Z"), 4000],
		[join(a, "s3.jsonl"), session("01dddddd-0003-7000", "/proj/a", "Cloud Logging + gcloud", "2026-11-19T08:00:00Z"), 3000],
		[join(b, "s4.jsonl"), session("01eeeeee-0004-7000", "/proj/b", "gcloud logging in B", "2026-11-18T08:00:00Z"), 2000],
		[join(a, "2026-11-20T09-59-00-000Z_01aaaaaa-0001", "__advisor.x.jsonl"), session("01ffffff", "/proj/a", "gcloud logging", "2026-11-18T08:00:00Z"), 5000],
	];
	await copyFile(FIXTURE, files[0][0]);
	for (const [file, content, mtime] of files) {
		if (content) await writeFile(file, content);
		await utimes(file, mtime, mtime);
	}
	return agentDir;
}

test("scope: current project by default, --all widens, current session excluded, newest first", async () => {
	const agentDir = await sessionsTree();
	try {
		const base = { root: join(agentDir, "sessions"), cwd: "/proj/a", excludeId: CURRENT, mode: "archive" as const };
		const m = matcher("gcloud logging");
		const own = await search({ ...base, all: false, matcher: m, limit: 50 });
		expect(own.rows.map(r => r.session)).toEqual(["01dddddd-0003", "01aaaaaa-0001", "01aaaaaa-0001"]);
		expect(own.limited).toBe(false);
		// Exactly `limit` matches: nothing more exists, so no limit note.
		expect(await search({ ...base, all: false, matcher: m, limit: 3 })).toMatchObject({ limited: false });
		const all = await search({ ...base, all: true, matcher: m, limit: 50 });
		expect(all.rows.map(r => r.session)).toEqual(["01dddddd-0003", "01eeeeee-0004", "01aaaaaa-0001", "01aaaaaa-0001"]);
		const limited = await search({ ...base, all: true, matcher: m, limit: 2 });
		expect(limited).toMatchObject({ limited: true });
		expect(limited.rows.map(r => r.session)).toEqual(["01dddddd-0003", "01eeeeee-0004"]);
		expect(await search({ ...base, all: true, matcher: m, limit: 3 })).toMatchObject({ limited: true });
		expect(await search({ ...base, all: true, matcher: m, limit: 4 })).toMatchObject({ limited: false });
		const missing = await search({ ...base, root: join(agentDir, "nope"), all: true, matcher: m, limit: 50 });
		expect(missing.rows).toEqual([]);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

const row: Row = {
	file: "/s/x.jsonl",
	cwd: "/home/u/www/x",
	session: "01aaaaaa-0001",
	project: "~/www/x",
	title: "a | b\nc",
	at: Date.parse("2026-11-20T10:01:00Z"),
	location: "Tool output (bash)",
	note: "x|y\nz",
};

test("layout: header, column order, padding, literal escaping", () => {
	expect(layout([row], "archive")).toEqual({
		head: "   Session        Project  Title    Date (UTC)  · Note below",
		items: [{ label: "1. 01aaaaaa\\-0001  \\~\\/www\\/x  a \\| b c  11\\-20 10\\:01", description: "x\\|y z" }],
	});
	expect(layout([row], "full")).toEqual({
		head: "   Session        Project  Title    Date (UTC)   Location  · Note below",
		items: [
			{
				label: "1. 01aaaaaa\\-0001  \\~\\/www\\/x  a \\| b c  11\\-20 10\\:01  Tool output (bash)",
				description: "x\\|y z",
			},
		],
	});
	// Ten rows: numbers padded after the dot (`1. ` keeps digit quick-pick); padding capped at 40 columns.
	const rows = Array.from({ length: 10 }, (_, i) => ({ ...row, title: i === 9 ? "t".repeat(60) : "short" }));
	const { head, items } = layout(rows, "archive");
	expect(items[0].label).toStartWith("1.  01aaaaaa\\-0001");
	expect(items[9].label).toStartWith("10. 01aaaaaa\\-0001");
	expect(items[0].label).toBe(`1.  01aaaaaa\\-0001  \\~\\/www\\/x  short${" ".repeat(35)}  11\\-20 10\\:01`);
	expect(items[9].label).toBe(`10. 01aaaaaa\\-0001  \\~\\/www\\/x  ${"t".repeat(60)}  11\\-20 10\\:01`);
	// Padding is measured on the literal text, so columns line up once the escapes render.
	expect(head.indexOf("Date")).toBe(4 + decodeInline(items[0].label.slice(4)).indexOf("11-20"));
	expect(flat("  a\r\n\tb | c  ")).toBe("a b | c");
	expect(cell("  a\r\n\tb | c  ")).toBe("a b \\| c");
	expect(cell("a\\|b")).toBe("a\\\\\\|b");
	expect(cell("end\\")).toBe("end\\\\");
	expect(cell("`x|y` *z*")).toBe("\\`x\\|y\\` \\*z\\*");
	expect(cell("\\(x) [a](b) $5")).toBe("\\\\(x) [a\\](b) \\$5");
	expect(formatDate(Number.NaN)).toBe("");
	expect(tilde(join(homedir(), "www", "x"))).toBe("~/www/x");
	expect(tilde(homedir())).toBe("~");
	expect(tilde("/srv/x")).toBe("/srv/x");
});

/**
 * Inline pass as omp runs it on picker labels and notes (`plainInlineMarkdown`): its `omp-math`
 * extension is tried before escapes and opens at `$`, `\(` or `\[` (math-delimiters.ts `Ntt`), so any
 * of those not consumed by a preceding escape fails. Other bare punctuation that could start markup
 * (emphasis, code, links, HTML, strike) fails too; `(`, `)` and `[` are inert on their own.
 */
function decodeInline(text: string): string {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		const next = text[i + 1] ?? "";
		if (c === "$" || (c === "\\" && (next === "(" || next === "["))) {
			throw new Error(`math opener at ${i} in ${JSON.stringify(text)}`);
		}
		if (c === "\\" && /[!-/:-@[-`{-~]/.test(next)) {
			out += next;
			i++;
		} else if (/[!-'*-/:-@\\-`{-~]/.test(c)) {
			throw new Error(`bare ${c} at ${i} in ${JSON.stringify(text)}`);
		} else out += c;
	}
	return out;
}

test("escaped labels and notes round-trip to the literal text under omp's inline markdown", () => {
	const at = Date.parse("2026-11-20T10:01:00Z");
	const base = { file: "/s/x.jsonl", cwd: "/x", at, location: "Tool call (bash)" };
	const rows: Row[] = [
		{ ...base, session: "a|b", project: "a\\|b", title: "a\\\\|b", note: "`code | x` *em* <b>&amp; [l](u) \\" },
		{ ...base, session: "(x)", project: "[a](b)", title: "[x]", note: "$5 and $6 \\(m\\) \\[n\\] $$z$$ ~~s~~ ![i](j)" },
		{ ...base, session: "s", project: "p", title: "trailing\\", location: "x  y", note: "" },
	];
	const { items } = layout(rows, "full");
	rows.forEach((r, i) => {
		// Columns are separated by two or more spaces; `flat` leaves at most one space inside a value.
		expect(decodeInline(items[i].label.slice(3)).split(/ {2,}/)).toEqual(
			[r.session, r.project, r.title, "11-20 10:01", r.location].map(flat),
		);
		expect(decodeInline(items[i].description)).toBe(flat(r.note));
	});
	// The rule rejects what the previous escaping produced: an escaped paren or a bare `$` opens math.
	expect(() => decodeInline("Date \\(UTC\\)")).toThrow("math opener");
	expect(() => decodeInline("$5")).toThrow("math opener");
});

test("argument parsing", () => {
	expect(parseArgs("gcloud logging")).toEqual({ query: "gcloud logging", all: false, limit: 50, regex: false });
	expect(parseArgs("gcloud --all logging --limit 5")).toEqual({ query: "gcloud logging", all: true, limit: 5, regex: false });
	expect(parseArgs("--limit=7 x")).toEqual({ query: "x", all: false, limit: 7, regex: false });
	expect(parseArgs("x --limit")).toBeUndefined();
	expect(parseArgs("x --limit 0")).toBeUndefined();
	expect(parseArgs("x --limit abc")).toBeUndefined();
	expect(parseArgs("--all")).toBeUndefined();
	expect(parseArgs("   ")).toBeUndefined();
	// Without --regex, quotes are not special and flags are found by whitespace split, as before.
	expect(parseArgs('"x --all y"')).toEqual({ query: '"x y"', all: true, limit: 50, regex: false });
});

test("argument parsing with --regex: any position, quoted patterns verbatim", () => {
	expect(parseArgs('--regex "deploy.*(staging|prod)"')).toEqual({
		query: "deploy.*(staging|prod)",
		all: false,
		limit: 50,
		regex: true,
	});
	expect(parseArgs('"error \\d{3}"  --all --regex')).toEqual({ query: "error \\d{3}", all: true, limit: 50, regex: true });
	expect(parseArgs("--limit 3 err\\w+ --regex --all")).toEqual({ query: "err\\w+", all: true, limit: 3, regex: true });
	// Inside quotes, spaces and flag-like words are part of the pattern.
	expect(parseArgs('--regex "a  --all b"')).toEqual({ query: "a  --all b", all: false, limit: 50, regex: true });
	// Unquoted words join with one space; an unclosed quote stays literal.
	expect(parseArgs('--regex say "hi')).toEqual({ query: 'say "hi', all: false, limit: 50, regex: true });
	// A quoted "--regex" is a pattern, not the flag.
	expect(parseArgs('"--regex"')).toEqual({ query: '"--regex"', all: false, limit: 50, regex: false });
	expect(parseArgs("--regex")).toBeUndefined();
	expect(parseArgs('--regex ""')).toBeUndefined();
	expect(parseArgs("--regex --all")).toBeUndefined();
	expect(parseArgs('--regex "x" --limit 0')).toBeUndefined();
});

test("commands: bare only; the dialog query opens the picker, which resumes the pick; nothing sent or saved", async () => {
	const agentDir = await sessionsTree();
	const root = join(agentDir, "sessions");
	const leaked: unknown[] = [];
	try {
		type Command = { description: string; handler: (args: string, ctx: unknown) => Promise<void> };
		const plugin = (dir: string) => {
			const commands = new Map<string, Command>();
			const pi = {
				pi: { getAgentDir: () => dir },
				registerCommand: (name: string, def: Command) => commands.set(name, def),
				sendMessage: (...args: unknown[]) => leaked.push(["sendMessage", args]),
				sendUserMessage: (...args: unknown[]) => leaked.push(["sendUserMessage", args]),
				appendEntry: (...args: unknown[]) => leaked.push(["appendEntry", args]),
			};
			searchArchive(pi as never);
			return commands;
		};
		const commands = plugin(agentDir);
		expect([...commands.keys()]).toEqual(["search-archive", "search-full"]);
		expect(commands.get("search-archive")?.description).toBe("Open the session search dialog (titles and messages)");
		expect(commands.get("search-full")?.description).toBe(
			"Open the full session search dialog (also thinking, tool calls and output)",
		);
		for (const { description } of commands.values()) expect(description).not.toMatch(/<query>|--|usage/i);

		const ctx = (mode: string, o: { pick?: (labels: string[]) => string | undefined; cancelled?: boolean; typed?: string } = {}) => {
			const c = {
				mode,
				cwd: "/proj/a",
				editor: [] as string[],
				notes: [] as string[],
				switched: [] as string[],
				selects: [] as { title: string[]; items: Item[] }[],
				inputs: [] as unknown[][],
				widgets: [] as [string, string[] | undefined][],
				events: [] as string[],
				sessionManager: { getSessionId: () => CURRENT },
				switchSession: async (file: string) => {
					c.switched.push(file);
					return { cancelled: o.cancelled ?? false };
				},
				ui: {
					input: async (...args: unknown[]) => {
						c.inputs.push(args);
						c.events.push("input");
						return o.typed;
					},
					setWidget: (key: string, lines?: string[]) => {
						c.widgets.push([key, lines]);
						c.events.push(lines ? "hints" : "clear");
					},
					select: async (title: string, items: Item[]) => {
						c.selects.push({ title: title.split("\n"), items });
						return o.pick?.(items.map(i => i.label));
					},
					setEditorText: (t: string) => c.editor.push(t),
					notify: (t: string) => c.notes.push(t),
				},
			};
			return c;
		};
		type Ctx = ReturnType<typeof ctx>;
		const run = (name: string, args: string, c: Ctx) => commands.get(name)?.handler(args, c);
		const dialog = async (name: string, typed: string | undefined, o: Parameters<typeof ctx>[1] = {}) => {
			const c = ctx("tui", { ...o, typed });
			await run(name, "", c);
			return c;
		};
		const sessions = (c: Ctx) => c.selects[0].items.map(i => i.label.split("  ")[0]);
		const untouched = (c: Ctx) => [c.inputs, c.widgets, c.selects, c.switched, c.editor];

		// Bare command: usage hints sit above the dialog while it is open; its title is the only text it shows.
		const tui = await dialog("search-archive", "gcloud logging", { pick: labels => labels[0] });
		expect(tui.events).toEqual(["hints", "input", "clear"]);
		expect(tui.inputs).toEqual([['/search-archive: words or --regex "pattern" [--all] [--limit N]']]);
		const [key, hints] = tui.widgets[0];
		expect(tui.widgets[1]).toEqual([key, undefined]);
		expect(hints).toEqual([
			"Searches session titles, your messages and the model's replies (this project by default).",
			"Words: each must start a word of the same message, in any order; case and accents are ignored.",
			'--regex "pattern": one case-insensitive JavaScript regular expression on the raw text instead of words.',
			"--all: every project · --limit N: at most N rows (default 50)",
		]);
		// Picking a same-project row resumes it.
		expect(tui.selects).toHaveLength(1);
		expect(tui.selects[0].title).toEqual([
			'3 results for "gcloud logging" · scope: this project (/proj/a)',
			"   Session        Project  Title            Date (UTC)  · Note below",
		]);
		expect(sessions(tui)).toEqual(["1. 01dddddd\\-0003", "2. 01aaaaaa\\-0001", "3. 01aaaaaa\\-0001"]);
		expect(tui.selects[0].items[0].description).toBe("Cloud Logging \\+ gcloud");
		expect(tui.selects[0].items.map(i => i.description).join(" ")).not.toContain("current");
		expect(tui.switched).toEqual([join(root, "-proj-a", "s3.jsonl")]);
		expect(tui.editor).toEqual([]);
		expect(tui.notes).toEqual([]);

		// A vetoed switch falls back to prefilling `/resume` for that row.
		const vetoed = await dialog("search-archive", "gcloud logging", { pick: labels => labels[1], cancelled: true });
		expect(vetoed.switched).toEqual([join(root, "-proj-a", "s1.jsonl")]);
		expect(vetoed.editor).toEqual(["/resume 01aaaaaa-0001"]);

		// Another project's row: no switch (omp would reject the cwd change), `/resume` prefilled.
		const other = await dialog("search-archive", "gcloud logging --all", { pick: labels => labels[1] });
		expect(other.selects[0].title[0]).toBe('4 results for "gcloud logging" · scope: all projects');
		expect(sessions(other)[1]).toBe("2. 01eeeeee\\-0004");
		expect(other.switched).toEqual([]);
		expect(other.editor).toEqual(["/resume 01eeeeee-0004"]);

		// Esc in the picker: nothing happens. /search-full names its wider scope above its dialog.
		const esc = await dialog("search-full", "permission denied --all", { pick: () => undefined });
		expect(esc.inputs).toEqual([['/search-full: words or --regex "pattern" [--all] [--limit N]']]);
		expect(esc.widgets[0][1]?.[0]).toBe(
			"Searches session titles, your messages, the model's replies and thinking, tool calls and tool output (this project by default).",
		);
		expect(esc.selects[0].title[1]).toContain("  Location  · Note below");
		expect(esc.selects[0].items.some(i => i.label.endsWith("  Tool output (bash)"))).toBe(true);
		expect(esc.switched).toEqual([]);
		expect(esc.editor).toEqual([]);

		const none = await dialog("search-archive", "zzzz-nothing");
		expect(none.notes).toEqual(['No results for "zzzz-nothing" · scope: this project (/proj/a)']);
		expect([none.selects, none.editor]).toEqual([[], []]);

		expect((await dialog("search-archive", "gcloud logging --limit 3")).selects[0].title).toHaveLength(2);
		const limit = await dialog("search-full", "gcloud logging --all --limit 2", { pick: () => undefined });
		expect(limit.selects[0].title).toEqual([
			'2 results for "gcloud logging" · scope: all projects',
			"Showing the first 2 results; use --limit N for more.",
			"   Session        Project  Title  Date (UTC)   Location  · Note below",
		]);

		// Dialog dismissed or left empty (bare or whitespace-only command): nothing at all.
		for (const [args, typed] of [["", undefined], ["  ", "   "]] as const) {
			const dismissed = ctx("tui", { typed });
			await run("search-archive", args, dismissed);
			expect(dismissed.events).toEqual(["hints", "input", "clear"]);
			expect([dismissed.selects, dismissed.notes, dismissed.editor, dismissed.switched]).toEqual([[], [], [], []]);
		}

		// Invalid dialog input (flags without a query, a bad limit): one warning, no search.
		for (const typed of ["--all --limit 0", "--regex", "--all"]) {
			const invalid = await dialog("search-archive", typed);
			expect(invalid.notes).toEqual([
				'Nothing was searched: type words or --regex "pattern", optionally with --all and --limit N (N at least 1).',
			]);
			expect(invalid.selects).toEqual([]);
		}

		// --regex: infix hits word mode misses; heading marks the pattern as a regex.
		const words = await dialog("search-archive", "loud logging");
		expect(words.notes).toEqual(['No results for "loud logging" · scope: this project (/proj/a)']);
		const regex = await dialog("search-archive", '--regex "LOUD\\s+logging"', { pick: () => undefined });
		expect(regex.selects[0].title[0]).toBe('3 results for regex "LOUD\\s+logging" · scope: this project (/proj/a)');
		expect(sessions(regex)).toEqual(["1. 01dddddd\\-0003", "2. 01aaaaaa\\-0001", "3. 01aaaaaa\\-0001"]);

		// --regex with --all on /search-full reaches tool output, flags in any position.
		const full = await dialog("search-full", '"permission (denied|granted)" --all --regex', { pick: () => undefined });
		expect(full.selects[0].title[0]).toBe('1 results for regex "permission (denied|granted)" · scope: all projects');
		expect(full.selects[0].items[0].label).toEndWith("  Tool output (bash)");
		expect(full.selects[0].items[0].description).toBe("ERROR\\: gcloud logging\\: permission denied");

		const anchored = await dialog("search-archive", '--all --regex "^gcloud logging in"', { pick: () => undefined });
		expect(anchored.selects[0].title[0]).toBe('1 results for regex "^gcloud logging in" · scope: all projects');
		expect(sessions(anchored)).toEqual(["1. 01eeeeee\\-0004"]);

		// Invalid pattern: one clear warning, no search, no picker.
		for (const name of ["search-archive", "search-full"]) {
			const bad = await dialog(name, '--regex "(" --all');
			expect(bad.notes).toEqual(['Invalid regular expression "(": missing ). Nothing was searched.']);
			expect([bad.selects, bad.editor, bad.switched]).toEqual([[], [], []]);
		}

		// Any text after the command (already in omp's prompt history): refused with a warning that names
		// the history file and never repeats the text; no dialog, no search.
		for (const name of ["search-archive", "search-full"]) {
			for (const args of ["gcloud logging", "--help", "--all", "--regex", "  --limit 5 "]) {
				const inline = ctx("tui", { typed: "gcloud logging", pick: labels => labels[0] });
				await run(name, args, inline);
				expect(inline.notes).toEqual([
					`Nothing was searched. The text you typed after /${name} is now saved in omp's prompt history (${tilde(join(agentDir, "history.db"))}), which agents can read. Run /${name} alone and type the query into its dialog.`,
				]);
				expect(inline.notes[0]).not.toContain(args.trim());
				expect(untouched(inline)).toEqual([[], [], [], [], []]);
			}
		}
		const home = ctx("tui");
		await plugin(join(homedir(), ".omp", "agent")).get("search-full")?.handler("x", home);
		expect(home.notes[0]).toContain("prompt history (~/.omp/agent/history.db), which agents can read.");

		// Outside the TUI no host is known to show the dialog: one notice, bare or not, nothing searched.
		for (const mode of ["rpc", "print"]) {
			for (const args of ["", "gcloud logging"]) {
				const c = ctx(mode, { typed: "gcloud logging", pick: labels => labels[0] });
				await run("search-archive", args, c);
				expect(c.notes).toEqual([
					"/search-archive needs omp's interactive TUI: run it alone there and type the query into its dialog. Nothing was searched.",
				]);
				expect(untouched(c)).toEqual([[], [], [], [], []]);
			}
		}
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
	expect(leaked).toEqual([]);
});
