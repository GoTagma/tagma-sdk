const code = Number(Bun.argv[2] ?? '1');
const message = Bun.argv.slice(3).join(' ') || `intentional failure with code ${code}`;
console.error(message);
process.exit(code);
