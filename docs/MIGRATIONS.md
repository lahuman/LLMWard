# Database migration policy

`runMigrations()` first verifies `PRAGMA integrity_check` and `PRAGMA foreign_key_check`. It refuses to start when either check fails, and rejects a `user_version` newer than the application schema before making any changes.

Before SQLite opens an existing target, startup validates its file type and header. A nonempty WAL is checked with private main/WAL copies in a unique `.llmward-schema-preflight-*` direct child of the database directory. This inherits the protected data-directory ACL on Windows; POSIX additionally applies `0700` to the directory and `0600` to both files. Cleanup removes only that generated directory and fails closed without exposing its path if removal fails.

A missing database path or existing zero-length regular database file is treated as new only when `-wal`, `-shm`, and `-journal` entries are all absent. Startup checks the path and sidecars again immediately before opening it. Any orphaned sidecar, nonregular file, stat error, corrupt nonempty header, or future schema fails closed without creating or deleting database files.

All schema changes, legacy-token migration, index creation, and the schema-version update run together in a `BEGIN IMMEDIATE` transaction. Re-running migration converges on schema version 3 without adding duplicate token records or indexes.

Schema version 3 adds `content_filters`, `content_filter_models`, their cascading foreign keys, and the model lookup index. Upgrading version 2 creates no filter rows, so existing traffic is unchanged. New filters are inactive, non-global, and have no model assignments unless an administrator explicitly changes them.

Legacy plaintext tokens are moved to `user_tokens`, then replaced in `users.api_token` by a `sha256:<hash>` marker while `secure_delete` is enabled. A marker is accepted only when its matching user token record exists; an orphaned marker aborts the migration and rolls back. Plaintext tokens are never retained in the database or WAL after a successful migration.

Startup migrations never run `VACUUM`. Operators may run `VACUUM` manually during a planned maintenance window after a verified backup, because it can hold a long write lock.