import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const e2eDir = __dirname;

let PrismaClient: any;
let wrapPrismaClient: any;
let prisma: any;
let safePrisma: any;
let pool: pg.Pool | undefined;

function getConnectionString(): string {
  if (process.env.DATABASE_URL_NONE !== undefined) return process.env.DATABASE_URL_NONE;
  if (process.env.DATABASE_URL !== undefined) return process.env.DATABASE_URL.replace(/\/[^/]+$/, '/test_none');
  return 'postgresql://postgres:postgres@localhost:5433/test_none';
}

describe('E2E None: Real database tests', () => {
  beforeAll(async () => {
    // Ensure database exists
    const baseUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5433/postgres';
    const adminPool = new pg.Pool({ connectionString: baseUrl });
    try {
      await adminPool.query('CREATE DATABASE test_none');
    } catch {
      // Already exists
    }
    await adminPool.end();

    // Build the generator
    execSync('pnpm run build', {
      cwd: path.join(e2eDir, '..', '..'),
      stdio: 'pipe',
    });

    // Generate Prisma client and soft-cascade wrapper
    execSync('npx prisma generate', {
      cwd: e2eDir,
      stdio: 'pipe',
      env: {
        ...process.env,
        PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: 'yes',
      },
    });

    // Push schema to create database (resets it)
    execSync('npx prisma db push --force-reset', {
      cwd: e2eDir,
      stdio: 'pipe',
      env: {
        ...process.env,
        PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: 'yes',
      },
    });

    // Dynamically import the generated modules
    const clientModule = await import('./generated/client/client.js');
    PrismaClient = clientModule.PrismaClient;

    const softCascadeModule = await import('./generated/soft-cascade/runtime.js');
    wrapPrismaClient = softCascadeModule.wrapPrismaClient;

    // Create pg pool and Prisma adapter
    const connectionString = getConnectionString();
    pool = new pg.Pool({ connectionString });
    const adapter = new PrismaPg(pool);

    prisma = new PrismaClient({ adapter });
    safePrisma = wrapPrismaClient(prisma);
  }, 120000);

  afterAll(async () => {
    if (prisma !== undefined) {
      await prisma.$disconnect();
    }
    if (pool !== undefined) {
      await pool.end();
    }
  });

  beforeEach(async () => {
    await prisma.comment.deleteMany();
    await prisma.post.deleteMany();
    await prisma.user.deleteMany();
    await prisma.customer.deleteMany();
  });

  describe('soft delete without mangling', () => {
    it('softDelete does NOT mangle unique fields', async () => {
      await safePrisma.user.create({
        data: { id: 'u1', email: 'test@test.com', name: 'Test' },
      });

      await safePrisma.user.softDelete({ where: { id: 'u1' } });

      const raw = await prisma.user.findUnique({ where: { id: 'u1' } });
      expect(raw.email).toBe('test@test.com'); // Not mangled
      expect(raw.deleted_at).not.toBeNull();
    });

    it('creating duplicate unique after soft delete fails (no mangling to free it)', async () => {
      await safePrisma.user.create({
        data: { id: 'u1', email: 'dup@test.com' },
      });
      await safePrisma.user.softDelete({ where: { id: 'u1' } });

      // Same email is still occupied since no mangling happened
      await expect(
        safePrisma.user.create({ data: { id: 'u2', email: 'dup@test.com' } }),
      ).rejects.toThrow();
    });
  });

  describe('restore without unmangling', () => {
    it('restore does NOT unmangle (nothing was mangled)', async () => {
      await safePrisma.user.create({
        data: { id: 'u1', email: 'restore@test.com' },
      });
      await safePrisma.user.softDelete({ where: { id: 'u1' } });
      await safePrisma.user.restore({ where: { id: 'u1' } });

      const raw = await prisma.user.findUnique({ where: { id: 'u1' } });
      expect(raw.email).toBe('restore@test.com'); // Unchanged
      expect(raw.deleted_at).toBeNull();
    });
  });

  describe('filter injection', () => {
    it('findMany filters soft-deleted records', async () => {
      await prisma.user.create({ data: { id: 'u1', email: 'active@test.com' } });
      await prisma.user.create({
        data: { id: 'u2', email: 'deleted@test.com', deleted_at: new Date() },
      });

      const users = await safePrisma.user.findMany();
      expect(users).toHaveLength(1);
      expect(users[0].id).toBe('u1');
    });

    it('count filters soft-deleted records', async () => {
      await prisma.user.create({ data: { id: 'u1', email: 'a@test.com' } });
      await prisma.user.create({
        data: { id: 'u2', email: 'b@test.com', deleted_at: new Date() },
      });

      const count = await safePrisma.user.count();
      expect(count).toBe(1);
    });
  });

  describe('cascade operations', () => {
    it('cascade works normally without mangling', async () => {
      await safePrisma.user.create({
        data: {
          id: 'u1',
          email: 'cascade@test.com',
          posts: {
            create: [
              {
                id: 'p1',
                title: 'Post 1',
                comments: {
                  create: [{ id: 'c1', content: 'Comment 1' }],
                },
              },
            ],
          },
        },
      });

      const { cascaded } = await safePrisma.user.softDelete({ where: { id: 'u1' } });
      expect(cascaded.Post).toBe(1);
      expect(cascaded.Comment).toBe(1);

      // All records should be soft-deleted
      const user = await prisma.user.findUnique({ where: { id: 'u1' } });
      const post = await prisma.post.findUnique({ where: { id: 'p1' } });
      const comment = await prisma.comment.findUnique({ where: { id: 'c1' } });

      expect(user.deleted_at).not.toBeNull();
      expect(post.deleted_at).toEqual(user.deleted_at);
      expect(comment.deleted_at).toEqual(user.deleted_at);
    });

    it('restoreCascade works without unmangling', async () => {
      await safePrisma.user.create({
        data: {
          id: 'u1',
          email: 'restore-cascade@test.com',
          posts: {
            create: [{ id: 'p1', title: 'Post 1' }],
          },
        },
      });

      await safePrisma.user.softDelete({ where: { id: 'u1' } });
      const { cascaded } = await safePrisma.user.restoreCascade({ where: { id: 'u1' } });
      expect(cascaded.Post).toBe(1);

      const user = await prisma.user.findUnique({ where: { id: 'u1' } });
      const post = await prisma.post.findUnique({ where: { id: 'p1' } });
      expect(user.deleted_at).toBeNull();
      expect(post.deleted_at).toBeNull();
    });
  });

  describe('softDeleteMany', () => {
    it('softDeleteMany works without mangling', async () => {
      await safePrisma.user.createMany({
        data: [
          { id: 'u1', email: 'a@test.com' },
          { id: 'u2', email: 'b@test.com' },
        ],
      });

      const { count } = await safePrisma.user.softDeleteMany({
        where: {},
      });
      expect(count).toBe(2);

      const users = await prisma.user.findMany();
      for (const user of users) {
        expect(user.deleted_at).not.toBeNull();
        // Emails should NOT be mangled
        expect(user.email).not.toContain('__deleted_');
      }
    });
  });

  describe('$onlyDeleted and $includingDeleted', () => {
    it('$onlyDeleted returns only deleted records', async () => {
      await prisma.user.create({ data: { id: 'u1', email: 'active@test.com' } });
      await prisma.user.create({
        data: { id: 'u2', email: 'deleted@test.com', deleted_at: new Date() },
      });

      const deleted = await safePrisma.$onlyDeleted.user.findMany();
      expect(deleted).toHaveLength(1);
      expect(deleted[0].id).toBe('u2');
    });

    it('$includingDeleted returns all records', async () => {
      await prisma.user.create({ data: { id: 'u1', email: 'active@test.com' } });
      await prisma.user.create({
        data: { id: 'u2', email: 'deleted@test.com', deleted_at: new Date() },
      });

      const all = await safePrisma.$includingDeleted.user.findMany();
      expect(all).toHaveLength(2);
    });
  });

  describe('deleted_by support', () => {
    it('deleted_by is set on soft delete', async () => {
      await safePrisma.customer.create({
        data: { id: 'c1', email: 'customer@test.com' },
      });

      await safePrisma.customer.softDelete({
        where: { id: 'c1' },
        deletedBy: 'admin',
      });

      const raw = await prisma.customer.findUnique({ where: { id: 'c1' } });
      expect(raw.deleted_by).toBe('admin');
    });
  });
});
