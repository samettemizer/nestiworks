# nestiworks

A marketplace of 25 plugins for [oh-my-pi (omp)](https://omp.sh/): language- and framework-focused CTO team modes, plus a generic option. The CTO coordinates planning, implementation and review through specialist agents.

## Get started

With omp installed, run these commands inside an omp session in your project:

```text
/marketplace add samettemizer/nestiworks
/marketplace discover nestiworks
/marketplace install --scope project generic@nestiworks
```

Replace `generic` with a plugin name below. Restart the session to load its extension, then run `/cto on` to enable team mode (`/cto off` turns it off).

Use only one nestiworks team-mode plugin per project: variants share `/cto` and agent names. Plugin agents override matching bundled agents even when CTO mode is off; disable or uninstall the previous variant and restart when switching.

See the official [omp marketplace documentation](https://github.com/can1357/oh-my-pi/blob/main/docs/marketplace.md) for installation scopes, updates and removal.

## Plugins

| Plugin | Focus |
| --- | --- |
| [angular](angular/README.md) | Reactivity, dependency injection and component lifetimes |
| [c](c/README.md) | Buffer bounds, ownership and undefined behavior |
| [cpp](cpp/README.md) | RAII, iterator validity and resource lifetimes |
| [csharp](csharp/README.md) | Async cancellation and disposable ownership |
| [dart](dart/README.md) | Futures, streams and platform boundaries |
| [delphi](delphi/README.md) | Ownership, exceptions and UI-thread boundaries |
| [django](django/README.md) | Migrations, transactions and async ORM safety |
| [fastapi](fastapi/README.md) | ASGI concurrency and dependency lifetimes |
| [generic](generic/README.md) | General-purpose developer and reviewer workflow |
| [go](go/README.md) | Goroutine lifetimes and cancellation |
| [java](java/README.md) | Resource ownership and shared-state safety |
| [javascript](javascript/README.md) | Module interoperability, promises and input boundaries |
| [kotlin](kotlin/README.md) | Coroutines, lifecycle cancellation and shared state |
| [laravel](laravel/README.md) | Authorization, committed side effects and Nesti escalation |
| [nextjs](nextjs/README.md) | Server boundaries, authorization and caching |
| [php](php/README.md) | Loading, failure handling and SQL/output safety |
| [python](python/README.md) | Async boundaries, cancellation and resource ownership |
| [rails](rails/README.md) | Parameters, migrations and committed side effects |
| [react](react/README.md) | Render identity, effects and UI behavior |
| [ruby](ruby/README.md) | Loading, mutation ownership and dynamic dispatch |
| [rust](rust/README.md) | Ownership, unsafe invariants and async progress |
| [springboot](springboot/README.md) | Managed versions, transactions and web-stack boundaries |
| [swift](swift/README.md) | Actor isolation, ARC and deployment-aware APIs |
| [typescript](typescript/README.md) | Compiler/runtime alignment and boundary validation |
| [vue](vue/README.md) | Reactive identity, watcher cleanup and SSR isolation |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for PR and commit guidelines.

## License

[MIT](LICENSE)
