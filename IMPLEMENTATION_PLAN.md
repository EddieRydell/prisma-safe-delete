# Implementation Plan: Transaction Support & Filter Propagation

## Overview

This plan addresses limitations with escape hatches (`$onlyDeleted`, `$includingDeleted`) in transactions and relation filtering, based on user feedback from production usage.

## Problems to Solve

### 1. No `$onlyDeleted`/`$includingDeleted` in Transactions
**Current State**: Escape hatches only available on root client, not transaction client (`tx`)

**User Impact**: Can't query deleted records inside transactions for audit logging or atomic restore operations

**Example Issue**:
```typescript
await safePrisma.$transaction(async (tx) => {
  // ❌ Doesn't exist
  const deletedUser = await tx.$onlyDeleted.users.findFirst({ ... });
});
```

### 2. No Nested Relation Filtering
**Current State**: `$onlyDeleted` only applies to top-level model, not nested where clauses

**User Impact**: Can't filter relations by deleted status in complex queries

**Example Issue**:
```typescript
// Want: Find users who have a deleted membership
safePrisma.users.findMany({
  where: {
    memberships: {
      some: {
        organization_id: orgId,
        // ❌ Can't use $onlyDeleted here - must manually write:
        deleted_at: { not: null }
      }
    }
  }
});
```

### 3. Filter Propagation in Relations
**Current State**: When using `$onlyDeleted`, included relations still exclude deleted records

**User Impact**: Can't see cascade-deleted children when querying deleted parents

**Example Issue**:
```typescript
// Query deleted user
const user = await safePrisma.$onlyDeleted.users.findFirst({
  include: {
    posts: true, // ❌ Returns empty even if user has deleted posts!
  }
});
```

### 4. restoreCascade in Transactions
**Status**: ✅ **ALREADY WORKS!** Just needs documentation

**Solution**:
```typescript
await safePrisma.$transaction(async (tx) => {
  const { record, cascaded } = await tx.classes.restoreCascade({
    where: { class_id: id }
  });
  // ✅ This works today!
});
```

---

## Implementation Phases

## Phase 1: Transaction Support ⭐ HIGH PRIORITY
**Estimated Time**: 1-2 days

### Problem
`$onlyDeleted` and `$includingDeleted` aren't available at transaction level.

### Solution
Add escape hatches to wrapped transaction client.

### Tasks
- [ ] Add `$onlyDeleted` to `wrapTransactionClient()` in `emit-runtime.ts`
- [ ] Add `$includingDeleted` to `wrapTransactionClient()` in `emit-runtime.ts`
- [ ] Update `SafeTransactionClient` interface in `emit-types.ts`
- [ ] Add integration tests for `tx.$onlyDeleted`
- [ ] Add integration tests for `tx.$includingDeleted`
- [ ] Document transaction escape hatches in README
- [ ] Document that `tx.model.restoreCascade()` already works

### Files to Modify
- `src/codegen/emit-runtime.ts` (~50 lines)
- `src/codegen/emit-types.ts` (~20 lines)
- `tests/e2e/transaction.test.ts` (new file, ~100 lines)
- `README.md` (new section)

### Implementation Details

In `wrapTransactionClient()`, add:
```typescript
$onlyDeleted: {
  users: {
    findMany: (args?: any) => tx.users.findMany({
      ...args,
      where: { ...args?.where, deleted_at: { not: null } }
    }),
    // ... other read methods
  },
  // ... all soft-deletable models
},
$includingDeleted: {
  users: tx.users,
  // ... all models
}
```

### Success Criteria
- [ ] Can use `tx.$onlyDeleted.model.findMany()` in transactions
- [ ] Can use `tx.$includingDeleted.model.findMany()` in transactions
- [ ] Types are correct (no TypeScript errors)
- [ ] Tests pass

---

## Phase 2: Helper Utilities
**Estimated Time**: 1 day

### Problem
No easy way to filter nested relations for deleted/active records in where clauses.

### Solution
Export helper functions for manual filtering.

### Tasks
- [ ] Create `src/codegen/emit-helpers.ts`
- [ ] Generate helpers in codegen: `onlyDeleted()`, `includingDeleted()`, `excludeDeleted()`
- [ ] Export helpers from generated client
- [ ] Add TypeScript types for helpers
- [ ] Add unit tests for helpers
- [ ] Document helper usage with examples

