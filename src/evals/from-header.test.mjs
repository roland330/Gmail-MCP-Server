/**
 * Regression test: RFC 2047 encoding of the From display name.
 *
 * Roland 2026-08-10: 4 of 7 open drafts had "Roland VojkovskÃ½" in From —
 * createEmailMessage() wrote raw UTF-8 bytes into the header. Run with:
 *   node src/evals/from-header.test.mjs
 * (build first: npx tsc)
 */
import assert from 'node:assert';
import { createEmailMessage, encodeAddressHeader } from '../../dist/utl.js';

let failed = 0;
function check(label, actual, expected) {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got:      ${actual}\n      expected: ${expected}`);
}

// 1. non-ASCII display name → RFC 2047 encoded-word, no quotes
check(
    'non-ASCII display name',
    encodeAddressHeader('"Roland Vojkovský" <roland@increaseo.sk>'),
    '=?UTF-8?B?Um9sYW5kIFZvamtvdnNrw70=?= <roland@increaseo.sk>'
);

// 2. pure ASCII → untouched (no behaviour change)
check(
    'ASCII display name untouched',
    encodeAddressHeader('"Roland Vojkovsky" <roland@increaseo.sk>'),
    '"Roland Vojkovsky" <roland@increaseo.sk>'
);

// 3. bare address / 'me' → untouched
check('bare address', encodeAddressHeader('roland@increaseo.sk'), 'roland@increaseo.sk');
check('me fallback', encodeAddressHeader('me'), 'me');

// 4. unquoted non-ASCII display name
check(
    'unquoted non-ASCII name',
    encodeAddressHeader('Henrietta Vojkovská <henka@increaseo.sk>'),
    '=?UTF-8?B?SGVucmlldHRhIFZvamtvdnNrw6E=?= <henka@increaseo.sk>'
);

// 5. long non-ASCII name → multiple encoded-words, each ≤ 75 chars
const longEncoded = encodeAddressHeader(
    '"Roland Vojkovský Increaseo Ďalšie Dlhé Meno Sem Ešte Viac Znakov" <roland@increaseo.sk>'
);
const words = longEncoded.slice(0, longEncoded.lastIndexOf('<')).trim().split(' ');
const tooLong = words.filter(w => w.length > 75);
check('long name: every encoded-word ≤75 chars', String(tooLong.length), '0');
check(
    'long name: round-trips to original',
    words.map(w => Buffer.from(w.slice(10, -2), 'base64').toString('utf8')).join(''),
    'Roland Vojkovský Increaseo Ďalšie Dlhé Meno Sem Ešte Viac Znakov'
);

// 6. end-to-end: the actual header line produced by createEmailMessage()
process.env.GMAIL_FROM = '"Roland Vojkovský" <roland@increaseo.sk>';
const raw = createEmailMessage({
    to: ['andrej.vanco@at-industry.com'],
    subject: 'Onpage SEO šprint – podklady',
    body: 'Dobrý deň,\n\nposielam podklady.\n\nPekný deň,\nRoland',
    mimeType: 'text/plain',
});
const fromLine = raw.split('\r\n').find(l => l.startsWith('From: '));
check(
    'createEmailMessage From line',
    fromLine,
    'From: =?UTF-8?B?Um9sYW5kIFZvamtvdnNrw70=?= <roland@increaseo.sk>'
);
const asciiOnlyHeaders = !/[^\x00-\x7F]/.test(raw.split('\r\n\r\n')[0]);
check('header block is 7-bit clean', String(asciiOnlyHeaders), 'true');
console.log('\nFrom: ' + fromLine);
console.log('Subject: ' + raw.split('\r\n').find(l => l.startsWith('Subject: ')));
console.log(failed === 0 ? '\nALL TESTS PASSED' : `\n${failed} TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
