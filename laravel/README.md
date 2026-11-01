# nestiworks-laravel

An [omp](https://omp.sh) plugin that adds an opt-in **CTO team mode**.

When CTO mode is on, the main agent becomes a CTO: it does not edit code itself. It writes a spec, sends the work to a `developer` subagent, approves the developer's plan, sends the result to a `reviewer` subagent and relays `MUST_FIX` items. Once the review approves, the developer commits the change as [Conventional Commits](https://www.conventionalcommits.org/) checked by [commitizen](https://commitizen-tools.github.io/commitizen/); nothing is pushed. After the second rejection it opens an unlabelled GitLab issue through Nesti MCP, spawns the `advisor` and gives the developer one final attempt: approved → the issue is closed with `omp-developer / model: <model>`; rejected → the issue gets the `nesti` label and Nesti's pipeline takes over. It prints a status line at every phase change (`▶ [n/6 Phase] ...`) in your language.

When CTO mode is off, nothing is injected and omp behaves like the default agent.

## What's inside

| Path | Purpose |
| --- | --- |
| `src/cto.ts` | Extension: the `/cto` command, state handling, system-prompt injection |
| `prompts/cto.md` | CTO rules appended to the system prompt while the mode is on |
| `agents/developer.md` | `developer` subagent: plans, waits for `APPROVED`, implements, fixes `MUST_FIX` items, commits after `COMMIT` |
| `agents/reviewer.md` | `reviewer` subagent: read-only review against the acceptance criteria, runs tests |
| `agents/advisor.md` | `advisor` subagent: read-only advice for the final attempt from Nesti's layout, skills, memory and issue history |
| `.mcp.json` | Nesti MCP server (`docker exec -i nesti-mcp python -m mcp_server.server`) |


## Install

In omp:
```
/marketplace add samettemizer/nestiworks-laravel
/marketplace install --scope project laravel@nestiworks
```

Then restart the session (extension modules load at session start). The `nesti-mcp` container must be running, and commitizen must be on `PATH` for developer commits:

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
| `/cto` | Show the effective state and where it comes from: `session`, `default`, or `off` |
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

The developer commits only after the CTO's `COMMIT`, one logical change per commit, with headers such as `feat(auth): add password reset endpoint` (English, imperative, header ≤ 72 characters, optional one-sentence body) and a `-- <paths>` pathspec so files the user staged stay out. For every developer `git commit` the plugin runs `cz check --message <msg> --message-length-limit 72 --allowed-prefixes` in the command's working directory, so a project's own commitizen config (`.cz.toml`, `pyproject.toml`, …) applies, and cz's default `Merge`/`Revert`/`fixup!` bypass is off. A rejected message blocks the whole bash command and returns commitizen's reason. The plugin also blocks:

- commit messages commitizen cannot see: `-F`, the editor, heredocs, `$(...)`, `$VAR`, and commits wrapped in `bash -c`/`sh -c`/`eval`;
- sweeping staging: `git add -A/--all/-u/./*` and `git commit -a`.

The guard only sees the bash tool: git run from another tool (for example Python) is covered by the developer's rules alone.

## ⚠️ Agent override

This plugin ships agents named `developer`, `reviewer` and `advisor`. Plugin agents take precedence over omp's bundled agents with the same name, so **installing this plugin replaces omp's built-in `reviewer` agent with this plugin's `reviewer`**, in every session, whether CTO mode is on or off. Project (`.omp/agents/`) and user (`<agent dir>/agents/`) agents with the same names still take precedence over the plugin's agents.

## License

MIT
