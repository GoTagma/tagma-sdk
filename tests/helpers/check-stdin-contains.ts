const expected = Bun.argv.slice(2).join(' ');
if (!expected) {
  console.error('usage: bun tests/helpers/check-stdin-contains.ts <token>');
  process.exit(2);
}

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) {
  chunks.push(Buffer.from(chunk));
}
const input = Buffer.concat(chunks).toString('utf8');

if (input.includes(expected)) {
  process.exit(0);
}

console.error(`stdin did not contain token: ${expected}`);
process.exit(1);
