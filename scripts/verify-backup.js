const { verifyDatabase } = require('../db/verify');

const arguments = process.argv.slice(2);
if (arguments.length !== 1) {
  process.stderr.write('Usage: npm run verify-backup -- <restore-copy.db>\n');
  process.exitCode = 1;
} else {
  try {
    const result = verifyDatabase(arguments[0]);
    process.stdout.write(`Backup verified: integrity=${result.integrity} schema=${result.schemaVersion}\n`);
  } catch {
    process.stderr.write('Backup verification failed\n');
    process.exitCode = 1;
  }
}
