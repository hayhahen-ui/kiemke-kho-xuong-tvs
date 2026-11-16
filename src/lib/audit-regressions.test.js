import test from 'node:test';
import assert from 'node:assert/strict';
import { getTheoreticalRequirements } from './model.js';
import { createTaskWorkbook, importTaskWorkbook } from './task-workbooks.js';
import ExcelJS from 'exceljs';
const file = (buffer) => ({name:'test.xlsx', arrayBuffer: async () => buffer});
const norm = (warehouseId, code, batchId) => ({warehouseId, materialCode:code, model:'M', color:'RED', productionOrder:'C', sourceOrderQty:100, sourceQuantity:10, batchId});
const base = {productionOrders:[{orderNo:'C', model:'M', color:'RED', productionQty:100}], materials:[], bom:[], importMeta:{}, chemicalNorms:[]};

test('chemical exports do not mix warehouses even when other warehouse has no batch', async () => {
  const data = {...base, chemicalNorms:[norm('HOA_MAU_LAF','LAF-ONLY','a')], importMeta:{'chemical-norms:HOA_MAU_LAF':{batchId:'a'}}};
  const buffer = await createTaskWorkbook('chemical-norms:HOA_MAU_LVF', data);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer);
  assert.equal(wb.getWorksheet('DM-NPL-DH').getRow(6).getCell(11).value, null);
  assert.equal(getTheoreticalRequirements(data,'HOA_MAU_LVF').rows.length, 0);
});
test('manual command mapping cannot join another model or color', () => {
  const data = {...base, productionOrders:[{orderNo:'SRC',model:'OTHER',color:'RED',productionQty:100}], chemicalNorms:[norm('HOA_MAU_LAF','X','a')], orderMappings:[{sourceOrderNo:'SRC',sourceModel:'OTHER',sourceColor:'RED',targetOrderNo:'C'}]};
  assert.equal(getTheoreticalRequirements(data,'HOA_MAU_LAF').rows.length,0);
});
test('manual mapping overrides source command even when a norm exists for source', () => {
  const data = {...base, chemicalNorms:[norm('HOA_MAU_LAF','X','a')], orderMappings:[{sourceOrderNo:'C',sourceModel:'M',sourceColor:'RED',targetOrderNo:'OTHER'}]};
  assert.equal(getTheoreticalRequirements(data,'HOA_MAU_LAF').rows.length,0);
});
test('multi-plant material is not guessed from the order plant', () => {
  const data = {...base, productionOrders:[{...base.productionOrders[0],plant:'LAF'}], materials:[{catalogNo:1,materialCode:'X',plants:['LAF','LVF']}],bom:[{catalogNo:1,model:'M',color:'RED',productKey:'M_RED',rate:1}]};
  const result = getTheoreticalRequirements(data,'LAF'); assert.equal(result.rows.length,0); assert.match(result.unmapped[0].reason,/nhiều nhà máy/);
});
test('missing, unknown or excessive stage quantities are not silently treated as zero', () => {
  const data = {...base, materials:[{catalogNo:1,materialCode:'X',plants:['LAF']}],bom:[{catalogNo:1,model:'M',color:'RED',productKey:'M_RED',rate:1,operation:'Chặt'}]};
  for (const stageQuantities of [{},{LAF_CUT:101}]) {
    const result=getTheoreticalRequirements({...data,productionOrders:[{...data.productionOrders[0],stageQuantities}]},'LAF');
    assert.equal(result.rows.length,0); assert.equal(result.unmapped.length,1);
  }
  const unknown=getTheoreticalRequirements({...data,bom:[{...data.bom[0],operation:'Khác'}]},'LAF');
  assert.equal(unknown.rows.length,0); assert.equal(unknown.unmapped.length,1);
});
test('missing critical progress quantity fails import instead of becoming zero', async () => {
  const wb=new ExcelJS.Workbook(); const sh=wb.addWorksheet('New');
  sh.addRow(['Số PO','Mã hàng','Màu','Số lượng lệnh sản xuất']); sh.addRow(['P','M','RED','']);
  await assert.rejects(importTaskWorkbook('production-orders',file(await wb.xlsx.writeBuffer())),/Thiếu Số lượng lệnh/);
});
test('conflicting product mappings fail import', async () => {
  const wb=new ExcelJS.Workbook(); const sh=wb.addWorksheet('Mapping_Ma_Hang_Mau');
  sh.addRow(['Mã sản phẩm nguồn','Mã hàng nguồn','Tên màu nguồn','Mã hàng BOM','Mã màu BOM']);
  sh.addRow(['SKU','M','RED','M','R1']); sh.addRow(['SKU','M','RED','M','R2']);
  await assert.rejects(importTaskWorkbook('product-mapping',file(await wb.xlsx.writeBuffer())),/xung đột/);
});

test('unknown stage stays blank through production export and import', async () => {
  const data={...base, productionOrders:[{...base.productionOrders[0],purchaseOrder:'P',stageQuantities:{LAF_CUT:null,LVF_SEW:0,LVF_GO:null}}]};
  const out = await createTaskWorkbook('production-orders',data);
  const imported=await importTaskWorkbook('production-orders',file(out));
  assert.equal(imported.productionOrders[0].stageQuantities.LAF_CUT,null);
  assert.equal(imported.productionOrders[0].stageQuantities.LVF_SEW,0);
});

test('production report reads completed stages, not packing or duplicate WIP headers', async () => {
  const wb = new ExcelJS.Workbook(); const sh=wb.addWorksheet('New');
  sh.getCell('U1').value='Số lượng đã sản xuất'; sh.getCell('X1').value='Số lượng đôi dở dang';
  for (const [col, value] of Object.entries({J:'Số PO',N:'Mã hàng',O:'Màu',Q:'Đóng gói',S:'SL đơn hàng',T:'Số lượng lệnh sản xuất',U:'Chặt\nNhóm vật tư : Nhà máy LAF - Hóa mẫu LAF',V:'May\nNhóm vật tư : Nhà máy LVF - Hóa mẫu LVF',W:'Gò\nNhóm vật tư : Nhà máy LVF - Hóa mẫu LVF',X:'Chặt\nNhóm vật tư : Nhà máy LAF - Hóa mẫu LAF',Y:'May\nNhóm vật tư : Nhà máy LVF - Hóa mẫu LVF',Z:'Gò\nNhóm vật tư : Nhà máy LVF - Hóa mẫu LVF'})) sh.getCell(`${col}2`).value=value;
  for (const [col,value] of Object.entries({J:'P',N:'M',O:'RED',Q:'True',S:600,T:500,U:300,V:200,W:100,X:-300,Y:-400,Z:-500})) sh.getCell(`${col}3`).value=value;
  const result=await importTaskWorkbook('production-orders',file(await wb.xlsx.writeBuffer()));
  assert.deepEqual([result.productionOrders[0].stageQuantities.LAF_CUT,result.productionOrders[0].stageQuantities.LVF_SEW,result.productionOrders[0].stageQuantities.LVF_GO],[300,200,100]);
});
