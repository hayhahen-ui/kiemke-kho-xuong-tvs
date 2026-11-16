import { getTheoreticalRequirements, normalizeJoinKey, resolveOrderCommand, WAREHOUSES } from './model.js';

const norm = normalizeJoinKey;
const active = (rows, meta, task) => meta?.[task]?.batchId ? (rows || []).filter((r) => r.batchId === meta[task].batchId) : (rows || []);
const key = (orderNo, model, color) => [orderNo, model, color].map(norm).join('|');
const numberOrNull = (value) => value === '' || value == null || !Number.isFinite(Number(value)) || Number(value) < 0 ? null : Number(value);

export function snapshotStage(warehouseId, lvfStage) {
  if (warehouseId === 'HOA_MAU_LAF' || warehouseId === 'LAF') return { key:'LAF_CUT', label:'Chặt' };
  if (warehouseId === 'LVF' && lvfStage === 'may') return { key:'LVF_SEW', label:'May' };
  if (warehouseId === 'LVF' && (!lvfStage || lvfStage === 'go')) return { key:'LVF_GO', label:'Gò' };
  if (warehouseId === 'HOA_MAU_LVF' && lvfStage === 'may') return { key:'LVF_SEW', label:'May' };
  if (warehouseId === 'HOA_MAU_LVF' && lvfStage === 'go') return { key:'LVF_GO', label:'Gò' };
  return null;
}

