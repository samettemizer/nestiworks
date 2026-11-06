# nestiworks-dart

An [omp](https://omp.sh) plugin that adds an opt-in **CTO team mode** for Dart projects.

When CTO mode is on, the main agent becomes a CTO: it does not edit code itself. It writes a spec, sends the work to a `developer` subagent, approves the developer's plan, sends the result to a `reviewer` subagent, relays `MUST_FIX` items until the review passes, then automatically delegates the approved commit and waits for its hash before reporting back to you (unless you explicitly forbid commits or there is no change to commit). It prints a status line at every phase change (`▶ [n/5 Phase] ...`) in your language.

When CTO mode is off, nothing is injected and omp behaves like the default agent.

## Dart focus

The developer keeps sound null safety without `!`/`late` shortcuts, awaits or explicitly `unawaited()`s every future, closes streams and respects the `lib/src` public/private split. The reviewer runs `dart analyze`, the tests and `dart format` and blocks runtime null errors, lost futures and leaked subscriptions. Both agents preserve your project's existing architecture/layout and toolchain by default; the developer implements architecture changes only when the CTO explicitly requests them and the approved plan covers them, and the reviewer checks against that approved target. This is not permission for unilateral restructuring or for bypassing safety and other language rules.

## What's inside

| Path | Purpose |
| --- | --- |
| `src/cto.ts` | Extension: the `/cto` command, state handling, system-prompt injection |
| `prompts/cto.md` | CTO rules appended to the system prompt while the mode is on |
| `agents/developer.md` | `developer` subagent: plans, waits for `APPROVED`, implements, fixes `MUST_FIX` items |
| `agents/reviewer.md` | `reviewer` subagent: read-only review against the acceptance criteria, runs tests |

## Install

In omp:

```
/marketplace add samettemizer/nestiworks
/marketplace install --scope project dart@nestiworks
```

Then restart the session (extension modules load at session start).

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
2. **Profile default**: set with `/cto default on|off`, stored as `nestiworks-dart.json` in the active omp profile's agent directory (for example `~/.omp/agent/` or `~/.omp/profiles/<name>/agent/`).
3. **Off.**

The profile default is read when a session opens (start, `/new`, resume). Changing it does not affect sessions that are already open.

CTO rules are injected only into the main session. Subagents, including `developer` and `reviewer`, never get them.

## Commits

After the reviewer approves and the CTO accepts the criteria, the CTO automatically sends `COMMIT` to the developer; you do not need to request it separately. Only the developer commits, and the CTO waits for `status: "committed"` with actual commit hashes before reporting completion. An explicit no-commit instruction wins; read-only, investigation and no-change tasks create no empty commits. Messages follow Conventional Commits and must pass [Commitizen](https://commitizen-tools.github.io/commitizen/) `cz check` using the repository config. Missing `cz` or a failed commit blocks completion. Explicit approved-file pathspecs keep unrelated staged files out; overlapping user edits must be resolved rather than swept in. Pushes, tags, branches and version bumps are not automatic.

## ⚠️ Agent override

This plugin ships agents named `developer` and `reviewer`. Plugin agents take precedence over omp's bundled agents with the same name, so **installing this plugin replaces omp's built-in `reviewer` agent with this plugin's `reviewer`**, in every session, whether CTO mode is on or off. Project (`.omp/agents/`) and user (`<agent dir>/agents/`) agents with the same names still take precedence over the plugin's agents.

## License

MIT
