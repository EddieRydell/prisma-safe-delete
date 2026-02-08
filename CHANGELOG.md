# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Cascade result tracking: `softDelete` returns `{ record, cascaded }`, `softDeleteMany` returns `{ count, cascaded }`, and `restoreCascade` returns `{ record, cascaded }` where `cascaded` is a `Record<string, number>` mapping model names to the number of affected records
- New `CascadeResult` type export for typing cascade return values
- Fast-path optimization: leaf models with no cascade children and no unique string mangling use a direct `updateMany` instead of a full transaction
- Structured `UniqueConstraintInfo` in DMMF parser for accurate unique constraint analysis
- Improved `uniqueStrategy='none'` warnings that distinguish between compound `@@unique` constraints that include `deleted_at` (broken NULL != NULL pattern) and constraints that need partial indexes
- SQL suggestions for both partial unique indexes and `NULLS NOT DISTINCT` (PostgreSQL 15+)

### Changed
- `update` and `updateMany` on soft-deletable models now inject `deleted_at IS NULL` filters, preventing accidental modification of soft-deleted records
- `softDeleteWithCascade` and `restoreWithCascade` internal functions now return cascade count metadata
- `restoreCascade` delegate method returns `{ record, cascaded }` instead of just the record

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
