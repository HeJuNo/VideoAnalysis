// Creates a user, or resets the password and role of an existing one.
// Usage: npm run user:create -- --email coach@example.com --role analyst
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { hashPassword } from '../src/auth.ts';
import { loadDatabasePath } from '../src/config.ts';
import { now, openDb } from '../src/db.ts';

const MIN_PASSWORD_LENGTH = 10;

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    role: { type: 'string', default: 'analyst' },
  },
});
const email = values.email?.trim().toLowerCase();
const role = values.role;
if (!email || !email.includes('@')) fail('Pass --email <address>');
if (role !== 'analyst' && role !== 'tagger') fail('--role must be analyst or tagger');

const password = await promptHidden('Password: ');
if (password.length < MIN_PASSWORD_LENGTH) fail(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
if (process.stdin.isTTY && (await promptHidden('Repeat password: ')) !== password) fail('Passwords do not match');

const db = openDb(loadDatabasePath());
const hash = await hashPassword(password);
const existing = db.prepare('select id from users where email = ?').get(email);
if (existing) {
  db.prepare('update users set password_hash = ?, role = ? where id = ?').run(hash, role, String(existing.id));
  db.prepare('delete from auth_sessions where user_id = ?').run(String(existing.id));
  console.log(`Updated ${email} (${role}); existing sessions signed out.`);
} else {
  db.prepare('insert into users (id, email, password_hash, role, created_at) values (?, ?, ?, ?, ?)').run(
    randomUUID(),
    email,
    hash,
    role,
    now(),
  );
  console.log(`Created ${email} (${role}).`);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Reads a line without echoing it; falls back to a plain line when stdin is piped. */
async function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const rl = createInterface({ input: stdin });
    for await (const line of rl) {
      rl.close();
      return line;
    }
    return '';
  }
  process.stdout.write(question);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  return new Promise((resolve) => {
    let input = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\u0003') process.exit(130);
        if (ch === '\r' || ch === '\n') {
          stdin.off('data', onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write('\n');
          resolve(input);
          return;
        }
        input = ch === '\u007f' || ch === '\b' ? input.slice(0, -1) : input + ch;
      }
    };
    stdin.on('data', onData);
  });
}
