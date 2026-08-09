# Database migration policy

`runMigrations()` first verifies `PRAGMA integrity_check` and `PRAGMA foreign_key_check`. It refuses to start when either check fails, and rejects a `user_version` newer than the application schema before making any changes.

All schema changes, legacy-token migration, index creation, and the schema-version update run together in a `BEGIN IMMEDIATE` transaction. Re-running migration converges on schema version 2 without adding duplicate token records or indexes.

Legacy plaintext tokens are moved to `user_tokens`, then replaced in `users.api_token` by a `sha256:<hash>` marker while `secure_delete` is enabled. A marker is accepted only when its matching user token record exists; an orphaned marker aborts the migration and rolls back. Plaintext tokens are never retained in the database or WAL after a successful migration.

Startup migrations never run `VACUUM`. Operators may run `VACUUM` manually during a planned maintenance window after a verified backup, because it can hold a long write lock.