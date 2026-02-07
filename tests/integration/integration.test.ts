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
    // Run tsc on the generated files
    const result = execSync(
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
    expect(content).toContain('hardDelete:');
    expect(content).toContain('hardDeleteMany:');

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
    expect(typeof safePrisma.user.hardDelete).toBe('function');
    expect(typeof safePrisma.user.hardDeleteMany).toBe('function');

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
