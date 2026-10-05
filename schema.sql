CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin','sales')), active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT DEFAULT '', status TEXT NOT NULL DEFAULT '跟进中', sales_id TEXT NOT NULL REFERENCES users(id), note TEXT DEFAULT '', avatar_url TEXT DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL);
CREATE INDEX IF NOT EXISTS customers_sales_idx ON customers(sales_id);
CREATE INDEX IF NOT EXISTS customers_name_idx ON customers(name);
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT TRUE;
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users(lower(username));
ALTER TABLE customers ADD COLUMN IF NOT EXISTS normalized_name TEXT NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS avatar BYTEA;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS avatar_hash TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS avatar_dhash TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE INDEX IF NOT EXISTS customers_normalized_name_idx ON customers(normalized_name);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS restore_previews (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), payload JSONB NOT NULL, expires_at TIMESTAMPTZ NOT NULL);

