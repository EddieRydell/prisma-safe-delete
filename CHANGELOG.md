## [4.1.0](https://github.com/EddieRydell/prisma-safe-delete/compare/v4.0.0...v4.1.0) (2026-02-18)

### Features

* add public $writeAuditEvent to SafePrismaClient and SafeTransactionClient ([#61](https://github.com/EddieRydell/prisma-safe-delete/issues/61)) ([adb846c](https://github.com/EddieRydell/prisma-safe-delete/commit/adb846c74bd499ff45eaa417663384a2fcd6afa3))

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `$writeAuditEvent` method on `SafePrismaClient` and `SafeTransactionClient` for writing custom audit events outside of automatic mutation tracking
- `eventData` parameter on `$writeAuditEvent` typed as `Prisma.InputJsonValue` for better DX

### Fixed
- Duplicate `created_at` validation error when audit table field has no default value

## [4.0.0] - 2026-02-18

### Changed
- **Breaking**: SOC 2 compliance hardening for the audit system (#60):
  - Delete audit uses pre-mutation snapshots (fetches record before deletion)
  - Audit timestamps are server-side only (`created_at` relies on `@default(now())`)
  - Audit context is whitelisted against `AUDIT_EXTRA_COLUMNS` before insertion
  - Audit chain breaks always warn (no `NODE_ENV` gate)
  - Missing after-records in `updateMany`/`updateManyAndReturn` throw on concurrent modification
  - Null PK in `getEntityId` throws descriptive error instead of empty-string fallback

## [3.2.1] - 2026-02-17

### Fixed
- Replace `ParsedModel` with discriminated union for type safety (#59)

## [3.2.0] - 2026-02-17

### Added
- Per-call `auditContext` parameter on all audited mutation methods — merges with the global `WrapOptions.auditContext` callback (#57)
- Cascade `parent_event_id` linking — child audit events from cascade operations reference their parent's audit event ID (#57)

## [3.1.1] - 2026-02-17

### Fixed
- Audit completeness and `softDelete` return post-processing (#56)

## [3.1.0] - 2026-02-17

### Added
- **Audit logging**: Mark models with `/// @audit` or `/// @audit(create, delete)` to automatically capture mutation events (#55)
  - Audit events capture before/after snapshots for updates, full records for creates/deletes
  - `actorId` parameter on all mutation methods for audited models (optional `string | null`)
  - `WrapOptions.auditContext` callback to inject request-scoped context (IP, user agent, trace IDs) into audit events
  - Works with both soft-deletable and audit-only models
  - All audit writes are atomic with the mutation (same transaction)
  - Selective action auditing: `@audit(create, delete)` only audits specified actions
  - `upsert` determines action (create vs update) at runtime and audits accordingly
  - Batch operations (`createMany`, `updateMany`, `deleteMany`) write one audit event per affected record
  - Requires an `/// @audit-table` model in the schema to store events

## [3.0.0] - 2026-02-16

### Added
- `cascade = "false"` generator option to disable cascade graph building; all models use the fast path and return `cascaded: {}` (#52)
- Generator warning for required to-one relations pointing to soft-deletable models (runtime nullification may return `null` despite the Prisma type)

### Changed
- **Breaking**: `softDelete` now throws `PrismaClientKnownRequestError` with code `P2025` when the target record doesn't exist or is already deleted, matching Prisma's native `delete` behavior (#49)
- **Breaking**: `softDelete` return type's `record` field is now non-nullable (`T` instead of `T | null`)

### Fixed
- Soft-deleted records visible through to-one relation `include`/`select` — query results are now post-processed to nullify deleted to-one relations, with `deleted_at` injected into selects and stripped from results (#50)
- To-one nullification also applies to write method returns (`create`, `update`, `upsert`, `createManyAndReturn`, `updateManyAndReturn`) (#50)
- `_count: true` now correctly filters out soft-deleted records by expanding to per-relation count queries with `deleted_at` filters
- `restoreCascade` now traverses through non-soft-deletable intermediary models to restore soft-deletable grandchildren
- `restore`, `restoreMany`, and `restoreCascade` now throw a clear error message on unique constraint violations (P2002) instead of exposing raw Prisma errors
- Removed idempotency short-circuit in unique field mangling that could skip mangling in edge cases

## [2.3.2] - 2026-02-16

### Fixed
- Various bugfixes (#42, #43, #44, #45) (#51)

## [2.3.1] - 2026-02-16

### Fixed
- Forward `include`/`select`/`omit` projections in `softDelete`, `restore`, and `restoreCascade` so results respect projections with proper types (#41, #38)

## [2.3.0] - 2026-02-11

### Added
- CI now fails on generator warnings (#36)

### Fixed
- Remove semantic-release/git plugin to fix release on protected main (#37)

## [2.2.1] - 2026-02-10

### Fixed
- Apply `transformSentinelFindUniqueWhere` to sentinel `upsert`
- Close safety gaps for SOC-compliant soft-delete

## [2.2.0] - 2026-02-10

### Added
- **Sentinel unique strategy**: new `uniqueStrategy = "sentinel"` option that uses a sentinel value (`9999-12-31`) instead of `NULL` for active records, enabling compound `@@unique` constraints that include `deleted_at`

## [2.1.1] - 2026-02-09

### Fixed
- Remove dead code from generated runtime output

## [2.1.0] - 2026-02-09

### Added
- Generated runtime no longer emits `@ts-nocheck`; proper type casts are used instead

### Fixed
- Type transaction client parameters with `Prisma.TransactionClient` instead of `any`
- Remove unused `deletedByType` variables from generated code
- Correct `softDelete` return type and add raw queries to transaction types

## [2.0.0] - 2026-02-08

### Added
- **Filter propagation**: `$onlyDeleted` and `$includingDeleted` now automatically propagate their filter mode through all nested relation includes
- **Transaction escape hatches**: `tx.$onlyDeleted` and `tx.$includingDeleted` are now available in transaction contexts
- **Explicit filter overrides**: User-specified `deleted_at` filters in `where` clauses now override automatic filter propagation, enabling mixed filtering (e.g., deleted users with active posts)
- **Helper utilities**: New exported functions `onlyDeleted()`, `excludeDeleted()`, and `includingDeleted()` for manual filtering in complex nested where clauses

### Changed
- **Breaking**: `$includingDeleted` now uses filter mode propagation instead of raw delegate passthrough, ensuring consistent filtering in nested relations
- Filter injection system now supports three modes: `'exclude-deleted'` (default), `'include-deleted'`, and `'only-deleted'`, which propagate through nested includes

### Fixed
- Filter injection now respects user's explicit `deleted_at` filters instead of overwriting them

## [1.0.0] - 2026-02-08

### Added
- Cascade result tracking: `softDelete` returns `{ record, cascaded }`, `softDeleteMany` returns `{ count, cascaded }`, and `restoreCascade` returns `{ record, cascaded }` where `cascaded` is a `Record<string, number>` mapping model names to affected record counts
- New `CascadeResult` type export for typing cascade return values
- Fast-path optimization: leaf models with no cascade children and no unique string mangling use direct `updateMany` instead of a full transaction
- Structured `UniqueConstraintInfo` in DMMF parser for accurate unique constraint analysis
- Improved `uniqueStrategy='none'` warnings that distinguish between compound `@@unique` constraints including `deleted_at` (broken `NULL != NULL` pattern) and constraints that need partial indexes
- SQL suggestions for both partial unique indexes and `NULLS NOT DISTINCT` (PostgreSQL 15+)

### Changed
- **Breaking**: `softDelete` now returns `{ record, cascaded }` instead of just the record
- **Breaking**: `softDeleteMany` now returns `{ count, cascaded }` instead of `BatchPayload`
- **Breaking**: `restoreCascade` now returns `{ record, cascaded }` instead of just the record
- `update` and `updateMany` on soft-deletable models now inject `deleted_at IS NULL` filters, preventing accidental modification of soft-deleted records

## [0.5.0] - 2026-02-08

### Added
- `restore`, `restoreMany`, and `restoreCascade` methods for recovering soft-deleted records (#13)
- `uniqueStrategy` generator option with `mangle` (default) and `none` strategies (#15)

### Fixed
- Include non-string unique fields in warnings and fix misleading error message

## [0.4.2] - 2026-02-08

### Fixed
- Exclude UUID native type fields from unique string mangling

## [0.4.0] - 2026-02-07

### Added
- `deleted_by` field support: models with a `deleted_by` column require a `deletedBy` argument at compile time for audit trails
- `softDeletePreview` method to preview cascade impact before executing

## [0.3.0] - 2026-02-07

### Added
- `deleted_by` field support for audit trails

## [0.2.0] - 2026-02-07

### Added
- Cascade soft-delete following `onDelete: Cascade` relations
- Deep relation filtering for `include`, `select`, `_count`, and relation filters (`some`/`every`/`none`)

## [0.1.0] - 2026-02-07

### Added
- Initial release
- Type-safe soft deletion wrapper for Prisma 7
- Automatic filter injection on all read operations
- Unique string field mangling to free values for reuse
- Transaction support with wrapped clients
- Compound primary key support
- Escape hatches: `$prisma`, `$includingDeleted`, `$onlyDeleted`
- `hardDelete` and `hardDeleteMany` methods
- `softDelete` and `softDeleteMany` methods
- Support for both `deleted_at` and `deletedAt` field names
