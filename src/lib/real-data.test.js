import test from 'node:test';
import assert from 'node:assert/strict';
import { unpackRealDataBundle } from './real-data.js';
import { calculateInventorySnapshot, compareSnapshotCounts } from './inventory-snapshot.js';
import { keyFor } from './cloud.js';

test('unpackRealDataBundle unpacks compactChemical tuples and calculates 4-warehouse snapshots', () => {
  const syntheticBundle = {
    materials: [
      { catalogNo: 1, materialCode: 'MAT-LAF', name: 'Vải mẫu LAF', unit: 'mét', plants: ['LAF'] },
      { catalogNo: 2, materialCode: 'MAT-LVF', name: 'Chỉ mẫu LVF', unit: 'CUỘN', plants: ['LVF'] },
    ],
    bom: [
      { catalogNo: 1, model: 'MODEL-A', color: 'BLK', productKey: 'MODEL-A_BLK', rate: 0.5, plant: 'LAF', operation: 'Chặt' },
      { catalogNo: 2, model: 'MODEL-A', color: 'BLK', productKey: 'MODEL-A_BLK', rate: 0.2, plant: 'LVF', operation: 'May' },
    ],
    productionOrders: [
      {
        orderNo: 'DEMO-01',
        purchaseOrder: 'PO-DEMO-1',
        model: 'MODEL-A',
        color: 'BLK',
        plannedQty: 100,
        productionQty: 100,
        stageQuantities: { LAF_CUT: 40, LVF_SEW: 30, LVF_GO: 10 },
      },
    ],
    workshopCounts: {
      rows: [
        { warehouseId: 'HOA_MAU_LAF', materialCode: 'CHEM-1', materialName: 'Hóa chất mẫu', unit: 'KÍ', quantity: 10 },
        { warehouseId: 'LAF', materialCode: 'MAT-LAF', materialName: 'Vải mẫu LAF', unit: 'mét', quantity: 25 },
      ],
    },
    materialIssues: [
      { warehouseId: 'HOA_MAU_LAF', po: 'PO-DEMO-1', materialCode: 'CHEM-1', materialName: 'Hóa chất mẫu', unit: 'KÍ', issuedQty: 15 },
    ],
    compactChemical: {
      batchId: 'batch-demo',
      stringPool: ['HOA_MAU_LAF', 'DEMO-01', 'MODEL-A', 'BLK', 'CHEM-1', 'Hóa chất mẫu', 'KÍ'],
      chemColumns: ['warehouseId', 'productionOrder', 'model', 'color', 'materialCode', 'materialName', 'unit'],
      chemNumeric: ['sourceOrderQty', 'sourceQuantity'],
      rows: [[0, 1, 2, 3, 4, 5, 6, 100, 20]],
    },
  };

  const data = unpackRealDataBundle(syntheticBundle);
  assert.equal(data.productionOrders.length, 1);
  assert.equal(data.chemicalNorms.length, 1);
  assert.equal(data.chemicalNorms[0].batchId, 'batch-demo');
  assert.equal(data.materialIssues.length, 1);

  const hmLaf = calculateInventorySnapshot(data, 'HOA_MAU_LAF', { mode: 'planned' });
  assert.equal(hmLaf.stage, 'Chặt');
  assert.equal(hmLaf.summary.length, 1);
  assert.equal(hmLaf.summary[0].quantity, 12);

  const xuongLaf = calculateInventorySnapshot(data, 'LAF', { mode: 'planned' });
  assert.equal(xuongLaf.summary.length, 1);
  assert.equal(xuongLaf.summary[0].quantity, 30);

  const cmpLaf = compareSnapshotCounts(xuongLaf, data.workshopCounts.rows, 'LAF');
  assert.equal(cmpLaf[0].actual, 25);
  assert.equal(cmpLaf[0].variance, -5);

  const lvfMay = calculateInventorySnapshot(data, 'LVF', { mode: 'planned', lvfStage: 'may' });
  assert.equal(lvfMay.stage, 'May');
  assert.equal(lvfMay.summary[0].quantity, 14);
});

test('cloud keyFor distinguishes BOM warehouseId/operation/supplyRoute and supports counts and issues', () => {
  const k1 = keyFor('bom', { catalogNo: 1, plant: 'LVF', warehouseId: 'LVF', productKey: 'M_C', operation: 'May', supplyRoute: 'A' });
  const k2 = keyFor('bom', { catalogNo: 1, plant: 'LVF', warehouseId: 'LVF', productKey: 'M_C', operation: 'Gò', supplyRoute: 'A' });
  assert.notEqual(k1, k2);
  assert.equal(keyFor('workshop_count', { warehouseId: 'LAF', materialCode: '001', unit: 'mét' }), 'LAF|001|mét');
  assert.equal(keyFor('material_issue', { warehouseId: 'HOA_MAU_LAF', po: 'PO1', stage: 'CÁN VẢI', materialCode: '002', unit: 'KÍ' }), 'HOA_MAU_LAF|PO1|CÁN VẢI|002|KÍ');
});
