# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Removed `@ts-nocheck` from generated `runtime.ts` and `types.ts`, replacing blanket type suppression with explicit type casts that preserve Prisma's full generic signatures for consumers

## [0.2.0] - 2025-02-08

### Added
- **Filter propagation**: `$onlyDeleted` and `$includingDeleted` now automatically propagate their filter mode through all nested relation includes for consistent behavior
- **Transaction escape hatches**: `tx.$onlyDeleted` and `tx.$includingDeleted` are now available in transaction contexts
- **Explicit filter overrides**: User-specified `deleted_at` filters in `where` clauses now override automatic filter propagation, enabling mixed filtering (e.g., deleted users with active posts)
- **Helper utilities**: New exported functions `onlyDeleted()`, `excludeDeleted()`, and `includingDeleted()` for manual filtering in complex nested where clauses
- **Atomic restore operations**: `tx.model.restoreCascade()` now works in transactions, enabling atomic restore with audit logging
- Cascade result tracking: `softDelete` returns `{ record, cascaded }`, `softDeleteMany` returns `{ count, cascaded }`, and `restoreCascade` returns `{ record, cascaded }` where `cascaded` is a `Record<string, number>` mapping model names to the number of affected records
- New `CascadeResult` type export for typing cascade return values
- Fast-path optimization: leaf models with no cascade children and no unique string mangling use a direct `updateMany` instead of a full transaction
- Structured `UniqueConstraintInfo` in DMMF parser for accurate unique constraint analysis
- Improved `uniqueStrategy='none'` warnings that distinguish between compound `@@unique` constraints that include `deleted_at` (broken NULL != NULL pattern) and constraints that need partial indexes
- SQL suggestions for both partial unique indexes and `NULLS NOT DISTINCT` (PostgreSQL 15+)

### Changed
- **Breaking**: `$includingDeleted` behavior changed - now uses filter mode propagation instead of raw delegate passthrough, ensuring consistent filtering in relations
- Filter injection system now supports three modes: `'exclude-deleted'` (default), `'include-deleted'`, and `'only-deleted'`, which propagate through nested includes
- `update` and `updateMany` on soft-deletable models now inject `deleted_at IS NULL` filters, preventing accidental modification of soft-deleted records
- `softDeleteWithCascade` and `restoreWithCascade` internal functions now return cascade count metadata
- `restoreCascade` delegate method returns `{ record, cascaded }` instead of just the record

### Fixed
- Filter injection now respects user's explicit `deleted_at` filters instead of overwriting them, fixing a bug where manual filters were ignored

## [0.1.0] - 2025-02-07

### Added
- Initial release
- Type-safe soft deletion wrapper for Prisma 7
- Automatic filter injection on all read operations
- Deep relation filtering for `include`, `select`, `_count`, and relation filters (`some`/`every`/`none`)
- Cascade soft-delete following `onDelete: Cascade` relations
- Unique string field mangling to free values for reuse
- Transaction support with wrapped clients
- Compound primary key support
- Escape hatches: `$prisma`, `$includingDeleted`, `$onlyDeleted`
- `hardDelete` and `hardDeleteMany` methods
- `softDelete` and `softDeleteMany` methods
- Support for both `deleted_at` and `deletedAt` field names
