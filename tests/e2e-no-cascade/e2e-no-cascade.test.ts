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
  if (process.env.DATABASE_URL_NO_CASCADE !== undefined) return process.env.DATABASE_URL_NO_CASCADE;
  if (process.env.DATABASE_URL !== undefined) return process.env.DATABASE_URL.replace(/\/[^/]+$/, '/test_no_cascade');
  return 'postgresql://postgres:postgres@localhost:5433/test_no_cascade';
}

describe('E2E No-Cascade: Real database tests', () => {
  beforeAll(async () => {
    // Ensure database exists
    const baseUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5433/postgres';
    const adminPool = new pg.Pool({ connectionString: baseUrl });
    try {
      await adminPool.query('CREATE DATABASE test_no_cascade');
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
  });

  describe('cascade disabled', () => {
    it('softDelete on parent does NOT cascade to children', async () => {
      await safePrisma.user.create({
        data: {
          id: 'u1',
          email: 'parent@test.com',
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

      // cascaded should be empty — no cascade happened
      expect(cascaded).toEqual({});

      // Parent is soft-deleted
      const user = await prisma.user.findUnique({ where: { id: 'u1' } });
      expect(user.deleted_at).not.toBeNull();

      // Children are NOT soft-deleted
      const post = await prisma.post.findUnique({ where: { id: 'p1' } });
      const comment = await prisma.comment.findUnique({ where: { id: 'c1' } });
      expect(post.deleted_at).toBeNull();
      expect(comment.deleted_at).toBeNull();
    });

    it('softDeleteMany on parent does NOT cascade to children', async () => {
      await safePrisma.user.create({
        data: {
          id: 'u1',
          email: 'a@test.com',
          posts: { create: [{ id: 'p1', title: 'Post 1' }] },
        },
      });
      await safePrisma.user.create({
        data: {
          id: 'u2',
          email: 'b@test.com',
          posts: { create: [{ id: 'p2', title: 'Post 2' }] },
        },
      });

      const { count, cascaded } = await safePrisma.user.softDeleteMany({ where: {} });

      expect(count).toBe(2);
      expect(cascaded).toEqual({});

      // Posts are NOT soft-deleted
      const posts = await prisma.post.findMany();
      for (const post of posts) {
        expect(post.deleted_at).toBeNull();
      }
    });

    it('softDelete on mid-level model does NOT cascade to its children', async () => {
      await safePrisma.user.create({
        data: {
          id: 'u1',
          email: 'mid@test.com',
          posts: {
            create: [{
              id: 'p1',
              title: 'Post',
              comments: {
                create: [{ id: 'c1', content: 'Comment' }],
              },
            }],
          },
        },
      });

      await safePrisma.post.softDelete({ where: { id: 'p1' } });

      // Post is soft-deleted
      const post = await prisma.post.findUnique({ where: { id: 'p1' } });
      expect(post.deleted_at).not.toBeNull();

      // Comment is NOT soft-deleted
      const comment = await prisma.comment.findUnique({ where: { id: 'c1' } });
      expect(comment.deleted_at).toBeNull();

      // User is NOT affected
      const user = await prisma.user.findUnique({ where: { id: 'u1' } });
      expect(user.deleted_at).toBeNull();
    });
  });

  describe('basic soft delete still works', () => {
    it('softDelete sets deleted_at', async () => {
      await safePrisma.user.create({
        data: { id: 'u1', email: 'basic@test.com' },
      });

      await safePrisma.user.softDelete({ where: { id: 'u1' } });

      const user = await prisma.user.findUnique({ where: { id: 'u1' } });
      expect(user.deleted_at).not.toBeNull();
    });

    it('findMany filters soft-deleted records', async () => {
      await prisma.user.create({ data: { id: 'u1', email: 'active@test.com' } });
      await prisma.user.create({
        data: { id: 'u2', email: 'deleted@test.com', deleted_at: new Date() },
      });

      const users = await safePrisma.user.findMany();
      expect(users).toHaveLength(1);
      expect(users[0].id).toBe('u1');
    });

    it('softDelete on non-existent record throws P2025', async () => {
      await expect(
        safePrisma.user.softDelete({ where: { id: 'nonexistent' } }),
      ).rejects.toThrow(expect.objectContaining({ code: 'P2025' }));
    });
  });

  describe('transaction support', () => {
    it('softDelete in transaction does NOT cascade', async () => {
      await safePrisma.user.create({
        data: {
          id: 'u1',
          email: 'tx@test.com',
          posts: {
            create: [{ id: 'p1', title: 'Post 1' }],
          },
        },
      });

      await safePrisma.$transaction(async (tx: any) => {
        await tx.user.softDelete({ where: { id: 'u1' } });
      });

      // User is soft-deleted
      const user = await prisma.user.findUnique({ where: { id: 'u1' } });
      expect(user.deleted_at).not.toBeNull();

      // Post is NOT soft-deleted
      const post = await prisma.post.findUnique({ where: { id: 'p1' } });
      expect(post.deleted_at).toBeNull();
    });
  });
});
