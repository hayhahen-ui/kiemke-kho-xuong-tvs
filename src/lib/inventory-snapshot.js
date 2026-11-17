import { getTheoreticalRequirements, normalizeJoinKey, resolveEffectiveStageQuantities, resolveOrderCommand, WAREHOUSES } from './model.js';

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
    const orderBomNorms = active(data.chemicalNorms,data.importMeta,`chemical-norms:${warehouseId}`).filter(r=>r.warehouseId===warehouseId);
    const bomLines = chemical ? [] : (data.bom || []).filter(r=>target(r)==='LVF');
    const norms = chemical ? orderBomNorms : [...orderBomNorms, ...bomLines];
    const classify=(row)=>{const v=norm(row.operation || ''); if(v==='MAY' || v==='SEW') return 'may'; if(v==='GO' || v==='ASSEMBLY') return 'go'; return '';};
    const unknown=norms.filter(r=>!classify(r)).map(r=>({...r,materialCode:r.materialCode || materials.get(String(r.catalogNo))?.materialCode || '',reason:'Chưa xác định công đoạn May/Gò cho dòng định mức LVF; không cộng để tránh tính trùng.'}));
    const make=(which)=>{
      const subset = chemical
        ? {...data,chemicalNorms:(data.chemicalNorms||[]).filter(r=>r.warehouseId!=='HOA_MAU_LVF' || classify(r)===which)}
        : {...data,chemicalNorms:(data.chemicalNorms||[]).filter(r=>r.warehouseId!=='LVF' || classify(r)===which),bom:(data.bom||[]).filter(r=>target(r)!=='LVF' || classify(r)===which)};
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
    const effectiveStages = resolveEffectiveStageQuantities(order.stageQuantities);
    const done = numberOrNull(effectiveStages?.[stage.key]);
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
    const k=[row.materialCode, row.materialColor || '', row.unit].map(norm).join('|');
    if (!grouped.has(k)) grouped.set(k,{materialCode:row.materialCode,materialName:row.materialName,materialColor:row.materialColor || '',unit:row.unit,quantity:0,details:[],orderKeys:new Set()});
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
export function buildStageExplanationRows(productionOrders = [], materialIssues = [], warehouseId = '') {
  const poIssueCount = new Map();
  for (const iss of materialIssues || []) {
    if (warehouseId && iss.warehouseId && iss.warehouseId !== warehouseId) continue;
    const po = norm(iss.po);
    if (!po || !(Number(iss.issuedQty) > 0)) continue;
    poIssueCount.set(po, (poIssueCount.get(po) || 0) + 1);
  }
  const rows = [];
  for (const order of productionOrders || []) {
    const s = order.stageQuantities || {};
    const received = numberOrNull(s.RECEIVED) ?? 0;
    const packed = numberOrNull(s.PACKED) ?? 0;
    const downstreamEnd = Math.max(received, packed);
    if (downstreamEnd <= 0) continue;

    const rawChat = numberOrNull(s.LAF_CUT);
    const rawMay = numberOrNull(s.LVF_SEW);
    const rawGo = numberOrNull(s.LVF_GO);
    const missingStages = [];
    if ((rawChat ?? 0) < downstreamEnd) missingStages.push(`Chặt=${rawChat ?? 'trống'}`);
    if ((rawMay ?? 0) < downstreamEnd) missingStages.push(`May=${rawMay ?? 'trống'}`);
    if ((rawGo ?? 0) < downstreamEnd) missingStages.push(`Gò=${rawGo ?? 'trống'}`);
    if (!missingStages.length) continue;

    const poKey = norm(order.purchaseOrder);
    const issueLines = poKey ? (poIssueCount.get(poKey) || 0) : 0;
    const issueNote = issueLines > 0 ? `Có ${issueLines} dòng xuất NVL theo PO` : 'Không có xuất NVL theo PO';
    const explanation = `Đã đóng thùng/nhập kho ${downstreamEnd} đôi nhưng thiếu ghi nhận (${missingStages.join(', ')}); ${issueNote}. Hệ thống tự suy luận đã SX tối thiểu ${downstreamEnd} đôi.`;
    rows.push({
      orderNo: order.orderNo || '',
      purchaseOrder: order.purchaseOrder || '',
      model: order.model || '',
      color: order.color || '',
      plannedQty: numberOrNull(order.plannedQty) ?? 0,
      rawChat: rawChat ?? 0,
      rawMay: rawMay ?? 0,
      rawGo: rawGo ?? 0,
      packed,
      received,
      issueLines,
      explanation,
    });
  }
  return rows;
}

export async function createSnapshotWorkbook(result, metadata) {
  const { default: ExcelJS }=await import('exceljs'); const wb=new ExcelJS.Workbook();
  const info=wb.addWorksheet('ThongTin');
  for (const row of [['Mốc kiểm kê',metadata.asOf],['Kho',metadata.warehouse],['Công đoạn',result.stage],['Cơ sở',metadata.modeLabel],['Cách gộp',metadata.groupByName ? 'Gộp theo tên vật tư (ghép chung mã)' : 'Tách theo mã vật tư'],['Múi giờ thiết bị',metadata.timeZone || ''],['File tiến độ',metadata.progressSource || ''],['File định mức',metadata.normSource || ''],['File số đôi đã lĩnh',metadata.issuedSource || ''],['File kiểm đếm',metadata.countSource || ''],['Ghi chú','Tính theo dữ liệu đã nạp hiện tại, không tự dựng lại dữ liệu quá khứ. Số dở dang theo định mức; không phải tồn sổ.'],['Cảnh báo','Kiểm tra ChuaGhep và GiaiThich; kết quả có thể chưa đầy đủ.']]) info.addRow(row); info.columns=[{width:25},{width:85}];
  const sum=wb.addWorksheet('TongHop'); sum.addRow(['Mã vật tư','Tên vật tư','Code màu','Đơn vị','Số chỉ lệnh','Tồn lý thuyết theo dở dang']);
  if (metadata.comparison) { sum.getRow(1).getCell(7).value='Đã lãnh kho tổng (chỉ lệnh dở dang)'; sum.getRow(1).getCell(8).value='Kiểm đếm thực tế'; sum.getRow(1).getCell(9).value='Chênh lệch tạm tính'; sum.getRow(1).getCell(10).value='Ghi chú'; }
  (metadata.comparison || metadata.summaryRows || result.summary).forEach(r=>sum.addRow([r.materialCode,r.materialName,r.materialColor || '',r.unit,r.orderCount,r.quantity, ...(metadata.comparison ? [r.issuedFromMain,r.actual,r.variance,r.comparison] : [])]));
  const detail=wb.addWorksheet('TheoDon'); detail.addRow(['Chỉ lệnh','PO','Mã hàng','Màu','Công đoạn','Số đôi cơ sở','Đã qua công đoạn','Còn lại','Mã vật tư','Tên vật tư','Code màu','ĐVT','Định mức/đôi','Tồn lý thuyết','Nguồn','Dòng nguồn']);
  result.rows.forEach(r=>detail.addRow([r.orderNo,r.purchaseOrder,r.model,r.color,r.stage,r.qty,r.done,r.basisQty,r.materialCode,r.materialName,r.materialColor || '',r.unit,r.rate,r.quantity,r.source,r.sourceRow]));
  const gaps=wb.addWorksheet('ChuaGhep'); gaps.addRow(['Chỉ lệnh','Mã hàng','Màu','Mã vật tư','Lý do']); result.unmapped.forEach(r=>gaps.addRow([r.productionOrder || r.orderNo || '',r.model || '',r.color || '',r.materialCode || '',r.reason || '']));
  const explain=wb.addWorksheet('GiaiThich');
  explain.addRow(['Chỉ lệnh','PO','Mã hàng','Màu','SL đơn hàng','Chặt (gốc)','May (gốc)','Gò (gốc)','Đóng thùng','Nhập kho','Xuất NVL theo PO (dòng)','Giải thích & Xử lý hệ thống']);
  const explainRows = buildStageExplanationRows(metadata.productionOrders, metadata.materialIssues, metadata.warehouseId);
  explainRows.forEach(r=>explain.addRow([r.orderNo,r.purchaseOrder,r.model,r.color,r.plannedQty,r.rawChat,r.rawMay,r.rawGo,r.packed,r.received,r.issueLines,r.explanation]));

  const recon=wb.addWorksheet('ThucLanh_SoVoi_LyThuyet');
  recon.addRow(['Mã vật tư','Tên vật tư','Code màu','Đơn vị','Tổng thực lãnh kho tổng','Lãnh cho chỉ lệnh dở dang (= cột G TongHop)','Lãnh cho đơn đã hoàn tất / đã nhập kho','Lãnh cho PO không có trong tiến độ','Xuất không gắn PO','Nhu cầu lý thuyết dở dang','Chênh lệch (Lãnh dở dang − Lý thuyết)','Ghi chú','Chi tiết PO']);
  const reconRows = (metadata.materialIssues || []).length
    ? buildIssuedVsTheoryRows(metadata.materialIssues, result, metadata.warehouseId, { lvfStage: metadata.lvfStage, productionOrders: metadata.productionOrders, groupByName: metadata.groupByName })
    : [];
  reconRows.forEach(r=>recon.addRow([r.materialCode,r.materialName,r.materialColor || '',r.unit,r.total,r.wip,r.done,r.notInProgress,r.noPo,r.theory,r.variance,r.note,r.poDetail]));
  if (reconRows.length) {
    const t = reconRows.reduce((a,r)=>({total:a.total+r.total,wip:a.wip+r.wip,done:a.done+r.done,nip:a.nip+r.notInProgress,nopo:a.nopo+r.noPo}),{total:0,wip:0,done:0,nip:0,nopo:0});
    const totalRow = recon.addRow(['TỔNG CỘNG','','','',t.total,t.wip,t.done,t.nip,t.nopo,'','','Tổng các đơn vị khác nhau chỉ mang tính tham khảo','']);
    totalRow.font = { bold: true };
  }

  // Formatting to match the reviewed template: colored tabs, bold header, frozen first row.
  const tabColors = [[info,'FFFFC000'],[sum,'FFFF99CC'],[detail,'FF92D050'],[gaps,'FF00B0F0'],[explain,'FFFF0000'],[recon,'FF7030A0']];
  for (const [s,color] of tabColors) s.properties.tabColor = { argb: color };
  const headerFill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFD9E1F2' } };
  for(const s of [sum,detail,gaps,explain,recon]) {
    s.views=[{state:'frozen',ySplit:1}];
    s.columns.forEach(c=>{c.width=18;});
    const h=s.getRow(1); h.font={bold:true}; h.alignment={vertical:'middle',wrapText:true}; h.height=32;
    h.eachCell(c=>{c.fill=headerFill;});
  }
  sum.getColumn(1).width=24; sum.getColumn(2).width=52; sum.getColumn(3).width=24; sum.getColumn(4).width=8; sum.getColumn(10).width=34;
  for (const c of [6,7,8,9]) sum.getColumn(c).numFmt='#,##0.00';
  if (metadata.comparison) {
    const yellow={ type:'pattern', pattern:'solid', fgColor:{ argb:'FFFFF2CC' } };
    sum.eachRow((row)=>{ row.getCell(7).fill=yellow; });
  }
  recon.getColumn(1).width=24; recon.getColumn(2).width=52; recon.getColumn(3).width=24; recon.getColumn(4).width=8; recon.getColumn(12).width=60; recon.getColumn(13).width=75;
  recon.getColumn(13).alignment = { wrapText: true, vertical: 'top' };
  for (const c of [5,6,7,8,9,10,11]) recon.getColumn(c).numFmt='#,##0.00';
  const reconFill={ type:'pattern', pattern:'solid', fgColor:{ argb:'FFFFF2CC' } };
  recon.eachRow((row)=>{ row.getCell(6).fill=reconFill; });
  explain.getColumn(12).width = 65;
  return wb.xlsx.writeBuffer();
}

const canonicalCode = (v) => (/^\d+$/.test(String(v).trim()) ? String(v).trim().replace(/^0+(?=\d)/, '') : norm(v));

export const ISSUE_CATEGORY = {
  WIP: 'Chỉ lệnh dở dang',
  DONE: 'Đơn đã hoàn tất công đoạn / đã nhập kho',
  NOT_IN_PROGRESS: 'PO không có trong file tiến độ',
  NO_PO: 'Xuất không gắn PO',
};

/**
 * Classify every main-warehouse issue line of the selected warehouse by the status of its PO:
 * only POs that still have unfinished pairs at the warehouse stage count toward TongHop.
 */
export function classifyWarehouseIssues(materialIssues, result, warehouseId, { lvfStage = '', productionOrders = [] } = {}) {
  const wipPOs = new Set((result?.rows || [])
    .filter((r) => Number(r.basisQty) > 0 || Number(r.quantity) > 0)
    .map((r) => norm(r.purchaseOrder)).filter(Boolean));
  const knownPOs = new Set((productionOrders || []).map((o) => norm(o.purchaseOrder)).filter(Boolean));
  for (const r of result?.rows || []) if (r.purchaseOrder) knownPOs.add(norm(r.purchaseOrder));
  const out = [];
  for (const row of materialIssues || []) {
    if (row.warehouseId !== warehouseId) continue;
    if ((warehouseId === 'LVF' || warehouseId === 'HOA_MAU_LVF') && (lvfStage === 'may' || lvfStage === 'go')) {
      const st = norm(row.stage || '');
      if (st && ((lvfStage === 'may' && !st.includes('MAY')) || (lvfStage === 'go' && !/\bGO\b/.test(st)))) continue;
    }
    const qty = Number(row.issuedQty);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const po = norm(row.po);
    let category;
    if (!po) category = 'NO_PO';
    else if (wipPOs.has(po)) category = 'WIP';
    else if (knownPOs.has(po)) category = 'DONE';
    else category = 'NOT_IN_PROGRESS';
    out.push({ ...row, issuedQty: qty, category });
  }
  return out;
}

export function summarizeWarehouseIssued(materialIssues, result, warehouseId, { lvfStage = '', productionOrders = [] } = {}) {
  const byKey = new Map();
  const byCanon = new Map();
  for (const row of classifyWarehouseIssues(materialIssues, result, warehouseId, { lvfStage, productionOrders })) {
    if (row.category !== 'WIP') continue;
    const colorKey = norm(row.materialColor || '');
    const k = [row.materialCode, colorKey, row.unit].map(norm).join('|');
    const existing = byKey.get(k) || { materialCode: row.materialCode, materialName: row.materialName, materialColor: row.materialColor || '', unit: row.unit, issuedFromMain: 0 };
    existing.issuedFromMain += row.issuedQty;
    byKey.set(k, existing);
    const ck = `${canonicalCode(row.materialCode)}|${colorKey}|${norm(row.unit)}`;
    if (!byCanon.has(ck)) byCanon.set(ck, k);
  }
  return { byKey, byCanon };
}

/**
 * Per-material reconciliation: total issued from the main warehouse split by PO status
 * versus the theoretical WIP requirement. Optionally merged by chemical name signature.
 */
export function buildIssuedVsTheoryRows(materialIssues, result, warehouseId, { lvfStage = '', productionOrders = [], groupByName = false } = {}) {
  const lines = classifyWarehouseIssues(materialIssues, result, warehouseId, { lvfStage, productionOrders });
  const keyOf = (code, name, unit, materialColor = '') => (groupByName
    ? `${normalizeMaterialNameKey(name) || norm(code)}|${norm(materialColor)}|${norm(unit)}`
    : `${canonicalCode(code)}|${norm(materialColor)}|${norm(unit)}`);
  const map = new Map();
  const get = (code, name, unit, materialColor = '') => {
    const k = keyOf(code, name, unit, materialColor);
    if (!map.has(k)) map.set(k, { codes: new Set(), names: [], materialColor: String(materialColor || '').trim(), unit, theory: 0, hasTheory: false, WIP: 0, DONE: 0, NOT_IN_PROGRESS: 0, NO_PO: 0, wipPOs: new Map(), donePOs: new Map(), otherPOs: new Map() });
    const x = map.get(k);
    if (code) x.codes.add(String(code).trim());
    if (name) x.names.push(name);
    if (!x.materialColor && materialColor) x.materialColor = String(materialColor).trim();
    return x;
  };
  for (const s of result?.summary || []) {
    const x = get(s.materialCode, s.materialName, s.unit, s.materialColor || '');
    x.theory += Number(s.quantity) || 0;
    x.hasTheory = true;
  }
  const addPoQty = (poMap, po, qty) => {
    const p = String(po || '').trim();
    if (!p) return;
    poMap.set(p, (poMap.get(p) || 0) + qty);
  };
  for (const l of lines) {
    const x = get(l.materialCode, l.materialName, l.unit, l.materialColor || '');
    x[l.category] += l.issuedQty;
    if (l.category === 'WIP') addPoQty(x.wipPOs, l.po, l.issuedQty);
    if (l.category === 'DONE') addPoQty(x.donePOs, l.po, l.issuedQty);
    if (l.category === 'NOT_IN_PROGRESS') addPoQty(x.otherPOs, l.po, l.issuedQty);
  }
  const formatPoMap = (poMap) => [...poMap.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'vi'))
    .map(([po, qty]) => `${po} (${Number(qty.toFixed(2))})`)
    .join(', ');
  const rows = [];
  for (const x of map.values()) {
    const total = x.WIP + x.DONE + x.NOT_IN_PROGRESS + x.NO_PO;
    if (total <= 0 && !x.hasTheory) continue;
    const name = x.names.find((n) => !/\bADIDAS\b/i.test(n)) || x.names[0] || '';
    const variance = x.WIP - x.theory;
    const notes = [];
    if (x.DONE > 0) notes.push(`${x.donePOs.size} PO đã hoàn tất/nhập kho vẫn có lãnh NVL`);
    if (x.NOT_IN_PROGRESS > 0) notes.push(`${x.otherPOs.size} PO không có trong tiến độ`);
    if (x.NO_PO > 0) notes.push('Có xuất không gắn PO');
    if (!x.hasTheory && total > 0) notes.push('Không có nhu cầu lý thuyết dở dang');
    const poParts = [];
    if (x.wipPOs.size) poParts.push(`Dở dang (${x.wipPOs.size}): ${formatPoMap(x.wipPOs)}`);
    if (x.donePOs.size) poParts.push(`Hoàn tất (${x.donePOs.size}): ${formatPoMap(x.donePOs)}`);
    if (x.otherPOs.size) poParts.push(`Ngoài tiến độ (${x.otherPOs.size}): ${formatPoMap(x.otherPOs)}`);
    rows.push({
      materialCode: [...x.codes].join(' / '),
      materialName: name,
      materialColor: x.materialColor,
      unit: x.unit,
      total,
      wip: x.WIP,
      done: x.DONE,
      notInProgress: x.NOT_IN_PROGRESS,
      noPo: x.NO_PO,
      theory: x.hasTheory ? x.theory : 0,
      variance,
      note: notes.join('; '),
      poDetail: poParts.join(' | ').slice(0, 32000),
    });
  }
  return rows.sort((a, b) => String(a.materialCode).localeCompare(String(b.materialCode), 'vi', { numeric: true }) || String(a.materialColor).localeCompare(String(b.materialColor), 'vi'));
}

