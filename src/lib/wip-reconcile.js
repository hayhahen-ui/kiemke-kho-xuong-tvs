import { resolveEffectiveStageQuantities } from './model.js';

const norm = (v) => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').trim().toUpperCase();
const compact = (v) => norm(v).replace(/[^A-Z0-9]/g, '');

const isAccessoryOrder = (o) => /PHU\s*KIEN|PHỤ\s*KIỆN|ACCESSORY|PHU\s*LIEU|PHỤ\s*LIỆU/i.test(
  `${o.productType || ''} ${o.sourceSheet || ''} ${o.model || ''} ${o.customer || ''}`
);

function cellRaw(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('result' in value) return cellRaw(value.result);
    if (Array.isArray(value.richText)) return value.richText.map((t) => t.text || '').join('');
    if ('text' in value) return String(value.text || '');
  }
  return value;
}

function cellText(row, col) {
  if (!col) return '';
  const v = cellRaw(row.getCell(col).value);
  return String(v ?? '').trim();
}

function cellNumberOrNull(row, col) {
  if (!col) return null;
  const v = cellRaw(row.getCell(col).value);
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function normalizePlant(raw) {
  const c = compact(raw);
  if (c.includes('LAF')) return 'LAF';
  if (c.includes('LVF')) return 'LVF';
  return '';
}

export function wipConfirmKey(plant, orderNo) {
  return `${normalizePlant(plant) || norm(plant)}|${norm(orderNo)}`;
}

/**
 * Parse DON HANG DO DANG THUC TE XUONG BAO CAO.xlsx (sheet DATA or first sheet).
 */
export async function readWorkshopWipReport(source) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const buf = typeof source?.arrayBuffer === 'function' ? await source.arrayBuffer() : source;
  await wb.xlsx.load(buf);
  const sheet = wb.worksheets.find((s) => compact(s.name) === 'DATA') || wb.worksheets[0];
  if (!sheet) throw new Error('Không tìm thấy sheet DATA trong file báo cáo dở dang xưởng.');

  let headerRow = 0;
  let cols = null;
  for (let r = 1; r <= Math.min(sheet.rowCount, 15); r += 1) {
    const map = {};
    sheet.getRow(r).eachCell((cell, colNumber) => {
      const k = compact(cellRaw(cell.value));
      if (k) map[k] = colNumber;
    });
    const orderCol = map.CHILENH || map.SOCHILENH;
    const plantCol = map.NHAMAY || map.XUONG;
    const wipCol = map.SOLUONGDODANGKYKIEMKE || map.SOLUONGDODANG || map.DODANG || map.SLDODANG;
    if (orderCol && plantCol && wipCol) {
      headerRow = r;
      cols = {
        orderNo: orderCol,
        so: map.MASO || map.SO || 0,
        po: map.MAPO || map.SOPO || 0,
        model: map.MAHANG || map.MODEL || 0,
        colorCode: map.MAMAU || 0,
        colorName: map.TENMAU || map.MAU || 0,
        plannedQty: map.SOLUONGDATHANG || map.SLDONHANG || map.SOLUONGDONHANG || 0,
        goQty: map.GO || 0,
        reportedWip: wipCol,
        plant: plantCol,
        cutoffDate: map.NGAYCHOTSOLUONGKIEMKE || map.NGAYCHOT || 0,
      };
      break;
    }
  }
  if (!cols) throw new Error('Không thấy cột Chỉ lệnh, Nhà máy và Số lượng dở dang kỳ kiểm kê trong file.');

  const rows = [];
  for (let r = headerRow + 1; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    const orderNo = cellText(row, cols.orderNo);
    const plant = normalizePlant(cellText(row, cols.plant));
    const reportedWip = cellNumberOrNull(row, cols.reportedWip);
    if (!orderNo || !plant || reportedWip === null) continue;
    rows.push({
      sourceRow: r,
      orderNo,
      so: cellText(row, cols.so),
      po: cellText(row, cols.po),
      model: cellText(row, cols.model),
      colorCode: cellText(row, cols.colorCode),
      colorName: cellText(row, cols.colorName),
      plannedQty: cellNumberOrNull(row, cols.plannedQty),
      goQty: cellNumberOrNull(row, cols.goQty),
      reportedWip,
      plant,
      cutoffDate: cellText(row, cols.cutoffDate),
    });
  }
  if (!rows.length) throw new Error('File báo cáo dở dang xưởng không có dòng dữ liệu hợp lệ.');
  return { rows, sourceFile: source?.name || 'DON HANG DO DANG THUC TE XUONG BAO CAO.xlsx' };
}

/**
 * Compare system WIP (from TIEN-DO-SX-DONHANG) against workshop reported WIP
 * for both LAF (Chặt = S − U) and LVF (Gò = S − W), and attach confirmed values.
 */
