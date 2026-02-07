# prisma-safe-delete

A Prisma generator that creates a type-safe wrapper for soft deletion with automatic cascade support. Designed to be a drop-in replacement that you configure once and never think about again.

## Features

- **Automatic filter injection**: All read operations automatically exclude soft-deleted records
- **Deep relation filtering**: Filters applied to `include`, `select`, `_count`, and relation filters (`some`/`every`/`none`)
- **Cascade soft-delete**: Automatically cascades based on `onDelete: Cascade` relations
- **Unique constraint handling**: Automatically mangles unique string fields to free up values for reuse
- **Transaction support**: Interactive transactions receive wrapped clients with filtering
- **Compound key support**: Full support for compound primary keys and foreign keys
- **Escape hatches**: Access raw client, query deleted records, or hard delete when needed

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
  provider = "prisma-client-js"
}

generator softDelete {
  provider = "prisma-safe-delete"
  output   = "./generated/soft-delete"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
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
import { PrismaClient } from '@prisma/client';
import { wrapPrismaClient } from './generated/soft-delete';

const prisma = new PrismaClient();
const safePrisma = wrapPrismaClient(prisma);

// All queries automatically filter out soft-deleted records
const users = await safePrisma.user.findMany();

// Soft delete with automatic cascade
await safePrisma.user.softDelete({ where: { id: 'user-1' } });
// ^ This soft-deletes the user AND all their posts AND all comments on those posts
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
// Standard write operations pass through unchanged
await safePrisma.user.create({ data: { email: 'new@example.com' } });
await safePrisma.user.createMany({ data: [...] });
await safePrisma.user.update({ where: { id: 'user-1' }, data: { name: 'Jane' } });
await safePrisma.user.updateMany({ where: { ... }, data: { ... } });
await safePrisma.user.upsert({ where: { ... }, create: { ... }, update: { ... } });
```

### Soft Delete

```typescript
// Soft delete a single record (with cascade)
await safePrisma.user.softDelete({ where: { id: 'user-1' } });

// Soft delete multiple records (with cascade)
const result = await safePrisma.user.softDeleteMany({ where: { name: 'Test' } });
console.log(result.count); // Number of records soft-deleted
```

### Hard Delete (Escape Hatch)

```typescript
// Permanently delete when needed
await safePrisma.user.hardDelete({ where: { id: 'user-1' } });
await safePrisma.user.hardDeleteMany({ where: { createdAt: { lt: oldDate } } });
```

### Escape Hatches

```typescript
// Access the raw Prisma client (no filtering)
const allUsers = await safePrisma.$prisma.user.findMany();

// Query including soft-deleted records
const allUsers = await safePrisma.$includingDeleted.user.findMany();

// Query only soft-deleted records
const deletedUsers = await safePrisma.$onlyDeleted.user.findMany();
```

### Transactions

Interactive transactions receive wrapped clients with filtering:

```typescript
const result = await safePrisma.$transaction(async (tx) => {
  // tx has the same filtering as safePrisma
  const users = await tx.user.findMany();  // Excludes deleted
  const posts = await tx.post.findMany();  // Excludes deleted
  return { users, posts };
});
```

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
await safePrisma.user.softDelete({ where: { id: 'user-1' } });
// Soft-deletes:
// 1. The user
// 2. All their posts
// 3. All comments on those posts
// All with the same timestamp (transactional)
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

### Non-String Unique Fields

For non-string unique fields (Int, UUID, etc.), use a **partial unique index** in your database:

```sql
-- PostgreSQL
CREATE UNIQUE INDEX user_employee_id_active ON "User"(employee_id) WHERE deleted_at IS NULL;

-- MySQL (8.0+)
-- Use a generated column + unique index

-- SQLite
CREATE UNIQUE INDEX user_employee_id_active ON User(employee_id) WHERE deleted_at IS NULL;
```

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

### Update/Upsert on Soft-Deleted Records

`update` and `upsert` can still modify soft-deleted records. This is intentional to allow restoration workflows:

```typescript
// This works even if the user is soft-deleted
await safePrisma.user.update({
  where: { id: 'deleted-user' },
  data: { deleted_at: null }  // Restore the user
});
```

## Requirements

- Node.js >= 18
- Prisma >= 5.0.0
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
