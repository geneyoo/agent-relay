#!/usr/bin/env node

import { main } from "../src/cli.js";

main(process.argv.slice(2)).catch((error) => {
  const code = error?.code ? `${error.code}: ` : "";
  process.stderr.write(`relay: ${code}${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
