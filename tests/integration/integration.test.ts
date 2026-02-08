import { describe, it, expect, beforeAll, vi } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const integrationDir = __dirname;
const generatedDir = path.join(integrationDir, 'generated', 'soft-cascade');

describe('Integration: prisma generate', () => {
  beforeAll(() => {
    // Build the generator first
    execSync('pnpm run build', {
      cwd: path.join(integrationDir, '..', '..'),
      stdio: 'pipe',
    });

    // Run prisma generate
    execSync('npx prisma generate', {
      cwd: integrationDir,
      stdio: 'pipe',
    });
  }, 60000);

  it('generates output files', () => {
    expect(fs.existsSync(path.join(generatedDir, 'index.ts'))).toBe(true);
    expect(fs.existsSync(path.join(generatedDir, 'types.ts'))).toBe(true);
    expect(fs.existsSync(path.join(generatedDir, 'runtime.ts'))).toBe(true);
    expect(fs.existsSync(path.join(generatedDir, 'cascade-graph.ts'))).toBe(true);
  });

  it('generates valid TypeScript that compiles', () => {
    // Run tsc on the generated files - throws if compilation fails
    execSync(
      `npx tsc --noEmit --skipLibCheck --module NodeNext --moduleResolution NodeNext --target ES2022 ${path.join(generatedDir, 'index.ts')}`,
      {
        cwd: integrationDir,
        stdio: 'pipe',
        encoding: 'utf-8',
      }
    );
    // If we get here without throwing, it compiled successfully
    expect(true).toBe(true);
  });

  it('TypeScript errors when deletedBy is missing for models with deleted_by field', () => {
    // Write a test file that only checks types (no instantiation needed)
    const testFile = path.join(integrationDir, 'generated', 'compile-fail-test.ts');
    fs.writeFileSync(
      testFile,
      `
import type { SafePrismaClient } from './soft-cascade/types.js';

// Use declare to avoid needing actual implementation
declare const safePrisma: SafePrismaClient;

// This should fail to compile - Customer has deleted_by, so deletedBy is required
safePrisma.customer.softDelete({ where: { id: '1' } });
`
    );

    try {
      // Run tsc on the test file - should FAIL
      const result = execSync(
        `npx tsc --noEmit --skipLibCheck --module NodeNext --moduleResolution NodeNext --target ES2022 ${testFile}`,
        {
          cwd: integrationDir,
          stdio: 'pipe',
          encoding: 'utf-8',
        }
      );
      // If we get here, tsc didn't fail - that's wrong!
      throw new Error(`Expected TypeScript compilation to fail, but it succeeded with output: ${result}`);
    } catch (error: unknown) {
      // tsc should fail with an error about missing deletedBy
      const execError = error as { status?: number; stdout?: string; stderr?: string; message?: string };
      // Check it's not our own thrown error
      if (execError.message?.includes('Expected TypeScript compilation to fail') === true) {
        throw error;
      }
      expect(execError.status).not.toBe(0);
      // tsc outputs errors to stdout, not stderr
      const output = (execError.stdout ?? '') + (execError.stderr ?? '');
      expect(output).toMatch(/deletedBy|Property.*missing/i);
    } finally {
      // Clean up
      if (fs.existsSync(testFile)) {
        fs.unlinkSync(testFile);
      }
    }
  });

  it('TypeScript compiles when deletedBy is provided for models with deleted_by field', () => {
    // Write a test file that only checks types (no instantiation needed)
    const testFile = path.join(integrationDir, 'generated', 'compile-pass-test.ts');
    fs.writeFileSync(
      testFile,
      `
import type { SafePrismaClient } from './soft-cascade/types.js';

// Use declare to avoid needing actual implementation
declare const safePrisma: SafePrismaClient;

// This should compile - deletedBy is provided
safePrisma.customer.softDelete({ where: { id: '1' }, deletedBy: 'admin' });

// User doesn't have deleted_by field, so deletedBy is optional - this should also compile
safePrisma.user.softDelete({ where: { id: '1' } });
`
    );

    try {
      // Run tsc - should succeed
      execSync(
        `npx tsc --noEmit --skipLibCheck --module NodeNext --moduleResolution NodeNext --target ES2022 ${testFile}`,
        {
          cwd: integrationDir,
          stdio: 'pipe',
          encoding: 'utf-8',
        }
      );
      // If we get here, it compiled successfully
      expect(true).toBe(true);
    } catch (error: unknown) {
      const execError = error as { stdout?: string; stderr?: string };
      const output = (execError.stdout ?? '') + (execError.stderr ?? '');
      throw new Error(`Expected TypeScript compilation to succeed, but it failed:\n${output}`);
    } finally {
      // Clean up
      if (fs.existsSync(testFile)) {
        fs.unlinkSync(testFile);
      }
    }
  });

  // Helper to run tsc and expect it to fail
  function expectTypeError(code: string, expectedPattern: RegExp): void {
    const testFile = path.join(integrationDir, 'generated', `type-test-${String(Date.now())}.ts`);
    fs.writeFileSync(testFile, code);
    try {
      execSync(
        `npx tsc --noEmit --skipLibCheck --module NodeNext --moduleResolution NodeNext --target ES2022 --strict ${testFile}`,
        { cwd: integrationDir, stdio: 'pipe', encoding: 'utf-8' }
      );
      throw new Error('Expected TypeScript compilation to fail, but it succeeded');
    } catch (error: unknown) {
      const execError = error as { status?: number; stdout?: string; stderr?: string; message?: string };
      if (execError.message?.includes('Expected TypeScript compilation to fail') === true) {
        throw error;
      }
      expect(execError.status).not.toBe(0);
      const output = (execError.stdout ?? '') + (execError.stderr ?? '');
      expect(output).toMatch(expectedPattern);
    } finally {
      if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
    }
  }

  // Helper to run tsc and expect it to pass
  function expectNoTypeError(code: string): void {
    const testFile = path.join(integrationDir, 'generated', `type-test-${String(Date.now())}.ts`);
    fs.writeFileSync(testFile, code);
    try {
      execSync(
        `npx tsc --noEmit --skipLibCheck --module NodeNext --moduleResolution NodeNext --target ES2022 --strict ${testFile}`,
        { cwd: integrationDir, stdio: 'pipe', encoding: 'utf-8' }
      );
    } catch (error: unknown) {
      const execError = error as { stdout?: string; stderr?: string };
      const output = (execError.stdout ?? '') + (execError.stderr ?? '');
      throw new Error(`Expected TypeScript compilation to succeed, but it failed:\n${output}`);
    } finally {
      if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
    }
  }

  it('TypeScript errors when calling delete on soft-deletable model', () => {
    expectTypeError(`
import type { SafePrismaClient } from './soft-cascade/types.js';
declare const safePrisma: SafePrismaClient;
safePrisma.user.delete({ where: { id: '1' } });
`, /Property 'delete' does not exist/);
  });

  it('TypeScript errors when calling deleteMany on soft-deletable model', () => {
    expectTypeError(`
import type { SafePrismaClient } from './soft-cascade/types.js';
declare const safePrisma: SafePrismaClient;
safePrisma.user.deleteMany({ where: {} });
`, /Property 'deleteMany' does not exist/);
  });

  it('TypeScript allows delete on non-soft-deletable model (AuditLog)', () => {
    expectNoTypeError(`
import type { SafePrismaClient } from './soft-cascade/types.js';
declare const safePrisma: SafePrismaClient;
safePrisma.auditLog.delete({ where: { id: '1' } });
`);
  });

  it('Transaction callback has typed softDelete method', () => {
    expectNoTypeError(`
import type { SafePrismaClient } from './soft-cascade/types.js';
declare const safePrisma: SafePrismaClient;
safePrisma.$transaction(async (tx) => {
  // tx should have softDelete on user
  await tx.user.softDelete({ where: { id: '1' } });
  // tx should have includingDeleted
  await tx.user.includingDeleted.findMany();
  // tx should require deletedBy for Customer
  await tx.customer.softDelete({ where: { id: '1' }, deletedBy: 'admin' });
});
`);
  });

  it('Transaction callback errors when missing deletedBy for Customer', () => {
    expectTypeError(`
import type { SafePrismaClient } from './soft-cascade/types.js';
declare const safePrisma: SafePrismaClient;
safePrisma.$transaction(async (tx) => {
  await tx.customer.softDelete({ where: { id: '1' } });
});
`, /deletedBy|Property.*missing/i);
  });

  it('includingDeleted has read methods but not write methods', () => {
    expectNoTypeError(`
import type { SafePrismaClient } from './soft-cascade/types.js';
declare const safePrisma: SafePrismaClient;
// These should all work
safePrisma.user.includingDeleted.findMany();
safePrisma.user.includingDeleted.findFirst({ where: { id: '1' } });
safePrisma.user.includingDeleted.findUnique({ where: { id: '1' } });
safePrisma.user.includingDeleted.count();
`);
  });

  it('includingDeleted does not have create/update/delete methods', () => {
    expectTypeError(`
import type { SafePrismaClient } from './soft-cascade/types.js';
declare const safePrisma: SafePrismaClient;
safePrisma.user.includingDeleted.create({ data: { email: 'test@test.com' } });
`, /Property 'create' does not exist/);
  });

  it('__dangerousHardDelete exists and is typed correctly', () => {
    expectNoTypeError(`
import type { SafePrismaClient } from './soft-cascade/types.js';
declare const safePrisma: SafePrismaClient;
safePrisma.user.__dangerousHardDelete({ where: { id: '1' } });
safePrisma.user.__dangerousHardDeleteMany({ where: {} });
`);
  });

  it('generates correct cascade graph for User -> Post -> Comment chain', async () => {
    const cascadeGraphPath = path.join(generatedDir, 'cascade-graph.ts');
    const content = fs.readFileSync(cascadeGraphPath, 'utf-8');

    // User should cascade to Post and Profile
    expect(content).toContain('"User"');
    expect(content).toContain('"Post"');
    expect(content).toContain('"Profile"');

    // Post should cascade to Comment
    expect(content).toContain('"Comment"');

    // Check cascade relationships exist
    expect(content).toContain('"model":"Post"');
    expect(content).toContain('"model":"Profile"');
    expect(content).toContain('"model":"Comment"');
    expect(content).toContain('"foreignKey":["authorId"]');
    expect(content).toContain('"foreignKey":["postId"]');
  });

  it('generates SafePrismaClient type that removes delete methods', () => {
    const typesPath = path.join(generatedDir, 'types.ts');
    const content = fs.readFileSync(typesPath, 'utf-8');

    // Should have Omit removing delete methods for soft-deletable models
    expect(content).toContain("Omit<");
    expect(content).toContain("'delete' | 'deleteMany'");

    // Should have softDelete methods
    expect(content).toContain('softDelete:');
    expect(content).toContain('softDeleteMany:');
    expect(content).toContain('__dangerousHardDelete:');
    expect(content).toContain('__dangerousHardDeleteMany:');

    // AuditLog (not soft-deletable) should NOT have Omit
    expect(content).toContain("SafeAuditLogDelegate = PrismaClient['auditLog']");
  });

  it('generates runtime with injectFilters function', () => {
    const runtimePath = path.join(generatedDir, 'runtime.ts');
    const content = fs.readFileSync(runtimePath, 'utf-8');

    // Should have filter injection
    expect(content).toContain('function injectFilters');
    expect(content).toContain('deleted_at');

    // Should have cascade function
    expect(content).toContain('softDeleteWithCascade');

    // Should have model delegates
    expect(content).toContain('createUserDelegate');
    expect(content).toContain('createPostDelegate');
    expect(content).toContain('createAuditLogDelegate');
  });
});

