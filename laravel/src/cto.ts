import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export const STATE_ENTRY = "nestiworks-laravel.state";
export const DEFAULT_FILE = "nestiworks-laravel.json";
export const ESCALATION_ENTRY = "nestiworks-laravel.escalation";
const USAGE = "Usage: /cto [status|on|off|default on|default off]";

export type Source = "session" | "default" | "off";
export type Escalation = { issue: number; url: string; status: "open" | "closed" | "handed_off" };
type Input = Record<string, unknown>;

/** Nesti MCP read tools the advisor may call. */
export const ADVISOR_NESTI_TOOLS = new Set([
	"project_layout",
	"issue_get",
	"issue_notes",
	"skill_catalog_status",
	"skill_catalog_select",
	"memory_status",
	"memory_search_docs",
	"memory_find_similar_issues",
	"memory_recall_failures",
]);
const ADVISOR_OWN_TOOLS = new Set(["read", "grep", "glob", "yield"]);
const ADVISOR_BLOCKED = "advisor is read-only: it may call only allowlisted Nesti MCP read tools and message the Developer";
const DEVELOPER_BLOCKED = "developer may message only the Advisor; report to the CTO through yield";
const ADVISOR_TOO_EARLY = "advisor joins only after the 2nd rejection, once Nesti issue_create succeeded";
/** Max length of the `type(scope): subject` line, enforced by `cz check -l`. */
export const COMMIT_SUBJECT_LIMIT = 72;
const COMMIT_FORM =
	'commit with literal messages only: git commit -m "<type>(<scope>): <subject>" [-m "<body>"]; commitizen cannot check -F, editor, heredoc or $(...) messages';
const SWEEP_BLOCKED = "stage only your changed_files by explicit path; never git add -A/--all/. or git commit -a";

/** Profile-wide default; undefined when the file is missing or unreadable. */
export async function readDefault(agentDir: string): Promise<boolean | undefined> {
	try {
		const { enabled } = JSON.parse(await readFile(join(agentDir, DEFAULT_FILE), "utf8"));
		return typeof enabled === "boolean" ? enabled : undefined;
	} catch {
		return undefined;
	}
}

export async function writeDefault(agentDir: string, enabled: boolean): Promise<string> {
	const file = join(agentDir, DEFAULT_FILE);
	await mkdir(agentDir, { recursive: true });
	await writeFile(file, `${JSON.stringify({ enabled })}\n`);
	return file;
}

/** Latest explicit `/cto on|off` on the current branch. */
export function sessionChoice(entries: readonly unknown[]): boolean | undefined {
	let choice: boolean | undefined;
	for (const e of entries) {
		const { type, customType, data } = e as { type?: string; customType?: string; data?: { enabled?: unknown } };
		if (type === "custom" && customType === STATE_ENTRY && typeof data?.enabled === "boolean") choice = data.enabled;
	}
	return choice;
}

export function effective(session: boolean | undefined, def: boolean | undefined): { enabled: boolean; source: Source } {
	if (session !== undefined) return { enabled: session, source: "session" };
	if (def !== undefined) return { enabled: def, source: "default" };
	return { enabled: false, source: "off" };
}

/** Nesti MCP tool name for a direct `mcp__nesti_<tool>` call or a `write xd://mcp__nesti_<tool>`; else undefined. */
export function nestiTool(toolName: string, input: Input): string | undefined {
	const direct = /^mcp__nesti_(\w+)$/.exec(toolName);
	if (direct) return direct[1];
	if (toolName === "write" && typeof input.path === "string") return /^xd:\/\/mcp__nesti_(\w+)$/.exec(input.path)?.[1];
	return undefined;
}

/** Block reason for an advisor tool call, or undefined when allowed. */
export function advisorBlock(toolName: string, input: Input): string | undefined {
	if (ADVISOR_OWN_TOOLS.has(toolName)) return undefined;
	const tool = nestiTool(toolName, input);
	if (tool !== undefined && ADVISOR_NESTI_TOOLS.has(tool)) return undefined;
	if (toolName === "write" && typeof input.path === "string" && /^agent:\/\/Developer(-\d+)?$/.test(input.path)) return undefined;
	return ADVISOR_BLOCKED;
}

