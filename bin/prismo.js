#!/usr/bin/env node

const { runCli } = require("../lib/prismo-dev-scan");

runCli(process.argv.slice(2)).catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exitCode = 1;
});