### Files to Modify
- `src/codegen/emit-helpers.ts` (new file, ~80 lines)
- `src/codegen/emit-runtime.ts` (import and emit helpers)
- `src/generator.ts` (call emitHelpers)
- `tests/unit/helpers.test.ts` (new file, ~50 lines)
- `README.md` (examples section)

### Implementation Details

```typescript
// Generated helpers
export function onlyDeleted(modelName: string, where: Record<string, unknown> = {}) {
  const deletedAtField = getDeletedAtField(modelName);
  if (!deletedAtField) return where;
  return { ...where, [deletedAtField]: { not: null } };
}

export function excludeDeleted(modelName: string, where: Record<string, unknown> = {}) {
  const deletedAtField = getDeletedAtField(modelName);
  if (!deletedAtField) return where;
  return { ...where, [deletedAtField]: null };
}

export function includingDeleted(where: Record<string, unknown> = {}) {
  return where; // No filter
}
```

### Usage Example
```typescript
import { onlyDeleted } from './generated/safe-client';

safePrisma.users.findMany({
  where: {
    memberships: {
      some: onlyDeleted('Membership', { organization_id: orgId })
    }
  }
});
```

### Success Criteria
- [ ] Helpers are generated and exported
- [ ] Can import and use helpers in queries
- [ ] TypeScript autocomplete works
- [ ] Tests pass

---

## Phase 3: Auto Filter Propagation ⭐ HIGH PRIORITY
**Estimated Time**: 2-3 days

### Problem
When using `$onlyDeleted`, included relations still exclude deleted records.

### Solution
Automatically propagate filter mode (only-deleted, include-deleted, exclude-deleted) down to all relation includes.

### Tasks
- [ ] Add `FilterMode` type to runtime: `'exclude-deleted' | 'include-deleted' | 'only-deleted'`
- [ ] Add `mode` parameter to `injectFilters()` function
- [ ] Add `mode` parameter to `injectIntoRelations()` function
- [ ] Add `mode` parameter to `injectIntoWhere()` function
- [ ] Update filter injection logic to respect mode
- [ ] Recursively pass mode down through nested includes
- [ ] Update `$onlyDeleted` to pass `'only-deleted'` mode
- [ ] Update `$includingDeleted` to pass `'include-deleted'` mode
- [ ] Update model delegates to use mode
- [ ] Update transaction wrapper to use mode
- [ ] Add tests for single-level propagation
- [ ] Add tests for deeply nested propagation (3+ levels)
- [ ] Document propagation behavior with examples

### Files to Modify
- `src/codegen/emit-runtime.ts` (~150 lines changed)
- `tests/e2e/filter-propagation.test.ts` (new file, ~200 lines)
- `README.md` (new section: "Filter Propagation")

### Implementation Details

```typescript
type FilterMode = 'exclude-deleted' | 'include-deleted' | 'only-deleted';

function injectFilters<T>(
  args: T | undefined,
  modelName: string,
  mode: FilterMode = 'exclude-deleted'
): T {
  // ... existing code

  if (result.include) {
    result.include = injectIntoRelations(
      result.include,
      modelName,
      mode // 👈 Pass mode down
    );
  }
}

function injectIntoRelations(
  relations: Record<string, unknown>,
  parentModel: string,
  mode: FilterMode // 👈 New parameter
): Record<string, unknown> {
  // ...
  if (deletedAtField) {
    switch (mode) {
      case 'exclude-deleted':
        nested.where = { ...nested.where, [deletedAtField]: null };
        break;
      case 'include-deleted':
        // Don't add any filter
        break;
      case 'only-deleted':
        nested.where = { ...nested.where, [deletedAtField]: { not: null } };
        break;
    }
  }

  // Recursively pass mode to nested includes
  if (nested.include) {
    nested.include = injectIntoRelations(
      nested.include,
      relationModel,
      mode // 👈 Propagate mode
    );
  }
}
```

Update `$onlyDeleted`:
```typescript
$onlyDeleted: {
  users: {
    findMany: (args) => {
      const filtered = injectFilters(args, 'User', 'only-deleted');
      return original.findMany(filtered);
    }
  }
}
```

### Behavior Examples

