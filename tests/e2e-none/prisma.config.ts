import 'dotenv/config';
import { defineConfig } from 'prisma/config';

function getUrl(): string {
  if (process.env.DATABASE_URL_NONE !== undefined) return process.env.DATABASE_URL_NONE;
  if (process.env.DATABASE_URL !== undefined) return process.env.DATABASE_URL.replace(/\/[^/]+$/, '/test_none');
  return 'postgresql://postgres:postgres@localhost:5433/test_none';
}

export default defineConfig({
  schema: './schema.prisma',
  datasource: {
    url: getUrl(),
  },
});
