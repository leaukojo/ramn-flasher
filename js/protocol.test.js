// Unit tests for the pure protocol helpers in protocol.js.
// Run with: npm test  (uses node's built-in test runner, no dependencies).
const test = require('node:test');
const assert = require('node:assert');
const {
  parseIntelHex, getFDCANDLC, getFDCANPadding,
  canIsACK, canIsNACK, parsePageSize, parseExtras,
} = require('./protocol.js');

test('getFDCANDLC maps payload length to FDCAN DLC code', () => {
  assert.strictEqual(getFDCANDLC(8), 8);
  assert.strictEqual(getFDCANDLC(9), 9);
  assert.strictEqual(getFDCANDLC(12), 9);
  assert.strictEqual(getFDCANDLC(13), 0xA);
  assert.strictEqual(getFDCANDLC(16), 0xA);
  assert.strictEqual(getFDCANDLC(20), 0xB);
  assert.strictEqual(getFDCANDLC(24), 0xC);
  assert.strictEqual(getFDCANDLC(32), 0xD);
  assert.strictEqual(getFDCANDLC(48), 0xE);
  assert.strictEqual(getFDCANDLC(64), 0xF);
});

test('getFDCANPadding: payloads <=8 get NO padding (padding corrupts slcan)', () => {
  for (let len = 0; len <= 8; len++) assert.strictEqual(getFDCANPadding(len), '');
});

test('getFDCANPadding pads 9..64 to the next valid FDCAN slot', () => {
  assert.strictEqual(getFDCANPadding(9), '000000');        // -> 12 bytes (3 pad)
  assert.strictEqual(getFDCANPadding(12), '');             // exact slot
  assert.strictEqual(getFDCANPadding(13), '000000');       // -> 16
  assert.strictEqual(getFDCANPadding(16), '');
  assert.strictEqual(getFDCANPadding(17), '000000');       // -> 20
  assert.strictEqual(getFDCANPadding(25), '00'.repeat(7)); // -> 32
  assert.strictEqual(getFDCANPadding(33), '00'.repeat(15));// -> 48
  assert.strictEqual(getFDCANPadding(64), '');
});

test('canIsACK / canIsNACK match the exact slcan response strings', () => {
  assert.strictEqual(canIsACK('1t031179', 0x31), true);
  assert.strictEqual(canIsACK('1t03111f', 0x31), false);
  assert.strictEqual(canIsNACK('1t03111f', 0x31), true);
  assert.strictEqual(canIsNACK('1t031179', 0x31), false);
  assert.strictEqual(canIsACK('1t044179', 0x44), true);   // erase cmd
  assert.strictEqual(canIsACK('garbage', 0x31), false);
});

test('parseIntelHex decodes extended-linear-address + data records into a compact buffer', () => {
  const hex = [
    ':020000040800F2',     // type 04: base = 0x08000000
    ':04000000DEADBEEF00',  // type 00: 4 data bytes at 0x0000 (checksum byte ignored)
    ':00000001FF',          // type 01: EOF
  ].join('\n');
  const buf = parseIntelHex(hex);
  assert.deepStrictEqual([...new Uint8Array(buf)], [0xDE, 0xAD, 0xBE, 0xEF]);
});

test('parseIntelHex throws when there are no data records', () => {
  assert.throws(() => parseIntelHex(':00000001FF'), /No data records/);
});

test('parsePageSize reads the STM32 DfuSe alt-name memory map', () => {
  const altName = '@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg';
  assert.strictEqual(parsePageSize(altName, 0x08000000), 16 * 1024); // first 64K region
  assert.strictEqual(parsePageSize(altName, 0x08010000), 64 * 1024); // next region
  assert.strictEqual(parsePageSize(altName, 0x08020000), 128 * 1024);
  assert.strictEqual(parsePageSize(altName, 0x09000000), null);      // out of range
  assert.strictEqual(parsePageSize('no slash here', 0x08000000), null);
});

test('parseExtras finds a DFU functional descriptor inside an extras blob', () => {
  // bLength=9, bDescriptorType=0x21, bmAttr=0x0B, wDetach=0x00FF,
  // wTransferSize=0x0400 (1024), bcdDFU=0x011A
  const bytes = [0x09, 0x21, 0x0B, 0xFF, 0x00, 0x00, 0x04, 0x1A, 0x01];
  const ab = new Uint8Array(bytes).buffer;
  const fd = parseExtras(ab);
  assert.strictEqual(fd.wTransferSize, 1024);
  assert.strictEqual(fd.bmAttr, 0x0B);
  assert.strictEqual(fd.bcdDFU, 0x011A);
});

test('parseExtras returns null when no descriptor is present', () => {
  assert.strictEqual(parseExtras(new Uint8Array([0, 1, 2, 3]).buffer), null);
  assert.strictEqual(parseExtras(null), null);
});
