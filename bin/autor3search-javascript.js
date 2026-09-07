#!/usr/bin/env node
import { dispatch } from '../src/cli/main.js'

process.exitCode = await dispatch(process.argv.slice(2), { out: process.stdout, err: process.stderr })