```typescript
// Default: exclude deleted (current behavior)
safePrisma.users.findMany({
  include: { posts: true } // Only active posts
});

// Only deleted: propagates down
safePrisma.$onlyDeleted.users.findMany({
  include: {
    posts: true, // Only deleted posts (auto-propagated)
    comments: {
      include: {
        replies: true // Only deleted replies (nested propagation)
      }
    }
  }
});

// Including deleted: propagates down
safePrisma.$includingDeleted.users.findMany({
  include: { posts: true } // All posts (deleted + active)
});
```

### Success Criteria
- [ ] `$onlyDeleted` only returns deleted records in all relations
- [ ] `$includingDeleted` returns all records (deleted + active) in all relations
- [ ] Propagation works for deeply nested includes (3+ levels)
- [ ] Propagation works with select + include combinations
- [ ] Default behavior unchanged (exclude deleted)
- [ ] Tests pass

---

## Phase 4: Respect User's Explicit Filters
**Estimated Time**: 1 day (do together with Phase 3)

### Problem
- Users can't override propagation for mixed results (e.g., deleted user with active posts)
- Bug: We currently overwrite user's explicit `deleted_at` filters

### Solution
Don't inject filter if user already specified one on `deleted_at` field.

### Tasks
- [ ] Update `injectIntoRelations()` to check for existing `deleted_at` filter
- [ ] If user provided explicit filter, skip injection
- [ ] Add tests for explicit override
- [ ] Add tests for partial override (some relations explicit, some auto)
- [ ] Document override behavior

### Files to Modify
- `src/codegen/emit-runtime.ts` (~20 lines changed)
- `tests/e2e/filter-propagation.test.ts` (~50 lines added)
- `README.md` (examples added)

### Implementation Details

```typescript
function injectIntoRelations(
  relations: Record<string, unknown>,
  parentModel: string,
  mode: FilterMode
): Record<string, unknown> {
  // ...
  if (deletedAtField) {
    const existingWhere = nested.where as Record<string, unknown> ?? {};

    // Only inject if user hasn't already filtered this field
    if (!(deletedAtField in existingWhere)) {
      nested.where = {
        ...existingWhere,
        [deletedAtField]: getModeFilter(mode, deletedAtField)
      };
    }
    // else: User's explicit filter takes precedence
  }
}

function getModeFilter(mode: FilterMode, field: string) {
  switch (mode) {
    case 'exclude-deleted': return null;
    case 'only-deleted': return { not: null };
    case 'include-deleted': return undefined; // No filter
  }
}
```

### Usage Examples

```typescript
// Mixed results: deleted user with active posts
safePrisma.$onlyDeleted.users.findFirst({
  include: {
    posts: {
      where: { deleted_at: null } // 🔧 Override: active posts only
    },
    comments: true, // Auto: deleted comments only
  }
});

// Explicit filter in nested relation
safePrisma.users.findMany({
  include: {
    posts: {
      where: {
        deleted_at: { not: null }, // 🔧 Override: show deleted posts
        published: true
      }
    }
  }
});
```

### Success Criteria
- [ ] User's explicit `deleted_at` filters are never overwritten
- [ ] Can mix auto-propagation with explicit overrides
- [ ] Tests pass for all override scenarios
- [ ] Documentation shows override examples

---

## Phase 5: Documentation
**Estimated Time**: 1 day (distributed across phases)

### Tasks

#### README Updates
- [ ] Add "Transactions" section
  - [ ] Document `tx.model.restoreCascade()` usage
  - [ ] Document `tx.$onlyDeleted` usage
  - [ ] Document `tx.$includingDeleted` usage
  - [ ] Show atomic audit logging pattern

- [ ] Add "Advanced Filtering" section
  - [ ] Explain filter propagation behavior
  - [ ] Show helper utility usage
  - [ ] Show explicit filter overrides
  - [ ] Provide decision tree for which approach to use

- [ ] Add "Escape Hatches" section
  - [ ] Document `$onlyDeleted` behavior and propagation
  - [ ] Document `$includingDeleted` behavior and propagation
  - [ ] Document `model.includingDeleted` (per-model escape)
  - [ ] Show comparison table of all escape hatches

#### Examples
- [ ] Create `examples/transaction-restore.ts`
- [ ] Create `examples/nested-filtering.ts`
- [ ] Create `examples/audit-logging.ts`
- [ ] Create `examples/filter-propagation.ts`

#### Migration Guide
- [ ] Document new features (all backward compatible)
- [ ] Update best practices
- [ ] Add troubleshooting section

#### JSDoc Comments
- [ ] Add JSDoc to all helper functions
- [ ] Add JSDoc to new types
- [ ] Add examples in JSDoc

