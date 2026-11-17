import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importTaskWorkbook } from '../src/lib/task-workbooks.js';
import { readWorkshopCounts, readMaterialIssueWorkbook, readBomDemandWorkbook } from '../src/lib/inventory-snapshot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const realDataDir = path.resolve(rootDir, '..', 'DU LIEU THAT');
const publicDir = path.resolve(rootDir, 'public');

function fileFromDisk(filePath, name) {
  const buf = fs.readFileSync(filePath);
  return {
    name: name || path.basename(filePath),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

async function main() {
  fs.mkdirSync(publicDir, { recursive: true });

  const tdPath = path.join(realDataDir, 'TIEN-DO-SX-DONHANG.xlsx');
  const hmPath = path.join(realDataDir, 'DM-MATHANG-HOAMAU LAF-CANLUYEN.xlsx');
  const wbPath = path.join(realDataDir, 'Mau_01_Thong_Ke_Xuong_Doi_Chieu_Kiem_Ke-v4_tu_dong_phan_bo_theo_nha_may_da_sua_loi.xlsx');
  const poIssuePath = path.join(realDataDir, 'chi tiet vat tu thuc xuat theo so po.xlsx');
  const bomDemandPath = path.join(realDataDir, 'DM NHU CAU THEO BOM.xlsx');

  const td = await importTaskWorkbook('production-orders', fileFromDisk(tdPath, 'TIEN-DO-SX-DONHANG.xlsx'));
  const hm = await importTaskWorkbook('chemical-norms:HOA_MAU_LAF', fileFromDisk(hmPath, 'DM-MATHANG-HOAMAU LAF-CANLUYEN.xlsx'));
  const wb = await importTaskWorkbook('workshop-bundle', fileFromDisk(wbPath, 'Mau_01_Thong_Ke_Xuong_Doi_Chieu_Kiem_Ke.xlsx'));
  const invHm = await importTaskWorkbook('inventory:HOA_MAU', fileFromDisk(wbPath, 'Mau_01_Thong_Ke_Xuong_Doi_Chieu_Kiem_Ke.xlsx'));
  const invLaf = await importTaskWorkbook('inventory:LAF', fileFromDisk(wbPath, 'Mau_01_Thong_Ke_Xuong_Doi_Chieu_Kiem_Ke.xlsx'));
  const invLvf = await importTaskWorkbook('inventory:LVF', fileFromDisk(wbPath, 'Mau_01_Thong_Ke_Xuong_Doi_Chieu_Kiem_Ke.xlsx'));
  const counts = await readWorkshopCounts(fileFromDisk(wbPath, 'Mau_01_Thong_Ke_Xuong_Doi_Chieu_Kiem_Ke.xlsx'));
  const poIssues = fs.existsSync(poIssuePath) ? await readMaterialIssueWorkbook(fileFromDisk(poIssuePath, 'chi tiet vat tu thuc xuat theo so po.xlsx')) : { rows: [] };
  const bomDemand = fs.existsSync(bomDemandPath)
    ? await readBomDemandWorkbook(fileFromDisk(bomDemandPath, 'DM NHU CAU THEO BOM.xlsx'), { workshopCounts: counts.rows, materialIssues: poIssues.rows, materials: wb.materials })
    : { rows: [] };

  const nowIso = '2026-11-16T04:00:00.000Z';
  const prodBatchId = 'real-prod-v1';
  const hmLafBatchId = 'real-hmlaf-v1';

  const productionOrders = td.productionOrders.map((row) => ({ ...row, batchId: prodBatchId }));

  // Dictionary-encode chemicalNorms for compact network transfer
  const stringPool = [];
  const stringMap = new Map();
  const intern = (str) => {
    const s = String(str ?? '');
    if (!stringMap.has(s)) {
      stringMap.set(s, stringPool.length);
      stringPool.push(s);
    }
    return stringMap.get(s);
  };

  const chemColumns = [
    'warehouseId', 'purchaseOrder', 'model', 'colorCode', 'color',
    'productionOrder', 'component', 'formulaName', 'materialGroup',
    'materialCode', 'materialName', 'materialColor', 'unit', 'specification', 'operation', 'sourceFile',
  ];
  const chemNumeric = [
    'sourceOrderQty', 'batchWeight', 'materialWeight', 'ratio', 'sourceQuantity', 'sourceRow',
  ];

  const allNormRows = [...hm.chemicalNorms, ...bomDemand.rows];
  const encodedChemicalNorms = allNormRows.map((row) => [
    ...chemColumns.map((k) => intern(row[k])),
    ...chemNumeric.map((k) => Number(row[k]) || 0),
  ]);

  const bundle = {
    version: 2,
    generatedAt: nowIso,
    materials: wb.materials,
    bom: wb.bom,
    norms: wb.norms,
    orders: [],
    productionOrders,
    productMappings: [],
    orderMappings: [],
    inventory: {
      ...invHm.inventory,
      ...invLaf.inventory,
      ...invLvf.inventory,
    },
    workshopCounts: counts,
    materialIssues: poIssues.rows,
    importMeta: {
      'production-orders': {
        taskId: 'production-orders',
        batchId: prodBatchId,
        sourceFile: 'TIEN-DO-SX-DONHANG.xlsx',
        importedAt: nowIso,
        rowCount: productionOrders.length,
      },
      'chemical-norms:HOA_MAU_LAF': {
        taskId: 'chemical-norms:HOA_MAU_LAF',
        batchId: hmLafBatchId,
        sourceFile: 'DM-MATHANG-HOAMAU LAF-CANLUYEN.xlsx',
        importedAt: nowIso,
        rowCount: hm.chemicalNorms.length,
      },
      ...['HOA_MAU_LVF', 'LAF', 'LVF'].reduce((acc, whId) => {
        const count = bomDemand.rows.filter((r) => r.warehouseId === whId).length;
        if (count > 0) {
          acc[`chemical-norms:${whId}`] = {
            taskId: `chemical-norms:${whId}`,
            batchId: hmLafBatchId,
            sourceFile: 'DM NHU CAU THEO BOM.xlsx',
            importedAt: nowIso,
            rowCount: count,
          };
        }
        return acc;
      }, {}),
      'workshop-bundle': {
        taskId: 'workshop-bundle',
        sourceFile: 'Mau_01_Thong_Ke_Xuong_Doi_Chieu_Kiem_Ke-v4_tu_dong_phan_bo_theo_nha_may_da_sua_loi.xlsx',
        importedAt: nowIso,
        rowCount: wb.materials.length + wb.bom.length + wb.norms.length,
      },
    },
    compactChemical: {
      batchId: hmLafBatchId,
      stringPool,
      chemColumns,
      chemNumeric,
      rows: encodedChemicalNorms,
    },
  };

  const outPath = path.join(publicDir, 'real-data-bundle.json');
  const json = JSON.stringify(bundle);
  fs.writeFileSync(outPath, json, 'utf8');
  console.log(`Wrote ${outPath} (${(json.length / 1024 / 1024).toFixed(2)} MB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
