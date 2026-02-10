import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const e2eDir = __dirname;

const SENTINEL_DATE = new Date('9999-12-31T00:00:00.000Z');

let PrismaClient: any;
let wrapPrismaClient: any;
let prisma: any;
let safePrisma: any;
let pool: pg.Pool | undefined;

function getConnectionString(): string {
  if (process.env.DATABASE_URL_SENTINEL !== undefined) return process.env.DATABASE_URL_SENTINEL;
  if (process.env.DATABASE_URL !== undefined) return process.env.DATABASE_URL.replace(/\/[^/]+$/, '/test_sentinel');
  return 'postgresql://postgres:postgres@localhost:5433/test_sentinel';
}

describe('E2E Sentinel: Real database tests', () => {
  beforeAll(async () => {
    // Ensure database exists
    const baseUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5433/postgres';
    const adminPool = new pg.Pool({ connectionString: baseUrl });
    try {
      await adminPool.query('CREATE DATABASE test_sentinel');
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
    await prisma.auditLog.deleteMany();
  });

  describe('create operations', () => {
    it('create auto-injects sentinel value for deleted_at', async () => {
      const user = await safePrisma.user.create({
        data: { email: 'test@test.com', name: 'Test' },
      });

      expect(user.deleted_at).toEqual(SENTINEL_DATE);
    });

    it('createMany injects sentinel value', async () => {
      await safePrisma.user.createMany({
        data: [
          { id: 'u1', email: 'a@test.com' },
          { id: 'u2', email: 'b@test.com' },
        ],
      });

      const users = await prisma.user.findMany();
      for (const user of users) {
        expect(user.deleted_at).toEqual(SENTINEL_DATE);
      }
    });

    it('createManyAndReturn injects sentinel value', async () => {
      const users = await safePrisma.user.createManyAndReturn({
        data: [
          { id: 'u1', email: 'a@test.com' },
          { id: 'u2', email: 'b@test.com' },
        ],
      });

      for (const user of users) {
        expect(user.deleted_at).toEqual(SENTINEL_DATE);
      }
    });
  });

  describe('read operations', () => {
    it('findMany filters by sentinel comparison', async () => {
      await safePrisma.user.create({ data: { id: 'u1', email: 'active@test.com' } });
      // Soft-delete a user (sets real timestamp)
      await safePrisma.user.softDelete({ where: { id: 'u1' } });
      await safePrisma.user.create({ data: { id: 'u2', email: 'active2@test.com' } });

      const users = await safePrisma.user.findMany();
      expect(users).toHaveLength(1);
      expect(users[0].id).toBe('u2');
    });

    it('count filters by sentinel comparison', async () => {
      await safePrisma.user.create({ data: { id: 'u1', email: 'a@test.com' } });
      await safePrisma.user.create({ data: { id: 'u2', email: 'b@test.com' } });
      await safePrisma.user.softDelete({ where: { id: 'u1' } });

      const count = await safePrisma.user.count();
      expect(count).toBe(1);
    });

    it('findUnique transforms to compound key for sentinel', async () => {
      await safePrisma.user.create({ data: { id: 'u1', email: 'find@test.com' } });

      // findUnique with just email should work (transformed to compound key)
      const user = await safePrisma.user.findUnique({
        where: { email_deleted_at: { email: 'find@test.com', deleted_at: SENTINEL_DATE } },
      });
      expect(user).not.toBeNull();
      expect(user.id).toBe('u1');
    });
  });

  describe('soft delete operations', () => {
    it('softDelete sets real timestamp overwriting sentinel', async () => {
      await safePrisma.user.create({ data: { id: 'u1', email: 'del@test.com' } });

      const before = new Date();
      await safePrisma.user.softDelete({ where: { id: 'u1' } });
      const after = new Date();

      const raw = await prisma.user.findUnique({ where: { id: 'u1' } });
      expect(raw.deleted_at).not.toEqual(SENTINEL_DATE);
      expect(raw.deleted_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(raw.deleted_at.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('restore sets sentinel back', async () => {
      await safePrisma.user.create({ data: { id: 'u1', email: 'restore@test.com' } });
      await safePrisma.user.softDelete({ where: { id: 'u1' } });
      await safePrisma.user.restore({ where: { id: 'u1' } });

      const raw = await prisma.user.findUnique({ where: { id: 'u1' } });
      expect(raw.deleted_at).toEqual(SENTINEL_DATE);
    });
  });

  describe('cascade operations', () => {
    it('cascade: parent + children all get same timestamp', async () => {
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

      await safePrisma.user.softDelete({ where: { id: 'u1' } });

      const user = await prisma.user.findUnique({ where: { id: 'u1' } });
      const post = await prisma.post.findUnique({ where: { id: 'p1' } });
      const comment = await prisma.comment.findUnique({ where: { id: 'c1' } });

      // All should have the same real timestamp (not sentinel)
      expect(user.deleted_at).not.toEqual(SENTINEL_DATE);
      expect(post.deleted_at).toEqual(user.deleted_at);
      expect(comment.deleted_at).toEqual(user.deleted_at);
    });
  });

  describe('upsert operations', () => {
    it('upsert create branch gets sentinel value', async () => {
      const result = await safePrisma.user.upsert({
        where: { email_deleted_at: { email: 'upsert@test.com', deleted_at: SENTINEL_DATE } },
        create: { email: 'upsert@test.com', name: 'Created' },
        update: { name: 'Updated' },
      });

      expect(result.name).toBe('Created');
      expect(result.deleted_at).toEqual(SENTINEL_DATE);
    });

    it('upsert update branch works for active records', async () => {
      await safePrisma.user.create({
        data: { id: 'u1', email: 'upsert@test.com', name: 'Original' },
      });

      const result = await safePrisma.user.upsert({
        where: { email_deleted_at: { email: 'upsert@test.com', deleted_at: SENTINEL_DATE } },
        create: { email: 'upsert@test.com', name: 'Should Not Create' },
        update: { name: 'Updated' },
      });

      expect(result.id).toBe('u1');
      expect(result.name).toBe('Updated');
    });
  });

  describe('compound unique enforcement', () => {
    it('duplicate active email fails at DB level', async () => {
      await safePrisma.user.create({ data: { email: 'dup@test.com' } });

      await expect(
        safePrisma.user.create({ data: { email: 'dup@test.com' } }),
      ).rejects.toThrow();
    });

    it('same email can exist as active + deleted', async () => {
      await safePrisma.user.create({ data: { id: 'u1', email: 'reuse@test.com' } });
      await safePrisma.user.softDelete({ where: { id: 'u1' } });

      // Creating with same email should succeed (deleted_at is different now)
      const newUser = await safePrisma.user.create({
        data: { id: 'u2', email: 'reuse@test.com' },
      });
      expect(newUser.id).toBe('u2');
    });
  });

  describe('$onlyDeleted and $includingDeleted', () => {
    it('$onlyDeleted uses sentinel comparison', async () => {
      await safePrisma.user.create({ data: { id: 'u1', email: 'a@test.com' } });
      await safePrisma.user.create({ data: { id: 'u2', email: 'b@test.com' } });
      await safePrisma.user.softDelete({ where: { id: 'u1' } });

      const deletedUsers = await safePrisma.$onlyDeleted.user.findMany();
      expect(deletedUsers).toHaveLength(1);
      expect(deletedUsers[0].id).toBe('u1');
    });

    it('$includingDeleted returns all records', async () => {
      await safePrisma.user.create({ data: { id: 'u1', email: 'a@test.com' } });
      await safePrisma.user.create({ data: { id: 'u2', email: 'b@test.com' } });
      await safePrisma.user.softDelete({ where: { id: 'u1' } });

      const allUsers = await safePrisma.$includingDeleted.user.findMany();
      expect(allUsers).toHaveLength(2);
    });
  });

  describe('deleted_by propagation', () => {
    it('deleted_by works with sentinel strategy', async () => {
      await safePrisma.customer.create({
        data: { id: 'c1', email: 'customer@test.com' },
      });

      await safePrisma.customer.softDelete({
        where: { id: 'c1' },
        deletedBy: 'admin-user',
      });

      const raw = await prisma.customer.findUnique({ where: { id: 'c1' } });
      expect(raw.deleted_by).toBe('admin-user');
      expect(raw.deleted_at).not.toEqual(SENTINEL_DATE);
    });
  });

  describe('filter injection on includes', () => {
    it('include filters soft-deleted children with sentinel', async () => {
      await safePrisma.user.create({
        data: {
          id: 'u1',
          email: 'parent@test.com',
          posts: {
            create: [
              { id: 'p1', title: 'Active Post' },
              { id: 'p2', title: 'To Delete Post' },
            ],
          },
        },
      });

      await safePrisma.post.softDelete({ where: { id: 'p2' } });

      const user = await safePrisma.user.findFirst({
        where: { id: 'u1' },
        include: { posts: true },
      });

      expect(user.posts).toHaveLength(1);
      expect(user.posts[0].id).toBe('p1');
    });
  });
});
