const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'v1', 'leads.ts'), 'utf8');

assert.match(source, /async function handlePoolClaim\(/, 'Pool claims must use one shared handler');
assert.match(source, /post\('\/pool\/:poolItemId\/claim', handlePoolClaim\)/, 'Canonical pool claim route is missing');
assert.match(source, /post\('\/:poolItemId\/claim', handlePoolClaim\)/, 'Compatibility claim alias must reuse the canonical handler');
assert.match(source, /where: \{ id: poolItemId, tenantId \}/, 'Pool lookup must be tenant scoped');
assert.match(source, /status: 'OPEN'/, 'Pool reservation must require an open item');
assert.match(source, /activeLeadCount >= maxActiveLeads/, 'Claim must enforce active lead quota');
assert.match(source, /LEAD_POOL_DEDUPLICATED/, 'Claim must link an existing tenant lead instead of duplicating it');

console.log('PASS: central lead pool claim contract');