// Snapshot estimates NPL remaining for unfinished orders, not ledger stock. The basis
// choice is explicit; order quantity is the requested basis, not evidence of physical issue.
export function calculateInventorySnapshot(data, warehouseId, { mode, issuedRows = [], lvfStage = '' } = {}) {
  if ((warehouseId === 'HOA_MAU_LVF' || warehouseId === 'LVF') && lvfStage === 'both') {
    const chemical = warehouseId === 'HOA_MAU_LVF';
    const materials = new Map((data.materials || []).map(m => [String(m.catalogNo),m]));
    const target = (line) => {
      const plants = (materials.get(String(line.catalogNo))?.plants || []).filter(p=>p==='LAF' || p==='LVF');
      return line.warehouseId || line.plant || (plants.length === 1 ? plants[0] : '');
    };
    const norms = chemical ? active(data.chemicalNorms,data.importMeta,'chemical-norms:HOA_MAU_LVF').filter(r=>r.warehouseId==='HOA_MAU_LVF') : (data.bom || []).filter(r=>target(r)==='LVF');
    const classify=(row)=>{const v=norm(row.operation || ''); if(v==='MAY' || v==='SEW') return 'may'; if(v==='GO' || v==='ASSEMBLY') return 'go'; return '';};
    const unknown=norms.filter(r=>!classify(r)).map(r=>({...r,materialCode:r.materialCode || materials.get(String(r.catalogNo))?.materialCode || '',reason:'Chưa xác định công đoạn May/Gò cho dòng định mức LVF; không cộng để tránh tính trùng.'}));
    const make=(which)=>{
      const subset = chemical
        ? {...data,chemicalNorms:(data.chemicalNorms||[]).filter(r=>r.warehouseId!=='HOA_MAU_LVF' || classify(r)===which)}
        : {...data,bom:(data.bom||[]).filter(r=>target(r)!=='LVF' || classify(r)===which)};
      return calculateInventorySnapshot(subset,warehouseId,{mode,issuedRows,lvfStage:which});
    };
    const may=make('may'), go=make('go');
    if (!may.ready || !go.ready) return {ready:false,rows:[],summary:[],unmapped:[],hasSource:false};
    const rows=[...may.rows,...go.rows]; const grouped=new Map();
    for (const r of rows) { if (!r.materialCode || !r.unit) continue; const k=[r.materialCode,r.unit].map(norm).join('|'); if(!grouped.has(k)) grouped.set(k,{materialCode:r.materialCode,materialName:r.materialName,unit:r.unit,quantity:0,details:[],orders:new Set()}); const x=grouped.get(k); x.quantity+=r.quantity; x.details.push(r); x.orders.add(key(r.orderNo,r.model,r.color)); }
    const summary=[...grouped.values()].map(({orders,...x})=>({...x,orderCount:orders.size})).sort((a,b)=>String(a.materialCode).localeCompare(String(b.materialCode),'vi'));
    const union=new Set(norms.filter(classify).map(r=>key(r.productionOrder,r.model,r.color)));
    const allChemical=WAREHOUSES.filter(w=>w.kind==='chemical').flatMap(w=>active(data.chemicalNorms,data.importMeta,`chemical-norms:${w.id}`).filter(r=>r.warehouseId===w.id));
    const gaps=[...may.unmapped,...go.unmapped].filter(r=>!chemical || !r.reason?.startsWith('Đơn dở dang không có định mức') || !union.has(key(resolveOrderCommand(r,allChemical,data.orderMappings||[]).orderNo || r.orderNo,r.model,r.color)));
    const dedup=new Map(); for(const r of [...unknown,...gaps]) {const k=[r.productionOrder || r.orderNo,r.model,r.color,r.materialCode,r.sourceRow,r.reason].join('|'); if(!dedup.has(k)) dedup.set(k,r);}
    return {ready:true,rows,summary,unmapped:[...dedup.values()],hasSource:norms.length>0,stage:'May + Gò (theo định mức)',orderCount:may.orderCount};
  }
  const stage = snapshotStage(warehouseId, lvfStage);
  if (!stage || !['released','planned','issued'].includes(mode)) return { ready:false, rows:[], summary:[], unmapped:[], hasSource:false };
  const allChemical = WAREHOUSES.filter(w => w.kind === 'chemical').flatMap(w => active(data.chemicalNorms,data.importMeta,`chemical-norms:${w.id}`).filter(r => r.warehouseId === w.id));
  const imported = active(data.productionOrders,data.importMeta,'production-orders');
  const original = imported.length ? imported : (data.orders || []);
  const issueByKey = new Map();
  for (const row of issuedRows) {
    if (row.warehouseId !== warehouseId) continue;
    const k = key(row.orderNo,row.model,row.color);
    if (!issueByKey.has(k)) issueByKey.set(k,[]);
    issueByKey.get(k).push(row);
  }
  const issues = []; const bases = new Map();
  const commandFor = (order) => resolveOrderCommand(order, allChemical, data.orderMappings || []).orderNo || order.orderNo;
  const frequencies = new Map();
  for (const order of original) { const k=key(commandFor(order),order.model,order.color); frequencies.set(k,(frequencies.get(k)||0)+1); }
  const selectedNorms = active(data.chemicalNorms,data.importMeta,`chemical-norms:${warehouseId}`).filter(r=>r.warehouseId===warehouseId);
  const normKeys = new Set(selectedNorms.map(n=>key(n.productionOrder,n.model,n.color)));
  const orders = original.map(order => {
    const command = commandFor(order);
    const k = key(command,order.model,order.color);
    let qty = null;
    if (mode === 'released') qty = numberOrNull(order.productionQty);
    if (mode === 'planned') qty = numberOrNull(order.plannedQty);
    if (mode === 'issued') {
      const candidates = issueByKey.get(k) || [];
      if (candidates.length === 1) qty = numberOrNull(candidates[0].quantity);
      if (candidates.length > 1) issues.push({ ...order, reason:'Trùng dòng số đôi đã lĩnh cho cùng kho/chỉ lệnh/mã hàng/màu.' });
    }
    const done = numberOrNull(order.stageQuantities?.[stage.key]);
    let remaining = 0;
    if (frequencies.get(k) > 1) {
      issues.push({...order, reason:'Trùng chỉ lệnh + mã hàng + màu trong tiến độ; chưa tính để tránh nhân đôi.'});
    } else if (qty === null || done === null) {
      issues.push({ ...order, reason: qty === null ? 'Thiếu số đôi cơ sở tại kho (hoặc chưa có dòng số đôi đã lĩnh).' : `Thiếu/không hợp lệ số đã ${stage.label}.` });
    } else if (done > qty) {
      issues.push({ ...order, reason:`Số đã ${stage.label} (${done}) lớn hơn số đôi cơ sở (${qty}); không tự suy số tồn.` });
    } else remaining = qty - done;
    if (remaining > 0 && warehouseId.startsWith('HOA_MAU_') && !normKeys.has(k)) issues.push({...order, reason:'Đơn dở dang không có định mức hóa mẫu khớp chỉ lệnh + mã hàng + màu tại kho này.'});
    bases.set(k,{qty,done,remaining});
    bases.set(key(order.orderNo,order.model,order.color),{qty,done,remaining});
    // getTheoreticalRequirements uses release as its base; set stages to zero so
    // the precomputed remainder is not subtracted again for direct BOM.
    return {...order, productionQty:remaining, stageQuantities:{...order.stageQuantities,LAF_CUT:0,LVF_SEW:0,LVF_GO:0}};
  });
  // Warehouse stages are authoritative. Explicit conflicting BOM stages require review.
  const filteredBom = [];
  // Source workbook gives BTP priority per catalog number. Without WIP by
  // size and a safe allocation to orders, do not substitute a matrix rate.
  const btpCatalog = new Set((data.norms || []).map(n => String(n.catalogNo)));
  if (warehouseId === 'LAF') for (const catalogNo of btpCatalog) {
    const material = (data.materials || []).find(m => String(m.catalogNo) === catalogNo);
    issues.push({materialCode:material?.materialCode || catalogNo, reason:'Vật tư ưu tiên BTP theo size/công đoạn; chưa tính vì cần số dở dang theo size và phân bổ tương ứng tại thời điểm kiểm kê.'});
  }
  for (const line of data.bom || []) {
    if (warehouseId === 'LAF' && btpCatalog.has(String(line.catalogNo))) continue;
    const material = (data.materials || []).find(m => String(m.catalogNo) === String(line.catalogNo));
    const plants = (material?.plants || []).filter(p => p === 'LAF' || p === 'LVF');
    const target = line.warehouseId || line.plant || (plants.length === 1 ? plants[0] : '');
    const op = norm(line.operation || '');
    const defined = op.includes('CHAT') || op.includes('CUT') ? 'Chặt' : op.includes('MAY') || op.includes('SEW') ? 'May' : /\bGO\b/.test(op) || op.includes('ASSEMB') ? 'Gò' : op ? '?' : '';
    if ((warehouseId === 'LAF' || warehouseId === 'LVF') && target === warehouseId && defined && defined !== stage.label) {
      issues.push({...line, materialCode:line.materialCode || '', reason:`Công đoạn BOM (${line.operation}) khác công đoạn kho đang tính (${stage.label}); cần rà soát.`});
    } else filteredBom.push(line);
  }
  const calculated = getTheoreticalRequirements({ ...data, productionOrders:orders, orders, bom:filteredBom, _snapshotStrictCoverage:true, importMeta:{...data.importMeta, 'production-orders':undefined} }, warehouseId);
  const rows = calculated.rows.map(row => ({...row, ...(bases.get(key(row.orderNo,row.model,row.color)) || {}), stage:stage.label, basisType:`Còn lại tại ${stage.label}`}));
  const grouped = new Map();
  for (const row of rows) {
    if (!row.unit || !row.materialCode) { issues.push({...row, reason:'Thiếu mã vật tư hoặc đơn vị; chưa cộng vào tổng.'}); continue; }
    const k=[row.materialCode,row.unit].map(norm).join('|');
    if (!grouped.has(k)) grouped.set(k,{materialCode:row.materialCode,materialName:row.materialName,unit:row.unit,quantity:0,details:[],orderKeys:new Set()});
    const item=grouped.get(k); item.quantity+=row.quantity; item.details.push(row); item.orderKeys.add(key(row.orderNo,row.model,row.color));
  }
  const summary=[...grouped.values()].map(({orderKeys,...x})=>({...x,orderCount:orderKeys.size})).sort((a,b)=>String(a.materialCode).localeCompare(String(b.materialCode),'vi'));
  return {ready:true,rows,summary,unmapped:[...issues,...calculated.unmapped],hasSource:calculated.hasSource,stage:stage.label,orderCount:original.length};
}

