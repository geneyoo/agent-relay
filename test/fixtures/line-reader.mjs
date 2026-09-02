import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  process.stdout.write(`RECEIVED:${line}\n`);
});
