import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { calculateInventorySnapshot, readIssuedWorkbook, createSnapshotWorkbook, normalizeMaterialNameKey, mergeRowsByMaterialName } from './inventory-snapshot.js';
const orders=[
  {orderNo:'ĐH09',model:'C',color:'1',plannedQty:600,productionQty:600,stageQuantities:{LAF_CUT:300,LVF_SEW:300,LVF_GO:100}},
  {orderNo:'ĐH10',model:'A',color:'2',plannedQty:600,productionQty:600,stageQuantities:{LAF_CUT:100,LVF_SEW:100,LVF_GO:0}},
];
const data={productionOrders:orders,chemicalNorms:[
  {warehouseId:'HOA_MAU_LAF',productionOrder:'ĐH09',model:'C',color:'1',sourceOrderQty:600,sourceQuantity:120,materialCode:'CHEM',materialName:'Hóa chất',unit:'kg'},
  {warehouseId:'HOA_MAU_LAF',productionOrder:'ĐH10',model:'A',color:'2',sourceOrderQty:600,sourceQuantity:60,materialCode:'CHEM',materialName:'Hóa chất',unit:'kg'},
],materials:[{catalogNo:1,materialCode:'MAT',name:'Vật tư',unit:'m',plants:['LAF']},{catalogNo:2,materialCode:'MAT2',name:'Vật tư LVF',unit:'cái',plants:['LVF']}],bom:[
  {catalogNo:1,model:'C',color:'1',productKey:'C_1',rate:.2,plant:'LAF'},
  {catalogNo:1,model:'A',color:'2',productKey:'A_2',rate:.1,plant:'LAF'},
  {catalogNo:2,model:'C',color:'1',productKey:'C_1',rate:1,plant:'LVF'},
],importMeta:{}};
const issued=orders.flatMap(o=>['HOA_MAU_LAF','LAF','LVF'].map(warehouseId=>({warehouseId,orderNo:o.orderNo,model:o.model,color:o.color,quantity:600})));

test('example unfinished orders scale chemical LAF and factory LAF from 300 and 500 pairs',()=>{
  const chem=calculateInventorySnapshot(data,'HOA_MAU_LAF',{mode:'issued',issuedRows:issued});
  assert.deepEqual(chem.rows.map(r=>r.basisQty),[300,500]); assert.equal(chem.summary[0].quantity,110);
  const factory=calculateInventorySnapshot(data,'LAF',{mode:'issued',issuedRows:issued});
  assert.equal(factory.summary[0].quantity,110); assert.equal(factory.rows[0].qty,600); assert.equal(factory.rows[0].done,300);
});
test('factory LVF uses Gò, not Chặt or May',()=>{
  const result=calculateInventorySnapshot(data,'LVF',{mode:'issued',issuedRows:issued});
  assert.equal(result.rows[0].basisQty,500); assert.equal(result.rows[0].stage,'Gò');
});
test('explicit selection required; missing or excessive progress is reported',()=>{
  assert.equal(calculateInventorySnapshot(data,'LAF',{}).ready,false);
  assert.equal(calculateInventorySnapshot(data,'HOA_MAU_LVF',{mode:'planned'}).ready,false);
  const a=calculateInventorySnapshot({...data,productionOrders:[{...orders[0],stageQuantities:{}}]},'LAF',{mode:'planned'});
  assert.equal(a.rows.length,0); assert.ok(a.unmapped.some(x=>x.reason.includes('Thiếu/không hợp lệ')));
  const b=calculateInventorySnapshot({...data,productionOrders:[{...orders[0],productionQty:100}]},'LAF',{mode:'released'});
  assert.equal(b.rows.length,0); assert.ok(b.unmapped.some(x=>x.reason.includes('lớn hơn')));
});
test('duplicate order rows cannot silently double stock',()=>{
 const a=calculateInventorySnapshot({...data,productionOrders:[orders[0],orders[0]]},'LAF',{mode:'planned'});
 assert.equal(a.rows.length,0); assert.ok(a.unmapped.some(x=>x.reason.includes('Trùng chỉ lệnh')));
});
test('LVF chemical can be calculated for one explicit stage without mixing',()=>{
 const chem={...data,chemicalNorms:[{...data.chemicalNorms[0],warehouseId:'HOA_MAU_LVF'}]};
 const may=calculateInventorySnapshot(chem,'HOA_MAU_LVF',{mode:'planned',lvfStage:'may'});
 const go=calculateInventorySnapshot(chem,'HOA_MAU_LVF',{mode:'planned',lvfStage:'go'});
 assert.equal(may.rows[0].basisQty,300); assert.equal(go.rows[0].basisQty,500);
 assert.ok(may.unmapped.some(x=>x.reason.includes('không có định mức')));
});
test('issued workbook validates source and retains numeric zero',async()=>{
 const wb=new ExcelJS.Workbook(); const sh=wb.addWorksheet('CoSo_Linh');
 sh.addRow(['Kho','Chỉ lệnh','Mã hàng','Màu','Số đôi đã lĩnh']); sh.addRow(['Kho Hóa mẫu LAF','ĐH09','C','1',0]);
 const buf=await wb.xlsx.writeBuffer(); const items=await readIssuedWorkbook({arrayBuffer:async()=>buf});
 assert.equal(items[0].quantity,0); assert.equal(items[0].warehouseId,'HOA_MAU_LAF');
});
test('export contains metadata, per-material and per-order results and gaps',async()=>{
 const result=calculateInventorySnapshot(data,'LAF',{mode:'issued',issuedRows:issued});
 const buf=await createSnapshotWorkbook(result,{asOf:'2026-11-14T10:00',warehouse:'Kho xưởng LAF',modeLabel:'Số đôi đã lĩnh'});
 const wb=new ExcelJS.Workbook(); await wb.xlsx.load(buf);
 assert.deepEqual(wb.worksheets.map(s=>s.name),['ThongTin','TongHop','TheoDon','ChuaGhep']);
 assert.equal(wb.getWorksheet('TongHop').getCell('E2').value,110);
 assert.equal(wb.getWorksheet('TheoDon').getCell('H2').value,300);
});

