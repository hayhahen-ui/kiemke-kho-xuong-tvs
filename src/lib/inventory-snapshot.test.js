import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { calculateInventorySnapshot, readIssuedWorkbook, createSnapshotWorkbook, normalizeMaterialNameKey, mergeRowsByMaterialName, compareSnapshotCounts } from './inventory-snapshot.js';
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
 assert.deepEqual(wb.worksheets.map(s=>s.name),['ThongTin','TongHop','TheoDon','ChuaGhep','GiaiThich','ThucLanh_SoVoi_LyThuyet']);
 assert.equal(wb.getWorksheet('TongHop').getCell('F2').value,110);
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
test('DM_BTP_Size_LAF calculates LAF stock when wipQty or size plannedQty breakdown is provided',()=>{
 const withPlanned=calculateInventorySnapshot({
  ...data,
  norms:[
   {catalogNo:1,materialCode:'M1',materialName:'Giấy Roki',unit:'TỜ',productKey:'C_1',size:'4',process:'Tẩy',rate:0.1,plannedQty:20,wipQty:null},
   {catalogNo:1,materialCode:'M1',materialName:'Giấy Roki',unit:'TỜ',productKey:'C_1',size:'5',process:'Tẩy',rate:0.2,plannedQty:80,wipQty:null},
  ],
 },'LAF',{mode:'planned'});
 assert.equal(withPlanned.rows.length,1);
 assert.equal(withPlanned.rows[0].source,'DM_BTP_Size_LAF');
 // weightedRate = (0.1*20 + 0.2*80) / 100 = 0.18; remaining = 300 pairs -> 54
 assert.ok(Math.abs(withPlanned.rows[0].quantity - 54) < 1e-6);
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
 assert.equal(normalizeMaterialNameKey('CAO SU KBR01(2)'), normalizeMaterialNameKey('Cao su [Cao su KBR01] ADIDAS'));
 assert.equal(normalizeMaterialNameKey('BÁT MÀURB-2124A'), normalizeMaterialNameKey('BÁT MÀU CAM ĐỎ RB-2124A (ADIDAS)'));
 assert.equal(normalizeMaterialNameKey('CHẤT TRỢ XÚC TIẾN VÀ LÀM MỀMKUMANOX'), normalizeMaterialNameKey('CHẤT TRỢ XÚC TIẾN VÀ LÀM MỀM KUMANOX DẠNG BỘTADIDAS'));
 assert.equal(normalizeMaterialNameKey('CHẤT TRỢ XÚC TIẾN VÀ LÀM MỀM UF440CHẤT PHÂN TÁN CAO SU'), normalizeMaterialNameKey('CHẤT TRỢ XÚC TIẾN VÀ LÀM MỀM CHẤT PHÂN TÁN CAO SU UF440ADIDAS'));
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
test('downstream Gò, Đóng thùng, Nhập kho propagate backward to missing upstream Chặt/May counts',()=>{
 const seqOrders=[
  {orderNo:'DH_PACKED',model:'C',color:'1',plannedQty:344,productionQty:344,stageQuantities:{LAF_CUT:0,LVF_SEW:0,LVF_GO:0,RECEIVED:344}},
  {orderNo:'DH_PARTIAL',model:'A',color:'2',plannedQty:516,productionQty:516,stageQuantities:{LAF_CUT:0,LVF_SEW:116,LVF_GO:509,RECEIVED:509}},
 ];
 const seqData={...data,productionOrders:seqOrders};
 const laf=calculateInventorySnapshot(seqData,'LAF',{mode:'planned'});
 assert.equal(laf.rows.length,1);
 assert.equal(laf.rows[0].orderNo,'DH_PARTIAL');
 assert.equal(laf.rows[0].done,509);
 assert.equal(laf.rows[0].basisQty,7);
 const chemLaf=calculateInventorySnapshot(seqData,'HOA_MAU_LAF',{mode:'planned'});
 assert.equal(chemLaf.summary.length,0);
});
test('compareSnapshotCounts and mergeRowsByMaterialName include PO-matched issuedFromMain column',()=>{
 const res={hasSource:true,orderCount:1,unmapped:[],rows:[{orderNo:'DH1',purchaseOrder:'PO-999',model:'C',color:'1',materialCode:'003362',materialName:'CAO SU3L',unit:'KÍ',quantity:100}],summary:[{materialCode:'003362',materialName:'CAO SU3L',unit:'KÍ',orderCount:1,quantity:100,details:[{orderNo:'DH1'}]}]};
 const counts=[{warehouseId:'HOA_MAU_LAF',materialCode:'009218',materialName:'Cao su [3L] ADIDAS',unit:'KÍ',quantity:80}];
 const issues=[
  {warehouseId:'HOA_MAU_LAF',po:'PO-999',stage:'CÁN VẢI',materialCode:'003362',materialName:'CAO SU3L',unit:'KÍ',issuedQty:50},
  {warehouseId:'HOA_MAU_LAF',po:'PO-999',stage:'CÁN VẢI',materialCode:'009218',materialName:'Cao su [3L] ADIDAS',unit:'KÍ',issuedQty:40},
  {warehouseId:'HOA_MAU_LAF',po:'PO-OTHER',stage:'CÁN VẢI',materialCode:'003362',materialName:'CAO SU3L',unit:'KÍ',issuedQty:999},
 ];
 const cmp=compareSnapshotCounts(res,counts,'HOA_MAU_LAF',{materialIssues:issues});
 const merged=mergeRowsByMaterialName(cmp);
 assert.equal(merged.length,1);
 assert.equal(merged[0].materialCode,'003362 / 009218');
 assert.equal(merged[0].quantity,100);
 assert.equal(merged[0].issuedFromMain,90);
 assert.equal(merged[0].actual,80);
 assert.equal(merged[0].variance,-20);
});
test('createSnapshotWorkbook adds GiaiThich sheet for orders with Nhập kho/Đóng thùng but missing Chặt/May/Gò',async()=>{
 const calc=calculateInventorySnapshot(data,'LAF',{mode:'planned'});
 const prodOrders=[
  {orderNo:'DH_MISSING',purchaseOrder:'PO_NO_ISSUE',model:'C',color:'1',plannedQty:344,stageQuantities:{LAF_CUT:0,LVF_SEW:0,LVF_GO:0,PACKED:344,RECEIVED:344}},
  {orderNo:'DH_OK',purchaseOrder:'PO_OK',model:'A',color:'2',plannedQty:100,stageQuantities:{LAF_CUT:100,LVF_SEW:100,LVF_GO:100,PACKED:100,RECEIVED:100}},
 ];
 const bytes=await createSnapshotWorkbook(calc,{asOf:'2026-11-16T15:00',warehouse:'Kho xưởng LAF',warehouseId:'LAF',modeLabel:'SL đơn hàng',productionOrders:prodOrders,materialIssues:[]});
 const wb=new ExcelJS.Workbook(); await wb.xlsx.load(bytes);
 const sheet=wb.getWorksheet('GiaiThich');
 assert.ok(sheet);
 assert.equal(sheet.rowCount,2);
 assert.equal(sheet.getCell('A2').value,'DH_MISSING');
 assert.equal(sheet.getCell('I2').value,344);
 assert.equal(sheet.getCell('J2').value,344);
 assert.ok(String(sheet.getCell('L2').value).includes('Không có xuất NVL theo PO'));
});
test('TongHop issued column counts only WIP POs; ThucLanh_SoVoi_LyThuyet splits the rest',async()=>{
 const res={hasSource:true,orderCount:1,unmapped:[],stage:'Chặt',
  rows:[{orderNo:'DH1',purchaseOrder:'PO-WIP',model:'C',color:'1',basisQty:10,materialCode:'003362',materialName:'CAO SU3L',unit:'KÍ',quantity:100}],
  summary:[{materialCode:'003362',materialName:'CAO SU3L',unit:'KÍ',orderCount:1,quantity:100,details:[{orderNo:'DH1'}]}]};
 const prod=[{orderNo:'DH1',purchaseOrder:'PO-WIP'},{orderNo:'DH2',purchaseOrder:'PO-DONE'}];
 const issues=[
  {warehouseId:'HOA_MAU_LAF',po:'PO-WIP',materialCode:'003362',materialName:'CAO SU3L',unit:'KÍ',issuedQty:60},
  {warehouseId:'HOA_MAU_LAF',po:'PO-DONE',materialCode:'003362',materialName:'CAO SU3L',unit:'KÍ',issuedQty:500},
  {warehouseId:'HOA_MAU_LAF',po:'PO-X',materialCode:'003362',materialName:'CAO SU3L',unit:'KÍ',issuedQty:7},
  {warehouseId:'HOA_MAU_LAF',po:'',materialCode:'003362',materialName:'CAO SU3L',unit:'KÍ',issuedQty:3},
 ];
 const cmp=compareSnapshotCounts(res,[],'HOA_MAU_LAF',{materialIssues:issues,productionOrders:prod});
 assert.equal(cmp[0].issuedFromMain,60);
 const bytes=await createSnapshotWorkbook(res,{asOf:'x',warehouse:'Kho Hóa mẫu LAF',warehouseId:'HOA_MAU_LAF',comparison:cmp,productionOrders:prod,materialIssues:issues});
 const wb=new ExcelJS.Workbook(); await wb.xlsx.load(bytes);
 assert.equal(wb.getWorksheet('TongHop').getCell('G2').value,60);
 const r=wb.getWorksheet('ThucLanh_SoVoi_LyThuyet');
 assert.equal(r.getCell('C1').value,'Code màu');
 assert.equal(r.getCell('E2').value,570);
 assert.equal(r.getCell('F2').value,60);
 assert.equal(r.getCell('G2').value,500);
 assert.equal(r.getCell('H2').value,7);
 assert.equal(r.getCell('I2').value,3);
 assert.equal(r.getCell('J2').value,100);
 assert.equal(r.getCell('K2').value,-40);
 assert.equal(r.getCell('M1').value,'Chi tiết PO');
 const poDetail=String(r.getCell('M2').value);
 assert.ok(poDetail.includes('Dở dang (1): PO-WIP (60)'));
 assert.ok(poDetail.includes('Hoàn tất (1): PO-DONE (500)'));
 assert.ok(poDetail.includes('Ngoài tiến độ (1): PO-X (7)'));
});
test('same material code with different materialColor (e.g. AETF vs A0QM) stays split across summary and reconciliation',async()=>{
 const colorData={
  ...data,
  productionOrders:[
   {orderNo:'DH_C1',purchaseOrder:'PO_C1',model:'M1',color:'RED',plannedQty:100,productionQty:100,stageQuantities:{LAF_CUT:0,LVF_SEW:0,LVF_GO:0,PACKED:0,RECEIVED:0}},
   {orderNo:'DH_C2',purchaseOrder:'PO_C2',model:'M1',color:'BLUE',plannedQty:100,productionQty:100,stageQuantities:{LAF_CUT:0,LVF_SEW:0,LVF_GO:0,PACKED:0,RECEIVED:0}},
  ],
  chemicalNorms:[
   {warehouseId:'LAF',productionOrder:'DH_C1',purchaseOrder:'PO_C1',model:'M1',color:'RED',materialCode:'003420',materialName:'VẢI COTTON THT- CM2C250 K 1.82M',materialColor:'AETF',unit:'MÉT',operation:'Chặt',sourceOrderQty:100,sourceQuantity:50},
   {warehouseId:'LAF',productionOrder:'DH_C2',purchaseOrder:'PO_C2',model:'M1',color:'BLUE',materialCode:'003420',materialName:'VẢI COTTON THT- CM2C250 K 1.82M',materialColor:'A0QM',unit:'MÉT',operation:'Chặt',sourceOrderQty:100,sourceQuantity:80},
  ],
 };
 const issues=[
  {warehouseId:'LAF',po:'PO_C1',stage:'CHẶT',materialCode:'003420',materialName:'VẢI COTTON THT- CM2C250 K 1.82M',materialColor:'AETF',unit:'MÉT',issuedQty:45},
  {warehouseId:'LAF',po:'PO_C2',stage:'CHẶT',materialCode:'003420',materialName:'VẢI COTTON THT- CM2C250 K 1.82M',materialColor:'A0QM',unit:'MÉT',issuedQty:90},
 ];
 const calc=calculateInventorySnapshot(colorData,'LAF',{mode:'planned'});
 assert.equal(calc.summary.length,2);
 const cmp=compareSnapshotCounts(calc,[],'LAF',{materialIssues:issues,productionOrders:colorData.productionOrders});
 const merged=mergeRowsByMaterialName(cmp);
 assert.equal(merged.length,2);
 const bytes=await createSnapshotWorkbook(calc,{asOf:'x',warehouse:'Kho xưởng LAF',warehouseId:'LAF',comparison:merged,summaryRows:merged,productionOrders:colorData.productionOrders,materialIssues:issues});
 const wb=new ExcelJS.Workbook(); await wb.xlsx.load(bytes);
 const recon=wb.getWorksheet('ThucLanh_SoVoi_LyThuyet');
 const colors=[recon.getCell('C2').value,recon.getCell('C3').value].sort();
 assert.deepEqual(colors,['A0QM','AETF']);
});
test('calculateInventorySnapshot uses per-order chemicalNorms for LAF and LVF (both mode)',()=>{
 const customData={
  ...data,
  productionOrders:[
   {orderNo:'DH_BOM',purchaseOrder:'PO_BOM',model:'M_BOM',color:'X',plannedQty:100,productionQty:100,stageQuantities:{LAF_CUT:60,LVF_SEW:30,LVF_GO:10,PACKED:0,RECEIVED:0}},
  ],
  chemicalNorms:[
   {warehouseId:'LAF',productionOrder:'DH_BOM',purchaseOrder:'PO_BOM',model:'M_BOM',color:'X',materialCode:'MAT_CUT',materialName:'Vải lót',unit:'M',operation:'Chặt',sourceOrderQty:100,sourceQuantity:200},
   {warehouseId:'LVF',productionOrder:'DH_BOM',purchaseOrder:'PO_BOM',model:'M_BOM',color:'X',materialCode:'MAT_SEW',materialName:'Chỉ may',unit:'M',operation:'May',sourceOrderQty:100,sourceQuantity:150},
   {warehouseId:'LVF',productionOrder:'DH_BOM',purchaseOrder:'PO_BOM',model:'M_BOM',color:'X',materialCode:'MAT_GO',materialName:'Keo gò',unit:'KG',operation:'Gò',sourceOrderQty:100,sourceQuantity:50},
  ],
 };
 const laf=calculateInventorySnapshot(customData,'LAF',{mode:'planned'});
 assert.equal(laf.hasSource,true);
 assert.equal(laf.rows.length,1);
 assert.equal(laf.rows[0].basisQty,40);
 assert.equal(laf.rows[0].quantity,80);
 const lvf=calculateInventorySnapshot(customData,'LVF',{mode:'planned',lvfStage:'both'});
 assert.equal(lvf.hasSource,true);
 assert.equal(lvf.rows.length,2);
 const sewRow=lvf.rows.find((x)=>x.materialCode==='MAT_SEW');
 const goRow=lvf.rows.find((x)=>x.materialCode==='MAT_GO');
 assert.equal(sewRow.basisQty,70);
 assert.equal(sewRow.quantity,105);
 assert.equal(goRow.basisQty,90);
 assert.equal(goRow.quantity,45);
});
test('reconcileWorkshopWip detects mismatches and confirmedWip overrides calculateInventorySnapshot',async()=>{
 const { reconcileWorkshopWip, createWipReconcileWorkbook } = await import('./wip-reconcile.js');
 const prod=[
  {orderNo:'ADIDA2611-0101',purchaseOrder:'PO1',model:'NVQ89',color:'LC1783',plannedQty:578,stageQuantities:{LAF_CUT:578,LVF_SEW:513,LVF_GO:513,PACKED:0,RECEIVED:0}},
  {orderNo:'ADIDA1120-0074',purchaseOrder:'PO2',model:'NVQ89',color:'LC1783',plannedQty:681,stageQuantities:{LAF_CUT:100,LVF_SEW:324,LVF_GO:324,PACKED:0,RECEIVED:0}},
 ];
 const reported=[
  {orderNo:'ADIDA2611-0101',plant:'LVF',reportedWip:65},
  {orderNo:'ADIDA1120-0074',plant:'LAF',reportedWip:681},
 ];
 const rec=reconcileWorkshopWip(prod,reported);
 const lvfMatch=rec.rows.find(r=>r.plant==='LVF'&&r.orderNo==='ADIDA2611-0101');
 const lafDiff=rec.rows.find(r=>r.plant==='LAF'&&r.orderNo==='ADIDA1120-0074');
 assert.equal(lvfMatch.status,'Khớp');
 assert.equal(lafDiff.status,'Xưởng báo cao hơn hệ thống');
 assert.equal(lafDiff.diff,324);
 const xl=await createWipReconcileWorkbook(rec,{confirmedActive:true});
 const wb=new ExcelJS.Workbook(); await wb.xlsx.load(xl);
 assert.deepEqual(wb.worksheets.map(s=>s.name),['TongHop_DoiChieu','ChiTiet_SaiLech','ToanBo_DoiChieu']);
 // Apply confirmedWip to calculateInventorySnapshot
 const calc=calculateInventorySnapshot({
  ...data,
  productionOrders:[{orderNo:'DH_CONF',purchaseOrder:'PO_C',model:'M1',color:'X',plannedQty:500,productionQty:500,stageQuantities:{LAF_CUT:100,LVF_SEW:0,LVF_GO:0,PACKED:0,RECEIVED:0}}],
  chemicalNorms:[{warehouseId:'LAF',productionOrder:'DH_CONF',purchaseOrder:'PO_C',model:'M1',color:'X',materialCode:'M_CONF',materialName:'Vải',unit:'M',operation:'Chặt',sourceOrderQty:500,sourceQuantity:1000}],
  confirmedWip:{active:true,rows:{'LAF|DH_CONF':250}},
 },'LAF',{mode:'planned'});
 assert.equal(calc.rows.length,1);
 assert.equal(calc.rows[0].basisQty,250);
 assert.equal(calc.rows[0].quantity,500);
});