function safeText(value) { if (value == null) return ''; if (typeof value === 'object') { if (value.result !== undefined) return safeText(value.result); if (value.formula || value.sharedFormula) return ''; } return String(value).trim(); }
const warehouseAliases = new Map([['HOAMAULAF','HOA_MAU_LAF'],['KHOHOAMAULAF','HOA_MAU_LAF'],['HOAMAULVF','HOA_MAU_LVF'],['KHOHOAMAULVF','HOA_MAU_LVF'],['LAF','LAF'],['KHOXUONGLAF','LAF'],['LVF','LVF'],['KHOXUONGLVF','LVF']]);
const compact = (v) => norm(v).replace(/[^A-Z0-9]/g,'');
export async function readIssuedWorkbook(file) {
  const { default: ExcelJS } = await import('exceljs'); const wb=new ExcelJS.Workbook(); await wb.xlsx.load(await file.arrayBuffer());
  const s=wb.getWorksheet('CoSo_Linh'); if(!s) throw new Error('Cần sheet CoSo_Linh; hãy dùng file mẫu.');
  const headers={}; s.getRow(1).eachCell((c,i)=>{headers[compact(c.value)]=i;});
  const columns=['KHO','CHILENH','MAHANG','MAU','SODOIDALINH'].map(x=>headers[x]);
  if(columns.some(x=>!x)) throw new Error('Thiếu cột Kho, Chỉ lệnh, Mã hàng, Màu hoặc Số đôi đã lĩnh.');
  const rows=[]; const seen=new Set();
  for (let r=2;r<=s.rowCount;r++) {
    const vals=columns.map(c=>safeText(s.getCell(r,c).value)); if(vals.every(x=>!x)) continue;
    const [warehouse,orderNo,model,color,raw]=vals; const warehouseId=warehouseAliases.get(compact(warehouse));
    const quantity = raw === '' ? null : Number(raw.replace(',', '.'));
    if(!warehouseId || !orderNo || !model || !color || quantity === null || !Number.isFinite(quantity) || quantity < 0) throw new Error(`Dòng ${r} thiếu thông tin hoặc số đôi không hợp lệ.`);
    const k=warehouseId+'|'+key(orderNo,model,color); if(seen.has(k)) throw new Error(`Trùng kho/chỉ lệnh/mã hàng/màu ở dòng ${r}.`); seen.add(k);
    rows.push({warehouseId,orderNo,model,color,quantity});
  }
  if(!rows.length) throw new Error('File chưa có dòng số đôi đã lĩnh.'); return rows;
}
export async function createIssuedTemplate() {
  const { default: ExcelJS }=await import('exceljs'); const wb=new ExcelJS.Workbook(); const s=wb.addWorksheet('CoSo_Linh');
  s.addRow(['Kho','Chỉ lệnh','Mã hàng','Màu','Số đôi đã lĩnh']); s.views=[{state:'frozen',ySplit:1}]; s.columns.forEach(c=>{c.width=25;});
  return wb.xlsx.writeBuffer();
}
export async function createSnapshotWorkbook(result, metadata) {
  const { default: ExcelJS }=await import('exceljs'); const wb=new ExcelJS.Workbook();
  const info=wb.addWorksheet('ThongTin');
  for (const row of [['Mốc kiểm kê',metadata.asOf],['Kho',metadata.warehouse],['Công đoạn',result.stage],['Cơ sở',metadata.modeLabel],['Múi giờ thiết bị',metadata.timeZone || ''],['File tiến độ',metadata.progressSource || ''],['File định mức',metadata.normSource || ''],['File số đôi đã lĩnh',metadata.issuedSource || ''],['File kiểm đếm',metadata.countSource || ''],['Ghi chú','Tính theo dữ liệu đã nạp hiện tại, không tự dựng lại dữ liệu quá khứ. Số dở dang theo định mức; không phải tồn sổ.'],['Cảnh báo','Kiểm tra ChuaGhep; kết quả có thể chưa đầy đủ.']]) info.addRow(row); info.columns=[{width:25},{width:85}];
  const sum=wb.addWorksheet('TongHop'); sum.addRow(['Mã vật tư','Tên vật tư','Đơn vị','Số chỉ lệnh','Tồn lý thuyết theo dở dang']);
  if (metadata.comparison) { sum.getRow(1).getCell(6).value='Kiểm đếm thực tế'; sum.getRow(1).getCell(7).value='Chênh lệch tạm tính'; sum.getRow(1).getCell(8).value='Ghi chú'; }
  (metadata.comparison || result.summary).forEach(r=>sum.addRow([r.materialCode,r.materialName,r.unit,r.orderCount,r.quantity, ...(metadata.comparison ? [r.actual,r.variance,r.comparison] : [])]));
  const detail=wb.addWorksheet('TheoDon'); detail.addRow(['Chỉ lệnh','PO','Mã hàng','Màu','Công đoạn','Số đôi cơ sở','Đã qua công đoạn','Còn lại','Mã vật tư','Tên vật tư','ĐVT','Định mức/đôi','Tồn lý thuyết','Nguồn','Dòng nguồn']);
  result.rows.forEach(r=>detail.addRow([r.orderNo,r.purchaseOrder,r.model,r.color,r.stage,r.qty,r.done,r.basisQty,r.materialCode,r.materialName,r.unit,r.rate,r.quantity,r.source,r.sourceRow]));
  const gaps=wb.addWorksheet('ChuaGhep'); gaps.addRow(['Chỉ lệnh','Mã hàng','Màu','Mã vật tư','Lý do']); result.unmapped.forEach(r=>gaps.addRow([r.productionOrder || r.orderNo || '',r.model || '',r.color || '',r.materialCode || '',r.reason || '']));
  for(const s of [sum,detail,gaps]) {s.views=[{state:'frozen',ySplit:1}]; s.columns.forEach(c=>{c.width=22;}); s.getRow(1).font={bold:true};}
  return wb.xlsx.writeBuffer();
}

