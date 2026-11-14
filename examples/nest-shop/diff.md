# ArchSieve diff: before@de660c5d60 -> after@de660c5d60

## Structure (observed counts)

| kind | before | after | delta |
|---|---:|---:|---:|
| container | 1 | 1 | 0 |
| external-package | 1 | 1 | 0 |
| file | 6 | 8 | +2 |
| nest-controller | 1 | 1 | 0 |
| nest-module | 3 | 3 | 0 |
| nest-provider | 2 | 4 | +2 |
| edge:imports | 14 | 23 | +9 |
| edge:nest-imports | 3 | 4 | +1 |
| edge:nest-injects | 2 | 4 | +2 |

## Component dependencies (directories at depth 2)

- NEW dependency `src/users` -> `src/orders` (2 file import(s))

## Container facts

| Container | Files | Lines | Dependencies | Toolchains |
|---|---:|---:|---:|---|
| . | 10 (+2) | 112 (+33) | 0 | no change |

## New findings

### Errors: verifiable regressions (4)

- `di-cycle` Provider injection cycle among nest:provider:OrdersModule/OrdersService, nest:provider:UsersModule/UsersService (resolvable at runtime only through forwardRef).
- `module-cycle` Module import cycle among nest:module:OrdersModule, nest:module:UsersModule (resolvable at runtime only through forwardRef).
- `no-circular` Runtime import cycle: src/orders/orders.module.ts -> src/users/users.module.ts -> src/orders/orders.module.ts
- `no-circular` Runtime import cycle: src/orders/orders.service.ts -> src/users/users.service.ts -> src/orders/orders.service.ts

### Signals: heuristics, need human/agent judgement (2)

- `token-indirection` InMemoryUsersRepository is bound behind token "USERS_REPOSITORY" with 1 binding(s) in this graph. Check that the indirection answers a real need (multiple implementations, test seam, boundary).
- `type-only-cycle` Cycle exists only through type-only imports (erased at runtime; compile-time coupling): src/users/repository/users.repository.ts -> src/users/users.service.ts -> src/users/repository/users.repository.ts

### Unknowns: not inferable from static evidence (1)

- `non-class-provider` Provider "CLOCK" is a value/factory/alias provider; what it returns and depends on is not visible in the DI graph.

## Added nodes (4)

- `nest:provider:UsersModule/CLOCK` (nest-provider)
- `nest:provider:UsersModule/InMemoryUsersRepository` (nest-provider)
- `src/users/repository/in-memory-users.repository.ts` (file)
- `src/users/repository/users.repository.ts` (file)

## Added edges (12)

- `nest:module:UsersModule` -> `nest:module:OrdersModule` (nest-imports)
- `nest:provider:UsersModule/UsersService` -> `nest:provider:OrdersModule/OrdersService` (nest-injects)
- `nest:provider:UsersModule/UsersService` -> `nest:provider:UsersModule/InMemoryUsersRepository` (nest-injects)
- `src/users/repository/in-memory-users.repository.ts` -> `npm:@nestjs/common` (imports)
- `src/users/repository/in-memory-users.repository.ts` -> `src/users/repository/users.repository.ts` (imports, type-only)
- `src/users/repository/in-memory-users.repository.ts` -> `src/users/users.service.ts` (imports, type-only)
- `src/users/repository/users.repository.ts` -> `src/users/users.service.ts` (imports, type-only)
- `src/users/users.module.ts` -> `src/orders/orders.module.ts` (imports)
- `src/users/users.module.ts` -> `src/users/repository/in-memory-users.repository.ts` (imports)
- `src/users/users.module.ts` -> `src/users/repository/users.repository.ts` (imports)
- `src/users/users.service.ts` -> `src/orders/orders.service.ts` (imports)
- `src/users/users.service.ts` -> `src/users/repository/users.repository.ts` (imports)

_Facts come from the listed tools for these exact commits. Signals are not defects. Unknowns are not absences._
