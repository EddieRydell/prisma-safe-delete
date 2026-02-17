# API Reference

Full API documentation for prisma-safe-delete. For a quick overview, see the [README](../README.md).

## Read Operations (Auto-filtered)

All read operations automatically inject `deleted_at: null` filters:

```typescript
await safePrisma.user.findMany();
await safePrisma.user.findFirst({ where: { name: 'John' } });
await safePrisma.user.findUnique({ where: { id: 'user-1' } });
await safePrisma.user.findFirstOrThrow({ where: { email: 'john@example.com' } });
await safePrisma.user.findUniqueOrThrow({ where: { id: 'user-1' } });
await safePrisma.user.count();
await safePrisma.user.aggregate({ _count: true });
await safePrisma.user.groupBy({ by: ['name'], _count: true });
```

## Relation Queries (Auto-filtered)

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

## Relation Filters (Auto-filtered)

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

## Write Operations

```typescript
// Create operations pass through unchanged
await safePrisma.user.create({ data: { email: 'new@example.com' } });
await safePrisma.user.createMany({ data: [...] });

// update and updateMany filter out soft-deleted records
// (you cannot accidentally modify a deleted record)
await safePrisma.user.update({ where: { id: 'user-1' }, data: { name: 'Jane' } });
await safePrisma.user.updateMany({ where: { ... }, data: { ... } });

// upsert filters out soft-deleted records from the where clause
// (if a soft-deleted record matches, the create branch fires instead)
await safePrisma.user.upsert({ where: { ... }, create: { ... }, update: { ... } });
```

## Soft Delete

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

