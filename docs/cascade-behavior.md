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
- Children without `deleted_at` are left unchanged
- All cascaded records get the same `deleted_at` timestamp
- Entire operation is transactional (all-or-nothing)

## Performance Characteristics

- Models with unique string fields using the `mangle` strategy require per-record updates (each record gets a unique PK-based suffix), so cascade performance scales linearly with record count.
- Models without unique string fields, or using `none`/`sentinel` strategy, use bulk `updateMany` operations for significantly better performance on large cascades.
- All cascade operations execute within a single database transaction regardless of record count.