test('LVF combined view assigns each norm to its explicit stage and flags unknowns',()=>{
 const norms=[{...data.chemicalNorms[0],warehouseId:'HOA_MAU_LVF',operation:'May',materialCode:'MAY'}, {...data.chemicalNorms[0],warehouseId:'HOA_MAU_LVF',operation:'Gò',materialCode:'GO'}, {...data.chemicalNorms[0],warehouseId:'HOA_MAU_LVF',operation:'',materialCode:'UNKNOWN'}];
 const result=calculateInventorySnapshot({...data,chemicalNorms:norms},'HOA_MAU_LVF',{mode:'planned',lvfStage:'both'});
 assert.equal(result.summary.find(r=>r.materialCode==='MAY').quantity,60);
 assert.equal(result.summary.find(r=>r.materialCode==='GO').quantity,100);
 assert.equal(result.summary.some(r=>r.materialCode==='UNKNOWN'),false);
 assert.ok(result.unmapped.some(r=>r.materialCode==='UNKNOWN' && r.reason.toLowerCase().includes('công đoạn')));
});

test('counts preserve missing versus zero and show extra materials cautiously', async()=>{
 const {compareSnapshotCounts}=await import('./inventory-snapshot.js');
 const result=calculateInventorySnapshot(data,'LAF',{mode:'issued',issuedRows:issued});
 const counts=[{warehouseId:'LAF',materialCode:'MAT',unit:'m',quantity:0},{warehouseId:'LAF',materialCode:'EXTRA',materialName:'Dư cũ',unit:'kg',quantity:7}];
 const comparison=compareSnapshotCounts(result,counts,'LAF');
 assert.equal(comparison.find(x=>x.materialCode==='MAT').actual,0);
 assert.equal(comparison.find(x=>x.materialCode==='MAT').variance,-110);
 assert.equal(comparison.find(x=>x.materialCode==='EXTRA').quantity,0);
 const partial=compareSnapshotCounts({...result,unmapped:[{reason:'thiếu'}]},counts,'LAF');
 assert.equal(partial.find(x=>x.materialCode==='EXTRA').quantity,null);
});

