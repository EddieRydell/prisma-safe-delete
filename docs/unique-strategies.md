# Unique Constraint Strategies

prisma-safe-delete provides three strategies for handling unique constraints when soft-deleting records. Each strategy determines how unique values are freed up for reuse after deletion.

## Mangle Strategy (Default)

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

Non-string unique fields (`Int`, `BigInt`, `@db.Uuid`, etc.) cannot be mangled. When the generator detects these, it warns you with partial index SQL:

```
prisma-safe-delete: uniqueStrategy is 'mangle'
   Some unique fields cannot be mangled and need partial unique indexes instead.
   Mangling only works on String fields (excluding @db.Uuid).

   Fields requiring partial unique indexes:
     - User: employee_id (Int)

   Example SQL (PostgreSQL):
     CREATE UNIQUE INDEX user_employee_id_active ON "User"(employee_id) WHERE deleted_at IS NULL;
```

## None Strategy

If you prefer to handle unique constraints yourself (e.g., via partial unique indexes), you can disable mangling:

```prisma
generator softDelete {
  provider       = "prisma-safe-delete"
  output         = "./generated/soft-delete"
  uniqueStrategy = "none"
}
```

When using `uniqueStrategy = "none"`, a warning is displayed during `prisma generate` listing all constraints that need attention:

```
prisma-safe-delete: uniqueStrategy is 'none'
   You must create partial unique indexes manually to prevent conflicts.

   Models requiring partial unique indexes:
     - User: email
     - Customer: email, username

   Example SQL (PostgreSQL):
     CREATE UNIQUE INDEX user_email_active ON "User"(email) WHERE deleted_at IS NULL;
     CREATE UNIQUE INDEX customer_email_active ON "Customer"(email) WHERE deleted_at IS NULL;
```

If you have compound `@@unique` constraints that include `deleted_at` (e.g., `@@unique([org_id, name, deleted_at])`), the generator will warn you that these don't enforce uniqueness on active records because `NULL != NULL` in SQL, and suggest replacing them with partial indexes.

## Sentinel Strategy

The sentinel strategy avoids mangling entirely by using a far-future date (`9999-12-31`) instead of `NULL` to mark active records. This lets you use standard `@@unique([field, deleted_at])` compound constraints — the database enforces uniqueness natively because `deleted_at` is a real date value (not NULL), so two active records with the same `email` would violate the constraint.

**When to use sentinel instead of mangle or none:**
- You want DB-level uniqueness enforcement without string mangling
- You don't want partial unique indexes (not all databases support them)
- You're okay with a non-nullable `deleted_at` column with a default value

### Prisma Schema Example

```prisma
generator softDelete {
  provider       = "prisma-safe-delete"
  output         = "./generated/soft-delete"
  uniqueStrategy = "sentinel"
}

model User {
  id         String   @id @default(cuid())
  email      String
  name       String?
  deleted_at DateTime @default(dbgenerated("'9999-12-31 00:00:00'"))

  @@unique([email, deleted_at])
}
```

Key differences from the default `mangle` strategy:
- `deleted_at` is **non-nullable** `DateTime` (not `DateTime?`)
- `deleted_at` has a `@default(dbgenerated(...))` that sets the sentinel value
- Unique constraints use `@@unique([field, deleted_at])` instead of standalone `@unique`

### How It Works

**Active records** have `deleted_at = 9999-12-31`. **Deleted records** have `deleted_at` set to the actual deletion timestamp. This is the opposite of the nullable approach where active records have `deleted_at = NULL`.

**findUnique transformation:** When you query by a field that's part of a compound unique with `deleted_at`, the runtime transparently rewrites the query:

```typescript
// You write:
await safePrisma.user.findUnique({ where: { email: "john@example.com" } });

// Runtime rewrites to:
await prisma.user.findUnique({
  where: { email_deleted_at: { email: "john@example.com", deleted_at: new Date("9999-12-31") } }
});
```

This means you don't need to know about the compound key — the wrapper handles it.

**Create injection:** All create operations automatically inject the sentinel value:

```typescript
// You write:
await safePrisma.user.create({ data: { email: "john@example.com" } });

// Runtime injects deleted_at automatically:
await prisma.user.create({
  data: { email: "john@example.com", deleted_at: new Date("9999-12-31") }
});
```

This applies to `create`, `createMany`, `createManyAndReturn`, and the `create` branch of `upsert`.

### Migrating Existing Data

If you're switching from a nullable `deleted_at` to the sentinel strategy, you need to migrate existing active rows:

```sql
-- Set active records (NULL) to the sentinel value
UPDATE "User" SET deleted_at = '9999-12-31 00:00:00' WHERE deleted_at IS NULL;

-- Then alter the column to non-nullable with a default
ALTER TABLE "User" ALTER COLUMN deleted_at SET DEFAULT '9999-12-31 00:00:00';
ALTER TABLE "User" ALTER COLUMN deleted_at SET NOT NULL;
```

### Generator Warnings

When using sentinel strategy, `prisma generate` validates each model's configuration and outputs targeted diagnostics:

**When models are correctly configured:**
```
prisma-safe-delete: uniqueStrategy is 'sentinel'
   Active records use deleted_at = '9999-12-31' (sentinel) instead of NULL.

   Correctly configured:
     - User: deleted_at, @@unique([email, deleted_at])

   All models correctly configured for sentinel strategy.
```

**When models need attention** (e.g., nullable `deleted_at` or missing compound uniques):
```
prisma-safe-delete: uniqueStrategy is 'sentinel'
   Active records use deleted_at = '9999-12-31' (sentinel) instead of NULL.

   deleted_at field misconfigured for sentinel strategy:
     - Post: deleted_at is nullable (DateTime?) — must be non-nullable with @default
   Required: deleted_at DateTime @default(dbgenerated("'9999-12-31 00:00:00'"))
   Migration: UPDATE "Model" SET deleted_at = '9999-12-31' WHERE deleted_at IS NULL

   Standalone unique constraints detected (should include deleted_at):
     - Post: slug
   Convert to compound: @@unique([field, deleted_at])
```

## Partial Unique Indexes

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

## Strategy Comparison

| Feature | `mangle` (default) | `none` | `sentinel` |
|---------|-------------------|--------|-----------|
| **Unique value reuse** | Automatic (string fields) | Manual (partial indexes) | Automatic (compound uniques) |
| **DB-level enforcement** | No (app-level mangling) | Yes (partial indexes) | Yes (compound uniques) |
| **Non-string uniques** | Requires partial indexes | Requires partial indexes | Supported natively |
| **Schema changes needed** | None | Add partial indexes | Non-nullable `deleted_at` + compound uniques |
| **Database compatibility** | All | PostgreSQL, SQLite | All |
| **Restore complexity** | Must unmangle | None | None |