// Counts are optional; keep null distinct from a real zero. Extra materials are
// not claimed as surplus when the theoretical side has gaps or no source.
export function compareSnapshotCounts(result, countRows, warehouseId) {
  const byKey = new Map();
  for (const c of countRows.filter(x=>x.warehouseId===warehouseId)) byKey.set([c.materialCode,c.unit].map(norm).join('|'),c);
  const canonicalCode = v => /^\d+$/.test(String(v).trim()) ? String(v).trim().replace(/^0+(?=\d)/,'') : norm(v);
  const rows=result.summary.map(r=>{
    const k=[r.materialCode,r.unit].map(norm).join('|'); let c=byKey.get(k), matchedKey=k;
    if (!c) { const candidates=[...byKey].filter(([,x])=>canonicalCode(x.materialCode)===canonicalCode(r.materialCode) && norm(x.unit)===norm(r.unit)); const theoretical=result.summary.filter(x=>canonicalCode(x.materialCode)===canonicalCode(r.materialCode) && norm(x.unit)===norm(r.unit)); if(candidates.length===1 && theoretical.length===1) [matchedKey,c]=candidates[0]; }
    if (c) byKey.delete(matchedKey);
    const actual=c ? c.quantity : null;
    return {...r,actual,variance:actual===null ? null : actual-r.quantity, comparison:actual===null ? 'Chưa đếm' : result.unmapped.length ? 'Tạm tính — còn dòng chưa ghép' : 'Đã đối chiếu'};
  });
  for (const c of byKey.values()) {
    const complete=result.hasSource && result.orderCount > 0 && !result.unmapped.length;
    rows.push({materialCode:c.materialCode,materialName:c.materialName,unit:c.unit,quantity:complete ? 0 : null,actual:c.quantity,variance:complete ? c.quantity : null,orderCount:0,details:[],comparison:complete ? 'Ngoài BOM đơn dở dang' : 'Ngoài kết quả đã ghép — cần rà soát'});
  }
  return rows;
}
export async function readCountWorkbook(file) {
  const { default: ExcelJS }=await import('exceljs'); const wb=new ExcelJS.Workbook(); await wb.xlsx.load(await file.arrayBuffer());
  const s=wb.getWorksheet('KiemDem'); if(!s) throw new Error('Cần sheet KiemDem; hãy dùng file mẫu.');
  const headers={}; s.getRow(1).eachCell((c,i)=>{headers[compact(c.value)]=i;});
  const cols=['KHO','MAVATTU','TENVATTU','DONVI','SODEMTHUCTE'].map(x=>headers[x]);
  if(cols.some(x=>!x)) throw new Error('Thiếu cột Kho, Mã vật tư, Tên vật tư, Đơn vị hoặc Số đếm thực tế.');
  const rows=[]; const seen=new Set();
  for(let r=2;r<=s.rowCount;r++) {
    const [warehouse,materialCode,materialName,unit,raw]=cols.map(c=>safeText(s.getCell(r,c).value)); if(![warehouse,materialCode,materialName,unit,raw].some(Boolean))continue;
    const warehouseId=warehouseAliases.get(compact(warehouse)); const quantity=raw===''?null:Number(raw.replace(',','.'));
    if(!warehouseId || !materialCode || !unit || quantity===null || !Number.isFinite(quantity) || quantity<0)throw new Error(`Dòng ${r} thiếu kho, mã, đơn vị hoặc số đếm hợp lệ.`);
    const k=[warehouseId,materialCode,unit].map(norm).join('|'); if(seen.has(k))throw new Error(`Trùng kho/mã vật tư/đơn vị ở dòng ${r}.`); seen.add(k);
    rows.push({warehouseId,materialCode,materialName,unit,quantity});
  }
  if(!rows.length)throw new Error('File chưa có dòng kiểm đếm.'); return rows;
}
export async function createCountTemplate() {
  const { default:ExcelJS }=await import('exceljs'); const wb=new ExcelJS.Workbook(); const s=wb.addWorksheet('KiemDem');
  s.addRow(['Kho','Mã vật tư','Tên vật tư','Đơn vị','Số đếm thực tế']); s.views=[{state:'frozen',ySplit:1}]; s.columns.forEach(c=>{c.width=25;}); return wb.xlsx.writeBuffer();
}

