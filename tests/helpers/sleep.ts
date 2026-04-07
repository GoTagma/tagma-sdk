const ms = Number(Bun.argv[2] ?? '1000');
const message = Bun.argv.slice(3).join(' ');
await Bun.sleep(ms);
if (message) console.log(message);
