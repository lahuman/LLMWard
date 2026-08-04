const { runMigrations } = require('../db/migrations');
const { createBackup } = require('../services/backup');

runMigrations();
createBackup()
  .then((result) => {
    process.stdout.write(`Backup created: ${result.filename} (integrity: ${result.integrity})\n`);
  })
  .catch((error) => {
    process.stderr.write(`Backup failed: ${error.message}\n`);
    process.exitCode = 1;
  });
