# nestiworks-generic

An [omp](https://omp.sh) plugin that adds an opt-in **CTO team mode**.

When CTO mode is on, the main agent becomes a CTO: it does not edit code itself. It writes a spec, sends the work to a `nesti-developer` subagent, approves the developer's plan, sends the result to a `nesti-reviewer` subagent, relays `MUST_FIX` items until the review passes, then automatically delegates the approved commit and waits for its hash before reporting back to you (unless you explicitly forbid commits or there is no change to commit). Analysis or plan-only requests stop after the plan. It prints a status line at every phase change (`▶ [n/5 Phase] ...`) in your language.

Turning the mode off stops CTO prompt injection; the plugin's agents stay registered.

## What's inside

| Path | Purpose |
| --- | --- |
| `src/cto.ts` | Extension: the `/cto` command, state handling, system-prompt injection |
| `prompts/cto.md` | CTO rules appended to the system prompt while the mode is on |
| `agents/nesti-developer.md` | `nesti-developer` subagent: plans, waits for `APPROVED`, implements, fixes `MUST_FIX` items, commits |
| `agents/nesti-reviewer.md` | `nesti-reviewer` subagent: read-only review against the acceptance criteria and approved plan, runs tests; `blocked` when checks cannot run |

## Install

In omp:

```
/marketplace add samettemizer/nestiworks
/marketplace install --scope project generic@nestiworks
```

Then restart the session (extension modules load at session start).

For local development in this repository, add `extensions: ["./generic"]` to `.omp/config.yml` (the path is relative to the repository working directory), retaining any other configured extension roots. Disable the cached project installation with `omp plugin disable --scope project generic@nestiworks` so only one `/cto` implementation loads. This project-only setup uses the working source without editing the marketplace cache or profile defaults. Restart omp: existing sessions and subagents retain their already-loaded prompts and output schemas. To return to the cached package, remove only the local generic extension entry, run `omp plugin enable --scope project generic@nestiworks`, and restart.

Tests:

```sh
bun test
```

## Commands

| Command | Effect |
| --- | --- |
| `/cto` | Show the effective state and where it comes from: `session`, `default`, or `off` |
| `/cto on` | Turn CTO mode on for the current session |
| `/cto off` | Turn CTO mode off for the current session |
| `/cto default on` | New sessions in this profile start with CTO mode on |
| `/cto default off` | New sessions in this profile start with CTO mode off |

Anything else prints the usage.

## State and precedence

The effective state is resolved in this order:

1. **Session choice**: the last `/cto on` / `/cto off` on the current session branch. It is stored in the session file, so it survives resume, and branch / tree navigation restores whatever was chosen on that branch.
2. **Profile default**: set with `/cto default on|off`, stored as `nestiworks-generic.json` in the active omp profile's agent directory (for example `~/.omp/agent/` or `~/.omp/profiles/<name>/agent/`).
3. **Off.**

The profile default is read when a session opens (start, `/new`, resume). Changing it does not affect sessions that are already open.

CTO rules are injected only into the main session. Subagents, including `nesti-developer` and `nesti-reviewer`, never get them.

## Commits

After the reviewer approves and the CTO accepts the criteria, the CTO automatically sends `COMMIT` to the developer; you do not need to request it separately. Only the developer commits, and the CTO waits for `status: "committed"` with actual commit hashes before reporting completion. An explicit no-commit instruction wins; read-only, investigation and no-change tasks create no empty commits. Messages follow Conventional Commits and must pass [Commitizen](https://commitizen-tools.github.io/commitizen/) `cz check` using the repository config. Missing `cz` or a failed commit blocks completion. Explicit approved-file pathspecs keep unrelated staged files out; overlapping user edits must be resolved rather than swept in. Pushes, tags, branches and version bumps are not automatic.

The developer confirms how the repository runs Commitizen while planning, so a missing `cz` surfaces before implementation. After committing, it checks that the commit holds only the approved paths and leaves them clean; a hook-modified file blocks delivery and goes back through review.

## Agent overrides and collisions

This plugin ships agents named `nesti-developer` and `nesti-reviewer`. Neither shadows an omp bundled agent, so the bundled `reviewer` stays available in normal mode. The agents stay registered while CTO mode is off; `/cto off` only stops prompt injection. Project `.omp/agents/` and user `<agent dir>/agents/` definitions with the same names take precedence over plugin agents.

Upgrading from 1.0.x: the agents were previously named `developer` and `reviewer`. Settings keyed by agent name do not follow the rename; move them yourself, e.g. `task.agentModelOverrides: { nesti-developer: "@task", nesti-reviewer: "@slow" }`. The plugin never writes omp settings, and bundled agents do not need to be disabled.

**Use one nestiworks team-mode package per project.** All variants register `/cto`. Separate state filenames do not prevent command conflicts or mixed agent selection when multiple variants load; do not rely on load order. Disable/uninstall the other variant and restart when switching.

## License

MIT