describe('Integration: Runtime behavior', () => {
  beforeAll(() => {
    // Ensure generated files exist
    if (!fs.existsSync(generatedDir)) {
      execSync('pnpm run build', {
        cwd: path.join(integrationDir, '..', '..'),
        stdio: 'pipe',
      });
      execSync('npx prisma generate', {
        cwd: integrationDir,
        stdio: 'pipe',
      });
    }
  }, 60000);

  it('wrapPrismaClient adds soft delete methods to delegates', async () => {
    // Dynamically import the generated module
    const runtime = await import('./generated/soft-cascade/runtime.js');

    // Create a mock PrismaClient
    const mockFindMany = vi.fn().mockResolvedValue([]);
    const mockFindFirst = vi.fn().mockResolvedValue(null);
    const mockCreate = vi.fn().mockResolvedValue({ id: '1' });
    const mockUpdate = vi.fn().mockResolvedValue({ id: '1' });
    const mockUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const mockTransaction = vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      return fn({
        user: {
          findMany: mockFindMany,
          updateMany: mockUpdateMany,
        },
        post: {
          findMany: mockFindMany,
          updateMany: mockUpdateMany,
        },
        profile: {
          findMany: mockFindMany,
          updateMany: mockUpdateMany,
        },
        comment: {
          findMany: mockFindMany,
          updateMany: mockUpdateMany,
        },
      });
    });

    const mockPrisma = {
      user: {
        findMany: mockFindMany,
        findFirst: mockFindFirst,
        findFirstOrThrow: mockFindFirst,
        findUnique: mockFindFirst,
        findUniqueOrThrow: mockFindFirst,
        count: vi.fn().mockResolvedValue(0),
        aggregate: vi.fn().mockResolvedValue({}),
        groupBy: vi.fn().mockResolvedValue([]),
        create: mockCreate,
        createMany: mockCreate,
        createManyAndReturn: mockCreate,
        update: mockUpdate,
        updateMany: mockUpdateMany,
        upsert: mockUpdate,
        delete: vi.fn(),
        deleteMany: vi.fn(),
      },
      post: {
        findMany: mockFindMany,
        findFirst: mockFindFirst,
        findFirstOrThrow: mockFindFirst,
        findUnique: mockFindFirst,
        findUniqueOrThrow: mockFindFirst,
        count: vi.fn().mockResolvedValue(0),
        aggregate: vi.fn().mockResolvedValue({}),
        groupBy: vi.fn().mockResolvedValue([]),
        create: mockCreate,
        createMany: mockCreate,
        createManyAndReturn: mockCreate,
        update: mockUpdate,
        updateMany: mockUpdateMany,
        upsert: mockUpdate,
        delete: vi.fn(),
        deleteMany: vi.fn(),
      },
      profile: {
        findMany: mockFindMany,
        findFirst: mockFindFirst,
        findFirstOrThrow: mockFindFirst,
        findUnique: mockFindFirst,
        findUniqueOrThrow: mockFindFirst,
        count: vi.fn().mockResolvedValue(0),
        aggregate: vi.fn().mockResolvedValue({}),
        groupBy: vi.fn().mockResolvedValue([]),
        create: mockCreate,
        createMany: mockCreate,
        createManyAndReturn: mockCreate,
        update: mockUpdate,
        updateMany: mockUpdateMany,
        upsert: mockUpdate,
        delete: vi.fn(),
        deleteMany: vi.fn(),
      },
      comment: {
        findMany: mockFindMany,
        findFirst: mockFindFirst,
        findFirstOrThrow: mockFindFirst,
        findUnique: mockFindFirst,
        findUniqueOrThrow: mockFindFirst,
        count: vi.fn().mockResolvedValue(0),
        aggregate: vi.fn().mockResolvedValue({}),
        groupBy: vi.fn().mockResolvedValue([]),
        create: mockCreate,
        createMany: mockCreate,
        createManyAndReturn: mockCreate,
        update: mockUpdate,
        updateMany: mockUpdateMany,
        upsert: mockUpdate,
        delete: vi.fn(),
        deleteMany: vi.fn(),
      },
      auditLog: {
        findMany: mockFindMany,
        findFirst: mockFindFirst,
        findFirstOrThrow: mockFindFirst,
        findUnique: mockFindFirst,
        findUniqueOrThrow: mockFindFirst,
        count: vi.fn().mockResolvedValue(0),
        aggregate: vi.fn().mockResolvedValue({}),
        groupBy: vi.fn().mockResolvedValue([]),
        create: mockCreate,
        createMany: mockCreate,
        createManyAndReturn: mockCreate,
        update: mockUpdate,
        updateMany: mockUpdateMany,
        upsert: mockUpdate,
        delete: vi.fn(),
        deleteMany: vi.fn(),
      },
      $connect: vi.fn(),
      $disconnect: vi.fn(),
      $on: vi.fn(),
      $transaction: mockTransaction,
      $use: vi.fn(),
      $extends: vi.fn(),
      $queryRaw: vi.fn(),
      $executeRaw: vi.fn(),
      $queryRawUnsafe: vi.fn(),
      $executeRawUnsafe: vi.fn(),
    };

    // Wrap the mock client
    const safePrisma = runtime.wrapPrismaClient(mockPrisma as never);

    // Verify soft-deletable model has softDelete method
    expect(typeof safePrisma.user.softDelete).toBe('function');
    expect(typeof safePrisma.user.softDeleteMany).toBe('function');
    expect(typeof safePrisma.user.__dangerousHardDelete).toBe('function');
    expect(typeof safePrisma.user.__dangerousHardDeleteMany).toBe('function');

    // Verify delete methods are NOT exposed (they're replaced)
    expect((safePrisma.user as Record<string, unknown>)['delete']).toBeUndefined();
    expect((safePrisma.user as Record<string, unknown>)['deleteMany']).toBeUndefined();
  });

  it('injects deleted_at: null filter on findMany', async () => {
    const runtime = await import('./generated/soft-cascade/runtime.js');

    const mockFindMany = vi.fn().mockResolvedValue([]);
    const mockPrisma = {
      user: {
        findMany: mockFindMany,
        findFirst: vi.fn(),
        findFirstOrThrow: vi.fn(),
        findUnique: vi.fn(),
        findUniqueOrThrow: vi.fn(),
        count: vi.fn(),
        aggregate: vi.fn(),
        groupBy: vi.fn(),
        create: vi.fn(),
        createMany: vi.fn(),
        createManyAndReturn: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
        upsert: vi.fn(),
        delete: vi.fn(),
        deleteMany: vi.fn(),
      },
      post: { findMany: vi.fn(), findFirst: vi.fn(), findFirstOrThrow: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), count: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn(), create: vi.fn(), createMany: vi.fn(), createManyAndReturn: vi.fn(), update: vi.fn(), updateMany: vi.fn(), upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
      profile: { findMany: vi.fn(), findFirst: vi.fn(), findFirstOrThrow: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), count: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn(), create: vi.fn(), createMany: vi.fn(), createManyAndReturn: vi.fn(), update: vi.fn(), updateMany: vi.fn(), upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
      comment: { findMany: vi.fn(), findFirst: vi.fn(), findFirstOrThrow: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), count: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn(), create: vi.fn(), createMany: vi.fn(), createManyAndReturn: vi.fn(), update: vi.fn(), updateMany: vi.fn(), upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
      auditLog: { findMany: vi.fn(), findFirst: vi.fn(), findFirstOrThrow: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), count: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn(), create: vi.fn(), createMany: vi.fn(), createManyAndReturn: vi.fn(), update: vi.fn(), updateMany: vi.fn(), upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
      $connect: vi.fn(),
      $disconnect: vi.fn(),
      $on: vi.fn(),
      $transaction: vi.fn(),
      $use: vi.fn(),
      $extends: vi.fn(),
      $queryRaw: vi.fn(),
      $executeRaw: vi.fn(),
      $queryRawUnsafe: vi.fn(),
      $executeRawUnsafe: vi.fn(),
    };

    const safePrisma = runtime.wrapPrismaClient(mockPrisma as never);

    // Call findMany without any args
    await safePrisma.user.findMany();

    // Verify the filter was injected
    expect(mockFindMany).toHaveBeenCalledWith({
      where: { deleted_at: null },
    });
  });

  it('injects deleted_at: null filter and preserves existing where', async () => {
    const runtime = await import('./generated/soft-cascade/runtime.js');

    const mockFindMany = vi.fn().mockResolvedValue([]);
    const mockPrisma = {
      user: {
        findMany: mockFindMany,
        findFirst: vi.fn(),
        findFirstOrThrow: vi.fn(),
        findUnique: vi.fn(),
        findUniqueOrThrow: vi.fn(),
        count: vi.fn(),
        aggregate: vi.fn(),
        groupBy: vi.fn(),
        create: vi.fn(),
        createMany: vi.fn(),
        createManyAndReturn: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
        upsert: vi.fn(),
        delete: vi.fn(),
        deleteMany: vi.fn(),
      },
      post: { findMany: vi.fn(), findFirst: vi.fn(), findFirstOrThrow: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), count: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn(), create: vi.fn(), createMany: vi.fn(), createManyAndReturn: vi.fn(), update: vi.fn(), updateMany: vi.fn(), upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
      profile: { findMany: vi.fn(), findFirst: vi.fn(), findFirstOrThrow: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), count: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn(), create: vi.fn(), createMany: vi.fn(), createManyAndReturn: vi.fn(), update: vi.fn(), updateMany: vi.fn(), upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
      comment: { findMany: vi.fn(), findFirst: vi.fn(), findFirstOrThrow: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), count: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn(), create: vi.fn(), createMany: vi.fn(), createManyAndReturn: vi.fn(), update: vi.fn(), updateMany: vi.fn(), upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
      auditLog: { findMany: vi.fn(), findFirst: vi.fn(), findFirstOrThrow: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), count: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn(), create: vi.fn(), createMany: vi.fn(), createManyAndReturn: vi.fn(), update: vi.fn(), updateMany: vi.fn(), upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
      $connect: vi.fn(),
      $disconnect: vi.fn(),
      $on: vi.fn(),
      $transaction: vi.fn(),
      $use: vi.fn(),
      $extends: vi.fn(),
      $queryRaw: vi.fn(),
      $executeRaw: vi.fn(),
      $queryRawUnsafe: vi.fn(),
      $executeRawUnsafe: vi.fn(),
    };

    const safePrisma = runtime.wrapPrismaClient(mockPrisma as never);

    // Call findMany with existing where clause
    await safePrisma.user.findMany({
      where: { email: 'test@example.com' },
    });

    // Verify the filter was injected AND original where preserved
    expect(mockFindMany).toHaveBeenCalledWith({
      where: {
        email: 'test@example.com',
        deleted_at: null,
      },
    });
  });
});