// Counts are optional; keep null distinct from a real zero. Extra materials are
// not claimed as surplus when the theoretical side has gaps or no source.
export function compareSnapshotCounts(result, countRows, warehouseId, { materialIssues = [], lvfStage = '', productionOrders = [] } = {}) {
  const byKey = new Map();
  for (const c of countRows.filter(x=>x.warehouseId===warehouseId)) byKey.set([c.materialCode, c.materialColor || '', c.unit].map(norm).join('|'), c);
  const hasIssueData = Array.isArray(materialIssues) && materialIssues.length > 0;
  const { byKey: issuedMap, byCanon: issuedCanon } = hasIssueData
    ? summarizeWarehouseIssued(materialIssues, result, warehouseId, { lvfStage, productionOrders })
    : { byKey: new Map(), byCanon: new Map() };
  const takeIssued = (materialCode, materialColor, unit) => {
    if (!hasIssueData) return null;
    const colorKey = norm(materialColor || '');
    const k = [materialCode, colorKey, unit].map(norm).join('|');
    let hit = issuedMap.get(k);
    if (!hit) {
      const ck = `${canonicalCode(materialCode)}|${colorKey}|${norm(unit)}`;
      const mappedKey = issuedCanon.get(ck);
      if (mappedKey) { hit = issuedMap.get(mappedKey); issuedMap.delete(mappedKey); }
    } else {
      issuedMap.delete(k);
    }
    return hit ? hit.issuedFromMain : 0;
  };
  const summaryCodeUnitCount = new Map();
  for (const r of result.summary || []) {
    const cu = `${canonicalCode(r.materialCode)}|${norm(r.unit)}`;
    summaryCodeUnitCount.set(cu, (summaryCodeUnitCount.get(cu) || 0) + 1);
  }
  const rows=result.summary.map(r=>{
    const colorKey = norm(r.materialColor || '');
    const k=[r.materialCode, colorKey, r.unit].map(norm).join('|'); let c=byKey.get(k), matchedKey=k;
    if (!c && colorKey && summaryCodeUnitCount.get(`${canonicalCode(r.materialCode)}|${norm(r.unit)}`) === 1) {
      const noColorKey = [r.materialCode, '', r.unit].map(norm).join('|');
      if (byKey.has(noColorKey)) { c = byKey.get(noColorKey); matchedKey = noColorKey; }
    }
    if (!c) { const candidates=[...byKey].filter(([,x])=>canonicalCode(x.materialCode)===canonicalCode(r.materialCode) && norm(x.unit)===norm(r.unit) && (!colorKey || norm(x.materialColor || '') === colorKey || summaryCodeUnitCount.get(`${canonicalCode(r.materialCode)}|${norm(r.unit)}`) === 1)); const theoretical=result.summary.filter(x=>canonicalCode(x.materialCode)===canonicalCode(r.materialCode) && norm(x.unit)===norm(r.unit)); if(candidates.length===1 && theoretical.length===1) [matchedKey,c]=candidates[0]; }
    if (c) byKey.delete(matchedKey);
    const actual=c ? c.quantity : null;
    const issuedFromMain = takeIssued(r.materialCode, r.materialColor || '', r.unit);
    return {...r,issuedFromMain,actual,variance:actual===null ? null : actual-r.quantity, comparison:actual===null ? 'Chưa đếm' : result.unmapped.length ? 'Tạm tính — còn dòng chưa ghép' : 'Đã đối chiếu'};
  });
  for (const c of byKey.values()) {
    const complete=result.hasSource && result.orderCount > 0 && !result.unmapped.length;
    const issuedFromMain = takeIssued(c.materialCode, c.materialColor || '', c.unit);
    rows.push({materialCode:c.materialCode,materialName:c.materialName,materialColor:c.materialColor || '',unit:c.unit,quantity:complete ? 0 : null,issuedFromMain,actual:c.quantity,variance:complete ? c.quantity : null,orderCount:0,details:[],comparison:complete ? 'Ngoài BOM đơn dở dang' : 'Ngoài kết quả đã ghép — cần rà soát'});
  }
  for (const iss of issuedMap.values()) {
    const complete=result.hasSource && result.orderCount > 0 && !result.unmapped.length;
    rows.push({materialCode:iss.materialCode,materialName:iss.materialName,materialColor:iss.materialColor || '',unit:iss.unit,quantity:complete ? 0 : null,issuedFromMain:iss.issuedFromMain,actual:null,variance:null,orderCount:0,details:[],comparison:'Đã lãnh kho tổng — chưa đếm'});
  }
  return rows;
}

