#!/usr/bin/env node
import { runCli } from "./cli/app.js";
import { buildRealContext } from "./cli/context.js";

await runCli(process.argv.slice(2), buildRealContext());
