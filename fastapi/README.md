# nestiworks-fastapi

An [omp](https://omp.sh) plugin providing opt-in **CTO team mode** for FastAPI projects.

The main agent coordinates rather than edits: spec → developer plan → CTO `APPROVED` → implementation → read-only reviewer → relayed `MUST_FIX` rounds → CTO `COMMIT` → confirmed commit → report (unless you explicitly forbid commits or there is no change to commit). After three rejected reviews, the CTO asks you how to proceed. Developer and reviewer communicate only through the CTO. Phase updates use your language. Turning the mode off stops CTO prompt injection, not agent overrides.

## FastAPI focus

**ASGI concurrency, dependency lifetime and response contracts.** The CTO discovers installed versions, repository layout and configured checks before assigning work. The developer follows the existing architecture and toolchain; an architecture change requires explicit CTO approval and does not waive safety. The reviewer blocks demonstrated applicable defects, not stylistic preferences or arbitrary metrics.

- Keep Python/FastAPI/Pydantic APIs compatible with the installed versions; do not silently migrate Pydantic schemas or replace the repository's router/dependency structure.
- Do not call blocking I/O directly from async handlers/dependencies. FastAPI offloads normal def path operations and dependencies, but an ordinary helper called from async code runs directly. Use the existing async client or a deliberate supported offload boundary.
- Scope request resources with yield dependencies and application resources with the existing lifespan/startup-shutdown mechanism. Release resources on failures too, and re-raise or deliberately translate dependency exceptions rather than swallow them.
- Check dependency exit timing for the installed FastAPI version before using yielded resources in streams or background tasks. Work that outlives the request must own suitable resources; do not assume every yield dependency closes at the same point in every version.
- Maintain validation and intended output filtering using the existing response-model contract. Returning a raw Response bypasses automatic model processing: ensure explicit output is safe. Preserve authentication/authorization dependencies and exclude secrets from responses.

## Install and use

In omp:

```text
/marketplace add samettemizer/nestiworks
/marketplace install --scope project fastapi@nestiworks
```

Restart the session to load the extension, then use `/cto on` and describe the task.

| Command | Effect |
| --- | --- |
| `/cto` | Show effective state and source: `session`, `default` or `off` |
| `/cto on` / `/cto off` | Set the current session branch's choice |
| `/cto default on` / `/cto default off` | Set this profile's default for newly opened sessions |

Other arguments print usage; there is no separate `/cto status` command.

## State and precedence

The last explicit on/off choice on the current branch wins over the profile default; otherwise CTO mode is off. Session choices are stored as `nestiworks-fastapi.state` entries and survive resume. Branch/tree navigation restores the selected branch's choice.

The profile default lives in `nestiworks-fastapi.json` in the active omp agent directory (for example `~/.omp/agent/` or `~/.omp/profiles/<name>/agent/`). It is read when a session opens, including new/resumed sessions. Changing it does not change already-open sessions. CTO rules are injected only for the main agent, never for subagents.

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
| `prompts/cto.md` | CTO coordination and FastAPI discovery |
| `agents/developer.md` | Plan/approval/implementation and checked-commit policy |
| `agents/reviewer.md` | Read-only, evidence-based review |
| `test/cto.test.ts` | State and extension lifecycle behavior |

From this package directory, run `bun test`; from the repository root, `bun test fastapi/test`. The runtime tests use temporary state and a small extension API harness, not model calls or a FastAPI application/compiler. Project-specific checks are selected from the target repository.

## Official references

These references inform the domain rules, not a required framework version. Follow documentation for the versions detected in your project; newer APIs and SSR/reactive rules apply only where supported and used.

- [Async dispatch and helper calls](https://fastapi.tiangolo.com/async/)
- [Yield dependencies and lifetime](https://fastapi.tiangolo.com/tutorial/dependencies/dependencies-with-yield/)
- [Response validation and filtering](https://fastapi.tiangolo.com/tutorial/response-model/)
- [Application lifespan](https://fastapi.tiangolo.com/advanced/events/)

## License

MIT