/** Block reason for a developer message to anyone but the Advisor, or undefined when allowed. */
export function developerBlock(toolName: string, input: Input): string | undefined {
	const path = input.path;
	if (toolName === "write" && typeof path === "string" && path.startsWith("agent://") && !/^agent:\/\/Advisor(-\d+)?$/.test(path)) {
		return DEVELOPER_BLOCKED;
	}
	return undefined;
}

/** `yield` input with `model` added to a `done` result; undefined otherwise. omp passes `data` as a JSON string. */
export function withModel(input: Input, model: string): Input | undefined {
	let data = input.data;
	const encoded = typeof data === "string";
	if (encoded) {
		try {
			data = JSON.parse(data as string);
		} catch {
			return undefined;
		}
	}
	if (data === null || typeof data !== "object" || !("status" in data) || data.status !== "done") return undefined;
	const next = { ...data, model };
	return { ...input, data: encoded ? JSON.stringify(next) : next };
}

/** Shell command split into `;`/`&`/`|`/newline segments of unquoted words; `dynamic` when a segment expands `$…`, backticks or heredocs. */
export function shellSegments(command: string): { words: string[]; dynamic: boolean }[] {
	const out: { words: string[]; dynamic: boolean }[] = [];
	let words: string[] = [];
	let word: string | undefined;
	let dynamic = false;
	let quote: "'" | '"' | undefined;
	const endWord = () => {
		if (word !== undefined) words.push(word);
		word = undefined;
	};
	const endSegment = () => {
		endWord();
		if (words.length) out.push({ words, dynamic });
		words = [];
		dynamic = false;
	};
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (quote === "'") {
			if (c === "'") quote = undefined;
			else word += c;
		} else if (quote === '"') {
			if (c === '"') quote = undefined;
			else if (c === "\\" && '"\\$`'.includes(command[i + 1] ?? "")) word += command[++i];
			else {
				if (c === "`" || (c === "$" && /[(A-Za-z_{]/.test(command[i + 1] ?? ""))) dynamic = true;
				word += c;
			}
		} else if (c === "'" || c === '"') {
			quote = c;
			word ??= "";
		} else if (c === "\\" && i + 1 < command.length) {
			word = (word ?? "") + command[++i];
		} else if (";&|\n".includes(c)) {
			endSegment();
		} else if (/\s/.test(c)) {
			endWord();
		} else {
			if (c === "`" || (c === "$" && /[(A-Za-z_{]/.test(command[i + 1] ?? "")) || (c === "<" && command[i + 1] === "<")) dynamic = true;
			word = (word ?? "") + c;
		}
	}
	endSegment();
	return out;
}

/**
 * Block reason for a developer bash command that sweeps unrelated files into a commit or commits a message
 * `check` (commitizen) rejects; undefined when allowed.
 */
export function commitBlock(command: string, check: (message: string) => string | undefined): string | undefined {
	for (const { words, dynamic } of shellSegments(command)) {
		// `bash -c "git commit …"`, `eval '…'` and the like hide the commit inside one word: fail closed.
		if (words.some((w) => /\bgit\b[\s\S]*\bcommit\b/.test(w))) return COMMIT_FORM;
		let i = words.findIndex((w) => w === "git" || w.endsWith("/git"));
		if (i < 0) continue;
		// Skip git's global options: `-C <dir>` / `-c <key=value>` take a value.
		for (i++; i < words.length && words[i].startsWith("-"); i++) if (words[i] === "-C" || words[i] === "-c") i++;
		const [sub, ...args] = words.slice(i);
		if (sub === "add" && args.some((a) => ["-A", "--all", "-u", "--update", ".", ":/", "*"].includes(a))) return SWEEP_BLOCKED;
		if (sub !== "commit") continue;
		const messages: string[] = [];
		for (let j = 0; j < args.length; j++) {
			const a = args[j];
			if (a === "--all") return SWEEP_BLOCKED;
			if (a === "--message") messages.push(args[++j] ?? "");
			else if (a.startsWith("--message=")) messages.push(a.slice("--message=".length));
			else if (/^-[^-]/.test(a)) {
				// Short-option bundle such as -am "msg" or -m"msg".
				const m = a.indexOf("m");
				const flags = m < 0 ? a : a.slice(0, m);
				if (flags.includes("a")) return SWEEP_BLOCKED;
				if (m >= 0) messages.push(a.length > m + 1 ? a.slice(m + 1) : (args[++j] ?? ""));
			}
		}
		if (dynamic || !messages.length) return COMMIT_FORM;
		const reason = check(messages.join("\n\n"));
		if (reason) return `commitizen rejected the commit message:\n${reason}`;
	}
	return undefined;
}

/** `cz check` failure output for *message*, or undefined when commitizen accepts it. */
export function czCheck(message: string, cwd: string): string | undefined {
	// Only spawning throws (ENOENT); a rejected message is a non-zero exit.
	try {
		const { exitCode, stdout, stderr } = Bun.spawnSync(
			// An empty --allowed-prefixes drops cz's default bypass for Merge/Revert/fixup!/squash! messages.
			["cz", "check", "--message", message, "--message-length-limit", String(COMMIT_SUBJECT_LIMIT), "--allowed-prefixes"],
			{ cwd, stdout: "pipe", stderr: "pipe" },
		);
		if (exitCode === 0) return undefined;
		return `${stdout?.toString() ?? ""}${stderr?.toString() ?? ""}`.trim() || `cz check exited ${exitCode}`;
	} catch {
		return "commitizen is not installed on this machine (pipx install commitizen); ask the CTO";
	}
}

/** Latest escalation entry on the current branch. */
export function currentEscalation(entries: readonly unknown[]): Escalation | undefined {
	let escalation: Escalation | undefined;
	for (const e of entries) {
		const { type, customType, data } = e as { type?: string; customType?: string; data?: Partial<Escalation> };
		if (type === "custom" && customType === ESCALATION_ENTRY && typeof data?.issue === "number") escalation = data as Escalation;
	}
	return escalation;
}

/** First JSON object in the text content of a tool result. */
function firstJson(content: unknown): Input | undefined {
	if (!Array.isArray(content)) return undefined;
	for (const chunk of content) {
		if (chunk === null || typeof chunk !== "object" || chunk.type !== "text" || typeof chunk.text !== "string") continue;
		const text: string = chunk.text;
		const start = text.indexOf("{");
		if (start < 0) continue;
		try {
			return JSON.parse(text.slice(start, text.lastIndexOf("}") + 1));
		} catch {}
	}
	return undefined;
}

/** `issue_id` of a direct call, or of the JSON body of an xd write. */
function callIssueId(input: Input): unknown {
	if (input.issue_id !== undefined) return input.issue_id;
	if (typeof input.content !== "string") return undefined;
	try {
		return JSON.parse(input.content).issue_id;
	} catch {
		return undefined;
	}
}

/** Escalation state after a successful Nesti issue_create/issue_resolve/issue_handoff; undefined when unchanged. */
export function escalationFromResult(
	toolName: string,
	input: Input,
	content: unknown,
	current: Escalation | undefined,
): Escalation | undefined {
	const tool = nestiTool(toolName, input);
	if (tool !== "issue_create" && tool !== "issue_resolve" && tool !== "issue_handoff") return undefined;
	const body = firstJson(content);
	if (body?.success !== true) return undefined;
	if (tool === "issue_create") {
		const result = body.result;
		if (result === null || typeof result !== "object" || !("id" in result) || !("web_url" in result)) return undefined;
		if (typeof result.id !== "number" || typeof result.web_url !== "string") return undefined;
		return { issue: result.id, url: result.web_url, status: "open" };
	}
	if (!current || Number(callIssueId(input)) !== current.issue) return undefined;
	return { ...current, status: tool === "issue_resolve" ? "closed" : "handed_off" };
}

export default async function teamMode(pi: ExtensionAPI) {
	const rules = await readFile(join(import.meta.dir, "../prompts/cto.md"), "utf8");
	let session: boolean | undefined;
	// Read only when a session opens, so `/cto default` never changes an already-open session.
	let def: boolean | undefined;
	let escalation: Escalation | undefined;
	// Developer sessions only: the model of the latest provider response, injected into `done`.
	let runtimeModel: string | undefined;

	const describe = () => {
		const { enabled, source } = effective(session, def);
		return `${enabled ? "on" : "off"} (source: ${source})`;
	};
	// Task subagents have depth > 0; omp's native advisor companion is depth 0.
	const isTaskAgent = (ctx: ExtensionContext, name: string) =>
		ctx.agent?.kind === "sub" && ctx.agent.name === name && (ctx.agent.depth ?? 0) > 0;

	const open = async (_event: unknown, ctx: ExtensionContext) => {
		def = await readDefault(pi.pi.getAgentDir());
		const branch = ctx.sessionManager.getBranch();
		session = sessionChoice(branch);
		escalation = currentEscalation(branch);
	};
	const navigate = async (_event: unknown, ctx: ExtensionContext) => {
		const branch = ctx.sessionManager.getBranch();
		session = sessionChoice(branch);
		escalation = currentEscalation(branch);
	};
	pi.on("session_start", open);
	pi.on("session_switch", open);
	pi.on("session_branch", navigate);
	pi.on("session_tree", navigate);

	pi.on("before_agent_start", async (event, ctx) => {
		// Subagents (developer, reviewer, ...) rebind this factory; only the main session is the CTO.
		if (ctx.agent.kind !== "main" || !effective(session, def).enabled) return;
		const issueLine = escalation?.status === "open" ? `\n\nOpen escalation issue: #${escalation.issue} ${escalation.url}` : "";
		return { systemPrompt: [...event.systemPrompt, rules + issueLine] };
	});

	pi.on("after_provider_response", async (_event, ctx) => {
		const model = ctx.model;
		if (isTaskAgent(ctx, "developer") && model) runtimeModel = `${model.provider}/${model.id}`;
	});

	pi.on("tool_call", async (event, ctx) => {
		const input = (event.input ?? {}) as Input;
		if (isTaskAgent(ctx, "advisor")) {
			const reason = advisorBlock(event.toolName, input);
			if (reason) return { block: true, reason };
		} else if (isTaskAgent(ctx, "developer")) {
			const reason = developerBlock(event.toolName, input);
			if (reason) return { block: true, reason };
			if (event.toolName === "bash" && typeof input.command === "string") {
				const cwd = typeof input.cwd === "string" ? resolve(ctx.cwd, input.cwd) : ctx.cwd;
				const why = commitBlock(input.command, (message) => czCheck(message, cwd));
				if (why) return { block: true, reason: `${why}\nThe whole command was blocked, so none of it ran (including any git add).` };
			}
			if (event.toolName === "yield" && runtimeModel) {
				const next = withModel(input, runtimeModel);
				if (next) return { input: next };
			}
		}
	});

	pi.on("before_subagent_spawn", async (event, ctx) => {
		if (ctx.agent.kind !== "main" || !effective(session, def).enabled) return;
		const { agent } = event;
		const name = typeof agent === "string" ? agent : agent && typeof agent === "object" && "name" in agent ? agent.name : undefined;
		if (name === "advisor" && escalation?.status !== "open") return { block: true, reason: ADVISOR_TOO_EARLY };
	});

	pi.on("tool_result", async (event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		const next = escalationFromResult(event.toolName, (event.input ?? {}) as Input, event.content, escalation);
		if (!next) return;
		escalation = next;
		pi.appendEntry(ESCALATION_ENTRY, next);
	});

	pi.registerCommand("cto", {
		description: `CTO Laravel/Vue team. ${USAGE}`,
		handler: async (args, ctx) => {
			const words = args.trim().split(/\s+/).filter(Boolean);
			const [a, b] = words;
			if (words.length === 0 || (words.length === 1 && a === "status")) {
				ctx.ui.notify(`CTO mode: ${describe()}`, "info");
			} else if (words.length === 1 && (a === "on" || a === "off")) {
				session = a === "on";
				pi.appendEntry(STATE_ENTRY, { enabled: session });
				ctx.ui.notify(`CTO mode ${a} for this session`, "info");
			} else if (words.length === 2 && a === "default" && (b === "on" || b === "off")) {
				const file = await writeDefault(pi.pi.getAgentDir(), b === "on");
				ctx.ui.notify(`Default for new sessions: ${b} (${file}). This session is unchanged: ${describe()}`, "info");
			} else {
				ctx.ui.notify(USAGE, "warning");
			}
		},
	});
}