### Files to Modify
- `README.md` (~300 lines added)
- `examples/` (new directory)
- `CHANGELOG.md` (update)

### Success Criteria
- [ ] All features are documented with examples
- [ ] Migration path is clear
- [ ] Examples run without errors
- [ ] JSDoc appears in IDE autocomplete

---

## Timeline & Priorities

### Sprint 1 (Week 1) - Transaction Support
**Goal**: Enable escape hatches in transactions

- Day 1-2: Phase 1 (Transaction Support)
- Day 3: Phase 5 (Transaction documentation)
- Day 4-5: Testing & polish

**Deliverable**: Users can use `tx.$onlyDeleted` and `tx.model.restoreCascade()`

### Sprint 2 (Week 2) - Filter Propagation
**Goal**: Automatic filter propagation with overrides

- Day 1-3: Phase 3 + 4 (Auto propagation + Respect user filters)
- Day 4: Phase 5 (Advanced filtering documentation)
- Day 5: Testing & polish

**Deliverable**: `$onlyDeleted` propagates to relations, users can override

### Sprint 3 (Week 3) - Helpers & Polish
**Goal**: Helper utilities and complete documentation

- Day 1: Phase 2 (Helper utilities)
- Day 2-3: Phase 5 (Examples, migration guide)
- Day 4-5: End-to-end testing, bug fixes, polish

**Deliverable**: Full feature set with comprehensive docs

---

## Testing Strategy

### Unit Tests
- Helper functions (`onlyDeleted`, `includingDeleted`, etc.)
- Filter mode logic
- Type definitions

### Integration Tests
- Transaction client wrapping
- Model delegate generation with different modes
- Type checking (tsc compilation)

### E2E Tests (PostgreSQL required)
- Transaction escape hatches work correctly
- Filter propagation through nested includes (1-5 levels deep)
- Explicit filter overrides work
- Mixed queries (some relations filtered, some not)
- restoreCascade in transactions

### Regression Tests
- Ensure default behavior unchanged
- Backward compatibility with existing code
- No performance degradation

---

## Success Metrics

### Functional
- [ ] All phases complete
- [ ] All tests passing
- [ ] No breaking changes
- [ ] TypeScript types correct

### User Experience
- [ ] Can query deleted records in transactions
- [ ] Filter propagation matches expectations
- [ ] Easy to override when needed
- [ ] Clear documentation with examples

### Code Quality
- [ ] No duplication
- [ ] Follows existing patterns
- [ ] Well-commented
- [ ] Type-safe

---

## Risks & Mitigations

### Risk: Breaking Changes
**Mitigation**: All changes are additive. Default behavior unchanged.

### Risk: Performance Degradation
**Mitigation**: Filter injection already happens; we're just making it mode-aware. Minimal overhead.

### Risk: Type Complexity
**Mitigation**: Keep types simple. Use existing Prisma types where possible.

### Risk: User Confusion
**Mitigation**: Comprehensive documentation with decision trees and examples.

---

## Open Questions

1. **Should helpers be generated per schema or static?**
   - Decision: Generate them - they need access to model metadata (deleted_at field names)

2. **Should we add `$excludeDeleted` for symmetry?**
   - Decision: No - it's the default behavior, would be redundant

3. **Should propagation work with `_count`?**
   - Decision: Yes - include in Phase 3

4. **How deep should propagation go?**
   - Decision: Unlimited depth - propagate through all levels

---

## Future Enhancements (Not in This Plan)

- Query builder API for fluent filtering
- Performance optimizations for deep nesting
- Explicit relation control syntax (`posts: { $onlyDeleted: true }`)
- Soft-delete-aware aggregations
- Migration tools for existing soft-delete implementations

---

## Quick Win (Can Ship Immediately)

**Documentation-only update**: Document that `tx.model.restoreCascade()` already works.

```markdown
## Using Transactions

All soft-delete operations are available in transactions:

```typescript
await safePrisma.$transaction(async (tx) => {
  // Cascade restore with audit logging
  const { record, cascaded } = await tx.classes.restoreCascade({
    where: { class_id: id }
  });

  await tx.auditLog.create({
    data: {
      action: 'restore',
      target: 'Class',
      cascaded: JSON.stringify(cascaded)
    }
  });
});
```
```

This solves the immediate user pain point while we work on the full implementation.