const SUBSCRIPT_DIGITS = { '₀':'0','₁':'1','₂':'2','₃':'3','₄':'4','₅':'5','₆':'6','₇':'7','₈':'8','₉':'9' };
const CHEMICAL_STOP_WORDS = new Set([
  'CHAT','TRO','XUC','TIEN','VA','LAM','MEM','PHAN','TAN','CAO','SU','TANG','DINH',
  'CHONG','PHUN','SUONG','LUU','HOA','DON','TAO','DANG','HAT','BOT','SIEU','MAI','MON',
  'BAT','MAU','CAM','DO','TONG','HOP','NUOC','XU','LY','VAI','DONG','CUNG','KEO',
  'VE','SINH','PHA','BONG','MO','HE','NS',
]);

/**
 * Normalize a material name for cross-code grouping by extracting its chemical
 * signature (strips accents, brackets, ADIDAS tags, trailing (1)/(2) batch suffixes,
 * glued Vietnamese prefixes, and generic chemical category words).
 */
export function normalizeMaterialNameKey(name) {
  let text = String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
  text = text.replace(/[₀-₉]/g, (c) => SUBSCRIPT_DIGITS[c]).toUpperCase();
  text = text.replace(/\(?\s*ADIDAS\s*\)?/g, ' ').replace(/\(\d+\)\s*$/g, ' ');
  text = text.replace(/[\[\]\(\),;._#\/]+/g, ' ');
  text = text
    .replace(/CAO\s*SU(?=[A-Z0-9])/g, 'CAO SU ')
    .replace(/MEM(?=[A-Z0-9])/g, 'MEM ')
    .replace(/TAN(?=[A-Z0-9])/g, 'TAN ')
    .replace(/MAU(?=[A-Z0-9])/g, 'MAU ')
    .replace(/CAM\s*DO(?=[A-Z0-9])/g, 'CAM DO ')
    .replace(/BOT(?=[A-Z0-9])/g, 'BOT ')
    .replace(/(\d)(CHAT)/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  const rawTokens = text.split(' ').map((w) => w.replace(/-/g, '')).filter(Boolean);
  const sig = rawTokens.filter((w, i, arr) => !CHEMICAL_STOP_WORDS.has(w) && (i === 0 || w !== arr[i - 1]));
  if (sig.length) {
    const codes = sig.filter((w) => /[A-Z]/.test(w) && /\d/.test(w));
    if (codes.length) return codes.join('');
    return sig.join('');
  }
  return rawTokens.join('');
}

/**
 * Merge inventory summary/comparison rows by normalized material name + unit,
 * combining all matched material codes onto a single row ("code1 / code2").
 */
export function mergeRowsByMaterialName(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    const nameKey = normalizeMaterialNameKey(row.materialName) || norm(row.materialCode);
    const groupKey = `${nameKey}|${norm(row.materialColor || '')}|${norm(row.unit)}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(row);
  }
  const merged = [];
  for (const list of groups.values()) {
    const codes = [...new Set(list.map((r) => String(r.materialCode || '').trim()).filter(Boolean))];
    const preferredName = (list.find((r) => !/\bADIDAS\b/i.test(String(r.materialName || ''))) || list[0]).materialName;
    const hasQty = list.some((r) => r.quantity !== null && r.quantity !== undefined);
    const quantity = hasQty ? list.reduce((sum, r) => sum + (r.quantity ?? 0), 0) : null;
    const hasIssued = list.some((r) => r.issuedFromMain !== null && r.issuedFromMain !== undefined);
    const issuedFromMain = hasIssued ? list.reduce((sum, r) => sum + (r.issuedFromMain ?? 0), 0) : null;
    const hasActual = list.some((r) => r.actual !== null && r.actual !== undefined);
    const actual = hasActual ? list.reduce((sum, r) => sum + (r.actual ?? 0), 0) : null;
    const variance = hasQty && hasActual ? actual - quantity : null;
    const details = list.flatMap((r) => r.details || []);
    const orderIds = new Set(details.map((d) => d.orderNo).filter(Boolean));
    const orderCount = orderIds.size || list.reduce((max, r) => Math.max(max, Number(r.orderCount) || 0), 0);
    let comparison;
    if (actual === null) comparison = hasIssued && issuedFromMain > 0 && quantity === 0 ? 'Đã lãnh kho tổng — chưa đếm' : 'Chưa đếm';
    else if (quantity === null) comparison = 'Ngoài kết quả đã ghép — cần rà soát';
    else if (list.some((r) => String(r.comparison || '').includes('Tạm tính'))) comparison = 'Tạm tính — còn dòng chưa ghép';
    else if (list.every((r) => String(r.comparison || '').includes('Ngoài BOM')) && quantity === 0) comparison = 'Ngoài BOM đơn dở dang';
    else comparison = 'Đã đối chiếu';
    merged.push({
      ...list[0],
      materialCode: codes.join(' / '),
      materialCodes: codes,
      materialName: preferredName,
      quantity,
      issuedFromMain,
      actual,
      variance,
      orderCount,
      details,
      comparison,
    });
  }
  return merged;
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

function colLettersToIndex(letters) {
  let col = 0;
  for (let i = 0; i < letters.length; i += 1) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  return col;
}

function decodeXmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function classifyIssueWarehouse(dept, group) {
  const d = compact(dept);
  const g = compact(group);
  const isChem = g.includes('HOACHAT');
  if (d.includes('LAF')) return isChem ? 'HOA_MAU_LAF' : 'LAF';
  if (d.includes('LVF')) return isChem ? 'HOA_MAU_LVF' : 'LVF';
  if (d === 'HOAMAU' && isChem) return 'HOA_MAU_LAF';
  return '';
}

async function parseFirstSheetRowsWithJSZip(source, onRow) {
  const { default: JSZip } = await import('jszip');
  const buf = typeof source?.arrayBuffer === 'function' ? await source.arrayBuffer() : source;
  const zip = await JSZip.loadAsync(buf);

  const strings = [];
  const ssFile = zip.file('xl/sharedStrings.xml');
  if (ssFile) {
    const ssXml = await ssFile.async('string');
    const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let m;
    while ((m = siRe.exec(ssXml)) !== null) {
      let s = '';
      let tm;
      tRe.lastIndex = 0;
      while ((tm = tRe.exec(m[1])) !== null) s += tm[1];
      strings.push(decodeXmlEntities(s));
    }
  }

  const sheetPaths = Object.keys(zip.files)
    .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(p))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!sheetPaths.length) throw new Error('Không tìm thấy sheet dữ liệu trong file Excel.');

  const sheetXml = await zip.file(sheetPaths[0]).async('string');
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  const cellRe = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
  const vRe = /<v\b[^>]*>([\s\S]*?)<\/v>/;
  const tInlineRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;

  const parseRow = (rowInner) => {
    const cells = {};
    let cm;
    cellRe.lastIndex = 0;
    while ((cm = cellRe.exec(rowInner)) !== null) {
      const attrs = cm[1];
      const body = cm[2] || '';
      const refM = /\br="([A-Z]+)\d+"/i.exec(attrs);
      if (!refM) continue;
      const col = colLettersToIndex(refM[1].toUpperCase());
      const typeM = /\bt="([^"]+)"/i.exec(attrs);
      const cellType = typeM ? typeM[1] : '';
      let val = '';
      if (cellType === 'inlineStr') {
        let tm;
        tInlineRe.lastIndex = 0;
        while ((tm = tInlineRe.exec(body)) !== null) val += tm[1];
        val = decodeXmlEntities(val);
      } else {
        const vm = vRe.exec(body);
        if (vm) {
          val = cellType === 's' ? (strings[Number(vm[1])] ?? '') : decodeXmlEntities(vm[1]);
        }
      }
      cells[col] = String(val).trim();
    }
    return cells;
  };

  let rowMatch;
  let rowIndex = 0;
  while ((rowMatch = rowRe.exec(sheetXml)) !== null) {
    rowIndex += 1;
    const stop = onRow(parseRow(rowMatch[1]), rowIndex);
    if (stop === false) break;
  }
}

/**
 * Parse ERP/warehouse material issue export (e.g. chi tiet vat tu thuc xuat theo so po.xlsx).
 * Uses JSZip directly so .xlsx files with non-standard namespace prefixes (e.g. d3p1:id)
 * parse reliably in both browser and Node.
 */
export async function readMaterialIssueWorkbook(source) {
  let headerCols = null;
  const grouped = new Map();
  let totalRows = 0;

  await parseFirstSheetRowsWithJSZip(source, (cells, rowIndex) => {
    if (!headerCols) {
      const map = {};
      for (const [c, v] of Object.entries(cells)) map[compact(v)] = Number(c);
      if (map.MAVATTU && (map.SOLUONGXUATKHO || map.THUCLANH || map.DALANH)) {
        const unitCol = map.DONVI || 30;
        const matColorCol = (cells[unitCol - 1] && compact(cells[unitCol - 1]) === 'MAU') ? (unitCol - 1) : (map.MAU > map.MAVATTU ? map.MAU : 29);
        headerCols = {
          dept: map.DONVIYEUCAU || 10,
          stage: map.CONGDOANSANXUAT || 11,
          cmd: map.SOCHILENH || 14,
          po: map.SOPO || 16,
          group: map.NHOMLON || 21,
          code: map.MAVATTU,
          name: map.TENVATTU || 25,
          materialColor: matColorCol,
          unit: unitCol,
          issuedQty: map.SOLUONGXUATKHO || map.THUCLANH || map.DALANH,
        };
      } else if (rowIndex > 10) {
        return false;
      }
      return true;
    }

    const materialCode = cells[headerCols.code] || '';
    const rawQty = cells[headerCols.issuedQty] || '';
    const issuedQty = Number(String(rawQty).replace(',', '.'));
    if (!materialCode || !Number.isFinite(issuedQty) || issuedQty <= 0) return true;

    const dept = cells[headerCols.dept] || '';
    const group = cells[headerCols.group] || '';
    const warehouseId = classifyIssueWarehouse(dept, group);
    if (!warehouseId) return true;

    const po = cells[headerCols.po] || '';
    const stage = cells[headerCols.stage] || '';
    const materialName = cells[headerCols.name] || '';
    const materialColor = cells[headerCols.materialColor] || '';
    const unit = cells[headerCols.unit] || '';
    totalRows += 1;

    const k = [warehouseId, po, stage, materialCode, materialColor, unit].map(norm).join('|');
    if (!grouped.has(k)) {
      grouped.set(k, { warehouseId, po, stage, materialCode, materialName, materialColor, unit, issuedQty: 0 });
    }
    grouped.get(k).issuedQty += issuedQty;
    return true;
  });

  if (!headerCols) throw new Error('Không thấy cột Mã vật tư và Số lượng xuất kho trong file thực xuất kho tổng.');
  const rows = [...grouped.values()];
  if (!rows.length) throw new Error('File thực xuất kho tổng không có dòng xuất kho hợp lệ (> 0) cho 4 kho LAF/LVF.');
  return { rows, totalRows };
}

/**
 * Parse DM NHU CAU THEO BOM.xlsx (col AE = order-level qty, col AF = per-size qty)
 * and route each row into HOA_MAU_LVF, LAF, or LVF (skipping HOA_MAU_LAF rubber already covered by DM-NPL-DH).
 */
export async function readBomDemandWorkbook(source, { workshopCounts = [], materialIssues = [], materials = [] } = {}) {
  const issueWhByPoCode = new Map();
  const issueWhByCode = new Map();
  const issueStageByCode = new Map();
  for (const iss of materialIssues || []) {
    const ck = canonicalCode(iss.materialCode);
    if (!ck || !iss.warehouseId) continue;
    if (!issueWhByCode.has(ck)) issueWhByCode.set(ck, new Set());
    issueWhByCode.get(ck).add(iss.warehouseId);
    if (iss.stage && !issueStageByCode.has(ck)) issueStageByCode.set(ck, iss.stage);
    if (iss.po) {
      const pk = `${norm(iss.po)}|${ck}`;
      if (!issueWhByPoCode.has(pk)) issueWhByPoCode.set(pk, { warehouseId: iss.warehouseId, stage: iss.stage || '' });
    }
  }
  const countWhByCode = new Map();
  for (const c of workshopCounts || []) {
    const ck = canonicalCode(c.materialCode);
    if (!ck || !c.warehouseId) continue;
    if (!countWhByCode.has(ck)) countWhByCode.set(ck, new Set());
    countWhByCode.get(ck).add(c.warehouseId);
  }
  const matPlantByCode = new Map();
  for (const m of materials || []) {
    const ck = canonicalCode(m.materialCode);
    const plants = (m.plants || []).filter((p) => p === 'LAF' || p === 'LVF');
    if (ck && plants.length === 1) matPlantByCode.set(ck, plants[0]);
  }

  let headerCols = null;
  const grouped = new Map();
  let totalRows = 0;

  await parseFirstSheetRowsWithJSZip(source, (cells, rowIndex) => {
    if (!headerCols) {
      const map = {};
      for (const [c, v] of Object.entries(cells)) map[compact(v)] = Number(c);
      if (map.MAVATTU && (map.CHILENHDH || map.CHILENH) && (map.SOLUONGTHEODONHANG || map.SOLUONGTUNGSIZE)) {
        const unitCol = map.DONVI || 30;
        const matColorCol = (cells[unitCol - 1] && compact(cells[unitCol - 1]) === 'MAU') ? (unitCol - 1) : (map.MAU > map.MAVATTU ? map.MAU : 29);
        headerCols = {
          orderNo: map.CHILENHDH || map.CHILENH || 11,
          po: map.SOPO || 12,
          sourceOrderQty: map.SLDONHANG || 14,
          model: map.MAHANG || 17,
          colorCode: map.MAMAU || 18,
          colorName: map.TENMAU || 19,
          group: map.NHOMLON || 20,
          subGroup: map.NHOMVUA || 21,
          code: map.MAVATTU || 23,
          name: map.TENVATTU || 24,
          size: map.SIZE || 27,
          materialColor: matColorCol,
          unit: unitCol,
          orderBomQty: map.SOLUONGTHEODONHANG || 31,
          sizeBomQty: map.SOLUONGTUNGSIZE || 32,
        };
      } else if (rowIndex > 10) {
        return false;
      }
      return true;
    }

    const orderNo = cells[headerCols.orderNo] || '';
    const materialCode = cells[headerCols.code] || '';
    const sourceOrderQty = Number(String(cells[headerCols.sourceOrderQty] || '').replace(',', '.'));
    const orderBomQty = Number(String(cells[headerCols.orderBomQty] || '').replace(',', '.')) || 0;
    const sizeBomQty = Number(String(cells[headerCols.sizeBomQty] || '').replace(',', '.')) || 0;
    const rowQty = sizeBomQty > 0 ? sizeBomQty : orderBomQty;
    if (!orderNo || !materialCode || !(sourceOrderQty > 0) || !(rowQty > 0)) return true;

    const group = compact(cells[headerCols.group] || '');
    const subGroup = compact(cells[headerCols.subGroup] || '');
    if (group === 'VATTUHOACHAT' && subGroup === 'CAOSU') return true;

    const po = cells[headerCols.po] || '';
    const ck = canonicalCode(materialCode);
    const poHit = po ? issueWhByPoCode.get(`${norm(po)}|${ck}`) : null;
    const countWhs = countWhByCode.get(ck);
    const issueWhs = issueWhByCode.get(ck);

    let warehouseId = '';
    if (poHit) warehouseId = poHit.warehouseId;
    else if (countWhs?.size === 1) warehouseId = [...countWhs][0];
    else if (issueWhs?.size === 1) warehouseId = [...issueWhs][0];
    else if (matPlantByCode.has(ck)) warehouseId = matPlantByCode.get(ck);
    else if (group === 'VATTUDONGGOI') warehouseId = 'LVF';
    else if (group === 'VATTUHOACHAT') warehouseId = subGroup === 'MUC' ? 'LAF' : 'HOA_MAU_LVF';
    else if (group === 'VATTUVAI') warehouseId = 'LAF';
    else if (group === 'VATTUPHULIEU') warehouseId = (subGroup === 'CHI' || subGroup === 'KHOEN') ? 'LVF' : 'LAF';
    if (!warehouseId || warehouseId === 'HOA_MAU_LAF') return true;

    let operation = 'Chặt';
    if (warehouseId === 'LVF' || warehouseId === 'HOA_MAU_LVF') {
      const rawStage = norm(poHit?.stage || issueStageByCode.get(ck) || '');
      if (rawStage.includes('MAY')) operation = 'May';
      else if (subGroup === 'CHI' || norm(cells[headerCols.name] || '').includes('CHI ')) operation = 'May';
      else operation = 'Gò';
    }

    const model = cells[headerCols.model] || '';
    const color = cells[headerCols.colorName] || cells[headerCols.colorCode] || '';
    const unit = cells[headerCols.unit] || '';
    const materialName = cells[headerCols.name] || '';
    const materialColor = cells[headerCols.materialColor] || '';
    totalRows += 1;

    const k = [warehouseId, orderNo, model, color, materialCode, materialColor, unit, operation].map(norm).join('|');
    if (!grouped.has(k)) {
      grouped.set(k, {
        warehouseId,
        productionOrder: orderNo,
        purchaseOrder: po,
        model,
        color,
        colorCode: cells[headerCols.colorCode] || '',
        component: cells[headerCols.subGroup] || cells[headerCols.group] || '',
        formulaName: cells[headerCols.size] ? `Size (${cells[headerCols.size]})` : '',
        operation,
        materialCode,
        materialName,
        materialColor,
        unit,
        sourceOrderQty,
        sourceQuantity: 0,
        orderBomQty: 0,
        sizeBomQty: 0,
        sizeCount: 0,
        sourceFile: 'DM NHU CAU THEO BOM.xlsx',
        sourceRow: rowIndex,
      });
    }
    const item = grouped.get(k);
    item.sourceQuantity += rowQty;
    item.orderBomQty += orderBomQty;
    item.sizeBomQty += sizeBomQty;
    item.sizeCount += 1;
    if (item.sizeCount > 1) item.formulaName = `${item.sizeCount} size/cụm (AF)`;
    return true;
  });

  if (!headerCols) throw new Error('Không thấy cột Chỉ lệnh ĐH, Mã vật tư và Số lượng theo đơn hàng/từng size (AE/AF) trong file DM NHU CAU THEO BOM.');
  const rows = [...grouped.values()];
  if (!rows.length) throw new Error('File DM NHU CAU THEO BOM không có dòng định mức hợp lệ cho các kho.');
  return { rows, totalRows };
}
