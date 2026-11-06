# nestiworks-laravel

An [omp](https://omp.sh) plugin that adds an opt-in **CTO team mode** for Laravel projects.

When CTO mode is on, the main agent becomes a CTO: it does not edit code itself. It writes a spec, sends the work to a `developer` subagent, approves the developer's plan, sends the result to a `reviewer` subagent and relays `MUST_FIX` items. When the review approves in round 1 or 2, the developer commits the change as [Conventional Commits](https://www.conventionalcommits.org/) checked by [commitizen](https://commitizen-tools.github.io/commitizen/); nothing is pushed. After the second rejection it opens an unlabelled GitLab issue through Nesti MCP, spawns the `advisor` and gives the developer one final attempt, which is never committed: approved → the issue is closed with `omp-developer / model: <model>` and the change stays uncommitted in your working tree; rejected → the issue gets the `nesti` label and Nesti's pipeline takes over. It prints a status line at every phase change (`▶ [n/6 Phase] ...`) in your language.

Turning the mode off stops CTO prompt injection, not agent overrides.

## Laravel focus

The roles work from the target project's installed Laravel/PHP versions, layout and conventions, and turn only the risks a change touches into acceptance criteria: object/tenant authorization, transactions and after-commit side effects, applied migrations and existing data, Eloquent query scope and volume, config caching and long-running workers. Reviews block concrete failures, not taste or a missing layer; tests run only against isolated targets. The advisor looks for the shared root cause of both rejections in the local code first, then in Nesti's corpus and precedents.

## What's inside

| Path | Purpose |
| --- | --- |
| `src/cto.ts` | Extension: the `/cto` command, state handling, system-prompt injection |
| `prompts/cto.md` | CTO rules appended to the system prompt while the mode is on |
| `agents/developer.md` | `developer` subagent: plans, waits for `APPROVED`, implements, fixes `MUST_FIX` items, commits after `COMMIT` |
| `agents/reviewer.md` | `reviewer` subagent: read-only review against the acceptance criteria, runs tests |
| `agents/advisor.md` | `advisor` subagent: read-only root-cause advice for the final attempt from the code first, then Nesti's layout, skills, memory and issue history |
| `.mcp.json` | Nesti MCP server (`nesti mcp`, stdio) |


## Install

In omp:
```
/marketplace add samettemizer/nestiworks
/marketplace install --scope project laravel@nestiworks
```

Then restart the session (extension modules load at session start). The `nesti` command must be on `PATH` (`.mcp.json` starts `nesti mcp`), and commitizen must be on `PATH` for developer commits:

```sh
pipx install commitizen
```

Tests:

```sh
bun test
```

## Commands

| Command | Effect |
| --- | --- |
| `/cto`, `/cto status` | Show the effective state and where it comes from: `session`, `default`, or `off` |
| `/cto on` | Turn CTO mode on for the current session |
| `/cto off` | Turn CTO mode off for the current session |
| `/cto default on` | New sessions in this profile start with CTO mode on |
| `/cto default off` | New sessions in this profile start with CTO mode off |

Anything else prints the usage.

## State and precedence

The effective state is resolved in this order:

1. **Session choice**: the last `/cto on` / `/cto off` on the current session branch. It is stored in the session file, so it survives resume, and branch / tree navigation restores whatever was chosen on that branch.
2. **Profile default**: set with `/cto default on|off`, stored as `nestiworks-laravel.json` in the active omp profile's agent directory (for example `~/.omp/agent/` or `~/.omp/profiles/<name>/agent/`).
3. **Off.**

The profile default is read when a session opens (start, `/new`, resume). Changing it does not affect sessions that are already open.

CTO rules are injected only into the main session. Subagents never get them. The plugin also guards the team: the `advisor` can be spawned only while an escalation issue is open, may call only allowlisted Nesti read tools and message only `agent://Developer`; the `developer` may message only `agent://Advisor`, and its `done` result gets the runtime `model`.

## Commits

The CTO sends `COMMIT` after a round 1 or round 2 approval without a separate request from you, and reports completion only after `status: "committed"` with actual commit hashes; a failed commit is reported, never passed off as success. No `COMMIT` is sent for a task escalated after two rejections (its change stays uncommitted whether the issue is closed or handed off to Nesti), when you explicitly forbid commits, or when there is no approved file change; no empty commits are created.

The developer commits only after the CTO's `COMMIT`, one logical change per commit, with headers such as `feat(auth): add password reset endpoint` (English, imperative, header ≤ 72 characters, optional one-sentence body) and a `-- <paths>` pathspec so files the user staged stay out. For every developer `git commit` the plugin runs `cz check --message <msg> --message-length-limit 72 --allowed-prefixes` in the command's working directory, so a project's own commitizen config (`.cz.toml`, `pyproject.toml`, …) applies, and cz's default `Merge`/`Revert`/`fixup!` bypass is off. A rejected message blocks the whole bash command and returns commitizen's reason. The plugin also blocks:

- commit messages commitizen cannot see: `-F`, the editor, heredocs, `$(...)`, `$VAR`, and commits wrapped in `bash -c`/`sh -c`/`eval`;
- sweeping staging: `git add -A/--all/-u/./*` and `git commit -a`.

The guard only sees the bash tool: git run from another tool (for example Python) is covered by the developer's rules alone.

## Agent overrides and collisions

This plugin ships agents named `developer`, `reviewer` and `advisor`. They override omp's bundled agents with those names, including the built-in `reviewer`, even while CTO mode is off. Project `.omp/agents/` and user `<agent dir>/agents/` definitions take precedence over plugin agents.

**Use one nestiworks team-mode package per project.** All variants register `/cto` and the same agent names. Separate state filenames do not prevent command conflicts or mixed agent selection when multiple variants load; do not rely on load order. Disable/uninstall the other variant and restart when switching.

## References

Use the documentation matching the project's installed Laravel version: [authorization](https://laravel.com/docs/12.x/authorization), [database transactions and deadlock retries](https://laravel.com/docs/12.x/database#database-transactions), [jobs and database transactions](https://laravel.com/docs/12.x/queues#jobs-and-database-transactions), [configuration caching](https://laravel.com/docs/12.x/configuration#configuration-caching).

## License

MIT
