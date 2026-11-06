import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import teamMode, { DEFAULT_FILE, effective, readDefault, STATE_ENTRY, sessionChoice, writeDefault } from "../src/cto";

const own = (enabled: boolean) => ({ type: "custom", customType: STATE_ENTRY, data: { enabled } });

test("precedence: session > default > off", () => {
	for (const def of [undefined, true, false]) {
		expect(effective(true, def)).toEqual({ enabled: true, source: "session" });
		expect(effective(false, def)).toEqual({ enabled: false, source: "session" });
	}
	expect(effective(undefined, true)).toEqual({ enabled: true, source: "default" });
	expect(effective(undefined, false)).toEqual({ enabled: false, source: "default" });
	expect(effective(undefined, undefined)).toEqual({ enabled: false, source: "off" });
});

test("branch choice ignores foreign and malformed entries", () => {
	expect(sessionChoice([])).toBeUndefined();
	expect(sessionChoice([{ type: "message" }, { type: "custom", customType: "other", data: { enabled: true } }])).toBeUndefined();
	expect(sessionChoice([own(true), { type: "custom", customType: STATE_ENTRY, data: { enabled: "false" } }])).toBe(true);
	expect(sessionChoice([own(true), own(false)])).toBe(false);
	expect(sessionChoice([own(false), own(true)])).toBe(true);
});

test("default persists and malformed files are ignored", async () => {
	const root = await mkdtemp(join(tmpdir(), "nestiworks-vue-"));
	try {
		const dir = join(root, "profile", "agent");
		expect(await readDefault(dir)).toBeUndefined();
		for (const enabled of [true, false]) {
			await writeDefault(dir, enabled);
			expect(await readDefault(dir)).toBe(enabled);
		}
		for (const content of ["not json", "null", "{}", '{"enabled":"true"}']) {
			await Bun.write(join(dir, DEFAULT_FILE), content);
			expect(await readDefault(dir)).toBeUndefined();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

type Handler = (event: any, ctx: ExtensionContext) => any;
async function withExtension(run: (h: {
	dir: string; entries: unknown[]; ctx: ExtensionContext;
	emit: (name: string) => Promise<void>; command: (args: string) => Promise<void>;
	injected: (kind?: string) => Promise<boolean>;
}) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "nestiworks-vue-"));
	try {
		const handlers = new Map<string, Handler>();
		const entries: unknown[] = [];
		let command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> };
		const ctx = { agent: { kind: "main" }, sessionManager: { getBranch: () => entries }, ui: { notify() {} } } as unknown as ExtensionContext;
		await teamMode({
			pi: { getAgentDir: () => dir },
			on: (name: string, handler: Handler) => handlers.set(name, handler),
			registerCommand: (_name: string, registered: typeof command) => { command = registered; },
			appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		} as unknown as ExtensionAPI);
		await run({ dir, entries, ctx,
			emit: async name => { await handlers.get(name)!({}, ctx); },
			command: args => command.handler(args, ctx),
			injected: async (kind = "main") => {
				const systemPrompt = ["existing"];
				const result = await handlers.get("before_agent_start")!({ systemPrompt }, { ...ctx, agent: { kind } } as ExtensionContext);
				expect(systemPrompt).toEqual(["existing"]);
				if (result) expect(result.systemPrompt.slice(0, 1)).toEqual(systemPrompt);
				return result !== undefined;
			},
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("commands persist session choice and reject invalid arguments without mutation", async () => {
	await withExtension(async h => {
		await h.emit("session_start");
		expect(await h.injected()).toBe(false);
		await h.command(" on ");
		expect(h.entries).toEqual([own(true)]);
		expect(await h.injected()).toBe(true);
		for (const args of ["", "status", "on extra", "default", "default yes", "default on extra"]) await h.command(args);
		expect(h.entries).toEqual([own(true)]);
		expect(await readDefault(h.dir)).toBeUndefined();
		expect(await h.injected("sub")).toBe(false);
		await h.command("off");
		expect(h.entries).toEqual([own(true), own(false)]);
		expect(await h.injected()).toBe(false);
	});
});

test("defaults change future sessions, not open sessions or navigation", async () => {
	await withExtension(async h => {
		await h.emit("session_start");
		await h.command("default on");
		expect(await readDefault(h.dir)).toBe(true);
		for (const event of ["session_branch", "session_tree"]) {
			await h.emit(event);
			expect(await h.injected()).toBe(false);
		}
		await h.emit("session_switch");
		expect(await h.injected()).toBe(true);
		await h.command("default off");
		expect(await h.injected()).toBe(true);
		await h.emit("session_start");
		expect(await h.injected()).toBe(false);
	});
});

test("resume and branch navigation restore explicit on and off over the default", async () => {
	await withExtension(async h => {
		await writeDefault(h.dir, true);
		h.entries.push(own(false));
		await h.emit("session_start");
		expect(await h.injected()).toBe(false);
		h.entries.splice(0, h.entries.length, own(true));
		await h.emit("session_branch");
		expect(await h.injected()).toBe(true);
		h.entries.splice(0, h.entries.length, own(false));
		await h.emit("session_tree");
		expect(await h.injected()).toBe(false);
		h.entries.length = 0;
		await h.emit("session_switch");
		expect(await h.injected()).toBe(true);
	});
});
