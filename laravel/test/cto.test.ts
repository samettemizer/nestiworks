import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	advisorBlock,
	commitBlock,
	czCheck,
	DEFAULT_FILE,
	developerBlock,
	type Escalation,
	effective,
	escalationFromResult,
	nestiTool,
	readDefault,
	STATE_ENTRY,
	sessionChoice,
	withModel,
	writeDefault,
} from "../src/cto";

test("precedence: session > default > off", () => {
	for (const def of [undefined, true, false]) {
		expect(effective(true, def)).toEqual({ enabled: true, source: "session" });
		expect(effective(false, def)).toEqual({ enabled: false, source: "session" });
	}
	expect(effective(undefined, true)).toEqual({ enabled: true, source: "default" });
	expect(effective(undefined, false)).toEqual({ enabled: false, source: "default" });
	expect(effective(undefined, undefined)).toEqual({ enabled: false, source: "off" });
});

test("sessionChoice takes the latest own entry on the branch", () => {
	const own = (enabled: boolean) => ({ type: "custom", customType: STATE_ENTRY, data: { enabled } });
	expect(sessionChoice([])).toBeUndefined();
	expect(sessionChoice([{ type: "message" }, { type: "custom", customType: "other", data: { enabled: true } }])).toBeUndefined();
	expect(sessionChoice([own(true), { type: "message" }, own(false)])).toBe(false);
	expect(sessionChoice([own(false), own(true), { type: "custom", customType: "other", data: { enabled: false } }])).toBe(true);
});

