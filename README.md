# prisma-soft-cascade

A Prisma generator that creates a type-safe wrapper for soft deletion with automatic cascade support.

## Features

- **Auto-injected filters**: Automatically adds `deleted_at: null` filters on all read operations
- **Type-safe soft delete**: Removes `.delete()` from the type system for soft-deletable models
- **Cascade support**: Automatically cascades soft-deletes based on `onDelete: Cascade` relations
- **Escape hatches**: Access underlying Prisma client, query deleted records, or perform hard deletes when needed

## Installation

```bash
npm install prisma-soft-cascade
# or
pnpm add prisma-soft-cascade
```

## Setup

### 1. Add the generator to your Prisma schema

```prisma
generator client {
  provider = "prisma-client-js"
}

generator softCascade {
  provider = "prisma-soft-cascade"
  output   = "./generated/soft-cascade"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

### 2. Add `deleted_at` field to soft-deletable models

```prisma
model User {
  id         String    @id @default(cuid())
  email      String    @unique
  name       String?
  deleted_at DateTime? // This makes the model soft-deletable
  posts      Post[]
}

model Post {
  id         String    @id @default(cuid())
  title      String
  authorId   String
  author     User      @relation(fields: [authorId], references: [id], onDelete: Cascade)
  deleted_at DateTime?
}
```

### 3. Run Prisma generate

```bash
npx prisma generate
```

### 4. Use the safe client

```typescript
import { PrismaClient } from '@prisma/client';
import { wrapPrismaClient, SafePrismaClient } from './generated/soft-cascade';

const prisma = new PrismaClient();
const safePrisma: SafePrismaClient = wrapPrismaClient(prisma);

// All queries automatically filter out soft-deleted records
const users = await safePrisma.user.findMany();

// Soft delete with automatic cascade
await safePrisma.user.softDelete({ where: { id: 'user-1' } });
// This will also soft-delete all related Posts due to onDelete: Cascade

// Hard delete when you need to permanently remove
await safePrisma.user.hardDelete({ where: { id: 'user-1' } });
```

## API

### SafePrismaClient

The wrapped client provides all standard Prisma operations with soft-delete awareness:

#### Read operations (auto-filtered)

- `findMany()` - Excludes soft-deleted records
- `findFirst()` - Excludes soft-deleted records
- `findUnique()` - Excludes soft-deleted records
- `count()` - Excludes soft-deleted records
- `aggregate()` - Excludes soft-deleted records
- `groupBy()` - Excludes soft-deleted records

#### Write operations

- `create()` - Standard create
- `createMany()` - Standard create many
- `update()` - Standard update
- `updateMany()` - Standard update many
- `upsert()` - Standard upsert
- `softDelete()` - Soft delete with cascade
- `softDeleteMany()` - Soft delete many with cascade
- `hardDelete()` - Permanent delete (escape hatch)
- `hardDeleteMany()` - Permanent delete many (escape hatch)

### Escape Hatches

```typescript
// Access underlying Prisma client
const rawUser = await safePrisma.$prisma.user.findFirst({
  where: { id: 'user-1' }
});

// Query including soft-deleted records
const allUsers = await safePrisma.$includingDeleted.user.findMany();

// Query only soft-deleted records
const deletedUsers = await safePrisma.$onlyDeleted.user.findMany();
```

## Soft Delete Detection

Models are considered soft-deletable if they have a nullable DateTime field named:
- `deleted_at` (snake_case)
- `deletedAt` (camelCase)

## Cascade Behavior

When you soft-delete a record, all related records with `onDelete: Cascade` will also be soft-deleted. The cascade follows the same relationships defined in your Prisma schema.

```prisma
model User {
  id    String @id
  posts Post[]
  deleted_at DateTime?
}

model Post {
  id       String @id
  author   User   @relation(fields: [authorId], references: [id], onDelete: Cascade)
  authorId String
  deleted_at DateTime?
}
```

Soft-deleting a User will automatically soft-delete all their Posts.

## Requirements

- Node.js >= 18
- Prisma >= 5.0.0

## License

MIT
