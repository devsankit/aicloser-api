const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.ts'), 'utf8');

assert.match(source, /'http:\/\/localhost:3020'/, 'Local refactor UI origin must be allowed');
assert.match(source, /'http:\/\/127\.0\.0\.1:3020'/, '127.0.0.1 refactor UI origin must be allowed');
assert.doesNotMatch(source, /origin:\s*['"]\*['"]/, 'Credentialed CORS must not use wildcard origin');

console.log('PASS: local UI CORS origin contract');
