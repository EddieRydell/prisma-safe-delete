# Contributing to prisma-safe-delete

Thank you for your interest in contributing! This document provides guidelines and instructions for contributing.

## Development Setup

### Prerequisites

- Node.js >= 18
- pnpm >= 10
- Docker (for running PostgreSQL)

### Getting Started

1. Clone the repository:
   ```bash
   git clone https://github.com/EddieRydell/prisma-safe-delete.git
   cd prisma-safe-delete
   ```

2. Install dependencies:
   ```bash
   pnpm install
   ```

3. Start the PostgreSQL database:
   ```bash
   docker compose up -d
   ```

4. Build the generator:
   ```bash
   pnpm run build
   ```

5. Run the tests:
   ```bash
   pnpm test
   ```

6. Stop the database when done:
   ```bash
   docker compose down
   ```

## Code Style

This project uses:
- **TypeScript** with strict mode enabled
- **ESLint** for linting
- **Knip** for detecting dead code

Before submitting a PR, ensure all checks pass:
```bash
pnpm run ci
```

This runs:
- `pnpm audit --prod` - Security audit
- `pnpm run typecheck` - TypeScript type checking
- `pnpm run lint` - ESLint
- `pnpm run knip` - Dead code detection
- `pnpm run test` - Test suite

## Running Tests

Tests require a PostgreSQL database. The easiest way is to use Docker Compose:

```bash
# Start PostgreSQL
docker compose up -d

# Run all tests
pnpm test

# Run tests in watch mode
pnpm run test:watch

# Run tests with coverage
pnpm run test:coverage
```

### Test Structure

- `tests/*.test.ts` - Unit tests for codegen, DMMF parser, cascade graph, and generator
- `tests/integration/` - Integration tests (prisma generate + TypeScript compilation checks)
- `tests/e2e/`, `tests/e2e-none/`, `tests/e2e-sentinel/` - End-to-end tests against a real PostgreSQL database

## Pull Request Process

1. Fork the repository and create a feature branch from `main`
2. Make your changes
3. Ensure all tests pass: `pnpm run ci`
4. Update documentation if needed
5. Submit a pull request

### PR Guidelines

- Keep changes focused and atomic
- Write clear commit messages
- Add tests for new functionality
- Update the README if adding user-facing features

## Reporting Issues

When reporting bugs, please include:
- Node.js version
- Prisma version
- Operating system
- Steps to reproduce
- Expected vs actual behavior
- Relevant error messages or logs

## Feature Requests

Feature requests are welcome! Please open an issue describing:
- The problem you're trying to solve
- Your proposed solution
- Any alternatives you've considered

## Questions

If you have questions about the codebase or need help, feel free to open an issue with the "question" label.