export function reconcileWorkshopWip(productionOrders = [], workshopWipReports = [], confirmedMap = {}) {
  const validOrders = (productionOrders || []).filter((o) => !isAccessoryOrder(o) && o.orderNo);
  const sysByOrder = new Map();
  for (const o of validOrders) {
    const k = norm(o.orderNo);
    const planned = Number(o.plannedQty) || 0;
    const eff = resolveEffectiveStageQuantities(o.stageQuantities || {});
    const lafDone = Number(eff.LAF_CUT) || 0;
    const lvfSewDone = Number(eff.LVF_SEW) || 0;
    const lvfGoDone = Number(eff.LVF_GO) || 0;
    const existing = sysByOrder.get(k) || {
      orderNo: o.orderNo,
      po: o.purchaseOrder || '',
      model: o.model || '',
      color: o.color || '',
      customer: o.customer || '',
      plannedQty: 0,
      lafDone: 0,
      lvfSewDone: 0,
      lvfGoDone: 0,
    };
    existing.plannedQty += planned;
    existing.lafDone += lafDone;
    existing.lvfSewDone += lvfSewDone;
    existing.lvfGoDone += lvfGoDone;
    sysByOrder.set(k, existing);
  }

  const repByKey = new Map();
  for (const r of workshopWipReports || []) {
    const k = wipConfirmKey(r.plant, r.orderNo);
    const prev = repByKey.get(k);
    if (!prev) {
      repByKey.set(k, { ...r });
    } else {
      prev.reportedWip = (Number(prev.reportedWip) || 0) + (Number(r.reportedWip) || 0);
    }
  }

  const rows = [];
  const seenKeys = new Set();

  for (const plant of ['LAF', 'LVF']) {
    for (const [ordKey, sys] of sysByOrder) {
      const k = `${plant}|${ordKey}`;
      const rep = repByKey.get(k) || null;
      const done = plant === 'LAF' ? sys.lafDone : sys.lvfGoDone;
      const systemWip = Math.max(0, sys.plannedQty - done);
      if (systemWip <= 0 && !rep) continue;
      seenKeys.add(k);
      const reportedWip = rep ? Number(rep.reportedWip) : null;
      const diff = reportedWip === null ? null : reportedWip - systemWip;
      let status = 'Khớp';
      if (reportedWip === null) status = 'Hệ thống có dở dang — Xưởng chưa báo';
      else if (systemWip === 0 && reportedWip > 0) status = 'Xưởng báo — Hệ thống đã xong (0)';
      else if (diff > 0.0001) status = 'Xưởng báo cao hơn hệ thống';
      else if (diff < -0.0001) status = 'Xưởng báo thấp hơn hệ thống';

      const confirmedVal = confirmedMap && Object.prototype.hasOwnProperty.call(confirmedMap, k)
        ? Number(confirmedMap[k])
        : null;

      rows.push({
        key: k,
        plant,
        stageLabel: plant === 'LAF' ? 'Chặt (S − U)' : 'Gò (S − W)',
        orderNo: sys.orderNo,
        so: rep?.so || '',
        po: rep?.po || sys.po || '',
        model: rep?.model || sys.model || '',
        color: rep?.colorCode || sys.color || '',
        customer: sys.customer || '',
        systemPlanned: sys.plannedQty,
        reportedPlanned: rep?.plannedQty ?? null,
        systemDone: done,
        reportedGo: rep?.goQty ?? null,
        systemWip,
        reportedWip,
        diff,
        status,
        cutoffDate: rep?.cutoffDate || '',
        confirmedQty: Number.isFinite(confirmedVal) ? confirmedVal : null,
      });
    }

    for (const [k, rep] of repByKey) {
      if (!k.startsWith(`${plant}|`) || seenKeys.has(k)) continue;
      const confirmedVal = confirmedMap && Object.prototype.hasOwnProperty.call(confirmedMap, k)
        ? Number(confirmedMap[k])
        : null;
      rows.push({
        key: k,
        plant,
        stageLabel: plant === 'LAF' ? 'Chặt (S − U)' : 'Gò (S − W)',
        orderNo: rep.orderNo,
        so: rep.so || '',
        po: rep.po || '',
        model: rep.model || '',
        color: rep.colorCode || rep.colorName || '',
        customer: '',
        systemPlanned: 0,
        reportedPlanned: rep.plannedQty ?? null,
        systemDone: 0,
        reportedGo: rep.goQty ?? null,
        systemWip: 0,
        reportedWip: Number(rep.reportedWip) || 0,
        diff: Number(rep.reportedWip) || 0,
        status: 'Xưởng báo — Không thấy trong tiến độ',
        cutoffDate: rep.cutoffDate || '',
        confirmedQty: Number.isFinite(confirmedVal) ? confirmedVal : null,
      });
    }
  }

  rows.sort((a, b) => a.plant.localeCompare(b.plant) || Math.abs(b.diff ?? b.systemWip) - Math.abs(a.diff ?? a.systemWip) || a.orderNo.localeCompare(b.orderNo, 'vi'));

  const summarize = (list) => ({
    count: list.length,
    matched: list.filter((r) => r.status === 'Khớp').length,
    mismatch: list.filter((r) => r.status !== 'Khớp').length,
    missingReport: list.filter((r) => r.status === 'Hệ thống có dở dang — Xưởng chưa báo').length,
    systemWipTotal: list.reduce((s, r) => s + r.systemWip, 0),
    reportedWipTotal: list.reduce((s, r) => s + (r.reportedWip ?? 0), 0),
    confirmedWipTotal: list.reduce((s, r) => s + (r.confirmedQty ?? 0), 0),
    confirmedCount: list.filter((r) => r.confirmedQty !== null).length,
  });

  return {
    rows,
    summary: summarize(rows),
    byPlant: {
      LAF: summarize(rows.filter((r) => r.plant === 'LAF')),
      LVF: summarize(rows.filter((r) => r.plant === 'LVF')),
    },
  };
}

