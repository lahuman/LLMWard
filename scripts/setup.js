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
  const temporaryPath = path.join(root, `.env.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporaryPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try {
      fs.linkSync(temporaryPath, envPath);
      created = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      generatedKey = undefined;
    }
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

fs.accessSync(dataDirectory, fs.constants.R_OK | fs.constants.W_OK);
fs.accessSync(envPath, fs.constants.R_OK);
const values = dotenv.parse(fs.readFileSync(envPath));
for (const name of ['ADMIN_SECRET_KEY']) {
  if (!values[name]) throw new Error(`${name} is required in .env`);
}
if (typeof values.ADMIN_SECRET_KEY !== 'string' || values.ADMIN_SECRET_KEY.length < 32) {
  throw new Error('ADMIN_SECRET_KEY must contain at least 32 characters');
}
const normalizedAdminKey = values.ADMIN_SECRET_KEY.toLowerCase();
const placeholders = [
  'change_me', 'changeme', 'example', 'placeholder', 'replace_me', 'your_admin',
  'generate-a-unique', 'admin_secret_key', 'password'
];
if (placeholders.some((placeholder) => normalizedAdminKey.includes(placeholder)) || new Set(values.ADMIN_SECRET_KEY).size < 8) {
  throw new Error('ADMIN_SECRET_KEY must not be weak or an example placeholder');
}

if (created) {
  process.stdout.write('Setup complete. Save this administrator key now; it will not be shown again.\n');
  process.stdout.write(`${generatedKey}\n`);
} else {
  process.stdout.write('Setup complete. Existing .env was preserved; no secrets were displayed.\n');
}
