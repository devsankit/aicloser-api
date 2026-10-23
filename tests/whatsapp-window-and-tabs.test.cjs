const assert = require('assert');
const fs = require('fs');
const path = require('path');

// 1. Static Contract Analysis of conversations.ts
const convRouteSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'v1', 'conversations.ts'),
  'utf8'
);

console.log('=== WhatsApp 24-Hour Window & Tabs Contract Verification ===\n');

// Test 1: Empty chat exclusion
console.log('Test 1: Verify empty 0-message conversation exclusion when includeEmpty is not set');
assert.match(
  convRouteSource,
  /shouldExcludeEmpty\s*=\s*includeEmpty\s*!==\s*'true'\s*&&\s*includeEmpty\s*!==\s*'1'/,
  'includeEmpty flag logic must default to excluding empty conversations'
);
assert.match(
  convRouteSource,
  /NOT:\s*\[\{\s*payload:\s*\{\s*path:\s*\['messages'\],\s*equals:\s*\[\]\s*\}\s*\}\]/,
  'andConditions must exclude conversations with empty messages array'
);
console.log('  PASS: Empty chat exclusion verified.\n');

// Test 2: Strict Tab Isolation (QR_SCANNER vs OFFICIAL_API)
console.log('Test 2: Verify Strict Tab Isolation (QR_SCANNER vs OFFICIAL_API)');
assert.match(
  convRouteSource,
  /if\s*\(sourceType\s*===\s*'OFFICIAL_API'\)\s*\{\s*andConditions\.push\(\{\s*serviceSlug:\s*\{\s*not:\s*'manual-chat'\s*\}\s*\}\);/,
  'OFFICIAL_API must strictly filter out manual-chat (serviceSlug != manual-chat)'
);
assert.match(
  convRouteSource,
  /else\s*if\s*\(sourceType\s*===\s*'QR_SCANNER'\)\s*\{\s*andConditions\.push\(\{\s*serviceSlug:\s*'manual-chat'\s*\}\);/,
  'QR_SCANNER must strictly filter to manual-chat (serviceSlug == manual-chat)'
);
console.log('  PASS: Strict tab isolation verified.\n');

// Test 3: calculate24HourWindow logic implementation
console.log('Test 3: Verify calculate24HourWindow function implementation');
assert.match(
  convRouteSource,
  /export function calculate24HourWindow\(/,
  'calculate24HourWindow must be exported'
);
assert.match(
  convRouteSource,
  /if\s*\(serviceSlug\s*===\s*'manual-chat'\)\s*\{\s*return\s*\{\s*is24HourWindowOpen:\s*true,/,
  'Personal QR manual-chat must be unrestricted (is24HourWindowOpen: true)'
);
assert.match(
  convRouteSource,
  /lastInboundTime\s*=\s*t;/,
  'Official API must track latest inbound message from customer'
);
assert.match(
  convRouteSource,
  /const\s*WINDOW_MS\s*=\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000;/,
  'Window duration must be 24 hours'
);
console.log('  PASS: calculate24HourWindow contract verified.\n');

// Test 4: Rejection of free-form messages outside 24h window
console.log('Test 4: Verify free-form message rejection with HTTP 400 Meta24HourWindowClosed');
assert.match(
  convRouteSource,
  /error:\s*'Meta24HourWindowClosed'/,
  'Endpoint must return error: Meta24HourWindowClosed'
);
assert.match(
  convRouteSource,
  /res\.status\(400\)\.json\(\{\s*success:\s*false,\s*error:\s*'Meta24HourWindowClosed'/,
  'Endpoint must respond with HTTP 400 when 24h window is closed'
);
console.log('  PASS: Meta24HourWindowClosed rejection contract verified.\n');

// Test 5: Template dispatch via body.templateName
console.log('Test 5: Verify template dispatch via body.templateName');
assert.match(
  convRouteSource,
  /const\s*isTemplateMessage\s*=\s*Boolean\(body\.templateName\s*&&\s*body\.templateName\.trim\(\)\.length\s*>\s*0\);/,
  'Must detect template message from body.templateName'
);
assert.match(
  convRouteSource,
  /type:\s*'template',\s*template:\s*\{\s*name:\s*body\.templateName/,
  'Must construct template payload with template name'
);
console.log('  PASS: Template dispatch verified.\n');

// 2. Functional Unit Test of calculate24HourWindow via compiled dist
console.log('Test 6: Functional execution of calculate24HourWindow');
try {
  const { calculate24HourWindow } = require('../dist/routes/v1/conversations.js');
  
  // 6a. Personal QR chat: unrestricted
  const qrRes = calculate24HourWindow({ serviceSlug: 'manual-chat' });
  assert.strictEqual(qrRes.is24HourWindowOpen, true, 'Personal QR must always have window open');
  assert.strictEqual(qrRes.lastInboundAt, null);

  // 6b. Official API: no inbound messages
  const noInboundRes = calculate24HourWindow({
    serviceSlug: 'whatsapp-cloud',
    payload: { messages: [] },
  });
  assert.strictEqual(noInboundRes.is24HourWindowOpen, false, 'No inbound messages must have window closed');

  // 6c. Official API: outbound only messages
  const outboundOnlyRes = calculate24HourWindow({
    serviceSlug: 'whatsapp-cloud',
    payload: {
      messages: [
        { fromMe: true, text: 'Hello', createdAt: new Date().toISOString() },
        { senderRole: 'sales', text: 'Hi', createdAt: new Date().toISOString() },
      ],
    },
  });
  assert.strictEqual(outboundOnlyRes.is24HourWindowOpen, false, 'Outbound only messages must not open window');

  // 6d. Official API: customer inbound 1 hour ago
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recentInboundRes = calculate24HourWindow({
    serviceSlug: 'whatsapp-cloud',
    payload: {
      messages: [
        { fromMe: false, senderRole: 'customer', text: 'Interested!', createdAt: oneHourAgo },
      ],
    },
  });
  assert.strictEqual(recentInboundRes.is24HourWindowOpen, true, 'Recent inbound must have window open');
  assert.ok(recentInboundRes.windowExpiresAt, 'windowExpiresAt must be defined');

  // 6e. Official API: customer inbound 25 hours ago
  const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  const expiredInboundRes = calculate24HourWindow({
    serviceSlug: 'whatsapp-cloud',
    payload: {
      messages: [
        { fromMe: false, senderRole: 'customer', text: 'Old inquiry', createdAt: twentyFiveHoursAgo },
      ],
    },
  });
  assert.strictEqual(expiredInboundRes.is24HourWindowOpen, false, 'Expired inbound must have window closed');

  console.log('  PASS: Functional execution of calculate24HourWindow all 5 scenarios passed!\n');
} catch (err) {
  console.error('  FAIL in functional test:', err);
  process.exit(1);
}

console.log('✅ ALL WHATSAPP 24-HOUR WINDOW & TABS VERIFICATION TESTS PASSED!\n');