test("default file read/write", async () => {
	const root = await mkdtemp(join(tmpdir(), "nestiworks-laravel-"));
	try {
		const agentDir = join(root, "profiles", "x", "agent"); // does not exist yet
		expect(await readDefault(agentDir)).toBeUndefined();
		await writeDefault(agentDir, true);
		expect(await readDefault(agentDir)).toBe(true);
		await writeDefault(agentDir, false);
		expect(await readDefault(agentDir)).toBe(false);
		await Bun.write(join(agentDir, DEFAULT_FILE), "not json");
		expect(await readDefault(agentDir)).toBeUndefined();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("nestiTool: direct MCP name and xd write", () => {
	expect(nestiTool("mcp__nesti_issue_get", {})).toBe("issue_get");
	expect(nestiTool("write", { path: "xd://mcp__nesti_memory_search_docs", content: "{}" })).toBe("memory_search_docs");
	expect(nestiTool("write", { path: "src/x.php" })).toBeUndefined();
	expect(nestiTool("mcp__other_issue_get", {})).toBeUndefined();
	expect(nestiTool("read", { path: "xd://mcp__nesti_issue_get" })).toBeUndefined();
});

test("advisorBlock: read tools, allowlisted Nesti tools and the Developer only", () => {
	for (const [tool, input] of [
		["write", { path: "xd://mcp__nesti_memory_search_docs" }],
		["write", { path: "agent://Developer" }],
		["write", { path: "agent://Developer-2" }],
		["mcp__nesti_project_layout", {}],
		["read", { path: "src/x.php" }],
		["yield", {}],
	] as const) {
		expect(advisorBlock(tool, input)).toBeUndefined();
	}
	for (const [tool, input] of [
		["write", { path: "agent://Reviewer" }],
		["write", { path: "agent://all" }],
		["write", { path: "src/x.php" }],
		["edit", { path: "src/x.php" }],
		["bash", { command: "ls" }],
		["write", { path: "xd://mcp__nesti_issue_handoff" }],
		["mcp__nesti_issue_create", {}],
	] as const) {
		expect(advisorBlock(tool, input)).toContain("advisor is read-only");
	}
});

test("developerBlock: messages only the Advisor", () => {
	expect(developerBlock("write", { path: "agent://Reviewer" })).toContain("developer may message only the Advisor");
	expect(developerBlock("write", { path: "agent://all" })).toBeDefined();
	expect(developerBlock("write", { path: "agent://Advisor" })).toBeUndefined();
	expect(developerBlock("write", { path: "agent://Advisor-2" })).toBeUndefined();
	expect(developerBlock("write", { path: "src/x.php" })).toBeUndefined();
	expect(developerBlock("edit", { path: "src/x.php" })).toBeUndefined();
});

test("withModel injects only into done results", () => {
	expect(withModel({ data: { status: "done", summary: "s" } }, "p/m")).toEqual({ data: { status: "done", summary: "s", model: "p/m" } });
	expect(withModel({ data: JSON.stringify({ status: "done", summary: "s" }) }, "p/m")).toEqual({ data: JSON.stringify({ status: "done", summary: "s", model: "p/m" }) });
	expect(withModel({ data: JSON.stringify({ status: "plan" }) }, "p/m")).toBeUndefined();
	expect(withModel({ data: { status: "plan" } }, "p/m")).toBeUndefined();
	expect(withModel({ data: { status: "blocked" } }, "p/m")).toBeUndefined();
	expect(withModel({}, "p/m")).toBeUndefined();
});

test("escalationFromResult: open on create, closed/handed_off only for the matching issue", () => {
	const text = (body: unknown) => [{ type: "text", text: JSON.stringify(body) }];
	const created = { success: true, result: { id: 42, web_url: "https://gitlab/x/-/issues/42", labels: [] } };
	const open: Escalation = { issue: 42, url: "https://gitlab/x/-/issues/42", status: "open" };

	expect(escalationFromResult("mcp__nesti_issue_create", {}, text(created), undefined)).toEqual(open);
	expect(escalationFromResult("write", { path: "xd://mcp__nesti_issue_create" }, text(created), undefined)).toEqual(open);
	expect(escalationFromResult("mcp__nesti_issue_create", {}, text({ success: false, error: "boom" }), undefined)).toBeUndefined();
	expect(escalationFromResult("mcp__nesti_issue_get", {}, text(created), undefined)).toBeUndefined();

	const ok = text({ success: true, result: {} });
	expect(escalationFromResult("mcp__nesti_issue_resolve", { issue_id: 42, model: "p/m" }, ok, open)).toEqual({ ...open, status: "closed" });
	expect(
		escalationFromResult("write", { path: "xd://mcp__nesti_issue_handoff", content: '{"issue_id":42,"report":"r"}' }, ok, open),
	).toEqual({ ...open, status: "handed_off" });
	expect(escalationFromResult("mcp__nesti_issue_resolve", { issue_id: 7, model: "p/m" }, ok, open)).toBeUndefined();
	expect(escalationFromResult("mcp__nesti_issue_handoff", { issue_id: 42 }, text({ success: false }), open)).toBeUndefined();
	expect(escalationFromResult("mcp__nesti_issue_resolve", { issue_id: 42 }, ok, undefined)).toBeUndefined();
});

test("commitBlock checks every literal commit message and blocks unchecked forms", () => {
	const seen: string[] = [];
	const ok = (m: string) => (seen.push(m), undefined);
	expect(commitBlock(`git add backend/app/X.php && git commit -m 'feat(members): add export' -m "Body with \\"quotes\\"."`, ok)).toBeUndefined();
	expect(commitBlock(`git -C backend commit --message="fix(auth): reject expired tokens"; git log -1`, ok)).toBeUndefined();
	expect(commitBlock(`git commit -m 'test(auth): cover expiry' -- backend/tests/A.php 'frontend/src/b c.ts'`, ok)).toBeUndefined();
	expect(seen).toEqual(['feat(members): add export\n\nBody with "quotes".', "fix(auth): reject expired tokens", "test(auth): cover expiry"]);
	expect(commitBlock("git status && git diff --stat && echo $HOME", ok)).toBeUndefined();

	for (const unchecked of [
		"git commit",
		"git commit -F msg.txt",
		"git commit --amend --no-edit",
		'git commit -m "$(cat <<EOF\nfeat: x\nEOF\n)"',
		"git commit -m `cat m`",
		'git commit -m "feat(x): $MSG"',
		"git commit -m feat:${MSG}",
		`bash -c "git commit -m 'feat: x'"`,
		`sh -c 'cd backend && git commit -m "feat: x"'`,
		`eval "git commit -m 'feat: x'"`,
	]) {
		expect(commitBlock(unchecked, ok)).toContain("literal messages only");
	}
	for (const sweep of ["git add -A", "git add .", "git add --all", "git add -u", "git add --update", "git add *", "git commit -am 'feat: x'", "git commit --all -m 'feat: x'"]) {
		expect(commitBlock(sweep, ok)).toContain("explicit path");
	}
	expect(commitBlock("git commit -m 'Added stuff'", () => "pattern mismatch")).toContain("commitizen rejected the commit message:\npattern mismatch");
});

test.skipIf(!Bun.which("cz"))("czCheck enforces Conventional Commits and the subject limit with real commitizen", () => {
	expect(czCheck("feat(members): add balance export endpoint", tmpdir())).toBeUndefined();
	expect(czCheck("fix(auth): reject expired reset tokens\n\nTokens older than one hour fail.", tmpdir())).toBeUndefined();
	expect(czCheck("Added stuff", tmpdir())).toContain("commit validation: failed");
	// cz lets Merge/Revert/fixup! through by default; the guard clears that list.
	expect(czCheck("Revert stuff", tmpdir())).toContain("commit validation: failed");
	expect(czCheck("fixup! feat(members): add export", tmpdir())).toContain("commit validation: failed");
	expect(czCheck(`feat(members): ${"x".repeat(80)}`, tmpdir())).toContain("length limit");
});
