# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
