const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const root = process.env.LLM_GATEWAY_SETUP_ROOT
  ? path.resolve(process.env.LLM_GATEWAY_SETUP_ROOT)
  : path.join(__dirname, '..');
const envPath = path.join(root, '.env');
const dataDirectory = path.join(root, 'data');
const backupDirectory = path.join(dataDirectory, 'backups');
let created = false;
let generatedKey;

fs.mkdirSync(backupDirectory, { recursive: true });
if (!fs.existsSync(envPath)) {
  generatedKey = crypto.randomBytes(32).toString('base64url');
  const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  const contents = example.replace(
    /^ADMIN_SECRET_KEY=.*$/m,
    `ADMIN_SECRET_KEY=${generatedKey}`
  );
  fs.writeFileSync(envPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  created = true;
}

fs.accessSync(dataDirectory, fs.constants.R_OK | fs.constants.W_OK);
fs.accessSync(envPath, fs.constants.R_OK);
const values = dotenv.parse(fs.readFileSync(envPath));
for (const name of ['ADMIN_SECRET_KEY']) {
  if (!values[name]) throw new Error(`${name} is required in .env`);
}
const { validateAdminKey } = require('../config');
validateAdminKey(values.ADMIN_SECRET_KEY);

if (created) {
  process.stdout.write('Setup complete. Save this administrator key now; it will not be shown again.\n');
  process.stdout.write(`${generatedKey}\n`);
} else {
  process.stdout.write('Setup complete. Existing .env was preserved; no secrets were displayed.\n');
}