// Read the supplied multi-sheet workbook directly. Sheet 2 explicitly allocates
// each material to Hóa mẫu LAF or LVF in column T. An empty count stays absent.
export async function readWorkshopCounts(file) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await file.arrayBuffer());
  const catalog = wb.getWorksheet('1_Danh_Muc_Va_Ma_Tran_BOM');
  if (!catalog) throw new Error('Không thấy sheet danh mục 1_Danh_Muc_Va_Ma_Tran_BOM.');
  const byCatalog=new Map();
  for (let r=6;r<=catalog.rowCount;r++) {
    const id=safeText(catalog.getCell(r,1).value), code=catalog.getCell(r,3).text?.trim() || safeText(catalog.getCell(r,3).value), name=safeText(catalog.getCell(r,4).value), unit=safeText(catalog.getCell(r,6).value);
    if (!/^\d+$/.test(id) || !code || !unit) continue;
    if (byCatalog.has(id)) throw new Error(`Trùng STT danh mục ${id}; không thể ghép an toàn.`);
    byCatalog.set(id,{materialCode:code,materialName:name,unit});
  }
  const specs=[['2_Kho_Hoa_Mau',''],['3_Kho_Xuong_LAF','LAF'],['4_Kho_Xuong_LVF','LVF']];
  const grouped=new Map(), warnings=[], dates={};
  for (const [sheetName,fixed] of specs) {
    const s=wb.getWorksheet(sheetName); if (!s) throw new Error(`Không thấy sheet ${sheetName}.`);
    const h=s.getRow(16); if (compact(h.getCell(2).value)!=='STTDANHMUC' || compact(h.getCell(13).value)!=='KIEMKETHUCTE') throw new Error(`Sheet ${sheetName} không đúng cấu trúc Bảng B.`);
    const date=safeText(s.getCell(4,fixed?11:10).value); dates[fixed || 'HOA_MAU']=date || 'Không ghi mốc kiểm kê';
    for(let r=17;r<=s.rowCount;r++) {
      const id=safeText(s.getCell(r,2).value); const cell=s.getCell(r,13), raw=safeText(cell.value);
      if (!raw) { if(cell.value && typeof cell.value==='object' && (cell.value.formula || cell.value.sharedFormula)) warnings.push(`${sheetName} dòng ${r}: công thức số đếm không có kết quả lưu.`); continue; }
      if (!/^\d+$/.test(id) && norm(s.getCell(r,1).value).startsWith('TONG CONG')) continue;
      if (!/^\d+$/.test(id)) { warnings.push(`${sheetName} dòng ${r}: số đếm không có STT danh mục; đã bỏ qua.`); continue; }
      const material=byCatalog.get(id); const warehouseId=fixed || warehouseAliases.get(compact(s.getCell(r,20).value));
      const quantity=Number(raw.replace(',', '.'));
      if (!material || !warehouseId || !Number.isFinite(quantity) || quantity<0) { warnings.push(`${sheetName} dòng ${r}: thiếu danh mục, đơn vị, phân kho hoặc số đếm không hợp lệ.`); continue; }
      const k=[warehouseId,material.materialCode,material.unit].map(norm).join('|');
      if (!grouped.has(k)) grouped.set(k,{...material,warehouseId,quantity:0,sourceRows:[]});
      const x=grouped.get(k); x.quantity+=quantity; x.sourceRows.push(`${sheetName}!M${r} (STT ${id})`);
    }
  }
  const rows=[...grouped.values()];
  if (!rows.length) throw new Error('Workbook không có dòng kiểm đếm hợp lệ; xem sheet Bảng B cột M.');
  return {rows,warnings,dates};
}