test('chemical norm export and import preserve operation for LVF stage allocation', async()=>{
 const {createTaskWorkbook,importTaskWorkbook}=await import('./task-workbooks.js');
 const row={...data.chemicalNorms[0],warehouseId:'HOA_MAU_LVF',operation:'Gò',purchaseOrder:'P'};
 const buf=await createTaskWorkbook('chemical-norms:HOA_MAU_LVF',{...data,chemicalNorms:[row]});
 const result=await importTaskWorkbook('chemical-norms:HOA_MAU_LVF',{name:'lvf.xlsx',arrayBuffer:async()=>buf});
 assert.equal(result.chemicalNorms[0].operation,'Gò');
});

test('counts outside calculated BOM are not classified when no production orders are loaded', async()=>{
 const {compareSnapshotCounts}=await import('./inventory-snapshot.js');
 const result=calculateInventorySnapshot({...data,productionOrders:[],orders:[]},'LAF',{mode:'planned'});
 const comparison=compareSnapshotCounts(result,[{warehouseId:'LAF',materialCode:'EXTRA',unit:'kg',quantity:7}],'LAF');
 assert.equal(comparison[0].quantity,null); assert.equal(comparison[0].variance,null);
});
test('conflicting factory BOM operation is flagged, not calculated at wrong stage',()=>{
 const bad={...data,bom:[{...data.bom[0],operation:'Gò'}]};
 const result=calculateInventorySnapshot(bad,'LAF',{mode:'planned'});
 assert.equal(result.rows.length,0); assert.ok(result.unmapped.some(x=>x.reason.includes('khác công đoạn')));
});

