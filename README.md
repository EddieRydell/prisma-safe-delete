# prisma-safe-delete

[![npm version](https://img.shields.io/npm/v/prisma-safe-delete.svg)](https://www.npmjs.com/package/prisma-safe-delete)
[![npm downloads](https://img.shields.io/npm/dm/prisma-safe-delete.svg)](https://www.npmjs.com/package/prisma-safe-delete)
[![CI](https://github.com/EddieRydell/prisma-safe-delete/actions/workflows/ci.yml/badge.svg)](https://github.com/EddieRydell/prisma-safe-delete/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)

A Prisma generator that creates a type-safe wrapper for soft deletion with automatic cascade support. Designed to be a drop-in replacement that you configure once and (hopefully) never think about again.

## Why This Library?

Soft deletion is a common pattern where records are marked as deleted (typically with a timestamp) rather than being permanently removed. This preserves data for auditing, recovery, and maintaining referential integrity.

**The problem:** Implementing soft deletion correctly is tedious and error-prone. You need to remember to filter out deleted records in every query, handle cascading deletes manually, and deal with unique constraint conflicts when "deleted" records still occupy unique values.

**prisma-safe-delete solves this by:**
- Automatically filtering deleted records from all read operations
- Cascading soft-deletes through your relation tree (following `onDelete: Cascade`)
- Mangling unique string fields to free them for reuse
- Providing escape hatches when you need to access deleted data

## Features

- **Automatic filter injection** on all read operations, including nested `include`, `select`, `_count`, and relation filters (`some`/`every`/`none`)
- **Cascade soft-delete** following `onDelete: Cascade` relations, with detailed counts by model
- **Unique constraint handling** via mangling, sentinel dates, or manual partial indexes
- **Escape hatches**: `$includingDeleted`, `$onlyDeleted`, per-model overrides, and raw `$prisma` access
- **Transaction support** with full soft-delete API including escape hatches
- **Restore operations** including cascade restore matching by timestamp
- **Compound key support** for both primary and foreign keys

## Installation

```bash
npm install prisma-safe-delete
# or
pnpm add prisma-safe-delete
# or
yarn add prisma-safe-delete
```

## Quick Start

### 1. Add the generator to your Prisma schema

```prisma
generator client {
  provider = "prisma-client"
  output   = "./generated/client"
}

generator softDelete {
  provider = "prisma-safe-delete"
  output   = "./generated/soft-delete"
}

datasource db {
  provider = "postgresql"
}
```

### 2. Add `deleted_at` to soft-deletable models

```prisma
model User {
  id         String    @id @default(cuid())
  email      String    @unique
  name       String?
  posts      Post[]
  deleted_at DateTime?  // Makes this model soft-deletable
}

model Post {
  id         String    @id @default(cuid())
  title      String
  authorId   String
  author     User      @relation(fields: [authorId], references: [id], onDelete: Cascade)
  comments   Comment[]
  deleted_at DateTime?
}

model Comment {
  id         String    @id @default(cuid())
  content    String
  postId     String
  post       Post      @relation(fields: [postId], references: [id], onDelete: Cascade)
  deleted_at DateTime?
}
```

### 3. Generate and use

```bash
npx prisma generate
```

```typescript
import { PrismaClient } from './generated/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { wrapPrismaClient } from './generated/soft-delete';

// Prisma 7 requires an adapter
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({ adapter });
const safePrisma = wrapPrismaClient(prisma);

// All queries automatically filter out soft-deleted records
const users = await safePrisma.user.findMany();

// Soft delete with automatic cascade
const { record, cascaded } = await safePrisma.user.softDelete({ where: { id: 'user-1' } });
// ^ Soft-deletes the user AND all their posts AND all comments on those posts
console.log(cascaded); // { Post: 3, Comment: 7 }
```

## API Overview

All read operations (`findMany`, `findFirst`, `findUnique`, `count`, `aggregate`, `groupBy`) automatically exclude soft-deleted records. Filters propagate into nested `include`, `select`, and `_count`.

| Method | Description |
|--------|-------------|
| `softDelete` | Soft-delete one record with cascade, returns `{ record, cascaded }` |
| `softDeleteMany` | Soft-delete many records with cascade, returns `{ count, cascaded }` |
| `softDeletePreview` | Preview cascade without changes, returns `{ wouldDelete }` |
| `restore` | Restore one record (no cascade) |
| `restoreMany` | Restore many records |
| `restoreCascade` | Restore one record + cascade children (matched by timestamp) |
| `__dangerousHardDelete` | Permanently delete one record |
| `__dangerousHardDeleteMany` | Permanently delete many records |
| `$includingDeleted` | Query all records (propagates to relations) |
| `$onlyDeleted` | Query only deleted records (propagates to relations) |
| `model.includingDeleted` | Per-model override (does not propagate) |
| `$prisma` | Raw Prisma client (no filtering) |
| `$transaction` | Interactive transaction with full soft-delete API |

For full API documentation with examples, see [docs/api-reference.md](docs/api-reference.md).

## Unique Constraint Handling

Three strategies are available via the `uniqueStrategy` generator option:

- **`"mangle"` (default)**: Appends `__deleted_{pk}` to unique string fields on soft-delete
- **`"none"`**: No mangling; you handle uniqueness via partial indexes
- **`"sentinel"`**: Uses `deleted_at = 9999-12-31` for active records, enabling `@@unique([field, deleted_at])` compound constraints

```prisma
generator softDelete {
  provider       = "prisma-safe-delete"
  output         = "./generated/soft-delete"
  uniqueStrategy = "sentinel"  // or "mangle" (default) or "none"
}
```

For full details on each strategy, migration guides, and generator warnings, see [docs/unique-strategies.md](docs/unique-strategies.md).

## Cascade Behavior

Soft-delete cascades follow `onDelete: Cascade` relations. All cascaded records share the same `deleted_at` timestamp, and the entire operation is transactional.

To disable cascading entirely, set `cascade = "false"`. With soft deletes the parent row still exists in the database, so foreign key constraints are never violated — cascading is a policy choice, not a data integrity requirement.

```prisma
generator softDelete {
  provider = "prisma-safe-delete"
  output   = "./generated/soft-delete"
  cascade  = "false"  // default: "true"
}
```

When cascade is disabled, all models use the fast `updateMany` path (no per-record transactions), and `softDelete` / `softDeleteMany` always return `cascaded: {}`.

For cascade rules and performance characteristics, see [docs/cascade-behavior.md](docs/cascade-behavior.md).

## Soft Delete Detection

Models are automatically detected as soft-deletable if they have a DateTime field named `deleted_at` or `deletedAt` matching one of these patterns:

- `DateTime?` (nullable) — used with `mangle` and `none` strategies
- `DateTime @default(...)` (non-nullable with default) — used with `sentinel` strategy

## Known Limitations

- **Fluent API**: `safePrisma.user.findUnique(...).posts()` bypasses filtering. Use `include` instead.
- **Raw queries**: `$queryRaw` bypasses the wrapper entirely (by design).
- **Upsert**: Soft-deleted records are not found by `upsert`'s `where` clause. With `none` strategy, the `create` branch will fail on unique constraint violation.
- **`$extends`**: `safePrisma.$extends(...)` returns a raw PrismaClient. Use `safePrisma.$prisma.$extends(...)` instead.
- **To-one includes**: Prisma doesn't support `where` on to-one relation includes, so soft-deleted to-one relations (e.g., `profile`, `author`) will still appear in results. See [Limitations and Caveats](#limitations-and-caveats) below.
- **Nested writes**: `connect`, `connectOrCreate`, and nested `create`/`delete` within `data` bypass soft-delete logic.
- **Sequential transactions**: `$transaction([...])` with a promise array bypasses soft-delete filtering. Use the interactive form `$transaction(async (tx) => { ... })` instead.
- **No database-level enforcement**: The wrapper operates at the application layer only. Developers can bypass soft-delete via `$prisma`, `__dangerousHardDelete`, raw SQL, or by using PrismaClient directly. For strict enforcement, add database triggers or row-level security policies.

## Limitations and Caveats

### To-one relation includes expose soft-deleted records

Prisma does not support `where` on to-one relation includes ([prisma/prisma#16049](https://github.com/prisma/prisma/issues/16049)). This means soft-deleted to-one relations are returned as if they are active:

```typescript
const user = await safePrisma.user.findFirst({
  include: {
    posts: true,    // ✓ Soft-deleted posts are filtered out
    profile: true,  // ✗ Soft-deleted profile is still returned
  }
});
```

**Impact**: If soft-deleted records contain sensitive data (PII, credentials), that data will be visible through to-one includes. List relations (`posts`, `comments`) are always filtered correctly.

**Workaround**: Check the `deleted_at` field on returned to-one relations in your application code, or avoid including to-one relations to soft-deletable models when the data is sensitive.

### Concurrent operations and isolation levels

Cascade and restore operations use transactions at the default isolation level (READ COMMITTED). Under heavy concurrent access to the same records, this can lead to:

- **Restore conflicts**: The conflict check (findFirst) and the actual restore (update) are not atomic — another transaction can insert a conflicting record between these steps.
- **Cascade inconsistency**: New child records created between the parent's findMany and the cascade updates may be missed.

If your application performs concurrent soft-deletes or restores on overlapping records, use SERIALIZABLE isolation:

```typescript
await safePrisma.$transaction(async (tx) => {
  await tx.user.softDelete({ where: { id: 'user-1' } });
}, { isolationLevel: 'Serializable' });
```

### Sentinel strategy and date range queries

With the sentinel strategy, active records have `deleted_at = 9999-12-31`. Any raw query or `$prisma` escape hatch that uses date range comparisons on `deleted_at` will match active records unexpectedly:

```sql
-- This matches ALL active records (sentinel = 9999-12-31)
SELECT * FROM "User" WHERE deleted_at > '2024-01-01';
```

This only affects raw queries and `$prisma` — the wrapper handles sentinel comparisons correctly for all wrapped operations.

## Test Coverage

| Scenario | Status |
|----------|--------|
| `findUnique` rewritten correctly | Tested |
| `include`/`select` nested 2-3 levels deep | Tested |
| Relation filters (`some`/`every`/`none`) with deleted children | Tested |
| `_count` correctness | Tested |
| `groupBy`/`aggregate` exclude deleted | Tested |
| `update`/`updateMany` filter out soft-deleted records | Tested |
| Cascade with mixed children (some soft-deletable, some not) | Tested |
| Self-referential relations (cycles) handled safely | Tested |
| Deep cascade chains (4+ levels) | Tested |
| Wide cascade (multiple child types simultaneously) | Tested |
| Cascade result counts accurate (including partial cascades) | Tested |
| Compound primary key mangling stable | Tested |
| Idempotent `softDelete` (re-deleting is safe) | Tested |
| `restore` unmangles unique fields | Tested |
| `restoreCascade` restores parent + children with counts | Tested |
| Restore conflict detection | Tested |
| Interactive transactions receive wrapped clients | Tested |
| Cascade results correct in transaction context | Tested |
| Compile-time enforcement of return types | Tested |
| Fast-path optimization for leaf models | Tested |
| Fluent API bypass confirmed (documented limitation) | Tested |

Run the full test suite:

```bash
pnpm test
```

## Requirements

- Node.js >= 18
- Prisma >= 7.0.0
- TypeScript >= 5.0 (recommended)

## Development

```bash
# Start Postgres
docker compose up -d

# Run tests
pnpm test

# Stop Postgres
docker compose down
```

## License

MIT
