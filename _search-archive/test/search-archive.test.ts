import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import searchArchive, {
	cell,
	compileQuery,
	formatDate,
	type Matcher,
	parseArgs,
	REPLY,
	renderTable,
	type Row,
	scanSession,
	search,
	THINKING,
	TITLE,
	tilde,
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
	expect(matcher("açılır").test("gcloud logging nasıl AÇILIR?")).toBe(true);
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

test("archive mode: only user-typed and model text; malformed lines skipped", async () => {
	const rows = await scanSession(FIXTURE, matcher("gcloud logging"), "archive", () => true);
	expect(rows?.map(r => [r.location, r.at, r.note])).toEqual([
		[REPLY, Date.parse("2026-11-20T10:01:00Z"), "Önce gcloud CLI kurun, ardından Cloud Logging API'sini etkinleştirin."],
		[USER, Date.parse("2026-11-20T10:00:00Z"), "gcloud logging nasıl açılır?"],
	]);
	expect(rows?.[0]).toMatchObject({ session: "01aaaaaa-0001", project: "/proj/a", title: "Logging | setup" });
});

test("full mode labels thinking, tool calls and tool output", async () => {
	const rows = await scanSession(FIXTURE, matcher("gcloud logging"), "full", () => true);
	expect(rows?.map(r => r.location)).toEqual([
		"Araç çıktısı (bash)",
		"Araç çağrısı (bash)",
		REPLY,
		THINKING,
		USER,
	]);
	expect(rows?.[1].note).toBe("bash gcloud logging read --limit 5 30");
	// Tool arguments are matched by value: `--limit 5` and the numeric timeout are searchable.
	expect((await scanSession(FIXTURE, matcher("limit 30"), "full", () => true))?.map(r => r.location)).toEqual([
		"Araç çağrısı (bash)",
	]);
	expect(await scanSession(FIXTURE, matcher("permission denied"), "archive", () => true)).toEqual([]);
});

test("title hits come first; the title slot wins over title_change", async () => {
	const rows = await scanSession(FIXTURE, matcher("setup"), "full", () => true);
	expect(rows).toEqual([
		{
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
		const all = await search({ ...base, all: true, matcher: m, limit: 50 });
		expect(all.rows.map(r => r.session)).toEqual(["01dddddd-0003", "01eeeeee-0004", "01aaaaaa-0001", "01aaaaaa-0001"]);
		const limited = await search({ ...base, all: true, matcher: m, limit: 2 });
		expect(limited).toMatchObject({ limited: true });
		expect(limited.rows.map(r => r.session)).toEqual(["01dddddd-0003", "01eeeeee-0004"]);
		const missing = await search({ ...base, root: join(agentDir, "nope"), all: true, matcher: m, limit: 50 });
		expect(missing.rows).toEqual([]);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

const row: Row = {
	session: "01aaaaaa-0001",
	project: "~/www/x",
	title: "a | b\nc",
	at: Date.parse("2026-11-20T10:01:00Z"),
	location: "Araç çıktısı (bash)",
	note: "x|y\nz",
};

test("table rendering: headers, column order, cell escaping", () => {
	expect(renderTable([row], "archive")).toBe(
		[
			"| Oturum | Proje | Başlık | Tarih (UTC) | Not |",
			"| --- | --- | --- | --- | --- |",
			"| 01aaaaaa-0001 | ~/www/x | a \\| b c | 11-20 10:01 | x\\|y z |",
		].join("\n"),
	);
	expect(renderTable([row], "full")).toBe(
		[
			"| Oturum | Proje | Başlık | Tarih (UTC) | Konum | Not |",
			"| --- | --- | --- | --- | --- | --- |",
			"| 01aaaaaa-0001 | ~/www/x | a \\| b c | 11-20 10:01 | Araç çıktısı (bash) | x\\|y z |",
		].join("\n"),
	);
	expect(cell("  a\r\n\tb | c  ")).toBe("a b \\| c");
	expect(formatDate(Number.NaN)).toBe("");
	expect(tilde(join(homedir(), "www", "x"))).toBe("~/www/x");
	expect(tilde(homedir())).toBe("~");
	expect(tilde("/srv/x")).toBe("/srv/x");
});

test("argument parsing", () => {
	expect(parseArgs("gcloud logging")).toEqual({ query: "gcloud logging", all: false, limit: 50 });
	expect(parseArgs("gcloud --all logging --limit 5")).toEqual({ query: "gcloud logging", all: true, limit: 5 });
	expect(parseArgs("--limit=7 x")).toEqual({ query: "x", all: false, limit: 7 });
	expect(parseArgs("x --limit")).toBeUndefined();
	expect(parseArgs("x --limit 0")).toBeUndefined();
	expect(parseArgs("x --limit abc")).toBeUndefined();
	expect(parseArgs("--all")).toBeUndefined();
	expect(parseArgs("   ")).toBeUndefined();
});

test("commands: table message, resume prefill only with editor support", async () => {
	const agentDir = await sessionsTree();
	try {
		const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
		const sent: { customType: string; content: string; display: boolean; excludeFromContext: boolean }[] = [];
		const pi = {
			pi: { getAgentDir: () => agentDir },
			registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
				commands.set(name, def.handler),
			sendMessage: (m: (typeof sent)[number]) => sent.push(m),
		};
		searchArchive(pi as never);
		expect([...commands.keys()]).toEqual(["search-archive", "search-full"]);

		const ctx = (supportsEditor?: boolean) => {
			const c = {
				cwd: "/proj/a",
				editor: [] as string[],
				notes: [] as string[],
				sessionManager: { getSessionId: () => CURRENT },
				ui: {
					supportsEditor,
					setEditorText: (t: string) => c.editor.push(t),
					notify: (t: string) => c.notes.push(t),
				},
			};
			return c;
		};

		const tui = ctx(true);
		await commands.get("search-archive")?.("gcloud logging", tui);
		expect(sent[0]).toMatchObject({ customType: "search-archive", display: true, excludeFromContext: true });
		expect(sent[0].content).toContain("| Oturum | Proje | Başlık | Tarih (UTC) | Not |");
		expect(sent[0].content).toContain("3 sonuç · kapsam: bu proje (/proj/a)");
		expect(sent[0].content).not.toContain("current");
		expect(tui.editor).toEqual(["/resume 01dddddd-0003"]);

		const headless = ctx(undefined);
		await commands.get("search-full")?.("permission denied --all", headless);
		expect(sent[1].content).toContain("| Konum | Not |");
		expect(sent[1].content).toContain("Araç çıktısı (bash)");
		expect(sent[1].content).toContain("kapsam: tüm projeler");
		expect(headless.editor).toEqual([]);

		const none = ctx(true);
		await commands.get("search-archive")?.("zzzz-nothing", none);
		expect(sent[2].content).toContain("sonuç bulunamadı");
		expect(none.editor).toEqual([]);

		await commands.get("search-archive")?.("--all", none);
		expect(none.notes[0]).toContain("Kullanım: /search-archive");
		expect(sent).toHaveLength(3);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});
