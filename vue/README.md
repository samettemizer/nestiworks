# nestiworks-vue

An [omp](https://omp.sh) plugin providing opt-in **CTO team mode** for Vue projects.

The main agent coordinates rather than edits: spec → developer plan → CTO `APPROVED` → implementation → read-only reviewer → relayed `MUST_FIX` rounds → CTO `COMMIT` → confirmed commit → report (unless you explicitly forbid commits or there is no change to commit). After three rejected reviews, the CTO asks you how to proceed. Developer and reviewer communicate only through the CTO. Phase updates use your language. Turning the mode off stops CTO prompt injection, not agent overrides.

## Vue focus

**Reactive identity, watcher cleanup and SSR request isolation.** The CTO discovers installed versions, repository layout and configured checks before assigning work. The developer follows the existing architecture and toolchain; an architecture change requires explicit CTO approval and does not waive safety. The reviewer blocks demonstrated applicable defects, not stylistic preferences or arbitrary metrics.

- Stay within the installed Vue/compiler APIs and existing Options/Composition conventions. Preserve reactive connections when passing or destructuring state; compiler-supported reactive props destructuring is version-dependent, not a blanket error.
- Keep props one-way: emit the existing update/event contract rather than mutating parent-owned state unexpectedly. Use computed state for derivation and watchers for side effects.
- Prevent stale async watcher results from overwriting newer state and clean up the work they start. onWatcherCleanup requires Vue 3.5+ and synchronous registration before await; use the supported cleanup callback otherwise. Synchronous setup watchers auto-stop on unmount; asynchronously created watchers may need explicit stopping.
- In SSR code, do not put request-specific mutable state in shared module singletons or access browser globals on the server. Ensure the server and first client render agree; component unmount cleanup does not run during SSR.

## Install and use

In omp:

```text
/marketplace add samettemizer/nestiworks
/marketplace install --scope project vue@nestiworks
```

Restart the session to load the extension, then use `/cto on` and describe the task.

| Command | Effect |
| --- | --- |
| `/cto` | Show effective state and source: `session`, `default` or `off` |
| `/cto on` / `/cto off` | Set the current session branch's choice |
| `/cto default on` / `/cto default off` | Set this profile's default for newly opened sessions |

Other arguments print usage; there is no separate `/cto status` command.

## State and precedence

The last explicit on/off choice on the current branch wins over the profile default; otherwise CTO mode is off. Session choices are stored as `nestiworks-vue.state` entries and survive resume. Branch/tree navigation restores the selected branch's choice.

The profile default lives in `nestiworks-vue.json` in the active omp agent directory (for example `~/.omp/agent/` or `~/.omp/profiles/<name>/agent/`). It is read when a session opens, including new/resumed sessions. Changing it does not change already-open sessions. CTO rules are injected only for the main agent, never for subagents.

## Commits

After the reviewer approves and the CTO accepts the criteria, the CTO automatically sends `COMMIT` to the developer; you do not need to request it separately. Only the developer commits, and the CTO waits for `status: "committed"` with actual commit hashes before reporting completion. An explicit no-commit instruction wins; read-only, investigation and no-change tasks create no empty commits. Messages follow Conventional Commits and must pass [Commitizen](https://commitizen-tools.github.io/commitizen/) `cz check` using the repository config. Missing `cz` or a failed commit blocks completion. Explicit approved-file pathspecs keep unrelated staged files out; overlapping user edits must be resolved rather than swept in. Pushes, tags, branches and version bumps are not automatic.

## Agent overrides and collisions

This package ships agents named `developer` and `reviewer`. They override omp's bundled agents with those names even while CTO mode is off. Project `.omp/agents/` and user `<agent dir>/agents/` definitions take precedence over plugin agents.

**Use one nestiworks team-mode package per project.** All variants register `/cto` and the same agent names. Separate state filenames do not prevent command conflicts or mixed agent selection when multiple variants load; do not rely on load order. Disable/uninstall the other variant and restart when switching.

## Package contents and tests

| Path | Purpose |
| --- | --- |
| `package.json` | Isolated omp extension manifest |
| `src/cto.ts` | Command, state persistence and main-only injection |
| `prompts/cto.md` | CTO coordination and Vue discovery |
| `agents/developer.md` | Plan/approval/implementation and checked-commit policy |
| `agents/reviewer.md` | Read-only, evidence-based review |
| `test/cto.test.ts` | State and extension lifecycle behavior |

From this package directory, run `bun test`; from the repository root, `bun test vue/test`. The runtime tests use temporary state and a small extension API harness, not model calls or a Vue application/compiler. Project-specific checks are selected from the target repository.

## Official references

These references inform the domain rules, not a required framework version. Follow documentation for the versions detected in your project; newer APIs and SSR/reactive rules apply only where supported and used.

- [Reactive limitations](https://vuejs.org/guide/essentials/reactivity-fundamentals.html)
- [Props](https://vuejs.org/guide/components/props.html)
- [Watchers and version-specific cleanup](https://vuejs.org/guide/essentials/watchers.html)
- [SSR isolation and hydration](https://vuejs.org/guide/scaling-up/ssr.html)

## License

MIT
