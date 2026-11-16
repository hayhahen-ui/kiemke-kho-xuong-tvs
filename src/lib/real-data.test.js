import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unpackRealDataBundle } from './real-data.js';
import { calculateInventorySnapshot, compareSnapshotCounts } from './inventory-snapshot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.resolve(__dirname, '../../public/real-data-bundle.json');

test('real-data-bundle.json unpacks and computes all 4 warehouses accurately', () => {
  const raw = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
  const data = unpackRealDataBundle(raw);

  assert.ok(data.productionOrders.length > 200);
  assert.ok(data.chemicalNorms.length > 20000);
  assert.ok(data.materials.length > 350);
  assert.ok(data.workshopCounts?.rows?.length > 50);

  const hmLaf = calculateInventorySnapshot(data, 'HOA_MAU_LAF', { mode: 'planned' });
  assert.equal(hmLaf.stage, 'Chặt');
  assert.equal(hmLaf.summary.length, 96);

  const xuongLaf = calculateInventorySnapshot(data, 'LAF', { mode: 'planned' });
  assert.equal(xuongLaf.stage, 'Chặt');
  assert.equal(xuongLaf.summary.length, 2);

  const cmpLaf = compareSnapshotCounts(xuongLaf, data.workshopCounts.rows, 'LAF');
  assert.equal(cmpLaf.length, 15);

  const lvfMay = calculateInventorySnapshot(data, 'LVF', { mode: 'planned', lvfStage: 'may' });
  assert.equal(lvfMay.stage, 'May');
  assert.equal(lvfMay.summary.length, 3);

  const lvfGo = calculateInventorySnapshot(data, 'LVF', { mode: 'planned', lvfStage: 'go' });
  assert.equal(lvfGo.stage, 'Gò');
  assert.equal(lvfGo.summary.length, 3);
});
