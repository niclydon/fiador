// Loads node:sqlite through createRequire. Vite/Vitest versions that
// predate node:sqlite in their builtin lists mangle the static
// 'node:sqlite' import (they strip the prefix and look for a package
// named "sqlite"); a runtime require through node:module bypasses that.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sqlite = require('node:sqlite') as typeof import('node:sqlite');

export const DatabaseSync = sqlite.DatabaseSync;
export type DatabaseSync = import('node:sqlite').DatabaseSync;
export default sqlite;
