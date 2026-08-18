const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repositoryRoot = path.join(__dirname, '..');
const outputIndex = process.argv.indexOf('--output');
const outputPath = outputIndex === -1
  ? path.join(repositoryRoot, 'artifacts', 'docker-stress-result.json')
  : path.resolve(process.cwd(), process.argv[outputIndex + 1] || '');

if (!outputPath || (outputIndex !== -1 && !process.argv[outputIndex + 1])) {
  throw new Error('Usage: node scripts/run-docker-stress.js [--output <result.json>]');
}

const projectName = `llmward-stress-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
const composeArguments = ['compose', '--project-name', projectName, '-f', 'docker-compose.stress.yml'];
const environment = {
  ...process.env,
  LLMWARD_STRESS_ADMIN_KEY: crypto.randomBytes(32).toString('base64url')
};

function run(arguments, options = {}) {
  return spawnSync('docker', arguments, {
    cwd: repositoryRoot,
    env: environment,
    encoding: 'utf8',
    ...options
  });
}

let up;
try {
  up = run([...composeArguments, 'up', '--build', '--abort-on-container-exit', '--exit-code-from', 'stress'], { maxBuffer: 10 * 1024 * 1024 });
  process.stdout.write(up.stdout || '');
  process.stderr.write(up.stderr || '');
} finally {
  const down = run([...composeArguments, 'down', '--volumes', '--remove-orphans']);
  process.stderr.write(down.stderr || '');
}

const marker = '@@LLMWARD_STRESS_RESULT@@';
const markerIndex = (up && up.stdout ? up.stdout : '').indexOf(marker);
if (markerIndex === -1) {
  throw new Error('Docker stress test did not emit a result record');
}
const resultLine = up.stdout.slice(markerIndex + marker.length).split(/\r?\n/, 1)[0];
const result = JSON.parse(resultLine);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`Docker stress result written to ${path.relative(repositoryRoot, outputPath)}\n`);

if (up.status !== 0) process.exitCode = up.status || 1;