**Audit trail**: The `cascaded` return value is ephemeral — it is not persisted anywhere. For automatic audit logging of mutations, see [Audit Logging](#audit-logging). For manual logging, use an interactive transaction:

```typescript
await safePrisma.$transaction(async (tx) => {
  const { record, cascaded } = await tx.user.softDelete({
    where: { id: 'user-1' },
    deletedBy: currentUserId,
  });

  await tx.auditLog.create({
    data: {
      action: 'SOFT_DELETE',
      modelName: 'User',
      recordId: record?.id,
      cascaded: JSON.stringify(cascaded),
      performedBy: currentUserId,
    },
  });
});
```

## Soft Delete Preview

Preview what would be cascade-deleted without making any changes:

```typescript
const { wouldDelete } = await safePrisma.user.softDeletePreview({ where: { name: 'Test' } });
console.log(wouldDelete); // { User: 2, Post: 5, Comment: 12 }
```

## Tracking Who Deleted a Record

If a model has a nullable `String` field named `deleted_by` or `deletedBy`, the `deletedBy` parameter becomes **required** on `softDelete` and `softDeleteMany` (enforced at compile time):

```prisma
model Customer {
  id         String    @id @default(cuid())
  email      String    @unique
  deleted_at DateTime?
  deleted_by String?   // Enables deletedBy tracking
}
```

```typescript
// TypeScript requires deletedBy for models with a deleted_by field
await safePrisma.customer.softDelete({
  where: { id: 'cust-1' },
  deletedBy: 'admin-user-id',  // Required — won't compile without it
});

// Models without deleted_by don't need it
await safePrisma.user.softDelete({ where: { id: 'user-1' } });
```

## Restore

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

## Hard Delete (Escape Hatch)

```typescript
// Permanently delete when needed (intentionally ugly name to discourage use)
await safePrisma.user.__dangerousHardDelete({ where: { id: 'user-1' } });
await safePrisma.user.__dangerousHardDeleteMany({ where: { createdAt: { lt: oldDate } } });
```

## Escape Hatches

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
| **Propagates to relations** | Yes | Yes | Yes | No | No |
| **Can override per-relation** | Yes | Yes | Yes | Yes | N/A |
| **Available in transactions** | Yes | Yes | Yes | Yes | No |
| **Soft delete methods** | Yes | No | No | No | No |
| **TypeScript types** | Full safe client | Read-only | Read-only | Read-only | Raw Prisma |
| **Use case** | Normal queries | View full history | Restore operations | Quick override | Raw SQL/migrations |

#### When to Use Each

- **`safePrisma.model`**: Default for all normal queries
- **`$onlyDeleted`**: Restore workflows, viewing deleted records with their cascade children
- **`$includingDeleted`**: Analytics, full history views (both active and deleted)
- **`model.includingDeleted`**: Quick access to all records for a specific model
- **`$prisma`**: Raw queries, migrations, or when you need to bypass all filtering

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

## Transactions

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

**Important**: Only interactive transactions (`$transaction(async (tx) => { ... })`) receive the soft-delete wrapper. Sequential transactions (`$transaction([promise1, promise2])`) pass through to raw Prisma with no soft-delete filtering. Always use the interactive form when soft-delete behavior is needed.

## Audit Logging

Audit logging automatically captures mutation events (create, update, delete) for marked models. Events are written atomically in the same transaction as the mutation.

### Schema Setup

Three schema annotations control audit logging:

| Annotation | Purpose |
|-----------|---------|
| `/// @audit` | Mark a model as auditable for all actions (create, update, delete) |
| `/// @audit(create, delete)` | Mark a model as auditable for specific actions only |
| `/// @audit-table` | Designate a model as the audit event table |

**Audit table**: Exactly one model must be marked with `/// @audit-table`. This model stores all audit events. It is never itself auditable or soft-deletable.

```prisma
/// @audit
model Project {
  id         String    @id @default(cuid())
  name       String
  deleted_at DateTime?
  deleted_by String?
}

/// @audit(create, delete)
model Webhook {
  id   String @id @default(cuid())
  url  String
}

/// @audit-table
model AuditEvent {
  id               String   @id @default(cuid())
  entity_type      String
  entity_id        String
  action           String
  actor_id         String?
  event_data       Json
  created_at       DateTime @default(now())
  parent_event_id  String?
}
```

#### Required audit table fields

| Field | Type | Purpose |
|-------|------|---------|
| `entity_type` | `String` | Model name (e.g., `"Project"`) |
| `entity_id` | `String` | Primary key of the affected record (JSON string for compound PKs) |
| `action` | `String` | `"create"`, `"update"`, or `"delete"` |
| `actor_id` | `String?` | Who performed the action (from `actorId` parameter) |
| `event_data` | `Json` | Snapshot of the record or before/after diff |
| `created_at` | `DateTime` | When the event occurred |

#### Optional audit table fields

| Field | Type | Purpose |
|-------|------|---------|
| `parent_event_id` | `String?` | Reserved for future use — linking child audit events to a parent (e.g., cascade operations). Currently not populated by the library. |

You can add additional fields to the audit table (e.g., `ip_address`, `user_agent`). Extra fields are populated via `auditContext` (see below).

### Configuring the Client

When your schema has auditable models, `wrapPrismaClient` accepts an optional `WrapOptions` parameter:

```typescript
import { wrapPrismaClient, type WrapOptions } from './generated/soft-delete';

const safePrisma = wrapPrismaClient(prisma, {
  auditContext: async () => ({
    ip_address: req.ip,
    user_agent: req.headers['user-agent'],
  }),
});
```

The `auditContext` callback is called once per audit event and its return value is spread into the audit event record. This lets you inject request-scoped context (IP address, user agent, trace IDs) into every audit event.

### Using Audited Models

All mutation methods on audited models accept an optional `actorId` parameter:

```typescript
// Create — actorId is optional
const project = await safePrisma.project.create({
  data: { name: 'New Project' },
  actorId: currentUserId,
});

// Update — captures before/after snapshot
const updated = await safePrisma.project.update({
  where: { id: project.id },
  data: { name: 'Renamed' },
  actorId: currentUserId,
});

// Delete (soft-delete for soft-deletable models, hard delete for audit-only)
await safePrisma.webhook.delete({
  where: { id: 'wh-1' },
  actorId: currentUserId,
});
```

`actorId` is always optional (`string | null`). If omitted, the audit event's `actor_id` is `null`.

### Audited Methods

Which methods are intercepted depends on the model's `@audit` actions:

| Method | Action | Audited when |
|--------|--------|-------------|
| `create` | `create` | `@audit` or `@audit(create, ...)` |
| `createMany` | `create` | `@audit` or `@audit(create, ...)` |
| `createManyAndReturn` | `create` | `@audit` or `@audit(create, ...)` |
| `update` | `update` | `@audit` or `@audit(update, ...)` |
| `updateMany` | `update` | `@audit` or `@audit(update, ...)` |
| `updateManyAndReturn` | `update` | `@audit` or `@audit(update, ...)` |
| `upsert` | runtime | Always intercepted; action determined at runtime (`create` if new, `update` if existing). Audit event is written only if the resulting action is in the model's audit actions. |
| `delete` | `delete` | `@audit` or `@audit(delete, ...)` (audit-only models only; soft-deletable models use `softDelete`) |
| `deleteMany` | `delete` | `@audit` or `@audit(delete, ...)` (audit-only models only) |

Methods whose action is **not** in the model's audit actions pass through without wrapping in a transaction or capturing events. They still strip the `actorId` parameter before forwarding to Prisma.

### Audit Event Data

The `event_data` field captures different snapshots depending on the action:

| Action | `event_data` contents |
|--------|----------------------|
| `create` | The full created record |
| `update` | `{ before: <record before>, after: <record after> }` |
| `delete` | The full deleted record |
| `upsert` (created) | The full created record |
| `upsert` (updated) | `{ before: <existing record>, after: <updated record> }` |

For batch operations (`createMany`, `updateMany`, `deleteMany`), one audit event is written per affected record. Audit events for batch operations are written in parallel within the same transaction.

**Limitations:**
- `event_data` only contains scalar fields — relation data is not included in before/after snapshots. If you need relation data in audit events, query relations separately in your application code.
- `createMany` is internally implemented using `createManyAndReturn` to capture record data for auditing. This means audited `createMany` requires database support for `RETURNING` (PostgreSQL, SQLite 3.35+). If your database does not support this, audited `createMany` will fail at runtime.
- For large batch operations, audit event writes run in parallel but are still bounded by the transaction timeout. Consider batching very large operations.

### Audit + Soft Delete

Models can be both soft-deletable and auditable:

```prisma
/// @audit
model Project {
  id         String    @id @default(cuid())
  name       String
  deleted_at DateTime?
  deleted_by String?
}
```

When a model is both:
- `softDelete` uses `actorId` instead of `deletedBy` for the identity parameter. The `actorId` value is written to the `deleted_by` column (if present) and also recorded in the audit event.
- All write methods (create, update, upsert, etc.) are wrapped with audit logging
- Soft-delete filtering still applies to all reads and updates

### Transactions

Audited methods work in transactions with the same API:

```typescript
await safePrisma.$transaction(async (tx) => {
  const project = await tx.project.create({
    data: { name: 'In Transaction' },
    actorId: currentUserId,
  });

  await tx.project.update({
    where: { id: project.id },
    data: { name: 'Updated in Transaction' },
    actorId: currentUserId,
  });
  // Both audit events are committed atomically with the mutations
});