test('BTP LAF takes priority over matrix, never silently adds or substitutes',()=>{
 const x=calculateInventorySnapshot({...data,norms:[{catalogNo:1,productKey:'C_1',size:'4',rate:.1,wipQty:null}]},'LAF',{mode:'planned'});
 assert.equal(x.rows.length,0); assert.ok(x.unmapped.some(r=>r.reason.includes('ưu tiên BTP')));
});
test('numeric material code formatting can be matched only uniquely',async()=>{
 const {compareSnapshotCounts}=await import('./inventory-snapshot.js');
 const result={summary:[{materialCode:'003370',unit:'KÍ',quantity:3}],hasSource:true,unmapped:[],orderCount:1};
 const rows=compareSnapshotCounts(result,[{warehouseId:'HOA_MAU_LAF',materialCode:'3370',unit:'KÍ',quantity:7}], 'HOA_MAU_LAF');
 assert.equal(rows[0].actual,7); assert.equal(rows[0].variance,4);
 const ambiguous=compareSnapshotCounts({...result,summary:[...result.summary,{materialCode:'3370',unit:'KÍ',quantity:1}]},[{warehouseId:'HOA_MAU_LAF',materialCode:'0003370',unit:'KÍ',quantity:7}], 'HOA_MAU_LAF');
 assert.equal(ambiguous[0].actual,null);
});
test('workshop count imports split by explicit warehouse, preserve zero and ignore missing',async()=>{
 const {readWorkshopCounts}=await import('./inventory-snapshot.js'); const wb=new ExcelJS.Workbook();
 const cat=wb.addWorksheet('1_Danh_Muc_Va_Ma_Tran_BOM'); cat.getCell('A6').value=1;cat.getCell('C6').value='003370';cat.getCell('D6').value='X';cat.getCell('F6').value='KÍ';
 for(const n of ['2_Kho_Hoa_Mau','3_Kho_Xuong_LAF','4_Kho_Xuong_LVF']){const s=wb.addWorksheet(n);s.getCell('B16').value='STT danh mục';s.getCell('M16').value='Kiểm kê thực tế';}
 let s=wb.getWorksheet('2_Kho_Hoa_Mau');s.getCell('B17').value=1;s.getCell('M17').value=0;s.getCell('T17').value='Hóa mẫu LAF';s.getCell('B18').value=1;s.getCell('M18').value=5;s.getCell('T18').value='Hóa mẫu LVF';s.getCell('B19').value=1;s.getCell('M19').value=3;
 const b=await wb.xlsx.writeBuffer(); const out=await readWorkshopCounts({arrayBuffer:async()=>b}); assert.equal(out.rows.length,2);assert.equal(out.rows[0].quantity,0);assert.equal(out.rows[1].warehouseId,'HOA_MAU_LVF');assert.equal(out.warnings.length,1);
});
test('BOM for another warehouse is not treated as zero in selected warehouse',()=>{
 const result=calculateInventorySnapshot({...data,bom:[{...data.bom[0],plant:'LVF'}]},'LAF',{mode:'planned'});
 assert.ok(result.unmapped.some(x=>x.reason.includes('chưa có dòng định mức trực tiếp')));
});
test('both LVF warehouses support May and Gò using the selected stage',()=>{
 const a=calculateInventorySnapshot(data,'LVF',{mode:'planned',lvfStage:'may'});
 const b=calculateInventorySnapshot(data,'LVF',{mode:'planned',lvfStage:'go'});
 assert.equal(a.rows[0].basisQty,300);assert.equal(b.rows[0].basisQty,500);
});
test('factory LVF combined view only sums BOM lines allocated to their stage',()=>{
 const x={...data,bom:[{...data.bom[2],operation:'May'}, {...data.bom[2],catalogNo:3,operation:'Gò'}, {...data.bom[2],catalogNo:4,operation:''}], materials:[...data.materials,{catalogNo:3,materialCode:'GO',name:'GO',unit:'cái',plants:['LVF']},{catalogNo:4,materialCode:'UNKNOWN',name:'UNKNOWN',unit:'cái',plants:['LVF']}]};
 const r=calculateInventorySnapshot(x,'LVF',{mode:'planned',lvfStage:'both'});
 assert.equal(r.summary.find(x=>x.materialCode==='MAT2').quantity,300);
 assert.equal(r.summary.find(x=>x.materialCode==='GO').quantity,500);
 assert.equal(r.summary.some(x=>x.materialCode==='UNKNOWN'),false);
 assert.ok(r.unmapped.some(x=>x.materialCode==='UNKNOWN' && x.reason.includes('công đoạn')));
});
test('normalizeMaterialNameKey matches equivalent ADIDAS and standard names without false collisions',()=>{
 assert.equal(normalizeMaterialNameKey('CAO SU3L'), normalizeMaterialNameKey('Cao su [3L]  ADIDAS'));
 assert.equal(normalizeMaterialNameKey('CAO SUSBR-1502'), normalizeMaterialNameKey('Cao su [SBR-1502] ADIDAS'));
 assert.equal(normalizeMaterialNameKey('CHẤT TRỢ XÚC TIẾN VÀ LÀM MỀM B75 NS'), normalizeMaterialNameKey('CHẤT XÚC TIẾN B75 NS ADIDAS'));
 assert.notEqual(normalizeMaterialNameKey('DẦU TCM LIQUID 1500'), normalizeMaterialNameKey('DẦU TCM LIQUID 220N ADIDAS'));
});
test('mergeRowsByMaterialName combines two material codes onto one row and recalculates totals',()=>{
 const rows=[
  {materialCode:'003362',materialName:'CAO SU3L',unit:'KÍ',orderCount:2,quantity:5487.827,actual:null,variance:null,comparison:'Chưa đếm',details:[{orderNo:'DH01'},{orderNo:'DH02'}]},
  {materialCode:'009218',materialName:'Cao su [3L]  ADIDAS',unit:'KÍ',orderCount:1,quantity:0,actual:3010,variance:3010,comparison:'Đã đối chiếu',details:[{orderNo:'DH02'}]},
 ];
 const merged=mergeRowsByMaterialName(rows);
 assert.equal(merged.length,1);
 assert.equal(merged[0].materialCode,'003362 / 009218');
 assert.deepEqual(merged[0].materialCodes,['003362','009218']);
 assert.equal(merged[0].materialName,'CAO SU3L');
 assert.equal(merged[0].quantity,5487.827);
 assert.equal(merged[0].actual,3010);
 assert.ok(Math.abs(merged[0].variance - (3010 - 5487.827)) < 1e-6);
 assert.equal(merged[0].orderCount,2);
 assert.equal(merged[0].comparison,'Đã đối chiếu');
});