export async function createWipReconcileWorkbook(reconcile, metadata = {}) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };

  const sumSheet = wb.addWorksheet('TongHop_DoiChieu');
  sumSheet.addRow(['Nhà máy', 'Số chỉ lệnh đối chiếu', 'Khớp hoàn toàn', 'Có sai lệch / Thiếu báo cáo', 'Tổng dở dang Hệ thống (đôi)', 'Tổng dở dang Xưởng báo (đôi)', 'Chênh lệch (Xưởng − HT)', 'Tổng đã chốt kiểm kê (đôi)']);
  for (const plant of ['LAF', 'LVF']) {
    const b = reconcile.byPlant[plant];
    sumSheet.addRow([plant, b.count, b.matched, b.mismatch, b.systemWipTotal, b.reportedWipTotal, b.reportedWipTotal - b.systemWipTotal, b.confirmedWipTotal]);
  }
  const s = reconcile.summary;
  const totalRow = sumSheet.addRow(['TỔNG CỘNG', s.count, s.matched, s.mismatch, s.systemWipTotal, s.reportedWipTotal, s.reportedWipTotal - s.systemWipTotal, s.confirmedWipTotal]);
  totalRow.font = { bold: true };
  sumSheet.addRow([]);
  sumSheet.addRow(['Ngày xuất báo cáo', metadata.exportedAt || new Date().toLocaleString('vi-VN')]);
  sumSheet.addRow(['Trạng thái chốt', metadata.confirmedActive ? `Đang áp dụng số đã chốt (${metadata.confirmedAt || ''})` : 'Chưa áp dụng số chốt (hệ thống tính theo tiến độ ERP)']);

  const addDetailSheet = (name, list, tabColor) => {
    const sh = wb.addWorksheet(name);
    sh.properties.tabColor = { argb: tabColor };
    sh.addRow(['Nhà máy', 'Công đoạn', 'Chỉ lệnh', 'Mã SO', 'Mã PO#', 'Mã hàng', 'Màu', 'SL đặt hàng (HT)', 'Đã SX (HT)', 'Dở dang Hệ thống', 'Dở dang Xưởng báo', 'Chênh lệch (Xưởng − HT)', 'Trạng thái đối chiếu', 'Số chốt kiểm kê', 'Ngày chốt xưởng']);
    for (const r of list) {
      sh.addRow([r.plant, r.stageLabel, r.orderNo, r.so, r.po, r.model, r.color, r.systemPlanned, r.systemDone, r.systemWip, r.reportedWip, r.diff, r.status, r.confirmedQty, r.cutoffDate]);
    }
    return sh;
  };

  const diffSheet = addDetailSheet('ChiTiet_SaiLech', reconcile.rows.filter((r) => r.status !== 'Khớp'), 'FFFF0000');
  const allSheet = addDetailSheet('ToanBo_DoiChieu', reconcile.rows, 'FF00B0F0');
  sumSheet.properties.tabColor = { argb: 'FFFFC000' };

  for (const sh of [sumSheet, diffSheet, allSheet]) {
    sh.views = [{ state: 'frozen', ySplit: 1 }];
    sh.columns.forEach((c) => { c.width = 18; });
    const h = sh.getRow(1);
    h.font = { bold: true };
    h.alignment = { vertical: 'middle', wrapText: true };
    h.height = 30;
    h.eachCell((c) => { c.fill = headerFill; });
  }
  diffSheet.getColumn(13).width = 34;
  allSheet.getColumn(13).width = 34;
  return wb.xlsx.writeBuffer();
}
