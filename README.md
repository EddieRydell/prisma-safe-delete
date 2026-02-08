# prisma-safe-delete

[![npm version](https://img.shields.io/npm/v/prisma-safe-delete.svg)](https://www.npmjs.com/package/prisma-safe-delete)
[![npm downloads](https://img.shields.io/npm/dm/prisma-safe-delete.svg)](https://www.npmjs.com/package/prisma-safe-delete)
[![CI](https://github.com/EddieRydell/prisma-safe-delete/actions/workflows/ci.yml/badge.svg)](https://github.com/EddieRydell/prisma-safe-delete/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)

A Prisma generator that creates a type-safe wrapper for soft deletion with automatic cascade support. Designed to be a drop-in replacement that you configure once and never think about again.

## Why This Library?

Soft deletion is a common pattern where records are marked as deleted (typically with a timestamp) rather than being permanently removed. This preserves data for auditing, recovery, and maintaining referential integrity.

**The problem:** Implementing soft deletion correctly is tedious and error-prone. You need to remember to filter out deleted records in every query, handle cascading deletes manually, and deal with unique constraint conflicts when "deleted" records still occupy unique values.

**prisma-safe-delete solves this by:**
- Automatically filtering deleted records from all read operations
- Cascading soft-deletes through your relation tree (following `onDelete: Cascade`)
- Mangling unique string fields to free them for reuse
- Providing escape hatches when you need to access deleted data

## Features

- **Automatic filter injection**: All read operations automatically exclude soft-deleted records
- **Deep relation filtering**: Filters applied to `include`, `select`, `_count`, and relation filters (`some`/`every`/`none`)
- **Filter propagation**: Escape hatch modes (`$onlyDeleted`, `$includingDeleted`) propagate through nested relations
- **Explicit filter overrides**: User-specified `deleted_at` filters override automatic propagation
- **Cascade soft-delete**: Automatically cascades based on `onDelete: Cascade` relations
- **Detailed cascade info**: Returns counts of cascaded deletions by model type
- **Unique constraint handling**: Automatically mangles unique string fields to free up values for reuse
- **Transaction support**: Full soft-delete API including escape hatches available in transactions
- **Atomic operations**: Combine `restoreCascade` with audit logging in transactions
- **Helper utilities**: Functions for manual filtering in complex nested queries
- **Compound key support**: Full support for compound primary keys and foreign keys
- **Escape hatches**: Multiple ways to access deleted records or bypass filtering

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

## API Reference

### Read Operations (Auto-filtered)

All read operations automatically inject `deleted_at: null` filters:

```typescript
// These all exclude soft-deleted records automatically
await safePrisma.user.findMany();
await safePrisma.user.findFirst({ where: { name: 'John' } });
await safePrisma.user.findUnique({ where: { id: 'user-1' } });
await safePrisma.user.findFirstOrThrow({ where: { email: 'john@example.com' } });
await safePrisma.user.findUniqueOrThrow({ where: { id: 'user-1' } });
await safePrisma.user.count();
await safePrisma.user.aggregate({ _count: true });
await safePrisma.user.groupBy({ by: ['name'], _count: true });
```

### Relation Queries (Auto-filtered)

Filters are automatically injected into relation queries:

```typescript
// Posts in include are filtered
const user = await safePrisma.user.findUnique({
  where: { id: 'user-1' },
  include: { posts: true }  // Only returns non-deleted posts
});

// Nested relations are filtered too
const user = await safePrisma.user.findUnique({
  where: { id: 'user-1' },
  include: {
    posts: {
      include: { comments: true }  // Only non-deleted comments
    }
  }
});

// select works the same way
const user = await safePrisma.user.findUnique({
  where: { id: 'user-1' },
  select: {
    email: true,
    posts: { select: { title: true } }  // Only non-deleted posts
  }
});

// _count is filtered
const user = await safePrisma.user.findUnique({
  where: { id: 'user-1' },
  include: {
    _count: { select: { posts: true } }  // Counts only non-deleted posts
  }
});
```

### Relation Filters (Auto-filtered)

The `some`, `every`, and `none` relation filters exclude soft-deleted records:

```typescript
// Find users who have at least one active post
const users = await safePrisma.user.findMany({
  where: {
    posts: { some: { title: { contains: 'hello' } } }  // Ignores deleted posts
  }
});

// Find users where all their posts are published
const users = await safePrisma.user.findMany({
  where: {
    posts: { every: { published: true } }  // Only considers non-deleted posts
  }
});
```

### Write Operations

```typescript
// Create operations pass through unchanged
await safePrisma.user.create({ data: { email: 'new@example.com' } });
await safePrisma.user.createMany({ data: [...] });

// update and updateMany filter out soft-deleted records
// (you cannot accidentally modify a deleted record)
await safePrisma.user.update({ where: { id: 'user-1' }, data: { name: 'Jane' } });
await safePrisma.user.updateMany({ where: { ... }, data: { ... } });

// upsert passes through unchanged (can find soft-deleted records)
await safePrisma.user.upsert({ where: { ... }, create: { ... }, update: { ... } });
```

### Soft Delete

```typescript
// Soft delete a single record (with cascade)
const { record, cascaded } = await safePrisma.user.softDelete({ where: { id: 'user-1' } });
console.log(record);    // The deleted user record (or null if not found)
console.log(cascaded);  // { Post: 3, Comment: 7 } — cascade-deleted counts by model

// Soft delete multiple records (with cascade)
const { count, cascaded } = await safePrisma.user.softDeleteMany({ where: { name: 'Test' } });
console.log(count);     // Number of matched records soft-deleted
console.log(cascaded);  // Aggregated cascade counts across all matched records
```

The `cascaded` field is a `Record<string, number>` mapping model names to the number of records that were cascade-deleted. It's empty (`{}`) when there are no cascade children.

### Restore

Restore soft-deleted records by setting `deleted_at` back to `null` and unmangling unique fields:

```typescript
// Restore a single record (does NOT restore children)
const user = await safePrisma.user.restore({ where: { id: 'user-1' } });

// Restore multiple records
const result = await safePrisma.user.restoreMany({ where: { name: 'Test' } });
console.log(result.count); // Number of records restored

// Restore with cascade - restores parent AND all cascade-deleted children
const { record, cascaded } = await safePrisma.user.restoreCascade({ where: { id: 'user-1' } });
// ^ Restores the user AND all their posts AND comments that were cascade-deleted
console.log(cascaded); // { Post: 2, Comment: 5 } — restored counts by model
```

**How cascade restore works:**
- Children are identified by having the **exact same `deleted_at` timestamp** as the parent
- This matches the behavior of cascade soft-delete, which uses a single timestamp for the whole tree
- All operations are wrapped in a transaction

**Conflict handling:** If the unmangled unique value already exists in an active record, `restore` throws an error. You must delete or modify the conflicting record first.

```typescript
// This will throw if 'john@example.com' is already taken by another active user
await safePrisma.user.restore({ where: { id: 'deleted-user-id' } });
// Error: Cannot restore User: unique field "email" with value "john@example.com"
// already exists in an active record.
```

### Hard Delete (Escape Hatch)

```typescript
// Permanently delete when needed (intentionally ugly name to discourage use)
await safePrisma.user.__dangerousHardDelete({ where: { id: 'user-1' } });
await safePrisma.user.__dangerousHardDeleteMany({ where: { createdAt: { lt: oldDate } } });
```

### Escape Hatches

When you need to query deleted records or bypass filtering:

```typescript
// Access the raw Prisma client (no filtering at all)
const allUsers = await safePrisma.$prisma.user.findMany();

// Query including soft-deleted records (with filter propagation)
const allUsers = await safePrisma.$includingDeleted.user.findMany({
  include: { posts: true }  // Includes both deleted and active posts
});

// Query only soft-deleted records (with filter propagation)
const deletedUsers = await safePrisma.$onlyDeleted.user.findMany({
  include: { posts: true }  // Includes only deleted posts
});

// Per-model escape hatch
const allUserPosts = await safePrisma.user.includingDeleted.findMany();
```

### Transactions

Interactive transactions have full soft-delete support including escape hatches:

```typescript
await safePrisma.$transaction(async (tx) => {
  // Standard filtering (excludes deleted)
  const users = await tx.user.findMany();
  const posts = await tx.post.findMany();

  // Use escape hatches in transactions
  const deletedUsers = await tx.$onlyDeleted.user.findMany();
  const allPosts = await tx.$includingDeleted.post.findMany();

  // Restore with atomic audit logging
  const { record, cascaded } = await tx.user.restoreCascade({
    where: { id: 'user-123' }
  });

  await tx.auditLog.create({
    data: {
      action: `RESTORE:User:${record!.id}`,
      entityId: record!.id,
    },
  });
});
```

## Advanced Filtering

### Filter Propagation

Filter modes automatically propagate through relation includes for consistent behavior:

```typescript
// $onlyDeleted propagates to all relations
const user = await safePrisma.$onlyDeleted.user.findFirst({
  where: { id: 'user-123' },
  include: {
    posts: true,          // Only deleted posts
    comments: {
      include: {
        replies: true     // Only deleted replies (nested propagation)
      }
    }
  }
});

// $includingDeleted propagates too
const user = await safePrisma.$includingDeleted.user.findFirst({
  where: { id: 'user-123' },
  include: {
    posts: true  // All posts (deleted + active)
  }
});
```

### Explicit Filter Overrides

You can override automatic propagation with explicit `where` clauses:

```typescript
// Query deleted users with their ACTIVE posts
const user = await safePrisma.$onlyDeleted.user.findFirst({
  where: { id: 'user-123' },
  include: {
    posts: {
      where: { deleted_at: null }  // Override: only active posts
    }
  }
});

// Mixed filtering at different levels
const user = await safePrisma.$onlyDeleted.user.findFirst({
  include: {
    posts: true,                    // Deleted posts (auto-propagated)
    comments: {
      where: { deleted_at: null },  // But active comments (override)
      include: {
        replies: true               // Deleted replies (resumes propagation)
      }
    }
  }
});
```

### Helper Utilities for Nested Filtering

For complex where clauses where escape hatches don't work:

```typescript
import { onlyDeleted, excludeDeleted, includingDeleted } from './generated/soft-delete';

// Find users who have deleted memberships
const users = await safePrisma.user.findMany({
  where: {
    memberships: {
      some: onlyDeleted('Membership', {
        organizationId: 'org-123'
      })
    }
  }
});

// Find active posts with deleted comments
const posts = await safePrisma.post.findMany({
  where: {
    comments: {
      some: onlyDeleted('Comment', {
        content: { contains: 'spam' }
      })
    }
  }
});

// Explicit active filter (overrides propagation)
const user = await safePrisma.$onlyDeleted.user.findFirst({
  include: {
    posts: {
      where: excludeDeleted('Post', { published: true })
    }
  }
});
```

#### Helper Functions

| Function | Purpose | Example |
|----------|---------|---------|
| `onlyDeleted(model, where)` | Filter for deleted records | `onlyDeleted('Post', { author_id: '123' })` |
| `excludeDeleted(model, where)` | Filter for active records | `excludeDeleted('User', { role: 'admin' })` |
| `includingDeleted(where)` | No-op for clarity | `includingDeleted({ status: 'premium' })` |

### Escape Hatch Comparison

| Feature | `safePrisma.model` | `$includingDeleted` | `$onlyDeleted` | `model.includingDeleted` | `$prisma` |
|---------|-------------------|---------------------|----------------|--------------------------|-----------|
| **Filter mode** | Exclude deleted | Include all | Only deleted | Include all | No filtering |
| **Propagates to relations** | ✅ Yes | ✅ Yes | ✅ Yes | ❌ No | ❌ No |
| **Can override per-relation** | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes | N/A |
| **Available in transactions** | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes | ❌ No |
| **Soft delete methods** | ✅ Yes | ❌ No | ❌ No | ❌ No | ❌ No |
| **TypeScript types** | Full safe client | Read-only | Read-only | Read-only | Raw Prisma |
| **Use case** | Normal queries | View full history | Restore operations | Quick override | Raw SQL/migrations |

#### When to Use Each

- **`safePrisma.model`**: Default for all normal queries
- **`$onlyDeleted`**: Restore workflows, viewing deleted records with their cascade children
- **`$includingDeleted`**: Analytics, full history views (both active and deleted)
- **`model.includingDeleted`**: Quick access to all records for a specific model
- **`$prisma`**: Raw queries, migrations, or when you need to bypass all filtering

## Cascade Behavior

Soft-delete cascades follow `onDelete: Cascade` relations defined in your schema:

```prisma
model User {
  id         String    @id
  posts      Post[]
  profile    Profile?
  deleted_at DateTime?
}

model Post {
  id         String    @id
  author     User      @relation(fields: [authorId], references: [id], onDelete: Cascade)
  authorId   String
  comments   Comment[]
  deleted_at DateTime?
}

model Comment {
  id         String    @id
  post       Post      @relation(fields: [postId], references: [id], onDelete: Cascade)
  postId     String
  deleted_at DateTime?
}
```

```typescript
const { record, cascaded } = await safePrisma.user.softDelete({ where: { id: 'user-1' } });
// Soft-deletes:
// 1. The user
// 2. All their posts
// 3. All comments on those posts
// All with the same timestamp (transactional)

console.log(cascaded); // { Post: 2, Comment: 5 }
```

### Cascade Rules

- Only follows `onDelete: Cascade` relations
- Only soft-deletes children that have a `deleted_at` field
- Children without `deleted_at` are left unchanged
- All cascaded records get the same `deleted_at` timestamp
- Entire operation is transactional (all-or-nothing)

## Unique Constraint Handling

When you soft-delete a record with unique string fields, the values are automatically mangled to free them up for reuse:

```typescript
// Before soft delete
{ id: 'user-1', email: 'john@example.com', deleted_at: null }

// After soft delete
{ id: 'user-1', email: 'john@example.com__deleted_user-1', deleted_at: '2024-...' }

// Now you can create a new user with the same email
await safePrisma.user.create({ data: { email: 'john@example.com' } });  // Works!
```

### Mangling Rules

- Only **string** fields with `@unique` or `@@unique` are mangled
- Suffix format: `__deleted_{primaryKey}`
- For compound PKs: `__deleted_{pk1}_{pk2}` (sorted alphabetically)
- NULL values are not mangled (already allow duplicates)
- Mangling is idempotent (won't double-mangle)
- Fails with clear error if mangled value would exceed max string length

### Disabling Mangling

If you prefer to handle unique constraints yourself (e.g., via partial unique indexes), you can disable mangling:

```prisma
generator softDelete {
  provider       = "prisma-safe-delete"
  output         = "./generated/soft-delete"
  uniqueStrategy = "none"  // Skip mangling, use partial indexes instead
}
```

**Options:**
- `"mangle"` (default): Append `__deleted_{pk}` suffix to unique string fields
- `"none"`: Skip mangling entirely; you handle uniqueness via partial indexes

When using `uniqueStrategy = "none"`, a warning is displayed during `prisma generate` listing all constraints that need attention:

```
⚠️  prisma-safe-delete: uniqueStrategy is 'none'
   You must create partial unique indexes manually to prevent conflicts.

   Models requiring partial unique indexes:
     - User: email
     - Customer: email, username

   Example SQL (PostgreSQL):
     CREATE UNIQUE INDEX user_email_active ON "User"(email) WHERE deleted_at IS NULL;
     CREATE UNIQUE INDEX customer_email_active ON "Customer"(email) WHERE deleted_at IS NULL;
```

If you have compound `@@unique` constraints that include `deleted_at` (e.g., `@@unique([org_id, name, deleted_at])`), the generator will warn you that these don't enforce uniqueness on active records because `NULL != NULL` in SQL, and suggest replacing them with partial indexes.

### Partial Unique Indexes

For non-string unique fields (Int, UUID, etc.) or if you prefer not to mangle, use **partial unique indexes** in your database:

```sql
-- PostgreSQL
CREATE UNIQUE INDEX user_email_active ON "User"(email) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX user_employee_id_active ON "User"(employee_id) WHERE deleted_at IS NULL;

-- MySQL (8.0+)
-- Use a generated column + unique index

-- SQLite
CREATE UNIQUE INDEX user_email_active ON User(email) WHERE deleted_at IS NULL;
```

This approach works for all field types and avoids the max-length issues of mangling.

## Compound Primary Keys

Full support for compound primary keys:

```prisma
model TenantUser {
  tenantId   String
  userId     String
  email      String
  deleted_at DateTime?

  @@id([tenantId, userId])
}
```

```typescript
await safePrisma.tenantUser.softDelete({
  where: {
    tenantId_userId: { tenantId: 'tenant-1', userId: 'user-1' }
  }
});
```

## Soft Delete Detection

Models are automatically detected as soft-deletable if they have a nullable DateTime field named:
- `deleted_at` (snake_case)
- `deletedAt` (camelCase)

```prisma
// Both of these work:
model User {
  deleted_at DateTime?  // snake_case
}

model Post {
  deletedAt DateTime?   // camelCase
}
```

## Known Limitations

### Fluent API

The Prisma fluent API bypasses the wrapper. Use `include` instead:

```typescript
// ❌ Does NOT filter deleted posts
const posts = await safePrisma.user.findUnique({ where: { id: '1' } }).posts();

// ✅ Correctly filters deleted posts
const user = await safePrisma.user.findUnique({
  where: { id: '1' },
  include: { posts: true }
});
const posts = user.posts;
```

### Raw Queries

Raw queries bypass the wrapper entirely (by design):

```typescript
// No filtering applied - returns all records including deleted
const users = await safePrisma.$queryRaw`SELECT * FROM User`;
```

### Upsert on Soft-Deleted Records

`upsert` can still find soft-deleted records (it passes through to Prisma unchanged). This means a soft-deleted record may be found by its unique constraint and updated rather than creating a new one:

```typescript
// If 'john@example.com' exists but is soft-deleted, this updates it
await safePrisma.user.upsert({
  where: { email: 'john@example.com' },
  create: { email: 'john@example.com', name: 'John' },
  update: { name: 'John Updated' },
});
```

## Test Coverage

This library has comprehensive test coverage across unit, integration, and end-to-end tests:

| Scenario | Status |
|----------|--------|
| `findUnique` rewritten correctly | ✅ |
| `include`/`select` nested 2–3 levels deep | ✅ |
| Relation filters (`some`/`every`/`none`) with deleted children | ✅ |
| `_count` correctness | ✅ |
| `groupBy`/`aggregate` exclude deleted | ✅ |
| `update`/`updateMany` filter out soft-deleted records | ✅ |
| Cascade with mixed children (some soft-deletable, some not) | ✅ |
| Self-referential relations (cycles) handled safely | ✅ |
| Deep cascade chains (4+ levels) | ✅ |
| Wide cascade (multiple child types simultaneously) | ✅ |
| Cascade result counts accurate (including partial cascades) | ✅ |
| Compound primary key mangling stable | ✅ |
| Idempotent `softDelete` (re-deleting is safe) | ✅ |
| `restore` unmangles unique fields | ✅ |
| `restoreCascade` restores parent + children with counts | ✅ |
| Restore conflict detection | ✅ |
| Interactive transactions receive wrapped clients | ✅ |
| Cascade results correct in transaction context | ✅ |
| Compile-time enforcement of return types | ✅ |
| Fast-path optimization for leaf models | ✅ |
| Fluent API bypass confirmed (documented limitation) | ✅ |

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
