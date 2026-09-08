import { readFileSync } from 'fs';
import vm from 'vm';

const stCode = readFileSync(new URL('../js2/miya-worldbook-st.js', import.meta.url), 'utf8');
const testCode = readFileSync(new URL('./worldbook-st-tests.js', import.meta.url), 'utf8');
const mem = {};
const localStorage = {
  getItem: (k) => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: (k) => { delete mem[k]; }
};
const sandbox = { console, localStorage, globalThis: {} };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(stCode, sandbox);
vm.runInContext(testCode, sandbox);
const out = sandbox.MiyaWorldbookSTTests.run();
if (!out.ok) process.exit(1);
