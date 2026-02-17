import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDMMF } from '../../src/dmmf-parser.js';
import { buildCascadeGraph } from '../../src/cascade-graph.js';
import { emitRuntime, emitTypes, emitCascadeGraph, emitIndex, resolveAuditTableConfig } from '../../src/codegen/index.js';
import { createMockField, createMockModel, createMockDMMF } from '../helpers/mock-dmmf.js';

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

    // Strip // @ts-nocheck from generated files so CI still type-checks them
    for (const file of fs.readdirSync(generatedDir)) {
      if (file.endsWith('.ts')) {
        const filePath = path.join(generatedDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        fs.writeFileSync(filePath, content.replace(/^\/\/ @ts-nocheck\n/m, ''), 'utf-8');
      }
    }
  }, 60000);

  it('generates output files', () => {
    expect(fs.existsSync(path.join(generatedDir, 'index.ts'))).toBe(true);
    expect(fs.existsSync(path.join(generatedDir, 'types.ts'))).toBe(true);
    expect(fs.existsSync(path.join(generatedDir, 'runtime.ts'))).toBe(true);
    expect(fs.existsSync(path.join(generatedDir, 'cascade-graph.ts'))).toBe(true);
  });

  it('generates valid TypeScript that compiles', { timeout: 15_000 }, () => {
    // Run tsc on the generated files - throws if compilation fails
    // --noUnusedLocals catches dead code in generated output
    execSync(
      `npx tsc --noEmit --skipLibCheck --module NodeNext --moduleResolution NodeNext --target ES2022 --noUnusedLocals ${path.join(generatedDir, 'index.ts')}`,
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

  it('softDelete return type has record and cascaded fields', () => {
    expectNoTypeError(`
import type { SafePrismaClient, CascadeResult } from './soft-cascade/types.js';
declare const safePrisma: SafePrismaClient;
async function test() {
  const result = await safePrisma.user.softDelete({ where: { id: '1' } });
  // Must be able to access .record and .cascaded
  const record = result.record;
  const cascaded: CascadeResult = result.cascaded;
  // record is non-nullable (throws P2025 when not found)
  const email: string = record.email;
  const count: number = cascaded['Post'] ?? 0;
}
`);
  });

  it('softDelete return type is not assignable to raw record', () => {
    expectTypeError(`
import type { SafePrismaClient, SafeUserDelegate } from './soft-cascade/types.js';
declare const safePrisma: SafePrismaClient;
async function test() {
  // Return type is { record, cascaded }, NOT just the record
  const result = await safePrisma.user.softDelete({ where: { id: '1' } });
  // Accessing .email directly on result should fail (it's on .record)
  const email: string = result.email;
}
`, /Property 'email' does not exist/);
  });

  it('softDeleteMany return type has count and cascaded fields', () => {
    expectNoTypeError(`
import type { SafePrismaClient, CascadeResult } from './soft-cascade/types.js';
declare const safePrisma: SafePrismaClient;
async function test() {
  const result = await safePrisma.user.softDeleteMany({ where: {} });
  const count: number = result.count;
  const cascaded: CascadeResult = result.cascaded;
}
`);
  });

  it('softDeleteMany return type is not BatchPayload', () => {
    expectTypeError(`
import type { SafePrismaClient } from './soft-cascade/types.js';
declare const safePrisma: SafePrismaClient;
async function test() {
  const result = await safePrisma.user.softDeleteMany({ where: {} });
  // BatchPayload would have .count as bigint, ours is number
  const n: bigint = result.count;
}
`, /Type 'number' is not assignable to type 'bigint'/);
  });

  it('restoreCascade return type has record and cascaded fields', () => {
    expectNoTypeError(`
import type { SafePrismaClient, CascadeResult } from './soft-cascade/types.js';
declare const safePrisma: SafePrismaClient;
async function test() {
  const result = await safePrisma.user.restoreCascade({ where: { id: '1' } });
  const record = result.record;  // can be null
  const cascaded: CascadeResult = result.cascaded;
  if (record !== null) {
    const email: string = record.email;
  }
}
`);
  });

  it('CascadeResult type is importable from index', () => {
    expectNoTypeError(`
import type { CascadeResult } from './soft-cascade/index.js';
const result: CascadeResult = { Post: 3, Comment: 5 };
const count: number = result['Post']!;
`);
  });

  it('filter helpers are importable from index', () => {
    expectNoTypeError(`
import { onlyDeleted, excludeDeleted, includingDeleted } from './soft-cascade/index.js';
const a = onlyDeleted('User');
const b = excludeDeleted('User');
const c = includingDeleted();
`);
  });

  it('softDelete cascaded return type works in transaction', () => {
    expectNoTypeError(`
import type { SafePrismaClient, CascadeResult } from './soft-cascade/types.js';
declare const safePrisma: SafePrismaClient;
async function test() {
  await safePrisma.$transaction(async (tx) => {
    const result = await tx.user.softDelete({ where: { id: '1' } });
    const record = result.record;
    const cascaded: CascadeResult = result.cascaded;

    const result2 = await tx.user.softDeleteMany({ where: {} });
    const count: number = result2.count;
    const cascaded2: CascadeResult = result2.cascaded;

    const result3 = await tx.user.restoreCascade({ where: { id: '1' } });
    const record3 = result3.record;
    const cascaded3: CascadeResult = result3.cascaded;
  });
}
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

    // Should have CascadeResult type
    expect(content).toContain('export type CascadeResult = Record<string, number>;');

    // Should have Omit removing delete methods for soft-deletable models
    expect(content).toContain("Omit<");
    expect(content).toContain("'delete' | 'deleteMany'");

    // Should have softDelete methods with cascaded return types
    expect(content).toContain('softDelete:');
    expect(content).toContain('softDeleteMany:');
    expect(content).toContain('cascaded: CascadeResult');
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
    // Audit models
    expect(content).toContain('createProjectDelegate');
    expect(content).toContain('createWebhookDelegate');
  });

  // --- Audit logging integration tests ---

  it('generates audit helper functions in runtime', () => {
    const runtimePath = path.join(generatedDir, 'runtime.ts');
    const content = fs.readFileSync(runtimePath, 'utf-8');

    expect(content).toContain('AUDITABLE_MODELS');
    expect(content).toContain('writeAuditEvent');
    expect(content).toContain('isAuditable');
    expect(content).toContain('getEntityId');
    expect(content).toContain('AUDIT_TABLE_NAME');
  });

  it('generates WrapOptions type in types', () => {
    const typesPath = path.join(generatedDir, 'types.ts');
    const content = fs.readFileSync(typesPath, 'utf-8');

    expect(content).toContain('WrapOptions');
    expect(content).toContain('auditContext');
  });

  it('audited + soft-deletable model has actorId on softDelete', () => {
    const typesPath = path.join(generatedDir, 'types.ts');
    const content = fs.readFileSync(typesPath, 'utf-8');

    // Project is @audit + soft-deletable
    expect(content).toMatch(/SafeProjectDelegate[\s\S]*actorId/);
  });

  it('audit-only model has actorId on delete', () => {
    const typesPath = path.join(generatedDir, 'types.ts');
    const content = fs.readFileSync(typesPath, 'utf-8');

    // Webhook is @audit(create, delete) without soft-delete
    expect(content).toMatch(/SafeWebhookDelegate[\s\S]*actorId/);
  });

  it('WrapOptions is exported from index', () => {
    const indexPath = path.join(generatedDir, 'index.ts');
    const content = fs.readFileSync(indexPath, 'utf-8');

    expect(content).toContain('WrapOptions');
  });

  it('audited model uses actorId in softDelete type', () => {
    expectNoTypeError(`
import type { SafePrismaClient } from './soft-cascade/types.js';
declare const safePrisma: SafePrismaClient;
// Project is audited+soft-deletable: uses actorId
safePrisma.project.softDelete({ where: { id: '1' }, actorId: 'user-123' });
safePrisma.project.softDeleteMany({ where: {}, actorId: 'user-123' });
// actorId is optional
safePrisma.project.softDelete({ where: { id: '1' } });
`);
  });

  it('audited model has actorId on create/update', () => {
    expectNoTypeError(`
import type { SafePrismaClient } from './soft-cascade/types.js';
declare const safePrisma: SafePrismaClient;
safePrisma.project.create({ data: { name: 'test' }, actorId: 'user-123' });
safePrisma.project.update({ where: { id: '1' }, data: { name: 'updated' }, actorId: 'user-123' });
`);
  });

  it('audit-only model has actorId on delete/create', () => {
    expectNoTypeError(`
import type { SafePrismaClient } from './soft-cascade/types.js';
declare const safePrisma: SafePrismaClient;
safePrisma.webhook.create({ data: { url: 'http://example.com' }, actorId: 'user-123' });
safePrisma.webhook.delete({ where: { id: '1' }, actorId: 'user-123' });
`);
  });

  it('wrapPrismaClient accepts WrapOptions', () => {
    expectNoTypeError(`
import { wrapPrismaClient } from './soft-cascade/runtime.js';
import type { WrapOptions } from './soft-cascade/types.js';
declare const prisma: any;
const opts: WrapOptions = { auditContext: async () => ({ source: 'test' }) };
const safePrisma = wrapPrismaClient(prisma, opts);
`);
  });

  it('transaction has actorId on audited model softDelete', () => {
    expectNoTypeError(`
import type { SafePrismaClient } from './soft-cascade/types.js';
declare const safePrisma: SafePrismaClient;
safePrisma.$transaction(async (tx) => {
  await tx.project.softDelete({ where: { id: '1' }, actorId: 'user-123' });
  await tx.project.create({ data: { name: 'test' }, actorId: 'user-123' });
  await tx.webhook.delete({ where: { id: '1' }, actorId: 'user-123' });
});
`);
  });
});

describe('Integration: sentinel strategy compilation', () => {
  it('sentinel-generated code compiles with --noUnusedLocals', () => {
    const models = [
      createMockModel({
        name: 'User',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({ name: 'email', type: 'String' }),
          createMockField({
            name: 'deleted_at',
            type: 'DateTime',
            isRequired: true,
            hasDefaultValue: true,
          }),
          createMockField({
            name: 'posts',
            type: 'Post',
            kind: 'object',
            isList: true,
            relationName: 'UserPosts',
          }),
        ],
        uniqueFields: [['email', 'deleted_at']],
        uniqueIndexes: [{ name: 'email_deleted_at', fields: ['email', 'deleted_at'] }],
      }),
      createMockModel({
        name: 'Post',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({ name: 'title', type: 'String' }),
          createMockField({ name: 'authorId', type: 'String' }),
          createMockField({
            name: 'author',
            type: 'User',
            kind: 'object',
            relationName: 'UserPosts',
            relationFromFields: ['authorId'],
            relationToFields: ['id'],
            relationOnDelete: 'Cascade',
          }),
          createMockField({
            name: 'deleted_at',
            type: 'DateTime',
            isRequired: true,
            hasDefaultValue: true,
          }),
        ],
      }),
    ];

    const schema = parseDMMF(createMockDMMF(models));
    const cascadeGraph = buildCascadeGraph(schema);

    // Use the same client import path as the integration test
    const clientImportPath = '../client/client.js';
    const runtimeContent = emitRuntime(schema, clientImportPath, { uniqueStrategy: 'sentinel', cascadeGraph });
    const typesContent = emitTypes(schema, clientImportPath);
    const cascadeGraphContent = emitCascadeGraph(cascadeGraph);
    const indexContent = emitIndex(schema);

    // Write to temporary directory
    const sentinelDir = path.join(integrationDir, 'generated', 'sentinel-test');
    fs.mkdirSync(sentinelDir, { recursive: true });

    // Strip // @ts-nocheck so CI still type-checks sentinel-generated code
    const stripTsNocheck = (s: string) => s.replace(/^\/\/ @ts-nocheck\n/m, '');

    try {
      fs.writeFileSync(path.join(sentinelDir, 'runtime.ts'), stripTsNocheck(runtimeContent), 'utf-8');
      fs.writeFileSync(path.join(sentinelDir, 'types.ts'), stripTsNocheck(typesContent), 'utf-8');
      fs.writeFileSync(path.join(sentinelDir, 'cascade-graph.ts'), cascadeGraphContent, 'utf-8');
      fs.writeFileSync(path.join(sentinelDir, 'index.ts'), stripTsNocheck(indexContent), 'utf-8');

      // Compile with --noUnusedLocals (same as main integration test)
      execSync(
        `npx tsc --noEmit --skipLibCheck --module NodeNext --moduleResolution NodeNext --target ES2022 --noUnusedLocals ${path.join(sentinelDir, 'index.ts')}`,
        {
          cwd: integrationDir,
          stdio: 'pipe',
          encoding: 'utf-8',
        }
      );
      // If we get here, it compiled successfully
      expect(true).toBe(true);
    } finally {
      // Clean up
      fs.rmSync(sentinelDir, { recursive: true, force: true });
    }
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
        project: {
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
        updateManyAndReturn: mockUpdate,
        upsert: mockUpdate,
        delete: vi.fn(),
        deleteMany: vi.fn(),
        fields: {},
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
        updateManyAndReturn: mockUpdate,
        upsert: mockUpdate,
        delete: vi.fn(),
        deleteMany: vi.fn(),
        fields: {},
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
        updateManyAndReturn: mockUpdate,
        upsert: mockUpdate,
        delete: vi.fn(),
        deleteMany: vi.fn(),
        fields: {},
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
        updateManyAndReturn: mockUpdate,
        upsert: mockUpdate,
        delete: vi.fn(),
        deleteMany: vi.fn(),
        fields: {},
      },
      customer: {
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
        updateManyAndReturn: mockUpdate,
        upsert: mockUpdate,
        delete: vi.fn(),
        deleteMany: vi.fn(),
        fields: {},
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
        updateManyAndReturn: mockUpdate,
        upsert: mockUpdate,
        delete: vi.fn(),
        deleteMany: vi.fn(),
        fields: {},
      },
      project: {
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
        updateManyAndReturn: mockUpdate,
        upsert: mockUpdate,
        delete: vi.fn(),
        deleteMany: vi.fn(),
        fields: {},
      },
      webhook: {
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
        updateManyAndReturn: mockUpdate,
        upsert: mockUpdate,
        delete: vi.fn(),
        deleteMany: vi.fn(),
        fields: {},
      },
      auditEvent: {
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
        updateManyAndReturn: mockUpdate,
        upsert: mockUpdate,
        delete: vi.fn(),
        deleteMany: vi.fn(),
        fields: {},
      },
      $connect: vi.fn(),
      $disconnect: vi.fn(),
      $on: vi.fn(),
      $transaction: mockTransaction,
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
        updateManyAndReturn: vi.fn(),
        upsert: vi.fn(),
        delete: vi.fn(),
        deleteMany: vi.fn(),
        fields: {},
      },
      post: { findMany: vi.fn(), findFirst: vi.fn(), findFirstOrThrow: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), count: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn(), create: vi.fn(), createMany: vi.fn(), createManyAndReturn: vi.fn(), update: vi.fn(), updateMany: vi.fn(), updateManyAndReturn: vi.fn(), upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), fields: {} },
      profile: { findMany: vi.fn(), findFirst: vi.fn(), findFirstOrThrow: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), count: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn(), create: vi.fn(), createMany: vi.fn(), createManyAndReturn: vi.fn(), update: vi.fn(), updateMany: vi.fn(), updateManyAndReturn: vi.fn(), upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), fields: {} },
      comment: { findMany: vi.fn(), findFirst: vi.fn(), findFirstOrThrow: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), count: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn(), create: vi.fn(), createMany: vi.fn(), createManyAndReturn: vi.fn(), update: vi.fn(), updateMany: vi.fn(), updateManyAndReturn: vi.fn(), upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), fields: {} },
      customer: { findMany: vi.fn(), findFirst: vi.fn(), findFirstOrThrow: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), count: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn(), create: vi.fn(), createMany: vi.fn(), createManyAndReturn: vi.fn(), update: vi.fn(), updateMany: vi.fn(), updateManyAndReturn: vi.fn(), upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), fields: {} },
      auditLog: { findMany: vi.fn(), findFirst: vi.fn(), findFirstOrThrow: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), count: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn(), create: vi.fn(), createMany: vi.fn(), createManyAndReturn: vi.fn(), update: vi.fn(), updateMany: vi.fn(), updateManyAndReturn: vi.fn(), upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), fields: {} },
      project: { findMany: vi.fn(), findFirst: vi.fn(), findFirstOrThrow: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), count: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn(), create: vi.fn(), createMany: vi.fn(), createManyAndReturn: vi.fn(), update: vi.fn(), updateMany: vi.fn(), updateManyAndReturn: vi.fn(), upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), fields: {} },
      webhook: { findMany: vi.fn(), findFirst: vi.fn(), findFirstOrThrow: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), count: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn(), create: vi.fn(), createMany: vi.fn(), createManyAndReturn: vi.fn(), update: vi.fn(), updateMany: vi.fn(), updateManyAndReturn: vi.fn(), upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), fields: {} },
      auditEvent: { findMany: vi.fn(), findFirst: vi.fn(), findFirstOrThrow: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), count: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn(), create: vi.fn(), createMany: vi.fn(), createManyAndReturn: vi.fn(), update: vi.fn(), updateMany: vi.fn(), updateManyAndReturn: vi.fn(), upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), fields: {} },
      $connect: vi.fn(),
      $disconnect: vi.fn(),
      $on: vi.fn(),
      $transaction: vi.fn(),
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
        updateManyAndReturn: vi.fn(),
        upsert: vi.fn(),
        delete: vi.fn(),
        deleteMany: vi.fn(),
        fields: {},
      },
      post: { findMany: vi.fn(), findFirst: vi.fn(), findFirstOrThrow: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), count: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn(), create: vi.fn(), createMany: vi.fn(), createManyAndReturn: vi.fn(), update: vi.fn(), updateMany: vi.fn(), updateManyAndReturn: vi.fn(), upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), fields: {} },
      profile: { findMany: vi.fn(), findFirst: vi.fn(), findFirstOrThrow: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), count: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn(), create: vi.fn(), createMany: vi.fn(), createManyAndReturn: vi.fn(), update: vi.fn(), updateMany: vi.fn(), updateManyAndReturn: vi.fn(), upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), fields: {} },
      comment: { findMany: vi.fn(), findFirst: vi.fn(), findFirstOrThrow: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), count: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn(), create: vi.fn(), createMany: vi.fn(), createManyAndReturn: vi.fn(), update: vi.fn(), updateMany: vi.fn(), updateManyAndReturn: vi.fn(), upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), fields: {} },
      customer: { findMany: vi.fn(), findFirst: vi.fn(), findFirstOrThrow: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), count: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn(), create: vi.fn(), createMany: vi.fn(), createManyAndReturn: vi.fn(), update: vi.fn(), updateMany: vi.fn(), updateManyAndReturn: vi.fn(), upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), fields: {} },
      auditLog: { findMany: vi.fn(), findFirst: vi.fn(), findFirstOrThrow: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), count: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn(), create: vi.fn(), createMany: vi.fn(), createManyAndReturn: vi.fn(), update: vi.fn(), updateMany: vi.fn(), updateManyAndReturn: vi.fn(), upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), fields: {} },
      project: { findMany: vi.fn(), findFirst: vi.fn(), findFirstOrThrow: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), count: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn(), create: vi.fn(), createMany: vi.fn(), createManyAndReturn: vi.fn(), update: vi.fn(), updateMany: vi.fn(), updateManyAndReturn: vi.fn(), upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), fields: {} },
      webhook: { findMany: vi.fn(), findFirst: vi.fn(), findFirstOrThrow: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), count: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn(), create: vi.fn(), createMany: vi.fn(), createManyAndReturn: vi.fn(), update: vi.fn(), updateMany: vi.fn(), updateManyAndReturn: vi.fn(), upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), fields: {} },
      auditEvent: { findMany: vi.fn(), findFirst: vi.fn(), findFirstOrThrow: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), count: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn(), create: vi.fn(), createMany: vi.fn(), createManyAndReturn: vi.fn(), update: vi.fn(), updateMany: vi.fn(), updateManyAndReturn: vi.fn(), upsert: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), fields: {} },
      $connect: vi.fn(),
      $disconnect: vi.fn(),
      $on: vi.fn(),
      $transaction: vi.fn(),
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

describe('Integration: strictUniqueChecks', () => {
  const tmpDirs: string[] = [];

  afterAll(() => {
    // Deferred cleanup to avoid Windows EBUSY file lock issues
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors (Windows file locks release after process exits)
      }
    }
  });

  it('prisma generate fails when strictUniqueChecks is enabled and unique issues exist', () => {
    // Create temp directory with a schema that has strictUniqueChecks = "true"
    const tmpDir = path.join(integrationDir, 'tmp-strict-unique-test');
    tmpDirs.push(tmpDir);
    fs.mkdirSync(tmpDir, { recursive: true });

    const schemaContent = `
generator client {
  provider = "prisma-client"
  output   = "./generated/client"
}

generator softCascade {
  provider           = "node ${path.join(integrationDir, '..', '..', 'dist', 'bin.js').split(path.sep).join('/')}"
  output             = "./generated/soft-cascade"
  uniqueStrategy     = "none"
  strictUniqueChecks = "true"
}

datasource db {
  provider = "sqlite"
}

model User {
  id         String    @id @default(cuid())
  email      String    @unique
  deleted_at DateTime?
}
`;

    fs.writeFileSync(path.join(tmpDir, 'schema.prisma'), schemaContent, 'utf-8');

    try {
      execSync('npx prisma generate', {
        cwd: tmpDir,
        stdio: 'pipe',
        encoding: 'utf-8',
      });
      // If we get here, prisma generate didn't fail — that's wrong
      throw new Error('Expected prisma generate to fail with strictUniqueChecks, but it succeeded');
    } catch (error: unknown) {
      const execError = error as { status?: number; stdout?: string; stderr?: string; message?: string };
      // Check it's not our own thrown error
      if (execError.message?.includes('Expected prisma generate to fail') === true) {
        throw error;
      }
      expect(execError.status).not.toBe(0);
      const output = (execError.stdout ?? '') + (execError.stderr ?? '');
      expect(output).toContain('strictUniqueChecks');
    }
  }, 60000);

  it('prisma generate succeeds when strictUniqueChecks is enabled and no issues exist', () => {
    // Create temp directory with a schema that has strictUniqueChecks but no unique fields
    const tmpDir = path.join(integrationDir, 'tmp-strict-unique-pass');
    tmpDirs.push(tmpDir);
    fs.mkdirSync(tmpDir, { recursive: true });

    const schemaContent = `
generator client {
  provider = "prisma-client"
  output   = "./generated/client"
}

generator softCascade {
  provider           = "node ${path.join(integrationDir, '..', '..', 'dist', 'bin.js').split(path.sep).join('/')}"
  output             = "./generated/soft-cascade"
  uniqueStrategy     = "none"
  strictUniqueChecks = "true"
}

datasource db {
  provider = "sqlite"
}

model User {
  id         String    @id @default(cuid())
  name       String
  deleted_at DateTime?
}
`;

    fs.writeFileSync(path.join(tmpDir, 'schema.prisma'), schemaContent, 'utf-8');

    execSync('npx prisma generate', {
      cwd: tmpDir,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    // If we get here, prisma generate succeeded — correct
    expect(true).toBe(true);
  }, 60000);
});

describe('Integration: cascade option', () => {
  const tmpDirs: string[] = [];

  afterAll(() => {
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors (Windows file locks release after process exits)
      }
    }
  });

  it('cascade = "false" produces empty cascade graph and all models use fast path', () => {
    const tmpDir = path.join(integrationDir, 'tmp-cascade-false');
    tmpDirs.push(tmpDir);
    fs.mkdirSync(tmpDir, { recursive: true });

    const schemaContent = `
generator client {
  provider = "prisma-client"
  output   = "./generated/client"
}

generator softCascade {
  provider       = "node ${path.join(integrationDir, '..', '..', 'dist', 'bin.js').split(path.sep).join('/')}"
  output         = "./generated/soft-cascade"
  uniqueStrategy = "none"
  cascade        = "false"
}

datasource db {
  provider = "sqlite"
}

model User {
  id         String    @id @default(cuid())
  email      String    @unique
  posts      Post[]
  deleted_at DateTime?
}

model Post {
  id         String    @id @default(cuid())
  title      String
  authorId   String
  author     User      @relation(fields: [authorId], references: [id], onDelete: Cascade)
  deleted_at DateTime?
}
`;

    fs.writeFileSync(path.join(tmpDir, 'schema.prisma'), schemaContent, 'utf-8');

    execSync('npx prisma generate', {
      cwd: tmpDir,
      stdio: 'pipe',
      encoding: 'utf-8',
    });

    const cascadeGraphContent = fs.readFileSync(
      path.join(tmpDir, 'generated', 'soft-cascade', 'cascade-graph.ts'),
      'utf-8',
    );
    const runtimeContent = fs.readFileSync(
      path.join(tmpDir, 'generated', 'soft-cascade', 'runtime.ts'),
      'utf-8',
    );

    // Cascade graph should be empty (no entries)
    expect(cascadeGraphContent).toContain('CASCADE_GRAPH');
    expect(cascadeGraphContent).not.toContain('"User"');
    expect(cascadeGraphContent).not.toContain('"Post"');

    // User would normally have cascade children, but with cascade=false
    // and uniqueStrategy=none, it should use fast path (updateMany, not softDeleteWithCascade)
    const userDelegate = /function createUserDelegate[\s\S]*?^}/m.exec(runtimeContent);
    expect(userDelegate).not.toBeNull();
    expect(userDelegate![0]).not.toContain('softDeleteWithCascade');
    expect(userDelegate![0]).toContain('original.updateMany');
  }, 60000);

  it('cascade defaults to true (omitted option produces normal cascade graph)', () => {
    const tmpDir = path.join(integrationDir, 'tmp-cascade-default');
    tmpDirs.push(tmpDir);
    fs.mkdirSync(tmpDir, { recursive: true });

    const schemaContent = `
generator client {
  provider = "prisma-client"
  output   = "./generated/client"
}

generator softCascade {
  provider       = "node ${path.join(integrationDir, '..', '..', 'dist', 'bin.js').split(path.sep).join('/')}"
  output         = "./generated/soft-cascade"
  uniqueStrategy = "none"
}

datasource db {
  provider = "sqlite"
}

model User {
  id         String    @id @default(cuid())
  email      String    @unique
  posts      Post[]
  deleted_at DateTime?
}

model Post {
  id         String    @id @default(cuid())
  title      String
  authorId   String
  author     User      @relation(fields: [authorId], references: [id], onDelete: Cascade)
  deleted_at DateTime?
}
`;

    fs.writeFileSync(path.join(tmpDir, 'schema.prisma'), schemaContent, 'utf-8');

    execSync('npx prisma generate', {
      cwd: tmpDir,
      stdio: 'pipe',
      encoding: 'utf-8',
    });

    const cascadeGraphContent = fs.readFileSync(
      path.join(tmpDir, 'generated', 'soft-cascade', 'cascade-graph.ts'),
      'utf-8',
    );
    const runtimeContent = fs.readFileSync(
      path.join(tmpDir, 'generated', 'soft-cascade', 'runtime.ts'),
      'utf-8',
    );

    // Cascade graph should contain User -> Post relationship
    expect(cascadeGraphContent).toContain('"User"');
    expect(cascadeGraphContent).toContain('"Post"');

    // User should use complex path (softDeleteWithCascade) because it has children
    const userDelegate = /function createUserDelegate[\s\S]*?^}/m.exec(runtimeContent);
    expect(userDelegate).not.toBeNull();
    expect(userDelegate![0]).toContain('softDeleteWithCascade');
  }, 60000);
});


describe('Integration: audit codegen compilation', () => {
  it('audit-generated code compiles with --noUnusedLocals', () => {
    const models = [
      createMockModel({
        name: 'User',
        documentation: '/// @audit',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({ name: 'email', type: 'String', isUnique: true }),
          createMockField({ name: 'deleted_at', type: 'DateTime', isRequired: false }),
          createMockField({ name: 'deleted_by', type: 'String', isRequired: false }),
          createMockField({
            name: 'posts',
            type: 'Post',
            kind: 'object',
            isList: true,
            relationName: 'UserPosts',
          }),
        ],
      }),
      createMockModel({
        name: 'Post',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({ name: 'title', type: 'String' }),
          createMockField({ name: 'authorId', type: 'String' }),
          createMockField({
            name: 'author',
            type: 'User',
            kind: 'object',
            relationName: 'UserPosts',
            relationFromFields: ['authorId'],
            relationToFields: ['id'],
            relationOnDelete: 'Cascade',
          }),
          createMockField({ name: 'deleted_at', type: 'DateTime', isRequired: false }),
        ],
      }),
      createMockModel({
        name: 'Webhook',
        documentation: '/// @audit(create, delete)',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({ name: 'url', type: 'String' }),
        ],
      }),
      createMockModel({
        name: 'AuditEvent',
        documentation: '/// @audit-table',
        fields: [
          createMockField({ name: 'id', type: 'String', isId: true }),
          createMockField({ name: 'entity_type', type: 'String' }),
          createMockField({ name: 'entity_id', type: 'String' }),
          createMockField({ name: 'action', type: 'String' }),
          createMockField({ name: 'actor_id', type: 'String', isRequired: false }),
          createMockField({ name: 'event_data', type: 'Json' }),
          createMockField({ name: 'created_at', type: 'DateTime' }),
          createMockField({ name: 'parent_event_id', type: 'String', isRequired: false }),
        ],
      }),
    ];

    const schema = parseDMMF(createMockDMMF(models));
    const cascadeGraph = buildCascadeGraph(schema);
    const auditTable = resolveAuditTableConfig(schema);

    const clientImportPath = '../client/client.js';
    const runtimeContent = emitRuntime(schema, clientImportPath, {
      uniqueStrategy: 'mangle',
      cascadeGraph,
      auditTable,
    });
    const typesContent = emitTypes(schema, clientImportPath);
    const cascadeGraphContent = emitCascadeGraph(cascadeGraph);
    const indexContent = emitIndex(schema);

    const auditDir = path.join(integrationDir, 'generated', 'audit-test');
    fs.mkdirSync(auditDir, { recursive: true });

    const stripTsNocheck = (s: string) => s.replace(/^\/\/ @ts-nocheck\n/m, '');

    try {
      fs.writeFileSync(path.join(auditDir, 'runtime.ts'), stripTsNocheck(runtimeContent), 'utf-8');
      fs.writeFileSync(path.join(auditDir, 'types.ts'), stripTsNocheck(typesContent), 'utf-8');
      fs.writeFileSync(path.join(auditDir, 'cascade-graph.ts'), cascadeGraphContent, 'utf-8');
      fs.writeFileSync(path.join(auditDir, 'index.ts'), stripTsNocheck(indexContent), 'utf-8');

      execSync(
        `npx tsc --noEmit --skipLibCheck --module NodeNext --moduleResolution NodeNext --target ES2022 --noUnusedLocals ${path.join(auditDir, 'index.ts')}`,
        {
          cwd: integrationDir,
          stdio: 'pipe',
          encoding: 'utf-8',
        }
      );
      expect(true).toBe(true);
    } finally {
      fs.rmSync(auditDir, { recursive: true, force: true });
    }
  });
});
