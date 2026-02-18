# Cascade Behavior

Soft-delete cascades follow `onDelete: Cascade` relations defined in your Prisma schema.

## How It Works

Given a schema like this:

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

Soft-deleting a user cascades through the entire relation tree:

```typescript
const { record, cascaded } = await safePrisma.user.softDelete({ where: { id: 'user-1' } });
// Soft-deletes:
// 1. The user
// 2. All their posts
// 3. All comments on those posts
// All with the same timestamp (transactional)

console.log(cascaded); // { Post: 2, Comment: 5 }
```

## Cascade Rules

- Only follows `onDelete: Cascade` relations
- Only soft-deletes children that have a `deleted_at` field
- Children without `deleted_at` are **hard-deleted** (matching the database's `onDelete: Cascade` behavior). Their descendants are also removed by the database cascade.
- All cascaded records get the same `deleted_at` timestamp
- Entire operation is transactional (all-or-nothing)

## Performance Characteristics

- Models with unique string fields using the `mangle` strategy require per-record updates (each record gets a unique PK-based suffix), so cascade performance scales linearly with record count.
- Models without unique string fields, or using `none`/`sentinel` strategy, use bulk `updateMany` operations for significantly better performance on large cascades.
- All cascade operations execute within a single database transaction regardless of record count.
- All matching records are loaded into memory before processing. For very large cascades (tens of thousands of child records), this may cause memory pressure or transaction timeouts.

## Concurrency

Cascade operations use the database's default transaction isolation level (typically READ COMMITTED). Under concurrent access:

- New child records created between the parent lookup and the cascade update may be missed by the cascade.
- Concurrent soft-deletes on overlapping record sets are safe (idempotent) but may result in different `cascaded` counts.

For strict consistency, use SERIALIZABLE isolation when concurrent soft-deletes are possible:

```typescript
await safePrisma.$transaction(async (tx) => {
  await tx.user.softDelete({ where: { id: 'user-1' } });
}, { isolationLevel: 'Serializable' });
```

## Audit Logging and Cascades

If a soft-deletable model is also auditable (`/// @audit`), cascade operations generate audit events for both the parent and its children. Each child's audit event includes a `parent_event_id` linking back to the parent's audit event, forming a traceable chain.

```typescript
const { record, cascaded } = await safePrisma.user.softDelete({
  where: { id: 'user-1' },
  actorId: currentUserId,
});
// Creates audit events for:
// 1. The user (parent event)
// 2. Each cascade-deleted post (with parent_event_id → user's event)
// 3. Each cascade-deleted comment (with parent_event_id → post's event)
```

If a cascade passes through a non-auditable intermediate model (e.g., a model without `@audit`), a warning is emitted and the `parent_event_id` chain breaks at that point.

For audit-only models (no `deleted_at`), `delete` and `deleteMany` are audited per-record when the model's audit actions include `delete`.

## Database-Level Enforcement

prisma-safe-delete operates at the application layer. It does not create database triggers, row-level security policies, or other database-level protections. Developers can bypass soft-delete via:

- The `$prisma` escape hatch
- `__dangerousHardDelete` / `__dangerousHardDeleteMany`
- Raw SQL queries (`$queryRaw`, `$executeRaw`)
- Using PrismaClient directly (without the wrapper)

If your compliance requirements mandate that records cannot be permanently deleted at the database level, add appropriate database triggers or permissions in addition to using this library.
