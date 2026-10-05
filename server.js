import pg from 'pg';
import { createApp, initialize } from './backend/app.js';
const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) { console.error('DATABASE_URL is required'); process.exit(1); }
const pool = new Pool({ connectionString: databaseUrl, ssl: process.env.DATABASE_SSL === 'true' || process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false, max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
await initialize(pool);
const app = createApp(pool, { production: process.env.NODE_ENV === 'production' });
const port = Number(process.env.PORT || 10000);
app.listen(port, '0.0.0.0', () => console.log(`Customer registry listening on ${port}`));
const stop = async () => { await pool.end(); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);

