import 'dotenv/config';
import { defineConfig } from 'prisma/config';

function getUrl(): string {
  if (process.env.DATABASE_URL_SENTINEL !== undefined) return process.env.DATABASE_URL_SENTINEL;
  if (process.env.DATABASE_URL !== undefined) return process.env.DATABASE_URL.replace(/\/[^/]+$/, '/test_sentinel');
  return 'postgresql://postgres:postgres@localhost:5433/test_sentinel';
}

export default defineConfig({
  schema: './schema.prisma',
  datasource: {
    url: getUrl(),
  },
});
