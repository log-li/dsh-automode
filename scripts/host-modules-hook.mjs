// Optional integration-test adapter: resolve host packages from an extracted
// official runtime, without copying or modifying any of its files.
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.DSH_AUTOMODE_TEST_HOST_MODULES;
if (!root) throw new Error('DSH_AUTOMODE_TEST_HOST_MODULES is required');
const parentURL = pathToFileURL(resolve(root, '../package.json')).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@deepseek-ai/')) {
    return nextResolve(specifier, { ...context, parentURL });
  }
  return nextResolve(specifier, context);
} });
