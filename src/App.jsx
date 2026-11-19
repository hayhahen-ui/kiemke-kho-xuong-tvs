import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, ArrowDownToLine, ArrowLeftRight, BookOpen, Boxes, Check, ChevronDown,
  CircleAlert, ClipboardCheck, ClipboardList, Cloud, CloudOff, FileSpreadsheet, Filter,
  Gauge, GitBranch, Layers3, LogOut, Menu, Moon, Package, Plus, RefreshCw, Search, Settings2,
  ShieldCheck, Sun, Upload, X,
} from 'lucide-react';
import { PLANTS, WAREHOUSES, getInventoryRows, getPlantName, getPlantSummary, getTheoreticalRequirements, getWarehouseName, summarizeTheoreticalRequirements, inventoryKey, mergeWipProgress, money, orderKey, productKey, productMappingKey, resolveEffectiveStageQuantities, resolveOrderCommand, statusTone } from './lib/model.js';
import { createTaskWorkbook, importTaskWorkbook, taskFilename } from './lib/task-workbooks.js';
import { loadLocalState, saveLocalState } from './lib/local-db.js';
import { supabase, cloudMode } from './lib/supabase.js';
import { ensureWorkspace, loadWorkspaceRecords, saveWorkspaceRecords } from './lib/cloud.js';
import { calculateInventorySnapshot, readIssuedWorkbook, createIssuedTemplate, createSnapshotWorkbook, readCountWorkbook, readWorkshopCounts, createCountTemplate, compareSnapshotCounts, mergeRowsByMaterialName, readMaterialIssueWorkbook, readBomDemandWorkbook, buildStageExplanationRows, classifyWarehouseIssues } from './lib/inventory-snapshot.js';
import { fetchRealDataBundle } from './lib/real-data.js';
import { readWorkshopWipReport, reconcileWorkshopWip, createWipReconcileWorkbook } from './lib/wip-reconcile.js';

const emptyData = () => ({ materials: [], bom: [], orders: [], productionOrders: [], productMappings: [], orderMappings: [], chemicalNorms: [], importMeta: {}, inventory: {}, norms: [], workshopCounts: null, materialIssues: [], workshopWipReports: [], confirmedWip: null });
const navItems = [
  { id: 'overview', label: 'Tổng quan', icon: Gauge },
  { id: 'snapshot', label: 'Tồn theo đơn dở dang', icon: ClipboardCheck },
  { id: 'wip-reconcile', label: 'Đối chiếu dở dang', icon: ArrowLeftRight },
  { id: 'guide', label: 'Hướng dẫn & Sơ đồ', icon: GitBranch },
  { id: 'orders', label: 'Đơn hàng', icon: Layers3 },
  { id: 'data-entry', label: 'Tác vụ nhập liệu', icon: ClipboardList },
  { id: 'catalog', label: 'Danh mục & BOM', icon: Boxes },
  { id: 'norms', label: 'Định mức BTP LAF', icon: Settings2 },
];

function mergeRows(existing, incoming, keyOf) {
  const merged = new Map((existing || []).map((item) => [keyOf(item), item]));
  for (const item of incoming || []) merged.set(keyOf(item), item);
  return [...merged.values()];
}

function materialKey(row) { return String(row.catalogNo); }
function bomKey(row) { return `${row.catalogNo}|${row.plant || 'ALL'}|${row.warehouseId || ''}|${row.productKey}|${row.operation || ''}|${row.supplyRoute || ''}|${row.size || ''}|${row.process || ''}`; }
function normKey(row) { return `${row.catalogNo}|${row.productKey}|${row.size}|${row.process}|${row.btpCode || ''}${row.sourceRow ? '|row:' + row.sourceRow : ''}`; }

function currentImportedRows(rows, importMeta, taskId) {
  const batchId = importMeta?.[taskId]?.batchId;
  return batchId ? (rows || []).filter((row) => row.batchId === batchId) : (rows || []);
}

const isAccessoryOrder = (o) => /PHU\s*KIEN|PHỤ\s*KIỆN|ACCESSORY|PHU\s*LIEU|PHỤ\s*LIỆU/i.test(
  `${o.productType || ''} ${o.sourceSheet || ''} ${o.model || ''} ${o.customer || ''}`
);

function currentOrderRows(data) {
  const productionOrders = currentImportedRows(data.productionOrders, data.importMeta, 'production-orders');
  const base = productionOrders.length ? productionOrders : (data.orders || []);
  return base.filter((o) => !isAccessoryOrder(o));
}

function orderResolutionContext(data) {
  return {
    chemicalRows: WAREHOUSES.filter((item) => item.kind === 'chemical')
      .flatMap((item) => currentImportedRows(data.chemicalNorms, data.importMeta, 'chemical-norms:' + item.id).filter((row) => row.warehouseId === item.id)),
    mappings: currentImportedRows(data.orderMappings, data.importMeta, 'order-mapping'),
  };
}

function resolvedOrderNo(order, context) {
  return resolveOrderCommand(order, context.chemicalRows, context.mappings).orderNo;
}

function App() {
  const [data, setData] = useState(() => emptyData());
  const [localLoading, setLocalLoading] = useState(!cloudMode);
  const [page, setPage] = useState('overview');
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('kk_theme') || 'light'; } catch { return 'light'; }
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('kk_theme', theme); } catch {}
  }, [theme]);
  const [selectedPlant, setSelectedPlant] = useState('LAF');
  const [selectedWarehouse, setSelectedWarehouse] = useState('HOA_MAU_LAF');
  const [session, setSession] = useState(null);
  const [workspaceId, setWorkspaceId] = useState(null);
  const [cloudLoading, setCloudLoading] = useState(cloudMode);
  const [saving, setSaving] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [toast, setToast] = useState('');
  const [modal, setModal] = useState('');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [catalogTab, setCatalogTab] = useState('materials');
  const [busyTask, setBusyTask] = useState('');
  const [taskErrors, setTaskErrors] = useState({});

  useEffect(() => {
    if (cloudMode) return undefined;
    let alive = true;
    loadLocalState(emptyData)
      .then(async (saved) => {
        if (!alive) return;
        const hasAnyData = (saved.productionOrders?.length || 0) > 0 || (saved.materials?.length || 0) > 0;
        if (hasAnyData) {
          try {
            const bundled = await fetchRealDataBundle();
            const isNewerBundle = bundled.bundleGeneratedAt && bundled.bundleGeneratedAt !== saved.bundleGeneratedAt;
            const needsMaterialColorUpgrade = saved.materialIssues?.some((m) => m.materialColor === undefined);
            const hasLegacyDonHangOrders = (saved.orders?.length || 0) > 0 && (saved.productionOrders?.length || 0) > 0;
            const needsSync = isNewerBundle || !(saved.materialIssues?.length) || !saved.importMeta?.['chemical-norms:LVF'] || needsMaterialColorUpgrade || hasLegacyDonHangOrders;
            if (alive && needsSync && (bundled.productionOrders?.length || bundled.materialIssues?.length || bundled.chemicalNorms?.length)) {
              const updated = { ...emptyData(), ...bundled, confirmedWip: saved.confirmedWip || null };
              await saveLocalState(updated);
              setData(updated);
              return;
            }
          } catch {}
          setData(saved);
          return;
        }
        try {
          const bundled = await fetchRealDataBundle();
          if (!alive) return;
          const hydrated = { ...emptyData(), ...bundled };
          await saveLocalState(hydrated);
          if (alive) setData(hydrated);
        } catch {
          if (alive) setData(saved);
        }
      })
      .finally(() => { if (alive) setLocalLoading(false); });
    return () => { alive = false; };
  }, []);

  const notify = useCallback((message) => {
    setToast(message);
    window.clearTimeout(notify.timer);
    notify.timer = window.setTimeout(() => setToast(''), 3200);
  }, []);

  useEffect(() => {
    if (cloudMode) return undefined;
    let checking = false;
    const checkLatestBundle = async () => {
      if (checking) return;
      checking = true;
      try {
        const bundled = await fetchRealDataBundle();
        if (bundled.bundleGeneratedAt && bundled.bundleGeneratedAt !== data.bundleGeneratedAt) {
          const updated = { ...emptyData(), ...bundled, confirmedWip: data.confirmedWip || null };
          await saveLocalState(updated);
          setData(updated);
          notify('Đã tự động đồng bộ dữ liệu mới nhất từ ổ O:.');
        }
      } catch {} finally {
        checking = false;
      }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') checkLatestBundle(); };
    const timer = window.setInterval(checkLatestBundle, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [data.bundleGeneratedAt, notify]);

  const hydrateCloud = useCallback(async (user) => {
    if (!user || !supabase) return;
    setCloudLoading(true);
    try {
      const workspace = await ensureWorkspace(supabase);
      const cloudData = await loadWorkspaceRecords(supabase, workspace);
      setWorkspaceId(workspace);
      setData({ ...emptyData(), ...cloudData });
      setLoginError('');
    } catch (error) {
      setLoginError(error.message || 'Không tải được dữ liệu dùng chung.');
    } finally {
      setCloudLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!supabase) return undefined;
    let alive = true;
    supabase.auth.getSession().then(({ data: result }) => {
      if (!alive) return;
      setSession(result.session);
      if (result.session?.user) hydrateCloud(result.session.user);
      else setCloudLoading(false);
    }).catch(() => setCloudLoading(false));
    const { data: authData } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      if (newSession?.user) window.setTimeout(() => hydrateCloud(newSession.user), 0);
      else {
        setWorkspaceId(null);
        setData(emptyData());
        setCloudLoading(false);
      }
    });
    return () => {
      alive = false;
      authData.subscription.unsubscribe();
    };
  }, [hydrateCloud]);

  useEffect(() => {
    const openImport = () => setPage('data-entry');
    window.addEventListener('open-import', openImport);
    return () => window.removeEventListener('open-import', openImport);
  }, []);

  const commit = useCallback(async (next, changedTypes = []) => {
    if (!cloudMode) {
      try {
        await saveLocalState(next);
        setData(next);
        return true;
      } catch (error) {
        notify(`Không lưu được dữ liệu trên thiết bị: ${error.message || 'lỗi bộ nhớ'}`);
        return false;
      }
    }
    if (!session?.user || !workspaceId) return false;
    setSaving(true);
    try {
      await saveWorkspaceRecords(supabase, workspaceId, session.user.id, next, changedTypes);
      setData(next);
      return true;
    } catch (error) {
      notify(`Chưa đồng bộ được: ${error.message || 'lỗi kết nối'}`);
      return false;
    } finally {
      setSaving(false);
    }
  }, [notify, session, workspaceId]);

  const signIn = async (event) => {
    event.preventDefault();
    setLoginError('');
    const form = new FormData(event.currentTarget);
    const { error } = await supabase.auth.signInWithPassword({
      email: String(form.get('email') || '').trim(),
      password: String(form.get('password') || ''),
    });
    if (error) setLoginError('Email hoặc mật khẩu không đúng.');
  };

  const importTask = async (taskId, file) => {
    setBusyTask(taskId);
    setTaskErrors((current) => ({ ...current, [taskId]: '' }));
    try {
      const imported = await importTaskWorkbook(taskId, file);
      let next = data;
      let changed = [];
      let count = 0;
      if (taskId === 'workshop-bundle') {
        count = imported.materials.length + imported.bom.length + imported.norms.length;
        next = { ...data, materials: imported.materials, bom: imported.bom, norms: imported.norms, importMeta: {...data.importMeta, [taskId]: {taskId, sourceFile:file.name, importedAt:new Date().toISOString(), rowCount:count}} };
        changed = ['material','bom','norm','import_meta'];
      } else if (taskId === 'orders') {
        count = imported.orders.length;
        next = { ...data, orders: mergeRows(data.orders, imported.orders, orderKey) };
        changed = ['order'];
      } else if (taskId === 'wip') {
        const result = mergeWipProgress(data.orders, imported.wip);
        count = result.matched;
        next = { ...data, orders: result.orders };
        changed = ['order'];
        if (result.unmatched) notify(`Đã cập nhật ${result.matched} dòng WIP; bỏ qua ${result.unmatched} dòng không khớp đơn hàng và nhà máy.`);
      } else if (taskId === 'materials') {
        count = imported.materials.length;
        next = { ...data, materials: mergeRows(data.materials, imported.materials, materialKey) };
        changed = ['material'];
      } else if (taskId === 'bom') {
        count = imported.bom.length;
        next = { ...data, bom: mergeRows(data.bom, imported.bom, bomKey) };
        changed = ['bom'];
      } else if (taskId === 'norms') {
        count = imported.norms.length;
        next = { ...data, norms: mergeRows(data.norms, imported.norms, normKey) };
        changed = ['norm'];
      } else if (taskId.startsWith('inventory:')) {
        count = Object.keys(imported.inventory).length;
        next = { ...data, inventory: { ...data.inventory, ...imported.inventory } };
        changed = ['inventory'];
      } else if (taskId === 'production-orders') {
        const batchId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const productionOrders = imported.productionOrders.map((order) => ({ ...order, batchId }));
        count = productionOrders.length;
        const importMeta = { ...data.importMeta, [taskId]: { taskId, batchId, sourceFile: file.name, importedAt: new Date().toISOString(), rowCount: count } };
        next = { ...data, productionOrders, importMeta };
        changed = ['production_order', 'import_meta'];
      } else if (taskId === 'order-mapping') {
        const batchId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const orderMappings = imported.orderMappings.map((mapping) => ({ ...mapping, batchId }));
        count = orderMappings.length;
        const importMeta = {
          ...data.importMeta,
          [taskId]: { taskId, batchId, sourceFile: file.name, importedAt: new Date().toISOString(), rowCount: count, orderMappings },
        };
        next = { ...data, orderMappings, importMeta };
        changed = ['import_meta'];
      } else if (taskId === 'product-mapping') {
        count = imported.productMappings.length;
        const manualMappings = imported.productMappings.map((row) => ({ ...row, sourceType: 'manual' }));
        next = { ...data, productMappings: mergeRows(data.productMappings, manualMappings, productMappingKey) };
        changed = ['product_mapping'];
      } else if (taskId.startsWith('chemical-norms:')) {
        const batchId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const chemicalNorms = [
          ...(data.chemicalNorms || []).filter((row) => row.warehouseId !== imported.warehouseId),
          ...imported.chemicalNorms.map((row) => ({ ...row, batchId })),
        ];
        count = imported.chemicalNorms.length;
        const importMeta = { ...data.importMeta, [taskId]: { taskId, batchId, sourceFile: file.name, importedAt: new Date().toISOString(), rowCount: count } };
        next = { ...data, chemicalNorms, importMeta };
        changed = ['chemical_norm', 'import_meta'];
      }
      const saved = await commit(next, changed);
      if (!saved) return;
      if (taskId.startsWith('chemical-norms:')) notify(`Đã chuẩn hóa ${count} dòng định mức hóa chất cho ${getWarehouseName(imported.warehouseId)}.`);
      else if (!(taskId === 'wip' && count < imported.wip.length)) notify(`Đã nhập ${count} dòng vào tác vụ ${taskId}.`);
    } catch (error) {
      setTaskErrors((current) => ({ ...current, [taskId]: error.message || 'Không nhập được file.' }));
    } finally {
      setBusyTask('');
    }
  };

  const exportTask = async (taskId, template = false) => {
    try {
      let exportData = data;
      if (template) exportData = emptyData();
      const bytes = await createTaskWorkbook(taskId, exportData);
      const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = taskFilename(taskId);
      link.click();
      URL.revokeObjectURL(url);
      notify(template ? 'Đã tải file mẫu cho tác vụ.' : 'Đã xuất dữ liệu tác vụ ra Excel.');
    } catch (error) {
      notify(error.message || 'Không tạo được file Excel.');
    }
  };

  const saveMaterial = async (form) => {
    const catalogNo = Number(form.catalogNo) || Math.max(0, ...data.materials.map((item) => Number(item.catalogNo) || 0)) + 1;
    const material = {
      catalogNo,
      materialCode: form.materialCode.trim(),
      name: form.name.trim(),
      unit: form.unit.trim(),
      issueUnit: form.issueUnit.trim(),
      packQty: Number(form.packQty) || 0,
      packagingWeight: 0,
      colorScope: form.colorScope.trim() || 'Dùng chung theo BOM',
      plants: form.plants,
    };
    if (!material.materialCode || !material.name || !material.plants.length) {
      notify('Hãy nhập mã, tên vật tư và chọn ít nhất một nhà máy.');
      return;
    }
    const next = { ...data, materials: mergeRows(data.materials, [material], materialKey) };
    if (!await commit(next, ['material'])) return;
    setModal('');
    notify(`Đã lưu vật tư ${material.materialCode} cho ${material.plants.length} nhà máy.`);
  };

  const saveBom = async (form) => {
    const line = {
      catalogNo: Number(form.catalogNo),
      model: form.model.trim(),
      color: form.color.trim(),
      productKey: productKey(form.model, form.color),
      rate: Number(form.rate),
      plant: form.plant || null,
    };
    if (!line.catalogNo || !line.model || !line.color || !(line.rate > 0)) {
      notify('Hãy nhập đủ vật tư, mã hàng, màu và định mức lớn hơn 0.');
      return;
    }
    const next = { ...data, bom: mergeRows(data.bom, [line], bomKey) };
    if (!await commit(next, ['bom'])) return;
    setModal('');
    notify('Đã lưu định mức BOM.');
  };

  const saveNorm = async (form) => {
    const material = data.materials.find((item) => Number(item.catalogNo) === Number(form.catalogNo));
    const norm = {
      catalogNo: Number(form.catalogNo),
      materialCode: material?.materialCode || '',
      materialName: material?.name || '',
      productKey: productKey(form.model, form.color),
      size: form.size.trim(),
      process: form.process.trim(),
      btpCode: form.btpCode.trim(),
      btpName: form.btpName.trim(),
      rate: Number(form.rate),
      plannedQty: Number(form.plannedQty) || 0,
      wipQty: Number(form.wipQty) || 0,
    };
    if (!norm.catalogNo || !form.model.trim() || !form.color.trim() || !norm.size || !(norm.rate > 0)) {
      notify('Hãy nhập vật tư, mã hàng-màu, size và định mức lớn hơn 0.');
      return;
    }
    const next = { ...data, norms: mergeRows(data.norms, [norm], normKey) };
    if (!await commit(next, ['norm'])) return;
    setModal('');
    notify('Đã lưu định mức BTP theo size.');
  };

  const saveOrder = async (form) => {
    const order = {
      orderNo: form.orderNo.trim(),
      model: form.model.trim(),
      color: form.color.trim(),
      colorName: form.colorName.trim(),
      plannedQty: Number(form.plannedQty) || 0,
      plant: form.plant || 'LAF',
      progress: { HOA_MAU: 0, LAF: 0, LVF: 0 },
      status: 'Chờ sản xuất',
      sourceSheet: 'Nhập trực tiếp',
    };
    if (!order.orderNo || !order.model || !order.color || order.plannedQty <= 0) {
      notify('Hãy nhập mã đơn, mã hàng, màu sắc và số lượng kế hoạch.');
      return;
    }
    const next = { ...data, orders: mergeRows(data.orders, [order], orderKey) };
    if (!await commit(next, ['order'])) return;
    setModal('');
    notify('Đã thêm đơn hàng.');
  };

  const updateInventory = async (row, field, value) => {
    const key = inventoryKey(row.plant, row.catalogNo);
    const previous = data.inventory[key] || { catalogNo: row.catalogNo, plant: row.plant, received: 0, actual: null };
    const nextEntry = { ...previous, catalogNo: row.catalogNo, plant: row.plant, [field]: value === '' ? null : Number(value) };
    const next = { ...data, inventory: { ...data.inventory, [key]: nextEntry } };
    await commit(next, ['inventory']);
  };

  const updateOrderProgress = async (order, plant, value) => {
    const progress = { ...(order.progress || {}), [plant]: Number(value) || 0 };
    const nextOrders = data.orders.map((item) => orderKey(item) === orderKey(order) ? { ...item, progress } : item);
    await commit({ ...data, orders: nextOrders }, ['order']);
  };

  const refreshCloud = async () => {
    if (!supabase || !workspaceId) return;
    setCloudLoading(true);
    try {
      setData(await loadWorkspaceRecords(supabase, workspaceId));
      notify('Đã tải lại dữ liệu dùng chung.');
    } catch (error) {
      notify(error.message || 'Không tải được dữ liệu.');
    } finally {
      setCloudLoading(false);
    }
  };

  const loadRealDataset = async () => {
    setBusyTask('real-bundle');
    try {
      const bundled = await fetchRealDataBundle();
      const next = { ...emptyData(), ...bundled };
      const saved = await commit(next, ['material', 'bom', 'order', 'inventory', 'norm', 'production_order', 'chemical_norm', 'import_meta']);
      if (saved) notify(`Đã nạp dữ liệu thực tế (${bundled.productionOrders.length} dòng tiến độ, ${bundled.materials.length} vật tư, ${bundled.chemicalNorms.length} định mức hóa chất).`);
    } catch (error) {
      notify(error.message || 'Không nạp được gói dữ liệu thực tế.');
    } finally {
      setBusyTask('');
    }
  };

  const saveWorkshopCounts = async (workshopCounts) => {
    const next = {
      ...data,
      workshopCounts,
      importMeta: {
        ...data.importMeta,
        'workshop-counts': {
          taskId: 'workshop-counts',
          dates: workshopCounts?.dates || null,
          warnings: workshopCounts?.warnings || [],
          importedAt: new Date().toISOString(),
          rowCount: workshopCounts?.rows?.length || 0,
        },
      },
    };
    await commit(next, ['workshop_count', 'import_meta']);
  };

  const saveMaterialIssues = async (materialIssues, sourceName) => {
    const next = {
      ...data,
      materialIssues,
      importMeta: {
        ...data.importMeta,
        'material-issues': { taskId: 'material-issues', sourceFile: sourceName, importedAt: new Date().toISOString(), rowCount: materialIssues.length },
      },
    };
    await commit(next, ['material_issue', 'import_meta']);
  };

  const saveBomDemand = async (bomRows, sourceName) => {
    const importedWarehouses = new Set(['HOA_MAU_LVF', 'LAF', 'LVF']);
    const kept = (data.chemicalNorms || []).filter((r) => !importedWarehouses.has(r.warehouseId));
    const nextNorms = [...kept, ...bomRows];
    const now = new Date().toISOString();
    const countOf = (wh) => bomRows.filter((r) => r.warehouseId === wh).length;
    const next = {
      ...data,
      chemicalNorms: nextNorms,
      importMeta: {
        ...data.importMeta,
        'chemical-norms:HOA_MAU_LVF': { taskId: 'chemical-norms:HOA_MAU_LVF', sourceFile: sourceName, importedAt: now, rowCount: countOf('HOA_MAU_LVF') },
        'chemical-norms:LAF': { taskId: 'chemical-norms:LAF', sourceFile: sourceName, importedAt: now, rowCount: countOf('LAF') },
        'chemical-norms:LVF': { taskId: 'chemical-norms:LVF', sourceFile: sourceName, importedAt: now, rowCount: countOf('LVF') },
      },
    };
    await commit(next, ['chemical_norm', 'import_meta']);
  };

  const saveWorkshopWipReports = async (rows, sourceName) => {
    const next = {
      ...data,
      workshopWipReports: rows,
      importMeta: {
        ...data.importMeta,
        'workshop-wip-report': { taskId: 'workshop-wip-report', sourceFile: sourceName, importedAt: new Date().toISOString(), rowCount: rows.length },
      },
    };
    await commit(next, ['import_meta']);
    notify(`Đã nạp ${rows.length} dòng báo cáo dở dang thực tế từ ${sourceName}.`);
  };

  const saveConfirmedWip = async (confirmedWip) => {
    const next = { ...data, confirmedWip };
    await commit(next, ['import_meta']);
    notify(confirmedWip?.active ? 'Đã chốt số đôi dở dang LAF/LVF và áp dụng tính kiểm kê 4 kho.' : 'Đã hủy áp dụng số chốt; hệ thống quay về tính theo tiến độ ERP.');
  };

  const signOut = async () => { if (supabase) await supabase.auth.signOut(); };

  if (!cloudMode && localLoading) return <LoadingScreen label="Đang tải dữ liệu kho xưởng" />;
  if (cloudMode && cloudLoading) return <LoadingScreen label="Đang đồng bộ dữ liệu xưởng" />;
  if (cloudMode && !session) return <LoginScreen onSubmit={signIn} error={loginError} />;
  if (cloudMode && session && !workspaceId && loginError) return <CloudAccessScreen error={loginError} onSignOut={signOut} />;

  const currentNav = navItems.find((item) => item.id === page) || navItems[0];
  const currentRows = getInventoryRows(data, selectedPlant);

  const setPageSafe = (id) => {
    setPage(id);
    setMobileNavOpen(false);
  };

  const openWarehouseSnapshot = (warehouseId) => {
    setSelectedWarehouse(warehouseId);
    setPageSafe('snapshot');
  };

  return (
    <div className="app-shell">
      <Sidebar page={page} setPage={setPageSafe} selectedWarehouse={selectedWarehouse} onSelectWarehouse={openWarehouseSnapshot} mobileOpen={mobileNavOpen} onClose={() => setMobileNavOpen(false)} />
      <main className="main-shell">
        <header className="topbar">
          <button className="icon-button mobile-menu" aria-label="Mở menu" onClick={() => setMobileNavOpen(true)}><Menu size={19} /></button>
          <div className="breadcrumbs"><span>Kho xưởng</span><i>/</i><strong>{currentNav.label}</strong></div>
          <div className="topbar-actions">
            <button
              type="button"
              className="button button-secondary button-small theme-toggle"
              onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
              title={theme === 'dark' ? 'Chuyển sang chế độ Sáng' : 'Chuyển sang chế độ Tối'}
            >
              {theme === 'dark' ? <><Sun size={15} /> Chế độ Sáng</> : <><Moon size={15} /> Chế độ Tối</>}
            </button>
            <span className={`connection-pill ${cloudMode ? 'is-cloud' : 'is-local'}`}>
              {cloudMode ? <Cloud size={14} /> : <CloudOff size={14} />}
              {cloudMode ? (saving ? 'Đang lưu' : 'Dữ liệu dùng chung') : 'Chế độ thiết bị'}
            </span>
            {cloudMode && <button className="icon-button" title="Tải lại dữ liệu" onClick={refreshCloud}><RefreshCw size={17} /></button>}
            <button className="button button-primary button-small" onClick={() => setPage('data-entry')}><Upload size={15} /> Tác vụ nhập liệu</button>
            {cloudMode && <button className="icon-button" title="Đăng xuất" onClick={signOut}><LogOut size={17} /></button>}
          </div>
        </header>

        <div className="page-content">
          {!cloudMode && <div className="local-notice"><ShieldCheck size={17} /><span><strong>Đồng bộ tự động từ ổ O:.</strong> Nguồn: <code>O:\1 KHOI VAN HANH\BO PHAN KHO\KIEM KE KHO - XUONG</code>{data.bundleGeneratedAt ? ` · Cập nhật: ${new Date(data.bundleGeneratedAt).toLocaleString('vi-VN')}` : ''}.</span><button onClick={loadRealDataset} disabled={busyTask === 'real-bundle'}>{busyTask === 'real-bundle' ? 'Đang đồng bộ...' : 'Đồng bộ mới nhất'}</button></div>}
          {page === 'overview' && <Dashboard data={data} setPage={setPageSafe} onOpenWarehouse={openWarehouseSnapshot} />}
          {page === 'guide' && <GuidePage data={data} setPage={setPageSafe} onOpenWarehouse={openWarehouseSnapshot} />}
          {page === 'orders' && <OrdersPage data={data} onAdd={() => setModal('order')} onProgress={updateOrderProgress} />}
          {page === 'snapshot' && <SnapshotPage data={data} selectedWarehouse={selectedWarehouse} setWarehouse={setSelectedWarehouse} onSaveCounts={saveWorkshopCounts} onSaveMaterialIssues={saveMaterialIssues} onSaveBomDemand={saveBomDemand} onOpenReconcile={() => setPageSafe('wip-reconcile')} />}
          {page === 'wip-reconcile' && <WipReconcilePage data={data} onImportReport={saveWorkshopWipReports} onSaveConfirmed={saveConfirmedWip} onOpenWarehouse={openWarehouseSnapshot} />}
          {page === 'catalog' && <CatalogPage data={data} tab={catalogTab} setTab={setCatalogTab} onAddMaterial={() => setModal('material')} onAddBom={() => setModal('bom')} />}
          {page === 'norms' && <NormsPage data={data} onAdd={() => setModal('norm')} />}
          {page === 'data-entry' && <DataTasksPage data={data} onImport={importTask} onExport={exportTask} onLoadReal={loadRealDataset} busyTask={busyTask} taskErrors={taskErrors} onOpen={(taskId) => {
            if (taskId === 'orders' || taskId === 'wip' || taskId === 'production-orders') setPageSafe('orders');
            else if (taskId === 'order-mapping') setPageSafe('orders');
            else if (taskId === 'product-mapping') openWarehouseSnapshot('LAF');
            else if (taskId === 'materials' || taskId === 'bom') { setCatalogTab(taskId); setPageSafe('catalog'); }
            else if (taskId === 'norms') { setPageSafe('norms'); setModal('norm'); }
            else if (taskId.startsWith('inventory:')) {
              const p = taskId.slice('inventory:'.length);
              openWarehouseSnapshot(p === 'HOA_MAU' ? 'HOA_MAU_LAF' : p);
            }
            else if (taskId.startsWith('chemical-norms:')) openWarehouseSnapshot(taskId.slice('chemical-norms:'.length));
          }} />}
        </div>
      </main>

      {modal === 'material' && <MaterialModal onClose={() => setModal('')} onSave={saveMaterial} />}
      {modal === 'bom' && <BomModal materials={data.materials} onClose={() => setModal('')} onSave={saveBom} />}
      {modal === 'norm' && <NormModal materials={data.materials} onClose={() => setModal('')} onSave={saveNorm} />}
      {modal === 'order' && <OrderModal onClose={() => setModal('')} onSave={saveOrder} />}
      {modal === 'setup' && <SetupModal onClose={() => setModal('')} />}
      {toast && <div className="toast"><Check size={16} />{toast}</div>}
    </div>
  );
}

function Sidebar({ page, setPage, selectedWarehouse, onSelectWarehouse, mobileOpen, onClose }) {
  return (
    <>
      <div className={`sidebar-backdrop ${mobileOpen ? 'visible' : ''}`} onClick={onClose} />
      <aside className={`sidebar ${mobileOpen ? 'open' : ''}`}>
        <div className="brand-lockup">
          <div className="brand-mark"><Package size={21} strokeWidth={2.2} /></div>
          <div><div className="brand-name">kho<span>xưởng</span></div><div className="brand-caption">WORKSHOP CONTROL</div></div>
          <button className="icon-button close-sidebar" aria-label="Đóng menu" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="workspace-selector"><div className="workspace-avatar">K</div><div className="workspace-copy"><strong>Kho tổng hợp</strong><span>4 kho · LAF & LVF</span></div><ChevronDown size={15} /></div>
        <div className="nav-label">KHÔNG GIAN LÀM VIỆC</div>
        <nav className="main-nav">
          {navItems.map(({ id, label, icon: Icon }) => (
            <button key={id} className={`nav-item ${page === id ? 'active' : ''}`} onClick={() => setPage(id)}>
              <Icon size={18} strokeWidth={1.9} /><span>{label}</span>{id === 'snapshot' && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-section">
          <div className="nav-label">4 KHO KIỂM KÊ</div>
          {WAREHOUSES.map((warehouse) => (
            <button
              type="button"
              className={`plant-link plant-link-button ${page === 'snapshot' && selectedWarehouse === warehouse.id ? 'is-selected' : ''}`}
              key={warehouse.id}
              onClick={() => onSelectWarehouse(warehouse.id)}
            >
              <span className={`plant-dot ${warehouse.color}`} />
              <span>{warehouse.name}</span>
              <small>{warehouse.id.includes('LAF') ? 'Chặt' : 'May/Gò'}</small>
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          <div className="help-card"><div className="help-icon"><Activity size={17} /></div><strong>Quản lý kho rõ ràng</strong><p>Đồng bộ tiến độ và kiểm kê 4 kho trên một màn hình.</p><button onClick={() => setPage('snapshot')}>Mở kiểm kê 4 kho <span>→</span></button></div>
          <div className="user-mini"><div className="user-avatar">K</div><div><strong>Người vận hành</strong><span>Quản lý kho</span></div><ChevronDown size={15} /></div>
        </div>
      </aside>
    </>
  );
}

function ExecLineTrendChart({ series }) {
  const [hoverIdx, setHoverIdx] = useState(null);
  if (!series.length) return <EmptyInline text="Chưa có dữ liệu tiến độ theo kỳ để vẽ xu hướng." />;
  const W = 680, H = 235, padL = 62, padR = 40, padT = 18, padB = 34;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const maxVal = Math.max(1, ...series.flatMap((d) => [d.planned, d.cut, d.received]));
  const xAt = (i) => padL + (series.length === 1 ? innerW / 2 : (i / (series.length - 1)) * innerW);
  const yAt = (v) => padT + innerH - (v / maxVal) * innerH;
  const makePath = (key) => series.map((d, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yAt(d[key]).toFixed(1)}`).join(' ');
  const makeArea = (key) => `${makePath(key)} L${xAt(series.length - 1).toFixed(1)},${(padT + innerH).toFixed(1)} L${xAt(0).toFixed(1)},${(padT + innerH).toFixed(1)} Z`;
  const active = hoverIdx !== null ? series[hoverIdx] : series[series.length - 1];

  return (
    <div className="exec-chart-wrap">
      <div className="exec-chart-readout">
        <span>Kỳ: <strong>{active.label}</strong></span>
        <span><i className="dot-sky" /> Kế hoạch: <strong>{money(active.planned)}</strong></span>
        <span><i className="dot-emerald" /> Đã Chặt: <strong>{money(active.cut)}</strong></span>
        <span><i className="dot-amber" /> Nhập kho: <strong>{money(active.received)}</strong></span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="exec-svg" role="img" aria-label="Biểu đồ xu hướng sản lượng theo kỳ">
        <defs>
          <linearGradient id="areaSky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0ea5e9" stopOpacity="0.24" />
            <stop offset="100%" stopColor="#0ea5e9" stopOpacity="0.01" />
          </linearGradient>
          <linearGradient id="areaEmerald" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#10b981" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#10b981" stopOpacity="0.01" />
          </linearGradient>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const y = padT + innerH * (1 - t);
          return (
            <g key={t}>
              <line x1={padL} y1={y} x2={W - padR} y2={y} className="chart-grid-line" />
              <text x={padL - 8} y={y + 4} textAnchor="end" className="chart-axis-text">{money(Math.round(maxVal * t))}</text>
            </g>
          );
        })}
        <path d={makeArea('planned')} fill="url(#areaSky)" />
        <path d={makeArea('cut')} fill="url(#areaEmerald)" />
        <path d={makePath('planned')} fill="none" stroke="#0ea5e9" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d={makePath('cut')} fill="none" stroke="#10b981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d={makePath('received')} fill="none" stroke="#f59e0b" strokeWidth="2.5" strokeDasharray="5 3" strokeLinecap="round" strokeLinejoin="round" />
        {series.map((d, i) => (
          <g key={d.label} onMouseEnter={() => setHoverIdx(i)} onMouseLeave={() => setHoverIdx(null)} style={{ cursor: 'pointer' }}>
            <line x1={xAt(i)} y1={padT} x2={xAt(i)} y2={padT + innerH} stroke={hoverIdx === i ? '#38bdf8' : 'transparent'} strokeWidth="1" strokeDasharray="3 3" />
            <circle cx={xAt(i)} cy={yAt(d.planned)} r={hoverIdx === i ? 5 : 3.5} fill="#0ea5e9" />
            <circle cx={xAt(i)} cy={yAt(d.cut)} r={hoverIdx === i ? 5 : 3.5} fill="#10b981" />
            <circle cx={xAt(i)} cy={yAt(d.received)} r={hoverIdx === i ? 5 : 3.5} fill="#f59e0b" />
            <text x={xAt(i)} y={H - 10} textAnchor="middle" className="chart-axis-text">{d.label}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function ExecDonutChart({ segments, centerValue, centerLabel }) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const r = 46, cx = 60, cy = 60, circ = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="exec-donut-row">
      <svg viewBox="0 0 120 120" className="exec-donut-svg">
        <circle cx={cx} cy={cy} r={r} fill="none" className="donut-track" strokeWidth="14" />
        {total > 0 && segments.map((seg) => {
          const len = (seg.value / total) * circ;
          const dash = `${len} ${circ - len}`;
          const el = (
            <circle
              key={seg.label}
              cx={cx}
              cy={cy}
              r={r}
              fill="none"
              stroke={seg.color}
              strokeWidth="14"
              strokeDasharray={dash}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${cx} ${cy})`}
            />
          );
          offset += len;
          return el;
        })}
        <text x={cx} y={cy - 2} textAnchor="middle" className="donut-center-val">{centerValue}</text>
        <text x={cx} y={cy + 14} textAnchor="middle" className="donut-center-lbl">{centerLabel}</text>
      </svg>
      <div className="exec-donut-legend">
        {segments.map((seg) => {
          const pct = total ? Math.round((seg.value / total) * 100) : 0;
          return (
            <div key={seg.label} className="donut-leg-item">
              <span className="donut-leg-dot" style={{ background: seg.color }} />
              <span className="donut-leg-name">{seg.label}</span>
              <strong>{money(seg.value)} <small>({pct}%)</small></strong>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Dashboard({ data, setPage, onOpenWarehouse }) {
  const isAccessoryOrder = (o) => /PHU\s*KIEN|PHỤ\s*KIỆN|ACCESSORY|PHU\s*LIEU|PHỤ\s*LIỆU/i.test(
    `${o.productType || ''} ${o.sourceSheet || ''} ${o.model || ''} ${o.customer || ''}`
  );
  const prodBatchOrders = currentImportedRows(data.productionOrders, data.importMeta, 'production-orders');
  const rawOrders = prodBatchOrders.length ? prodBatchOrders : (data.orders || []);
  const orders = rawOrders.filter((o) => !isAccessoryOrder(o));
  const countRows = data.workshopCounts?.rows || [];
  const materialIssues = data.materialIssues || [];

  const warehouseSnapshots = useMemo(() => {
    const specs = [
      { id: 'HOA_MAU_LAF', short: 'Hóa mẫu LAF', stageLabel: 'Chặt (S − U)', lvfStage: '' },
      { id: 'LAF', short: 'Xưởng LAF', stageLabel: 'Chặt (S − U)', lvfStage: '' },
      { id: 'HOA_MAU_LVF', short: 'Hóa mẫu LVF', stageLabel: 'May + Gò (S − V/W)', lvfStage: 'both' },
      { id: 'LVF', short: 'Xưởng LVF', stageLabel: 'May + Gò (S − V/W)', lvfStage: 'both' },
    ];
    return specs.map((spec) => {
      const info = WAREHOUSES.find((w) => w.id === spec.id);
      const snap = calculateInventorySnapshot(data, spec.id, { mode: 'planned', lvfStage: spec.lvfStage });
      const cmp = compareSnapshotCounts(snap, countRows, spec.id, { materialIssues, lvfStage: spec.lvfStage, productionOrders: data.productionOrders || [] });
      const merged = mergeRowsByMaterialName(cmp);
      const counted = merged.filter((r) => r.actual !== null && r.actual !== undefined).length;
      const withVariance = merged.filter((r) => r.variance !== null && r.variance !== undefined && Math.abs(r.variance) > 0.0001);
      const coveragePct = merged.length ? Math.round((counted / merged.length) * 100) : 0;
      const byUnit = new Map();
      for (const r of merged) {
        const u = String(r.unit || 'Khác').trim();
        if (!byUnit.has(u)) byUnit.set(u, { unit: u, theory: 0, issued: 0, actual: 0 });
        const b = byUnit.get(u);
        b.theory += Number(r.quantity) || 0;
        b.issued += Number(r.issuedFromMain) || 0;
        b.actual += Number(r.actual) || 0;
      }
      const unitStats = [...byUnit.values()].sort((a, b) => (b.theory + b.actual) - (a.theory + a.actual));
      const hasTheorySource = snap.hasSource && snap.summary.length > 0;
      return { ...info, ...spec, snap, merged, counted, withVariance, coveragePct, unitStats, hasTheorySource };
    });
  }, [data, countRows, materialIssues]);

  const prodStats = useMemo(() => {
    let planned = 0, cut = 0, sew = 0, go = 0, received = 0, lafWip = 0, lvfGoWip = 0;
    const byPeriod = new Map();
    for (const o of orders) {
      const eff = resolveEffectiveStageQuantities(o.stageQuantities);
      const p = Number(o.plannedQty) || 0;
      const c = eff.LAF_CUT ?? 0;
      const s = eff.LVF_SEW ?? 0;
      const g = eff.LVF_GO ?? 0;
      const r = Number(o.stageQuantities?.RECEIVED) || 0;
      planned += p; cut += c; sew += s; go += g; received += r;
      lafWip += Math.max(0, p - c);
      lvfGoWip += Math.max(0, p - g);
      const rawDate = String(o.dueDate || o.orderDate || '').trim();
      const ym = /^\d{4}[\/-]\d{2}/.test(rawDate) ? rawDate.slice(0, 7).replace('-', '/') : 'Chưa gắn kỳ';
      if (!byPeriod.has(ym)) byPeriod.set(ym, { label: ym, planned: 0, cut: 0, received: 0 });
      const bucket = byPeriod.get(ym);
      bucket.planned += p; bucket.cut += c; bucket.received += r;
    }
    const series = [...byPeriod.values()].sort((a, b) => a.label.localeCompare(b.label));
    return { planned, cut, sew, go, received, lafWip, lvfGoWip, series };
  }, [orders]);

  const issueBreakdown = useMemo(() => {
    const counts = { WIP: 0, DONE: 0, NOT_IN_PROGRESS: 0, NO_PO: 0 };
    for (const wh of warehouseSnapshots) {
      for (const row of classifyWarehouseIssues(materialIssues, wh.snap, wh.id, { lvfStage: wh.lvfStage, productionOrders: data.productionOrders || [] })) {
        counts[row.category] += row.issuedQty;
      }
    }
    return counts;
  }, [warehouseSnapshots, materialIssues, data.productionOrders]);

  const stageAnomalies = useMemo(() => buildStageExplanationRows(data.productionOrders || [], materialIssues, ''), [data.productionOrders, materialIssues]);

  const totalGroups = warehouseSnapshots.reduce((s, w) => s + w.merged.length, 0);
  const totalCounted = warehouseSnapshots.reduce((s, w) => s + w.counted, 0);
  const totalVarianceGroups = warehouseSnapshots.reduce((s, w) => s + w.withVariance.length, 0);
  const totalUnmapped = warehouseSnapshots.reduce((s, w) => s + w.snap.unmapped.length, 0);
  const completionPct = prodStats.planned ? Math.round((prodStats.received / prodStats.planned) * 100) : 0;
  const countPct = totalGroups ? Math.round((totalCounted / totalGroups) * 100) : 0;

  const topVariances = useMemo(() => {
    const items = [];
    for (const wh of warehouseSnapshots) {
      for (const r of wh.withVariance) {
        items.push({ ...r, warehouseId: wh.id, warehouseName: wh.short, color: wh.color });
      }
    }
    return items.sort((a, b) => Math.abs(b.variance || 0) - Math.abs(a.variance || 0)).slice(0, 6);
  }, [warehouseSnapshots]);

  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">{new Intl.DateTimeFormat('vi-VN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date()).toUpperCase()} <span>•</span> BÁO CÁO QUẢN TRỊ BAN GIÁM ĐỐC</div>
          <h1>Executive Dashboard — Kiểm kê & Tiến độ 4 Kho</h1>
          <p>Tổng hợp sản lượng đơn hàng, tồn lý thuyết dở dang, thực lãnh kho tổng theo PO và kết quả kiểm đếm hiện trường LAF & LVF.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="button button-secondary" onClick={() => setPage('guide')}><GitBranch size={16} /> Sơ đồ & Hướng dẫn</button>
          <button className="button button-primary" onClick={() => setPage('snapshot')}><ClipboardCheck size={16} /> Mở kiểm kê 4 kho</button>
        </div>
      </div>

      <div className="summary-grid">
        <MetricCard label="TỔNG SỐ ĐÔI CẦN SẢN XUẤT" value={`${money(prodStats.planned)} đôi`} detail={`${money(orders.length)} chỉ lệnh (không tính phụ kiện) · Nhập kho ${money(prodStats.received)} đôi (${completionPct}%)`} icon={Layers3} tint="blue" />
        <MetricCard label="TỔNG SỐ ĐÔI TẠI LAF (CHẶT)" value={`${money(prodStats.cut)} / ${money(prodStats.lafWip)}`} detail={`Đã sản xuất: ${money(prodStats.cut)} đôi · Dở dang: ${money(prodStats.lafWip)} đôi`} icon={Boxes} tint="teal" />
        <MetricCard label="TỔNG SỐ ĐÔI TẠI LVF (MAY / GÒ)" value={`${money(prodStats.go)} / ${money(prodStats.lvfGoWip)}`} detail={`Đã Gò: ${money(prodStats.go)} (May ${money(prodStats.sew)}) · Dở dang: ${money(prodStats.lvfGoWip)} đôi`} icon={ClipboardCheck} tint="amber" />
        <MetricCard label="KIỂM ĐẾM & CẢNH BÁO 4 KHO" value={`${countPct}%`} detail={`${money(totalCounted)}/${money(totalGroups)} nhóm đã đếm · ${money(totalVarianceGroups)} lệch · ${money(totalUnmapped)} chưa ghép`} icon={CircleAlert} tint="rose" />
      </div>

      <div className="exec-charts-grid">
        <section className="panel" style={{ padding: 20 }}>
          <div className="panel-heading" style={{ padding: '0 0 12px' }}>
            <div>
              <h2>Xu hướng sản lượng & Tiến độ hoàn thành</h2>
              <p>Đường line so sánh Kế hoạch đơn hàng, Đã Chặt và Nhập kho thành phẩm theo kỳ giao hàng</p>
            </div>
            <span className="period-badge">{prodStats.series.length} KỲ</span>
          </div>
          <ExecLineTrendChart series={prodStats.series} />
        </section>

        <section className="panel" style={{ padding: 20 }}>
          <div className="panel-heading" style={{ padding: '0 0 12px' }}>
            <div>
              <h2>Độ phủ & Tồn theo từng ĐVT trên 4 Kho</h2>
              <p>Tách riêng theo từng đơn vị tính (không cộng gộp KÍ, mét, TỜ, CUỘN…); cảnh báo kho chưa đủ nguồn</p>
            </div>
            <button className="text-button" onClick={() => setPage('snapshot')}>Chi tiết <span>→</span></button>
          </div>
          <div className="exec-bar-list">
            {warehouseSnapshots.map((wh) => {
              const primary = wh.unitStats[0];
              const maxUnit = primary ? Math.max(1, primary.theory, primary.issued, primary.actual) : 1;
              return (
                <button type="button" key={wh.id} className="exec-bar-card" onClick={() => onOpenWarehouse(wh.id)}>
                  <div className="exec-bar-head">
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className={`plant-dot ${wh.color}`} />
                      <strong>{wh.name}</strong>
                    </span>
                    <span className="period-badge">{wh.stageLabel}</span>
                  </div>
                  {!wh.hasTheorySource ? (
                    <div className="mapping-warning" style={{ margin: 0, padding: '6px 9px', fontSize: 12 }}>
                      <CircleAlert size={14} />
                      <span>Chưa đủ nguồn định mức / công đoạn để đối chiếu</span>
                    </div>
                  ) : primary ? (
                    <div className="exec-bars-stack">
                      <div className="exec-mini-bar"><span>Định mức ({primary.unit})</span><div><i style={{ width: `${Math.min(100, (primary.theory / maxUnit) * 100)}%`, background: '#0ea5e9' }} /></div><b>{money(primary.theory, 0)}</b></div>
                      <div className="exec-mini-bar"><span>Kho tổng ({primary.unit})</span><div><i style={{ width: `${Math.min(100, (primary.issued / maxUnit) * 100)}%`, background: '#f59e0b' }} /></div><b>{money(primary.issued, 0)}</b></div>
                      <div className="exec-mini-bar"><span>Thực đếm ({primary.unit})</span><div><i style={{ width: `${Math.min(100, (primary.actual / maxUnit) * 100)}%`, background: '#10b981' }} /></div><b>{money(primary.actual, 0)}</b></div>
                    </div>
                  ) : null}
                  <div className="exec-bar-foot">
                    <span>Độ phủ: <strong>{wh.coveragePct}%</strong> ({money(wh.counted)}/{money(wh.merged.length)} nhóm)</span>
                    <span className={wh.snap.unmapped.length ? 'text-warning' : ''}>{money(wh.snap.unmapped.length)} chưa ghép</span>
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      </div>

      <div className="dashboard-grid" style={{ marginTop: 16 }}>
        <section className="panel" style={{ padding: 20 }}>
          <div className="panel-heading" style={{ padding: '0 0 12px' }}>
            <div>
              <h2>Cơ cấu kiểm kê & Phân bổ xuất kho tổng</h2>
              <p>Tỷ lệ nhóm vật tư đã kiểm đếm và phân loại phiếu xuất kho tổng theo PO</p>
            </div>
          </div>
          <div className="exec-donuts-stack">
            <ExecDonutChart
              centerValue={`${countPct}%`}
              centerLabel="Đã đếm"
              segments={[
                { label: 'Đã đếm & khớp / dư', value: Math.max(0, totalCounted - totalVarianceGroups), color: '#10b981' },
                { label: 'Đã đếm (có chênh lệch)', value: totalVarianceGroups, color: '#f59e0b' },
                { label: 'Chưa kiểm đếm', value: Math.max(0, totalGroups - totalCounted), color: '#64748b' },
              ]}
            />
            <ExecDonutChart
              centerValue={money(issueBreakdown.WIP + issueBreakdown.DONE + issueBreakdown.NO_PO, 0)}
              centerLabel="Tổng xuất"
              segments={[
                { label: 'Chỉ lệnh dở dang (TongHop)', value: Math.round(issueBreakdown.WIP), color: '#0ea5e9' },
                { label: 'Đơn đã hoàn tất / Nhập kho', value: Math.round(issueBreakdown.DONE), color: '#8b5cf6' },
                { label: 'Xuất chung không gắn PO', value: Math.round(issueBreakdown.NO_PO), color: '#f43f5e' },
              ]}
            />
          </div>
        </section>

        <section className="panel table-panel">
          <div className="panel-heading">
            <div>
              <h2>Top vật tư chênh lệch lớn nhất (Thực đếm vs Định mức)</h2>
              <p>Các nhóm mã cần Ban Giám Đốc / Quản lý kho ưu tiên kiểm tra</p>
            </div>
            <span className="alert-count">{totalVarianceGroups}</span>
          </div>
          {topVariances.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>KHO</th>
                    <th>MÃ / TÊN VẬT TƯ</th>
                    <th className="numeric">ĐỊNH MỨC</th>
                    <th className="numeric">THỰC ĐẾM</th>
                    <th className="numeric">CHÊNH LỆCH</th>
                  </tr>
                </thead>
                <tbody>
                  {topVariances.map((item) => (
                    <tr key={`${item.warehouseId}|${item.materialCode}|${item.unit}`} onClick={() => onOpenWarehouse(item.warehouseId)} style={{ cursor: 'pointer' }}>
                      <td><span className="plant-tag">{item.warehouseName}</span></td>
                      <td><strong>{item.materialCode}</strong><small>{item.materialName}</small></td>
                      <td className="numeric">{money(item.quantity, 1)}</td>
                      <td className="numeric">{money(item.actual, 1)}</td>
                      <td className={`numeric strong-cell ${(item.variance || 0) < 0 ? 'text-danger' : 'text-warning'}`}>{money(item.variance, 1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="all-clear" style={{ padding: 28 }}>
              <div><Check size={20} /></div>
              <strong>Chưa có chênh lệch lớn</strong>
              <span>Nhập số thực đếm tại màn hình Kiểm kê 4 kho để theo dõi.</span>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function MetricCard({ label, value, detail, icon: Icon, tint }) {
  return <div className="metric-card"><div className={`metric-icon ${tint}`}><Icon size={19} /></div><div className="metric-label">{label}</div><div className="metric-value">{value}</div><div className="metric-detail">{detail}</div><div className={`metric-line ${tint}`} /></div>;
}

function ReconcileLine({ label, value, icon }) {
  return <div className="reconcile-line"><span className={`reconcile-icon ${icon}`}>{icon === 'receipt' ? '↓' : icon === 'wip' ? '↗' : '◉'}</span><span>{label}</span><strong>{money(value, 1)}</strong></div>;
}

function DataTasksPage({ data, onImport, onExport, onLoadReal, busyTask, taskErrors, onOpen }) {
  const latestProductionBatch = data.importMeta?.['production-orders']?.batchId;
  const currentProductionOrders = latestProductionBatch
    ? data.productionOrders.filter((row) => row.batchId === latestProductionBatch)
    : data.productionOrders;
  const chemicalCount = (warehouseId) => {
    const taskId = 'chemical-norms:' + warehouseId;
    const batchId = data.importMeta?.[taskId]?.batchId;
    return data.chemicalNorms.filter((row) => row.warehouseId === warehouseId && (!batchId || row.batchId === batchId)).length;
  };
  const tasks = [
    { id: 'orders', title: 'Kế hoạch đơn hàng', description: 'Nhập mã đơn, mã hàng-màu, nhà máy và số lượng kế hoạch.', source: 'DON HANG.xlsx · ADIDAS / LƯU HÓA', count: data.orders.length, unit: 'đơn', icon: Layers3, color: 'blue', action: 'Mở nhập đơn hàng' },
    { id: 'production-orders', title: 'Tiến độ & lệnh sản xuất', description: 'Nhập PO/SO, mã hàng-màu và số lượng. Dòng thiếu chỉ lệnh vẫn được giữ để đối chiếu.', source: 'TIEN-DO-SX-DONHANG.xlsx · sheet New', count: currentProductionOrders.length, unit: 'dòng tiến độ', icon: Activity, color: 'teal', action: 'Mở tiến độ sản xuất' },
    { id: 'order-mapping', title: 'Bảng phụ mapping chỉ lệnh', description: 'Tự dò chỉ lệnh từ DM-NPL-DH theo PO + mã hàng + màu; chỉ tự ghép khi có đúng một kết quả.', source: 'Bảng phụ · Mapping_Chi_Lenh', count: data.orderMappings.length, unit: 'mapping đã nhập', icon: ArrowLeftRight, color: 'amber', action: 'Rà soát đơn hàng' },
    { id: 'product-mapping', title: 'Mapping mã hàng - màu BOM', description: 'Nối tên mã hàng/màu ở tiến độ với mã hàng và mã màu nội bộ trong BOM; dùng cho đơn chưa có mã màu từ định mức Hóa mẫu.', source: 'File riêng · Mapping_Ma_Hang_Mau', count: data.productMappings.length, unit: 'mapping', icon: ArrowLeftRight, color: 'amber', action: 'Mở nhu cầu theo kho' },
    { id: 'wip', title: 'Tiến độ WIP', description: 'Cập nhật sản lượng theo từng đơn và từng nhà máy.', source: 'File riêng · TienDo_WIP', count: data.orders.length, unit: 'đơn có thể cập nhật', icon: Activity, color: 'teal', action: 'Mở nhập tiến độ' },
    { id: 'materials', title: 'Danh mục vật tư', description: 'Quản lý một mã vật tư dùng cho một hoặc nhiều nhà máy.', source: 'Workbook · 1_Danh_Muc_Va_Ma_Tran_BOM', count: data.materials.length, unit: 'mã', icon: Boxes, color: 'green', action: 'Mở nhập vật tư' },
    { id: 'bom', title: 'Định mức BOM trực tiếp', description: 'Nhập định mức và khai báo kho nhận, công đoạn, luồng cấp phát khi vật tư dùng nhiều nhà máy.', source: 'Workbook · ma trận mã hàng-màu hoặc Dinh_Muc_BOM', count: data.bom.length, unit: 'dòng', icon: ArrowLeftRight, color: 'amber', action: 'Mở nhập BOM' },
    ...['HOA_MAU_LAF', 'HOA_MAU_LVF'].map((warehouseId) => ({
      id: 'chemical-norms:' + warehouseId,
      title: 'Định mức Hóa mẫu · ' + (warehouseId.endsWith('LAF') ? 'LAF' : 'LVF'),
      description: 'Đọc DM-NPL-DH và ghép từng hóa chất với chỉ lệnh, mã hàng, màu và số lượng lệnh sản xuất.',
      source: warehouseId.endsWith('LAF') ? 'DM-MATHANG-HOAMAU LAF-CANLUYEN' : 'Nguồn định mức Hóa mẫu LVF',
      count: chemicalCount(warehouseId),
      unit: 'dòng định mức',
      icon: FileSpreadsheet,
      color: 'violet',
      action: 'Mở nhu cầu theo kho',
    })),
    ...PLANTS.map((plant) => ({
      id: 'inventory:' + plant.id,
      title: 'Lĩnh về & kiểm kê · ' + plant.name,
      description: 'Nhập số lượng lĩnh về và kết quả đếm thực tế cho khu vực này.',
      source: 'Workbook · ' + (plant.id === 'HOA_MAU' ? '2_Kho_Hoa_Mau' : plant.id === 'LAF' ? '3_Kho_Xuong_LAF' : '4_Kho_Xuong_LVF'),
      count: data.materials.filter((material) => (material.plants || []).includes(plant.id)).length,
      unit: 'mã vật tư',
      icon: ClipboardCheck,
      color: plant.color,
      action: 'Mở nhập kiểm kê',
    })),
    { id: 'norms', title: 'Định mức BTP theo size · LAF', description: 'Nhập vật tư, mã hàng-màu, size, công đoạn, định mức, kế hoạch và WIP theo size.', source: 'Workbook · DM_BTP_Size_LAF', count: data.norms.length, unit: 'dòng', icon: Settings2, color: 'violet', action: 'Mở nhập định mức' },
  ];

  return <>
    <div className="page-heading"><div><div className="eyebrow">TRUNG TÂM DỮ LIỆU <span>•</span> TÁCH RIÊNG THEO TỪNG TÁC VỤ</div><h1>Tác vụ nhập liệu</h1><p>Mỗi phần dữ liệu có file import, export và biểu mẫu riêng theo cấu trúc workbook.</p></div></div>
    <div className="task-guidance"><FileSpreadsheet size={18} /><span><strong>Không phụ thuộc công thức Excel.</strong> Chỉ nhập các cột đầu vào. Nhu cầu được tính trong ứng dụng; tồn ước tính tại màn hình kiểm kê cũ chưa phải sổ nhập–xuất–tồn.</span></div>
    <div className="panel" style={{padding:20,marginBottom:16}}>
      <h2>Nạp nhanh dữ liệu thực tế & workbook thống kê kho</h2>
      <p>Hệ thống đã đóng gói sẵn 5 file từ thư mục <code>DU LIEU THAT</code> (Tiến độ đơn hàng, Định mức Hóa mẫu LAF, Danh mục/Ma trận BOM/Kiểm đếm, Đơn hàng). Bạn có thể nạp lại toàn bộ bất cứ lúc nào hoặc nạp file mới từng phần bên dưới.</p>
      <div style={{display:'flex',flexWrap:'wrap',gap:10,alignItems:'center'}}>
        <button type="button" className="button button-primary" disabled={Boolean(busyTask)} onClick={onLoadReal}><RefreshCw size={14}/>{busyTask === 'real-bundle' ? 'Đang nạp dữ liệu...' : 'Nạp lại dữ liệu thực tế (DU LIEU THAT)'}</button>
        <label className="button button-secondary upload-control"><Upload size={14}/>Nạp workbook thống kê (.xlsx/.xlsm)<input type="file" accept=".xlsx,.xlsm" disabled={Boolean(busyTask) || cloudMode} onChange={event=>{const f=event.target.files?.[0]; if(f)onImport('workshop-bundle',f); event.target.value='';}}/></label>
      </div>
      {taskErrors['workshop-bundle'] && <div className="task-error">{taskErrors['workshop-bundle']}</div>}
    </div>
    <div className="task-grid">
      {tasks.map((task) => {
        const Icon = task.icon;
        return <article className="task-card" key={task.id}>
          <div className="task-card-top"><div className={`task-icon ${task.color}`}><Icon size={19} /></div><span className="task-count"><strong>{money(task.count)}</strong> {task.unit}</span></div>
          <h2>{task.title}</h2>
          <p className="task-description">{task.description}</p>
          <div className="task-source"><FileSpreadsheet size={13} /><span>{task.source}</span></div>
          <div className="task-actions">
            <label className="button button-primary button-small upload-control"><Upload size={14} />{busyTask === task.id ? 'Đang nhập...' : 'Import file'}
              <input type="file" accept=".xlsx,.xlsm" disabled={Boolean(busyTask)} onChange={(event) => { const file = event.target.files?.[0]; if (file) onImport(task.id, file); event.target.value = ''; }} />
            </label>
            <button className="button button-secondary button-small" onClick={() => onExport(task.id)}><ArrowDownToLine size={14} /> Export dữ liệu</button>
            <button className="task-template-button" onClick={() => onExport(task.id, true)}>Tải mẫu trống</button>
          </div>
          {taskErrors[task.id] && <div className="task-error"><CircleAlert size={14} />{taskErrors[task.id]}</div>}
          <button className="task-manual-button" onClick={() => onOpen(task.id)}>{task.action}<span>→</span></button>
        </article>;
      })}
    </div>
  </>;
}

function OrdersPage({ data, onAdd, onProgress }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('Tất cả');
  const allOrders = currentOrderRows(data);
  const orderContext = useMemo(() => orderResolutionContext(data), [data.chemicalNorms, data.orderMappings, data.importMeta]);
  const hasSourceProgress = allOrders.some((order) => order.stageQuantities);
  const orders = allOrders.filter((order) => {
    const q = query.toLowerCase();
    const matches = !q || `${order.orderNo} ${order.purchaseOrder || ''} ${order.model} ${order.color} ${order.colorName || ''} ${order.customer || ''}`.toLowerCase().includes(q);
    const running = Number(order.productionQty) > 0 || Object.values(order.stageQuantities || {}).some((value) => Number(value) > 0) || Object.values(order.progress || {}).some((value) => Number(value) > 0);
    return matches && (filter === 'Tất cả' || (filter === 'Đang chạy' ? running : !running));
  });
  const plannedTotal = allOrders.reduce((sum, item) => sum + (Number(item.plannedQty) || 0), 0);
  const releasedTotal = allOrders.reduce((sum, item) => sum + (Number(item.productionQty ?? item.plannedQty) || 0), 0);
  return <>
    <div className="page-heading"><div><div className="eyebrow">BẢNG A <span>•</span> TIẾN ĐỘ THEO MÃ HÀNG & MÀU SẮC</div><h1>Đơn hàng sản xuất</h1><p>Giữ nguyên PO/SO và tự hiển thị chỉ lệnh đã ghép theo PO + mã hàng + màu; dòng chưa duy nhất sẽ hiện trạng thái chưa ghép.</p></div><button className="button button-primary" onClick={onAdd}><Plus size={16} /> Thêm đơn hàng</button></div>
    <div className="metric-strip"><MetricInline label="TỔNG CHỈ LỆNH" value={money(allOrders.length)} /><MetricInline label="SL ĐƠN HÀNG" value={money(plannedTotal)} /><MetricInline label="SL ĐÃ PHÁT LỆNH SX" value={money(releasedTotal)} /><MetricInline label="MÃ HÀNG - MÀU" value={money(new Set(allOrders.map((order) => productKey(order.model, order.color))).size)} /></div>
    <section className="panel table-panel page-table-panel"><div className="table-toolbar"><div className="search-input"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm mã đơn, mã hàng, màu..." /></div><div className="toolbar-right"><div className="filter-pills">{['Tất cả', 'Đang chạy', 'Chờ sản xuất'].map((label) => <button key={label} className={filter === label ? 'selected' : ''} onClick={() => setFilter(label)}>{label}</button>)}</div><button className="icon-button"><Filter size={17} /></button></div></div>
      {orders.length ? <div className="table-scroll"><table className="orders-table">{hasSourceProgress ? <><thead><tr><th>CHỈ LỆNH / PO</th><th>MÃ HÀNG & MÀU</th><th>KHÁCH HÀNG</th><th className="numeric">SL ĐƠN</th><th className="numeric">SL LỆNH SX</th><th className="numeric">CHẶT · LAF/HM</th><th className="numeric">MAY · LVF/HM</th><th className="numeric">GÒ · LVF/HM</th><th className="numeric">ĐÓNG THÙNG</th><th className="numeric">NHẬP KHO</th><th className="numeric">GIAO HÀNG</th><th>TRẠNG THÁI</th></tr></thead><tbody>{orders.map((order) => <tr key={orderKey(order)}><td><strong>{resolvedOrderNo(order, orderContext) || 'Chưa ghép chỉ lệnh'}</strong><small>{order.purchaseOrder || order.sourceSheet || '—'}</small></td><td><span className="product-code">{order.model}</span><small>{order.color}</small></td><td>{order.customer || '—'}</td><td className="numeric">{money(order.plannedQty)}</td><td className="numeric strong-cell">{money(order.productionQty)}</td><td className="numeric">{money(order.stageQuantities?.LAF_CUT || 0)}</td><td className="numeric">{money(order.stageQuantities?.LVF_SEW || 0)}</td><td className="numeric">{money(order.stageQuantities?.LVF_GO || 0)}</td><td className="numeric">{money(order.stageQuantities?.PACKED || 0)}</td><td className="numeric">{money(order.stageQuantities?.RECEIVED || 0)}</td><td className="numeric">{money(order.stageQuantities?.SHIPPED || 0)}</td><td><StatusBadge status={order.productionQty > 0 ? 'Đang sản xuất' : order.status || 'Chờ sản xuất'} /></td></tr>)}</tbody></> : <><thead><tr><th>CHỈ LỆNH / PO</th><th>MÃ HÀNG & MÀU SẮC</th><th>NHÀ MÁY</th><th className="numeric">SL KẾ HOẠCH</th>{PLANTS.map((plant) => <th className="numeric" key={plant.id}>WIP {plant.short}</th>)}<th className="numeric">CÒN LẠI</th><th>TRẠNG THÁI</th></tr></thead><tbody>{orders.map((order) => {
        const done = Object.values(order.progress || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
        const remaining = Math.max(0, (Number(order.plannedQty) || 0) - done);
        return <tr key={orderKey(order)}><td><strong>{resolvedOrderNo(order, orderContext) || 'Chưa ghép chỉ lệnh'}</strong><small>{order.purchaseOrder || order.sourceSheet || 'Nhập trực tiếp'}</small></td><td><span className="product-code">{order.model}</span><small>{order.color} · {order.colorName || '—'}</small></td><td>{order.plant ? <PlantTag plantId={order.plant} /> : '—'}</td><td className="numeric">{money(order.plannedQty)}</td>{PLANTS.map((plant) => <td className="numeric" key={plant.id}><NumberInput className="cell-input numeric-input" value={order.progress?.[plant.id] ?? 0} onSave={(value) => onProgress(order, plant.id, value)} /></td>)}<td className="numeric strong-cell">{money(remaining)}</td><td><StatusBadge status={done ? 'Đang sản xuất' : order.status || 'Chờ sản xuất'} /></td></tr>;
      })}</tbody></>}</table></div> : <EmptyState title="Chưa có đơn hàng phù hợp" text="Nhập TIEN-DO-SX-DONHANG hoặc tạo đơn hàng mới để bắt đầu theo dõi." action="Thêm đơn hàng" onAction={onAdd} />}
      <div className="table-footnote"><span>{hasSourceProgress ? 'Tiến độ U:Z được giữ riêng từng công đoạn, không cộng dồn giữa các nhà máy.' : 'Tiến độ WIP theo từng nhà máy'}</span><span>{money(orders.length)} dòng hiển thị</span></div>
    </section>
  </>;
}

function MetricInline({ label, value }) { return <div><span>{label}</span><strong>{value}</strong></div>; }

function NumberInput({ value, onSave, className, placeholder = '', min = '0' }) {
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => setDraft(value ?? ''), [value]);
  return <input
    className={className}
    type="number"
    min={min}
    placeholder={placeholder}
    value={draft}
    onChange={(event) => setDraft(event.target.value)}
    onBlur={() => { if (String(draft) !== String(value ?? '')) onSave(draft); }}
    onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
  />;
}

function InventoryPage({ data, rows, selectedPlant, setPlant, onUpdate }) {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('Tất cả');
  const summary = getPlantSummary(data, selectedPlant);
  const filtered = rows.filter((row) => {
    const q = query.toLowerCase();
    const matchesQuery = !q || `${row.catalogNo} ${row.materialCode} ${row.name} ${row.colorScope}`.toLowerCase().includes(q);
    return matchesQuery && (statusFilter === 'Tất cả' || row.status === statusFilter);
  });
  const exportCsv = () => {
    const header = ['STT danh mục', 'Mã vật tư', 'Tên vật tư', 'ĐVT', 'Nhu cầu BOM', 'Lĩnh về', 'Sản xuất WIP', 'Tồn lý thuyết', 'Kiểm kê thực tế', 'Chênh lệch', 'Trạng thái'];
    const lines = filtered.map((row) => [row.catalogNo, row.materialCode, row.name, row.unit, row.plannedNeed, row.received, row.wipNeed, row.theoretical, row.actual ?? '', row.variance ?? '', row.status]);
    const csv = [header, ...lines].map((line) => line.map((value) => {
      const safe = typeof value === 'string' && /^[\s]*[=+@\-\t\r]/.test(value) ? "'" + value : String(value);
      return `"${safe.replaceAll('"', '""')}"`;
    }).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `kiem-ke-${selectedPlant.toLowerCase()}.csv`; link.click(); URL.revokeObjectURL(url);
  };
  return <>
    <div className="page-heading"><div><div className="eyebrow">BẢNG B <span>•</span> NHU CẦU BOM & ĐỐI CHIẾU THỰC TẾ</div><h1>Kiểm kê vật tư</h1><p>Đây là kiểm kê theo 3 khu vực cũ, chưa tách hai kho Hóa mẫu. Số lý thuyết chỉ là ước tính Lĩnh về − WIP, không phải tồn theo sổ giao dịch.</p></div><button className="button button-secondary" onClick={exportCsv}><ArrowDownToLine size={16} /> Xuất CSV</button></div>
    <div className="plant-tabs">{PLANTS.map((plant) => <button key={plant.id} className={selectedPlant === plant.id ? 'active' : ''} onClick={() => setPlant(plant.id)}><span className={`plant-dot ${plant.color}`} />{plant.name}<b>{data.materials.filter((material) => material.plants?.includes(plant.id)).length}</b></button>)}</div>
    <div className="metric-strip inventory-metrics"><MetricInline label="Mã danh mục" value={money(summary.count)} /><MetricInline label="Có phát sinh" value={money(summary.active)} /><MetricInline label="Đã kiểm kê" value={money(summary.enough + summary.surplus + summary.shortage)} /><MetricInline label="Dòng thiếu" value={money(summary.shortage)} /><MetricInline label="Dòng dư" value={money(summary.surplus)} /></div>
    <section className="panel table-panel page-table-panel"><div className="table-toolbar"><div className="search-input"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm mã hoặc tên vật tư..." /></div><div className="toolbar-right"><select className="select-compact" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option>Tất cả</option><option>Đủ</option><option>Dư</option><option>Thiếu</option><option>Chưa kiểm kê</option><option>Chưa phát sinh</option></select><button className="icon-button"><Filter size={17} /></button></div></div>
      {filtered.length ? <div className="table-scroll"><table className="inventory-table"><thead><tr><th>STT</th><th>MÃ VẬT TƯ / TÊN VẬT TƯ</th><th>PHẠM VI</th><th>ĐVT</th><th className="numeric">NHU CẦU BOM</th><th className="numeric">LĨNH VỀ</th><th className="numeric">SX WIP</th><th className="numeric">TỒN LÝ THUYẾT</th><th className="numeric">KIỂM KÊ THỰC TẾ</th><th className="numeric">CHÊNH LỆCH</th><th>TRẠNG THÁI</th></tr></thead><tbody>{filtered.map((row) => <tr key={`${row.plant}|${row.catalogNo}`}><td className="muted-cell">{row.catalogNo}</td><td><strong>{row.materialCode}</strong><small>{row.name}</small></td><td>{row.colorScope || '—'}</td><td>{row.unit || '—'}</td><td className="numeric">{money(Math.max(0, row.plannedNeed - row.wipNeed), 2)}</td><td className="numeric"><NumberInput className="cell-input numeric-input" value={row.received} onSave={(value) => onUpdate(row, 'received', value)} /></td><td className="numeric">{money(row.wipNeed, 2)}</td><td className="numeric strong-cell">{money(row.theoretical, 2)}</td><td className="numeric"><NumberInput className="cell-input numeric-input count-input" placeholder="Nhập số đếm" value={row.actual ?? ''} onSave={(value) => onUpdate(row, 'actual', value)} /></td><td className={`numeric ${row.variance < 0 ? 'text-danger' : row.variance > 0 ? 'text-warning' : ''}`}>{row.variance === null ? '—' : money(row.variance, 2)}</td><td><StatusBadge status={row.status} /></td></tr>)}</tbody></table></div> : <EmptyState title="Chưa có vật tư cho khu vực này" text="Nhập danh mục từ file thống kê kho để tự chia mã theo nhà máy." action="Nhập Excel" onAction={() => window.dispatchEvent(new CustomEvent('open-import'))} />}
      <div className="table-footnote"><span>Tồn lý thuyết = Lĩnh về − Sản xuất quy đổi WIP</span><span>{money(filtered.length)} / {money(rows.length)} mã</span></div>
    </section>
  </>;
}

function SnapshotPage({ data, selectedWarehouse, setWarehouse, onSaveCounts, onSaveMaterialIssues, onSaveBomDemand, onOpenReconcile }) {
  const localNow = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
  const [asOf, setAsOf] = useState(localNow);
  const [mode, setMode] = useState('planned');
  const [lvfStage, setLvfStage] = useState('both');
  const [issuedRows, setIssuedRows] = useState([]);
  const [issuedFile, setIssuedFile] = useState('');
  const [customCounts, setCustomCounts] = useState(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState('');
  const [snapshotTab, setSnapshotTab] = useState('summary');
  const [countFilter, setCountFilter] = useState('Tất cả');
  const [groupByName, setGroupByName] = useState(true);

  const countRows = customCounts?.rows || data.workshopCounts?.rows || [];
  const countFile = customCounts?.file || (data.workshopCounts?.rows?.length ? 'Mau_01_Thong_Ke_Xuong_Doi_Chieu_Kiem_Ke.xlsx' : '');
  const countNotes = customCounts?.notes || (data.workshopCounts?.dates ? data.workshopCounts : null);
  const materialIssues = data.materialIssues || [];
  const issueFile = data.importMeta?.['material-issues']?.sourceFile || (materialIssues.length ? 'chi tiet vat tu thuc xuat theo so po.xlsx' : '');

  const labels = {issued:'Số đôi đã lĩnh theo file', released:'SL phát lệnh (cột T) — giả định đã lĩnh', planned:'SL đơn hàng (cột S) trong TIEN-DO-SX-DONHANG'};
  const calc = useMemo(() => mode === 'issued' && !issuedRows.length ? {ready:false,rows:[],summary:[],unmapped:[],hasSource:false} : calculateInventorySnapshot(data, selectedWarehouse, {mode,lvfStage,issuedRows}), [data,selectedWarehouse,mode,lvfStage,issuedRows]);
  const comparison = useMemo(() => (countRows.length || materialIssues.length) ? compareSnapshotCounts(calc, countRows, selectedWarehouse, { materialIssues, lvfStage, productionOrders: data.productionOrders || [] }) : null, [calc,countRows,selectedWarehouse,materialIssues,lvfStage,data.productionOrders]);
  const displaySummary = useMemo(() => {
    const base = comparison || calc.summary;
    return groupByName ? mergeRowsByMaterialName(base) : base;
  }, [comparison, calc.summary, groupByName]);
  const rows = displaySummary.filter(r => {
    const matchText = `${r.materialCode} ${r.materialName} ${r.materialColor || ''}`.toLowerCase().includes(query.toLowerCase());
    if (!matchText) return false;
    if (countFilter === 'Đã kiểm đếm') return r.actual !== null && r.actual !== undefined;
    if (countFilter === 'Chưa đếm') return r.actual === null || r.actual === undefined;
    if (countFilter === 'Có chênh lệch') return r.variance !== null && r.variance !== undefined && Math.abs(r.variance) > 0.0001;
    return true;
  });
  const unmappedRows = useMemo(() => (calc.unmapped || []).filter(r => `${r.productionOrder || r.orderNo || ''} ${r.model || ''} ${r.color || ''} ${r.materialCode || ''} ${r.reason || ''}`.toLowerCase().includes(query.toLowerCase())), [calc.unmapped, query]);
  const selectedWarehouseInfo = WAREHOUSES.find(w => w.id === selectedWarehouse);
  const download = (bytes, name) => { const u=URL.createObjectURL(new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'})); const a=document.createElement('a'); a.href=u; a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(u),1000); };
  const importIssued = async (file) => { try { const rows=await readIssuedWorkbook(file); setIssuedRows(rows); setIssuedFile(file.name); setError(''); } catch(e) { setIssuedRows([]); setIssuedFile(''); setError(e.message || 'Không đọc được file số đôi đã lĩnh.'); } };
  const importCount = async (file) => { try { const rows=await readCountWorkbook(file); const payload = { rows, warnings: [], dates: null }; setCustomCounts({ rows, file: file.name, notes: null }); if (onSaveCounts) await onSaveCounts(payload); setError(''); } catch(e) { setError(e.message || 'Không đọc được file kiểm đếm.');} };
  const importWorkshopCounts = async (file) => { try { const result=await readWorkshopCounts(file); setCustomCounts({ rows: result.rows, file: file.name, notes: result }); if (onSaveCounts) await onSaveCounts(result); setError(''); } catch(e) { setError(e.message || 'Không đọc được workbook thống kê.');} };
  const importMaterialIssues = async (file) => { try { const result=await readMaterialIssueWorkbook(file); if (onSaveMaterialIssues) await onSaveMaterialIssues(result.rows, file.name); setError(''); } catch(e) { setError(e.message || 'Không đọc được file thực xuất kho tổng.'); } };
  const importBomDemand = async (file) => { try { const result=await readBomDemandWorkbook(file, { workshopCounts: data.workshopCounts?.rows || [], materialIssues, materials: data.materials || [] }); if (onSaveBomDemand) await onSaveBomDemand(result.rows, file.name); setError(''); } catch(e) { setError(e.message || 'Không đọc được file DM nhu cầu theo BOM.'); } };
  const updateManualCount = async (row, rawValue) => {
    const trimmed = String(rawValue ?? '').trim();
    const numericVal = trimmed === '' ? null : Number(trimmed.replace(',', '.'));
    if (numericVal !== null && (!Number.isFinite(numericVal) || numericVal < 0)) return;
    const codesInRow = row.materialCodes?.length ? row.materialCodes : [row.materialCode];
    const canon = (v) => (/^\d+$/.test(String(v).trim()) ? String(v).trim().replace(/^0+(?=\d)/, '') : String(v).trim().toUpperCase());
    const codeSet = new Set(codesInRow.map(canon));
    const unitNorm = String(row.unit || '').trim().toUpperCase();
    const filtered = countRows.filter((c) => !(c.warehouseId === selectedWarehouse && codeSet.has(canon(c.materialCode)) && String(c.unit || '').trim().toUpperCase() === unitNorm));
    if (numericVal !== null) {
      filtered.push({ warehouseId: selectedWarehouse, materialCode: codesInRow[0], materialName: row.materialName, unit: row.unit, quantity: numericVal });
    }
    const baseMeta = data.workshopCounts || { warnings: [], dates: null };
    const nextPayload = { ...baseMeta, rows: filtered };
    if (customCounts) setCustomCounts({ ...customCounts, rows: filtered });
    if (onSaveCounts) await onSaveCounts(nextPayload);
  };
  const exportResult = async () => { try { const effectiveModeLabel = data.confirmedWip?.active && mode !== 'issued' ? `Số dở dang đã chốt LAF/LVF (${data.confirmedWip.confirmedAt ? new Date(data.confirmedWip.confirmedAt).toLocaleString('vi-VN') : ''})` : labels[mode]; const bytes=await createSnapshotWorkbook(calc,{asOf,warehouse:selectedWarehouseInfo?.name,warehouseId:selectedWarehouse,modeLabel:effectiveModeLabel,groupByName,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,progressSource:data.importMeta?.['production-orders']?.sourceFile || '',normSource:data.importMeta?.['chemical-norms:' + selectedWarehouse]?.sourceFile || 'BOM hoặc nguồn chưa ghi tên',issuedSource:issuedFile,countSource:countFile + (countNotes ? ' | ' + Object.values(countNotes.dates).join(' | ') + ' | Lưu ý: mốc đếm có thể khác mốc tiến độ; đối chiếu chỉ tạm tính.' : ''),comparison: comparison ? displaySummary : null,summaryRows: displaySummary,productionOrders:data.productionOrders || [],materialIssues,lvfStage}); download(bytes,`Ton_kiem_ke_${selectedWarehouse}.xlsx`); setError(''); } catch(e) {setError(e.message || 'Không xuất được file.');} };
  return <>
    <div className="page-heading"><div><div className="eyebrow">KIỂM KÊ <span>•</span> THEO ĐƠN DỞ DANG 4 KHO</div><h1>Tồn lý thuyết theo định mức</h1><p>Chặt (S − U) → Kho xưởng LAF & Hóa mẫu LAF · May/Gò (S − V/W) → Kho xưởng LVF & Hóa mẫu LVF.</p></div><button className="button button-secondary" disabled={!calc.ready || !asOf || (mode === 'issued' && !issuedRows.length)} onClick={exportResult}><ArrowDownToLine size={16} /> Xuất kết quả Excel</button></div>
    {data.confirmedWip?.active && mode !== 'issued' && (
      <div className="task-guidance" style={{ marginBottom: 12, borderColor: 'var(--accent, #0ea5e9)' }}>
        <ShieldCheck size={18} />
        <span><strong>Đang áp dụng số lượng đôi dở dang ĐÃ CHỐT (LAF & LVF)</strong> từ tab Đối chiếu dở dang ({Object.keys(data.confirmedWip.rows || {}).length} chỉ lệnh chốt lúc {data.confirmedWip.confirmedAt ? new Date(data.confirmedWip.confirmedAt).toLocaleString('vi-VN') : '—'}). Báo cáo kiểm kê đang tính theo số đã chốt này.</span>
        {onOpenReconcile && <button type="button" className="text-button" onClick={onOpenReconcile}>Xem / Chỉnh số chốt →</button>}
      </div>
    )}
    <div className="plant-tabs warehouse-tabs">{WAREHOUSES.map(w => <button key={w.id} className={selectedWarehouse === w.id ? 'active' : ''} onClick={() => { setWarehouse(w.id); setSelected(null); }}><span className={`plant-dot ${w.color}`} />{w.name}</button>)}</div>
    <div className="task-guidance"><FileSpreadsheet size={18}/><span><strong>Quy tắc công đoạn:</strong> Chặt (cột U) tương ứng dở dang của <strong>Kho xưởng LAF</strong> và <strong>Kho Hóa mẫu LAF</strong>; May (cột V) & Gò (cột W) tương ứng dở dang của <strong>Kho xưởng LVF</strong> và <strong>Kho Hóa mẫu LVF</strong>. Dở dang = Cơ sở − Đã sản xuất tại công đoạn.</span></div>
    <section className="panel" style={{padding:20,marginBottom:16}}><div className="form-grid">
      <label>Mốc kiểm kê (giờ trên thiết bị)<input type="datetime-local" value={asOf} onChange={e=>setAsOf(e.target.value)}/></label>
      <label>Số đôi cơ sở<select value={mode} onChange={e=>setMode(e.target.value)}><option value="planned">SL đơn hàng (cột S) trong TIEN-DO-SX-DONHANG</option><option value="released">SL phát lệnh SX (cột T)</option><option value="issued">Số đôi đã lĩnh theo file riêng</option></select></label>
      {(selectedWarehouse === 'HOA_MAU_LVF' || selectedWarehouse === 'LVF') && <label>Công đoạn LVF<select value={lvfStage} onChange={e=>setLvfStage(e.target.value)}><option value="both">May + Gò — theo cột công đoạn của định mức</option><option value="may">May (cột V)</option><option value="go">Gò (cột W)</option></select></label>}
      {mode === 'issued' && <div><label className="button button-secondary button-small upload-control"><Upload size={14}/> Nhập file số đôi đã lĩnh<input type="file" accept=".xlsx" onChange={e=>{const f=e.target.files?.[0]; if(f)importIssued(f); e.target.value='';}}/></label> <button className="text-button" onClick={async()=>download(await createIssuedTemplate(),'Mau_So_Doi_Da_Linh.xlsx')}>Tải mẫu</button><p>{issuedFile ? `${issuedFile} · ${issuedRows.length} dòng` : 'Chưa nạp file số đôi đã lĩnh.'}</p></div>}
      <div className="field-span" style={{display:'flex',flexWrap:'wrap',gap:10,alignItems:'center'}}>
        <label className="button button-secondary button-small upload-control"><Upload size={14}/> Import Thực xuất kho tổng (theo PO)<input type="file" accept=".xlsx,.xlsm" onChange={e=>{const f=e.target.files?.[0]; if(f)importMaterialIssues(f); e.target.value='';}}/></label>
        <label className="button button-secondary button-small upload-control"><Upload size={14}/> Import DM Nhu cầu theo BOM (AE/AF)<input type="file" accept=".xlsx,.xlsm" onChange={e=>{const f=e.target.files?.[0]; if(f)importBomDemand(f); e.target.value='';}}/></label>
        <label className="button button-secondary button-small upload-control"><Upload size={14}/> Nhập kiểm đếm (file mẫu)<input type="file" accept=".xlsx" onChange={e=>{const f=e.target.files?.[0]; if(f)importCount(f); e.target.value='';}}/></label>
        <button className="text-button" onClick={async()=>download(await createCountTemplate(),'Mau_Kiem_Dem.xlsx')}>Tải mẫu</button>
        <label className="button button-secondary button-small upload-control"><Upload size={14}/> Nhập đếm từ workbook thống kê 4 kho<input type="file" accept=".xlsx,.xlsm" onChange={e=>{const f=e.target.files?.[0]; if(f)importWorkshopCounts(f); e.target.value='';}}/></label>
        <span className="helper-label">{countFile ? `Kiểm đếm: ${countFile} (${countRows.length} dòng)` : 'Chưa nạp số đếm thực tế.'}{issueFile ? ` · Kho tổng: ${issueFile} (${materialIssues.length} dòng)` : ''}</span>
      </div>
    </div></section>
    {countNotes && <div className="mapping-warning"><CircleAlert size={16}/><span><strong>Số đếm theo mốc trong workbook — không mặc định trùng mốc tiến độ:</strong> {Object.entries(countNotes.dates).map(([k,v])=>`${k}: ${v}`).join(' · ')}. {countNotes.warnings.length} dòng kiểm đếm không ghép được hoặc không có kết quả công thức; cần kiểm tra nguồn. Đối chiếu chỉ tạm tính khi mốc không đồng nhất.{countNotes.warnings.length > 0 && <details><summary>Xem các dòng đã bỏ qua</summary><ul>{countNotes.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul></details>}</span></div>}
    {error && <div className="mapping-warning"><CircleAlert size={16}/>{error}</div>}
    {!mode && <div className="mapping-warning"><CircleAlert size={16}/>Chọn cơ sở số đôi để tính; số đơn và số phát lệnh chỉ thay số đã lĩnh khi bạn chấp nhận giả định tương ứng.</div>}
    {selectedWarehouse === 'HOA_MAU_LVF' && !lvfStage && <div className="mapping-warning"><CircleAlert size={16}/>Chọn May hoặc Gò cho lần tính này. Không cộng hai công đoạn trên cùng định mức khi chưa có phân bổ, để tránh tính trùng.</div>}
    {mode === 'issued' && !issuedRows.length && <div className="mapping-warning"><CircleAlert size={16}/>Hãy nhập file số đôi đã lĩnh theo mẫu trước khi sử dụng kết quả.</div>}
    {calc.ready && <div className="mapping-warning"><CircleAlert size={16}/>Tính theo SL đơn hàng trừ số đã sản xuất tại công đoạn; đây không phải số vật tư thực tế đã lĩnh.</div>}
    {calc.ready && (selectedWarehouse === 'HOA_MAU_LVF' || selectedWarehouse === 'LVF') && <div className="mapping-warning"><CircleAlert size={16}/>{lvfStage === 'both' ? 'Áp dụng May hoặc Gò theo cột Công đoạn sử dụng của từng dòng định mức. Dòng thiếu công đoạn được đưa vào cần rà soát, không tự cộng trùng.' : `Lần này áp dụng ${calc.stage} cho toàn bộ định mức LVF chưa gán công đoạn. Không cộng kết quả May và Gò nếu cùng một định mức.`}</div>}
    {calc.ready && calc.unmapped.length > 0 && <div className="mapping-warning"><CircleAlert size={16}/><span><strong>{money(calc.unmapped.length)} dòng cần rà soát.</strong> Chuyển sang tab <strong>Chưa ghép (ChuaGhep)</strong> bên dưới hoặc xuất Excel để kiểm tra chi tiết.</span></div>}
    <div className="metric-strip"><MetricInline label="CÔNG ĐOẠN" value={calc.stage || 'Chưa chọn'} /><MetricInline label={groupByName ? 'NHÓM TÊN VẬT TƯ' : 'MÃ VẬT TƯ ĐÃ TÍNH'} value={money(displaySummary.length)} /><MetricInline label="DÒNG CHI TIẾT" value={money(calc.rows.length)} /><MetricInline label="CẦN RÀ SOÁT" value={money(calc.unmapped.length)} /></div>
    <section className="panel table-panel page-table-panel">
      <div className="catalog-toolbar">
        <div className="subtabs">
          <button className={snapshotTab === 'summary' ? 'active' : ''} onClick={() => setSnapshotTab('summary')}>Tổng hợp vật tư <span>{money(rows.length)}</span></button>
          <button className={snapshotTab === 'unmapped' ? 'active' : ''} onClick={() => setSnapshotTab('unmapped')}>Chưa ghép (ChuaGhep) <span>{money(unmappedRows.length)}</span></button>
        </div>
        <div className="toolbar-right" style={{flexWrap:'wrap'}}>
          {snapshotTab === 'summary' && (
            <div className="filter-pills">
              <button type="button" className={groupByName ? 'selected' : ''} onClick={() => setGroupByName(true)}>Gộp theo tên vật tư (chung mã)</button>
              <button type="button" className={!groupByName ? 'selected' : ''} onClick={() => setGroupByName(false)}>Tách theo mã</button>
            </div>
          )}
          {snapshotTab === 'summary' && comparison && (
            <div className="filter-pills">
              {['Tất cả', 'Đã kiểm đếm', 'Chưa đếm', 'Có chênh lệch'].map((label) => (
                <button key={label} type="button" className={countFilter === label ? 'selected' : ''} onClick={() => setCountFilter(label)}>{label}</button>
              ))}
            </div>
          )}
          <div className="search-input"><Search size={16}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder={snapshotTab === 'summary' ? 'Tìm mã hoặc tên vật tư' : 'Tìm chỉ lệnh, mã hàng, màu, lý do...'}/></div>
        </div>
      </div>
      {snapshotTab === 'summary' ? (
        calc.ready && (mode !== 'issued' || issuedRows.length) && rows.length ? <div className="table-scroll"><table><thead><tr><th>MÃ VẬT TƯ / TÊN</th><th>CODE MÀU</th><th>ĐVT</th><th className="numeric">SỐ CHỈ LỆNH</th><th className="numeric">TỒN THEO ĐỊNH MỨC</th>{comparison && <><th className="numeric">ĐÃ LÃNH KHO TỔNG (CL DỞ DANG)</th><th className="numeric">THỰC ĐẾM HIỆN TRƯỜNG</th><th className="numeric">CHÊNH LỆCH</th><th>ĐỐI CHIẾU</th></>}<th>CHI TIẾT</th></tr></thead><tbody>{rows.map(r=><tr key={`${r.materialCode}|${r.materialColor || ''}|${r.unit}`}><td><strong>{r.materialCode}</strong>{r.materialCodes?.length > 1 && <span className="pill-badge" style={{marginLeft:6,fontSize:11,padding:'1px 6px',borderRadius:999,background:'var(--accent-soft, #e0f2fe)',color:'var(--accent, #0369a1)'}}>Gộp {r.materialCodes.length} mã</span>}<small>{r.materialName}</small></td><td>{r.materialColor || '—'}</td><td>{r.unit}</td><td className="numeric">{money(r.orderCount)}</td><td className="numeric strong-cell">{r.quantity == null ? '—' : money(r.quantity,3)}</td>{comparison && <><td className="numeric">{r.issuedFromMain == null ? '—' : money(r.issuedFromMain,3)}</td><td className="numeric"><NumberInput className="cell-input numeric-input count-input" placeholder="Nhập tay" value={r.actual ?? ''} onSave={(val)=>updateManualCount(r,val)} /></td><td className={`numeric ${(r.variance || 0) < 0 ? 'text-danger' : (r.variance || 0) > 0 ? 'text-warning' : ''}`}>{r.variance == null ? '—' : money(r.variance,3)}</td><td>{r.comparison}</td></>}<td>{r.details.length ? <button className="text-button" onClick={()=>setSelected(r)}>Theo đơn →</button> : '—'}</td></tr>)}</tbody></table></div> : <EmptyInline text={calc.hasSource ? 'Chưa có dòng kết quả phù hợp. Kiểm tra cơ sở, tiến độ, định mức và dòng cần rà soát.' : 'Chưa có nguồn định mức cho kho này. Kiểm tra tab ChuaGhep hoặc nạp định mức trong Tác vụ nhập liệu.'}/>
      ) : (
        unmappedRows.length ? <div className="table-scroll"><table><thead><tr><th>CHỈ LỆNH</th><th>MÃ HÀNG</th><th>MÀU</th><th>MÃ VẬT TƯ</th><th>LÝ DO CẦN RÀ SOÁT</th></tr></thead><tbody>{unmappedRows.slice(0, 500).map((r, i) => <tr key={i}><td><strong>{r.productionOrder || r.orderNo || '—'}</strong></td><td>{r.model || '—'}</td><td>{r.color || '—'}</td><td>{r.materialCode || '—'}</td><td>{r.reason || '—'}</td></tr>)}</tbody></table>{unmappedRows.length > 500 && <div className="table-footnote"><span>Đang hiển thị 500 / {money(unmappedRows.length)} dòng. Xuất Excel để xem toàn bộ.</span></div>}</div> : <EmptyInline text="Không có dòng nào cần rà soát cho kho này." />
      )}
    </section>
    {selected && <RequirementsDetailModal row={selected} warehouseName={selectedWarehouseInfo?.name} onClose={()=>setSelected(null)}/>}
  </>;
}

function RequirementsPage({ data, selectedWarehouse, setWarehouse, onExport, onImport, busyTask }) {
  const [query, setQuery] = useState('');
  const [selectedMaterial, setSelectedMaterial] = useState(null);
  const allRequirements = useMemo(() => new Map(WAREHOUSES.map((warehouse) => [warehouse.id, getTheoreticalRequirements(data, warehouse.id)])), [data]);
  const current = allRequirements.get(selectedWarehouse) || { rows: [], unmapped: [], hasSource: false };
  const searchable = useMemo(() => current.rows.filter((row) => !query || `${row.orderNo} ${row.purchaseOrder} ${row.model} ${row.color} ${row.component} ${row.formulaName} ${row.materialCode} ${row.materialName}`.toLowerCase().includes(query.toLowerCase())), [current, query]);
  const summaries = useMemo(() => summarizeTheoreticalRequirements(searchable), [searchable]);
  const selected = WAREHOUSES.find((item) => item.id === selectedWarehouse);
  const importTask = selected?.kind === 'chemical' ? `chemical-norms:${selectedWarehouse}` : 'bom';
  const importInfo = data.importMeta?.[importTask];
  const orderCount = new Set(searchable.map((row) => row.orderNo)).size;
  const missingSource = !current.hasSource;
  return <>
    <div className="page-heading"><div><div className="eyebrow">BẢNG NHU CẦU <span>•</span> DỮ LIỆU ĐÃ CHUẨN HÓA THEO KHO</div><h1>Nhu cầu vật tư lý thuyết</h1><p>Nhu cầu hóa chất lấy theo định mức chi tiết từng chỉ lệnh; vật tư trực tiếp lấy theo BOM và kho nhận đã khai báo.</p></div><button className="button button-secondary" onClick={() => onExport(`requirements:${selectedWarehouse}`)}><ArrowDownToLine size={16} /> Xuất chi tiết</button></div>
    <div className="plant-tabs warehouse-tabs">{WAREHOUSES.map((warehouse) => {
      const calc = allRequirements.get(warehouse.id) || { rows: [] };
      const count = summarizeTheoreticalRequirements(calc.rows).length;
      return <button key={warehouse.id} className={selectedWarehouse === warehouse.id ? 'active' : ''} onClick={() => setWarehouse(warehouse.id)}><span className={`plant-dot ${warehouse.color}`} />{warehouse.name}<b>{count}</b></button>;
    })}</div>
    <div className="mapping-warning"><CircleAlert size={16} /><span><strong>Chưa đủ dữ liệu để tính vật tư dở dang theo ví dụ kiểm kê.</strong> Phép tính bên dưới chưa dùng lượng NPL đã lĩnh từng đơn; Hóa mẫu đang nhân toàn bộ SL lệnh. Không dùng kết quả này làm số tồn hoặc đối chiếu kiểm kê chính thức.</span></div>
    <div className="task-guidance"><FileSpreadsheet size={18} /><span><strong>Đây là nhu cầu, không phải tồn kho lý thuyết.</strong> Chưa trừ tồn hiện có hay cấp phát. Cơ sở tính: định mức hóa chất / đôi = Số lượng hóa chất ÷ SL đơn hàng nguồn; nhu cầu theo lệnh = định mức / đôi × SL lệnh SX. Với BOM trực tiếp có công đoạn, nhu cầu còn lại = định mức × max(0, SL lệnh SX − SL đã qua công đoạn).</span></div>
    <div className="metric-strip inventory-metrics"><MetricInline label="MÃ VẬT TƯ CÓ NHU CẦU" value={money(summaries.length)} /><MetricInline label="CHỈ LỆNH CÓ NHU CẦU" value={money(orderCount)} /><MetricInline label="DÒNG ĐỊNH MỨC ĐÃ GHÉP" value={money(searchable.length)} /><MetricInline label="DÒNG CHƯA GHÉP / THIẾU KHO" value={money(current.unmapped.length)} /><MetricInline label="NGUỒN" value={current.hasSource ? 'Đã nạp' : 'Chưa có'} /></div>
    {current.unmapped.length > 0 && <div className="mapping-warning"><CircleAlert size={16} /><span><strong>{money(current.unmapped.length)} dòng cần xử lý mapping.</strong> Vật tư đa nhà máy phải có kho nhận cụ thể; dòng định mức cũng cần khớp đúng chỉ lệnh, mã hàng và màu. Xuất file chi tiết để rà soát.</span></div>}
    <section className="panel table-panel page-table-panel"><div className="table-toolbar"><div className="search-input"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm mã vật tư, công đoạn, chỉ lệnh..." /></div><div className="toolbar-right"><span className="helper-label">{selected?.name}</span></div></div>
      {missingSource ? <div className="requirements-empty"><div className="empty-icon"><Boxes size={20} /></div><strong>Chưa có nguồn định mức cho {selected?.name}</strong><span>{selected?.kind === 'chemical' ? 'Nguồn DM Hóa mẫu của khu vực này chưa được nhập. Hệ thống để trống kết quả, không lấy định mức của LAF thay thế.' : 'Chưa có BOM trực tiếp hoặc chưa khai báo kho nhận LAF/LVF trong danh mục.'}</span><label className="button button-primary button-small upload-control"><Upload size={14} />{busyTask === importTask ? 'Đang nhập...' : selected?.kind === 'chemical' ? 'Import định mức Hóa mẫu' : 'Import BOM trực tiếp'}<input type="file" accept=".xlsx,.xlsm" disabled={Boolean(busyTask)} onChange={(event) => { const file = event.target.files?.[0]; if (file) onImport(importTask, file); event.target.value = ''; }} /></label></div>
        : summaries.length ? <div className="table-scroll"><table className="requirements-table"><thead><tr><th>CÔNG ĐOẠN / CỤM</th><th>MÃ VẬT TƯ / TÊN</th><th className="numeric">SỐ CHỈ LỆNH</th><th className="numeric">NHU CẦU LÝ THUYẾT</th><th>ĐVT</th><th>CHI TIẾT</th></tr></thead><tbody>{summaries.map((row, index) => <tr key={`${row.materialCode}|${row.component}|${index}`}><td>{row.component || '—'}</td><td><strong>{row.materialCode}</strong><small>{row.materialName}</small></td><td className="numeric">{money(row.orderCount)}</td><td className="numeric strong-cell">{money(row.quantity, 3)}</td><td>{row.unit || '—'}</td><td><button className="text-button" onClick={() => setSelectedMaterial(row)}>Theo đơn hàng →</button></td></tr>)}</tbody></table></div>
        : <div className="requirements-empty"><div className="empty-icon"><Search size={20} /></div><strong>Chưa có dòng nhu cầu khớp</strong><span>{current.hasSource ? 'Kiểm tra mã hàng, màu, chỉ lệnh hoặc số lượng lệnh sản xuất bằng 0.' : 'Nhập nguồn định mức và tiến độ sản xuất ở Tác vụ nhập liệu.'}</span></div>}
      <div className="table-footnote"><span>{importInfo ? `Nguồn: ${importInfo.sourceFile} · nạp ${new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(importInfo.importedAt))}` : selected?.kind === 'factory' ? 'Nguồn: ma trận BOM + khai báo nhà máy/kho nhận' : 'Chưa nạp định mức nguồn cho kho này'}</span><span>{money(summaries.length)} mã vật tư</span></div>
    </section>
    {selectedMaterial && <RequirementsDetailModal row={selectedMaterial} warehouseName={selected?.name} onClose={() => setSelectedMaterial(null)} />}
  </>;
}

function RequirementsDetailModal({ row, warehouseName, onClose }) {
  const details = [...row.details].sort((a, b) => String(a.orderNo).localeCompare(String(b.orderNo), 'vi'));
  return <ModalShell title={`${row.materialCode} · ${row.materialName}`} subtitle={`${warehouseName} · ${row.component || 'Tổng vật tư'} · ${money(row.quantity, 3)} ${row.unit || ''}`} onClose={onClose}>
    <div className="table-scroll requirement-detail-scroll"><table><thead><tr><th>CHỈ LỆNH</th><th>PO</th><th>MÃ HÀNG / MÀU</th><th>CÔNG THỨC / CÔNG ĐOẠN</th><th className="numeric">ĐỊNH MỨC / ĐÔI</th><th>CƠ SỞ SỐ LƯỢNG</th>{details.some(line => line.stage) && <><th className="numeric">SL CƠ SỞ</th><th className="numeric">ĐÃ QUA CÔNG ĐOẠN</th></>}<th className="numeric">SL QUY ĐỔI</th><th className="numeric">NHU CẦU</th></tr></thead><tbody>{details.map((line, index) => <tr key={`${line.orderNo}|${line.formulaName}|${line.sourceRow}|${index}`}><td>{line.orderNo}</td><td>{line.purchaseOrder || '—'}</td><td>{line.model}<small>{line.color}</small></td><td>{line.formulaName || line.component || '—'}</td><td className="numeric">{money(line.rate, 6)}</td><td>{line.basisType || 'Số lượng lệnh sản xuất'}</td>{details.some(item => item.stage) && <><td className="numeric">{line.qty == null ? '—' : money(line.qty)}</td><td className="numeric">{line.done == null ? '—' : money(line.done)}</td></>}<td className="numeric">{money(line.basisQty)}</td><td className="numeric strong-cell">{money(line.quantity, 3)} {line.unit}</td></tr>)}</tbody></table></div>
  </ModalShell>;
}

function CatalogPage({ data, tab, setTab, onAddMaterial, onAddBom }) {
  const [query, setQuery] = useState('');
  const materials = data.materials.filter((row) => `${row.catalogNo} ${row.materialCode} ${row.name} ${row.colorScope}`.toLowerCase().includes(query.toLowerCase()));
  const bom = data.bom.filter((row) => {
    const material = data.materials.find((item) => Number(item.catalogNo) === Number(row.catalogNo));
    return `${row.model} ${row.color} ${row.productKey} ${material?.materialCode} ${material?.name}`.toLowerCase().includes(query.toLowerCase());
  });
  return <>
    <div className="page-heading"><div><div className="eyebrow">DANH MỤC CHUNG <span>•</span> DÙNG CHO NHIỀU NHÀ MÁY</div><h1>Danh mục & định mức BOM</h1><p>Một vật tư có thể gắn nhiều nhà máy; mã ghép hàng-màu được lưu thành các dòng định mức.</p></div><button className="button button-primary" onClick={tab === 'materials' ? onAddMaterial : onAddBom}><Plus size={16} />{tab === 'materials' ? 'Thêm vật tư' : 'Thêm định mức'}</button></div>
    <div className="catalog-summary"><div><Boxes size={18} /><strong>{money(data.materials.length)}</strong><span>mã vật tư</span></div><div><ArrowLeftRight size={18} /><strong>{money(data.bom.length)}</strong><span>dòng BOM</span></div><div><Package size={18} /><strong>{money(new Set(data.bom.map((row) => row.productKey)).size)}</strong><span>mã hàng - màu</span></div><div><Layers3 size={18} /><strong>{money(data.materials.filter((row) => row.plants?.length > 1).length)}</strong><span>vật tư đa nhà máy</span></div></div>
    <section className="panel table-panel page-table-panel"><div className="catalog-toolbar"><div className="subtabs"><button className={tab === 'materials' ? 'active' : ''} onClick={() => setTab('materials')}>Vật tư <span>{money(data.materials.length)}</span></button><button className={tab === 'bom' ? 'active' : ''} onClick={() => setTab('bom')}>Ma trận BOM <span>{money(data.bom.length)}</span></button></div><div className="search-input"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm trong danh mục..." /></div></div>
      {tab === 'materials' ? (materials.length ? <div className="table-scroll"><table><thead><tr><th>STT</th><th>MÃ VẬT TƯ</th><th>TÊN VẬT TƯ</th><th>NHÀ MÁY SỬ DỤNG</th><th>MÀU / PHẠM VI</th><th>ĐVT ERP</th><th>ĐVT CẤP PHÁT</th></tr></thead><tbody>{materials.map((row) => <tr key={row.catalogNo}><td>{row.catalogNo}</td><td><strong>{row.materialCode}</strong></td><td>{row.name}</td><td><div className="plant-tags">{(row.plants || []).map((plantId) => <PlantTag key={plantId} plantId={plantId} />)}</div></td><td>{row.colorScope || '—'}</td><td>{row.unit || '—'}</td><td>{row.issueUnit || '—'}</td></tr>)}</tbody></table></div> : <EmptyState title="Danh mục đang trống" text="Nhập file thống kê hoặc thêm vật tư mới. Dữ liệu mẫu không được nạp sẵn." action="Thêm vật tư" onAction={onAddMaterial} />) : (bom.length ? <div className="table-scroll"><table><thead><tr><th>MÃ HÀNG - MÀU</th><th>MÃ VẬT TƯ</th><th>TÊN VẬT TƯ</th><th>NHÀ MÁY</th><th className="numeric">ĐỊNH MỨC</th><th>ĐVT</th></tr></thead><tbody>{bom.map((line, index) => { const material = data.materials.find((item) => Number(item.catalogNo) === Number(line.catalogNo)); return <tr key={bomKey(line) + index}><td><strong>{line.productKey}</strong></td><td>{material?.materialCode || line.catalogNo}</td><td>{material?.name || '—'}</td><td>{line.plant ? getPlantName(line.plant) : 'Theo BOM chung'}</td><td className="numeric">{money(line.rate, 4)}</td><td>{material?.unit || '—'}</td></tr>; })}</tbody></table></div> : <EmptyState title="Ma trận BOM đang trống" text="Nhập workbook để nạp định mức theo từng cặp mã hàng - màu sắc." action="Nhập file" onAction={() => window.dispatchEvent(new CustomEvent('open-import'))} />)}
      <div className="table-footnote"><span>Vật tư dùng chung được gắn đồng thời với từng nhà máy được chọn.</span><span>{tab === 'materials' ? `${materials.length} mã` : `${bom.length} dòng`}</span></div>
    </section>
  </>;
}

function NormsPage({ data, onAdd }) {
  const [query, setQuery] = useState('');
  const norms = data.norms.filter((row) => `${row.catalogNo} ${row.productKey} ${row.size} ${row.process} ${row.btpCode} ${row.btpName}`.toLowerCase().includes(query.toLowerCase()));
  return <>
    <div className="page-heading"><div><div className="eyebrow">BẢNG PHỤ <span>•</span> NHÀ MÁY LAF</div><h1>Định mức BTP theo size</h1><p>Chi tiết vật tư, mã hàng-màu, size, công đoạn và định mức cho từng dòng bán thành phẩm.</p></div><button className="button button-primary" onClick={onAdd}><Plus size={16} />Thêm định mức size</button></div>
    <div className="metric-strip"><MetricInline label="Dòng định mức" value={money(data.norms.length)} /><MetricInline label="Vật tư liên quan" value={money(new Set(data.norms.map((row) => row.catalogNo)).size)} /><MetricInline label="Mã hàng - màu" value={money(new Set(data.norms.map((row) => row.productKey)).size)} /><MetricInline label="Công đoạn" value={money(new Set(data.norms.map((row) => row.process).filter(Boolean)).size)} /></div>
    <section className="panel table-panel page-table-panel"><div className="table-toolbar"><div className="search-input"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm vật tư, mã hàng, size, công đoạn..." /></div><span className="helper-label">Từ sheet DM_BTP_Size_LAF</span></div>
      {norms.length ? <div className="table-scroll"><table><thead><tr><th>STT DM</th><th>MÃ VẬT TƯ / TÊN</th><th>MÃ HÀNG - MÀU</th><th>SIZE</th><th>CÔNG ĐOẠN</th><th>MÃ BTP</th><th>TÊN BTP</th><th className="numeric">ĐỊNH MỨC / ĐÔI</th><th className="numeric">SL KẾ HOẠCH</th><th className="numeric">NHU CẦU</th></tr></thead><tbody>{norms.map((row, index) => { const material = data.materials.find((item) => Number(item.catalogNo) === Number(row.catalogNo)); return <tr key={`${normKey(row)}|${index}`}><td>{row.catalogNo}</td><td><strong>{material?.materialCode || row.materialCode || '—'}</strong><small>{material?.name || row.materialName || '—'}</small></td><td>{row.productKey}</td><td>{row.size || '—'}</td><td>{row.process || '—'}</td><td>{row.btpCode || '—'}</td><td>{row.btpName || '—'}</td><td className="numeric">{money(row.rate, 4)}</td><td className="numeric">{money(row.plannedQty)}</td><td className="numeric">{money(row.rate * row.plannedQty, 2)}</td></tr>; })}</tbody></table></div> : <EmptyState title="Chưa có định mức size" text="Nhập file thống kê .xlsm/.xlsx. Sheet DM_BTP_Size_LAF sẽ được đọc riêng; sheet BTP trong DON HANG không được sử dụng." action="Nhập workbook" onAction={() => window.dispatchEvent(new CustomEvent('open-import'))} />}
      <div className="table-footnote"><span>Không lấy sheet BTP trong DON HANG.xlsx.</span><span>{money(norms.length)} dòng</span></div>
    </section>
  </>;
}

function PlantTag({ plantId }) {
  const plant = PLANTS.find((item) => item.id === plantId);
  return <span className={`plant-tag ${plant?.color || ''}`}><i />{plant?.name || plantId}</span>;
}

function StatusBadge({ status }) { return <span className={`status-badge ${statusTone(status)}`}><i />{status}</span>; }

function EmptyInline({ text }) { return <div className="empty-inline"><Package size={18} />{text}</div>; }
function EmptyState({ title, text, action, onAction }) { return <div className="empty-state"><div className="empty-illustration"><FileSpreadsheet size={25} /></div><strong>{title}</strong><p>{text}</p>{action && <button className="button button-secondary button-small" onClick={onAction}><Plus size={14} />{action}</button>}</div>; }

function LoginScreen({ onSubmit, error }) {
  return <div className="login-screen"><div className="login-card"><div className="brand-mark large"><Package size={25} /></div><div className="eyebrow">KHO XƯỞNG · HỆ THỐNG NỘI BỘ</div><h1>Đăng nhập</h1><p>Truy cập dữ liệu dùng chung của Hóa mẫu, LAF và LVF.</p><form onSubmit={onSubmit}><label>Email<input name="email" type="email" autoComplete="username" required placeholder="ten@congty.com" /></label><label>Mật khẩu<input name="password" type="password" autoComplete="current-password" required placeholder="••••••••••" /></label>{error && <div className="login-error">{error}</div>}<button className="button button-primary full-width" type="submit">Đăng nhập hệ thống</button></form><div className="login-note"><ShieldCheck size={15} /> Tài khoản được tạo bởi quản trị Supabase.</div></div></div>;
}

function CloudAccessScreen({ error, onSignOut }) {
  return <div className="login-screen"><div className="login-card"><div className="brand-mark large"><ShieldCheck size={25} /></div><div className="eyebrow">KHO XƯỞNG · QUYỀN TRUY CẬP</div><h1>Chưa có workspace</h1><p>{error}</p><p>Hãy nhờ quản trị viên thêm email của bạn vào <code>workspace_members</code>, rồi đăng nhập lại.</p><button className="button button-primary full-width" onClick={onSignOut}>Đăng xuất</button></div></div>;
}

function LoadingScreen({ label }) { return <div className="loading-screen"><div className="loader" /><strong>{label}</strong><span>Đang kết nối không gian dữ liệu</span></div>; }

function MaterialModal({ onClose, onSave }) {
  const [plants, setPlants] = useState(['LAF']);
  const toggle = (id) => setPlants((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const submit = (event) => { event.preventDefault(); const form = Object.fromEntries(new FormData(event.currentTarget)); onSave({ ...form, plants }); };
  return <ModalShell title="Thêm vật tư" subtitle="Một mã vật tư có thể cùng lúc thuộc nhiều nhà máy." onClose={onClose}><form className="form-grid" onSubmit={submit}><label>STT danh mục<input name="catalogNo" type="number" min="1" placeholder="Tự tăng tiếp theo" /></label><label>Mã vật tư *<input name="materialCode" required placeholder="VD: VT-013" /></label><label className="field-span">Tên vật tư *<input name="name" required placeholder="Tên vật tư / quy cách" /></label><label>ĐVT ERP<input name="unit" placeholder="mét, kg, cái..." /></label><label>ĐVT cấp phát<input name="issueUnit" placeholder="cuộn, kiện..." /></label><label>Quy cách / kiện<input name="packQty" type="number" min="0" step="any" placeholder="0" /></label><label className="field-span">Phạm vi mã màu<input name="colorScope" placeholder="Dùng chung theo BOM hoặc mã màu" /></label><div className="field-span"><div className="form-label">Nhà máy sử dụng *</div><div className="plant-checks">{PLANTS.map((plant) => <label key={plant.id} className={`plant-check ${plants.includes(plant.id) ? 'checked' : ''}`}><input type="checkbox" checked={plants.includes(plant.id)} onChange={() => toggle(plant.id)} /><span className={`plant-dot ${plant.color}`} />{plant.name}</label>)}</div></div><div className="modal-actions field-span"><button type="button" className="button button-ghost" onClick={onClose}>Hủy</button><button type="submit" className="button button-primary"><Check size={15} /> Lưu vật tư</button></div></form></ModalShell>;
}

function BomModal({ materials, onClose, onSave }) {
  const [plant, setPlant] = useState('LAF');
  const submit = (event) => { event.preventDefault(); onSave({ ...Object.fromEntries(new FormData(event.currentTarget)), plant }); };
  return <ModalShell title="Thêm định mức BOM" subtitle="Nhập một dòng định mức cho cặp mã hàng - màu sắc." onClose={onClose}><form className="form-grid" onSubmit={submit}><label className="field-span">Vật tư<select name="catalogNo" required defaultValue=""><option value="" disabled>Chọn vật tư</option>{materials.map((item) => <option key={item.catalogNo} value={item.catalogNo}>{item.catalogNo} · {item.materialCode} · {item.name}</option>)}</select></label><label>Mã hàng<input name="model" required placeholder="VD: SP001" /></label><label>Mã màu<input name="color" required placeholder="VD: BLACK-001" /></label><label>Định mức / đôi<input name="rate" required type="number" min="0" step="0.0001" /></label><label>Nhà máy<select value={plant} onChange={(event) => setPlant(event.target.value)}><option value="LAF">LAF</option><option value="LVF">LVF</option><option value="HOA_MAU">Hóa mẫu</option></select></label><div className="modal-actions field-span"><button type="button" className="button button-ghost" onClick={onClose}>Hủy</button><button className="button button-primary" type="submit"><Check size={15} /> Lưu định mức</button></div></form></ModalShell>;
}

function OrderModal({ onClose, onSave }) {
  const submit = (event) => { event.preventDefault(); onSave(Object.fromEntries(new FormData(event.currentTarget))); };
  return <ModalShell title="Thêm đơn hàng" subtitle="Nhập một dòng theo chỉ lệnh / mã hàng / màu sắc." onClose={onClose}><form className="form-grid" onSubmit={submit}><label>Mã đơn hàng / LSX *<input name="orderNo" required placeholder="VD: LSX-2609-001" /></label><label>Mã hàng *<input name="model" required /></label><label>Mã màu *<input name="color" required /></label><label>Tên màu<input name="colorName" /></label><label>Nhà máy chính<select name="plant" defaultValue="LAF"><option value="HOA_MAU">Hóa mẫu</option><option value="LAF">LAF</option><option value="LVF">LVF</option></select></label><label>Số lượng kế hoạch (đôi) *<input name="plannedQty" required type="number" min="1" /></label><div className="modal-actions field-span"><button type="button" className="button button-ghost" onClick={onClose}>Hủy</button><button type="submit" className="button button-primary"><Check size={15} /> Lưu đơn hàng</button></div></form></ModalShell>;
}

function NormModal({ materials, onClose, onSave }) {
  const submit = (event) => { event.preventDefault(); onSave(Object.fromEntries(new FormData(event.currentTarget))); };
  return <ModalShell title="Thêm định mức BTP theo size" subtitle="Mỗi dòng là một vật tư cho mã hàng-màu, size và công đoạn LAF." onClose={onClose}>
    <form className="form-grid" onSubmit={submit}>
      <label className="field-span">Vật tư *<select name="catalogNo" required defaultValue=""><option value="" disabled>Chọn vật tư trong danh mục</option>{materials.map((item) => <option key={item.catalogNo} value={item.catalogNo}>{item.catalogNo} · {item.materialCode} · {item.name}</option>)}</select></label>
      <label>Mã hàng *<input name="model" required placeholder="VD: NVQ89" /></label><label>Mã màu *<input name="color" required placeholder="VD: LC1783" /></label>
      <label>Size *<input name="size" required placeholder="VD: 7" /></label><label>Công đoạn LAF<input name="process" placeholder="VD: Lót / Tẩy" /></label>
      <label>Mã BTP<input name="btpCode" /></label><label>Tên BTP<input name="btpName" /></label>
      <label>Định mức / 1 đôi *<input name="rate" type="number" min="0.000001" step="any" required /></label><label>SL kế hoạch theo size<input name="plannedQty" type="number" min="0" step="any" defaultValue="0" /></label>
      <label>SL WIP LAF theo size<input name="wipQty" type="number" min="0" step="any" defaultValue="0" /></label>
      <div className="modal-actions field-span"><button type="button" className="button button-ghost" onClick={onClose}>Hủy</button><button className="button button-primary" type="submit"><Check size={15} />Lưu định mức</button></div>
    </form>
  </ModalShell>;
}

function SetupModal({ onClose }) {
  return <ModalShell title="Kết nối dữ liệu dùng chung" subtitle="Cần một dự án Supabase để nhiều người và nhà máy dùng chung dữ liệu." onClose={onClose}><div className="setup-steps"><div><b>1</b><span>Tạo project Supabase và chạy file <code>supabase/schema.sql</code> trong SQL Editor.</span></div><div><b>2</b><span>Tạo tài khoản người dùng trong Supabase Auth.</span></div><div><b>3</b><span>Thêm biến <code>VITE_SUPABASE_URL</code> và <code>VITE_SUPABASE_ANON_KEY</code> trong Vercel Project Settings.</span></div><div><b>4</b><span>Redeploy. Người đăng nhập đầu tiên sẽ có workspace riêng; dữ liệu được giới hạn bằng RLS.</span></div></div><p className="setup-footnote">Bản đang chạy lưu dữ liệu trong trình duyệt. Chưa nhập dữ liệu thật vào dịch vụ bên thứ ba.</p><div className="modal-actions"><button className="button button-primary" onClick={onClose}>Đã hiểu</button></div></ModalShell>;
}

function WipReconcilePage({ data, onImportReport, onSaveConfirmed, onOpenWarehouse }) {
  const [plantFilter, setPlantFilter] = useState('Tất cả');
  const [statusFilter, setStatusFilter] = useState('Tất cả');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [draftMap, setDraftMap] = useState(() => ({ ...(data.confirmedWip?.rows || {}) }));

  useEffect(() => {
    setDraftMap({ ...(data.confirmedWip?.rows || {}) });
  }, [data.confirmedWip]);

  const prodOrders = useMemo(
    () => currentImportedRows(data.productionOrders, data.importMeta, 'production-orders'),
    [data.productionOrders, data.importMeta]
  );
  const reconcile = useMemo(
    () => reconcileWorkshopWip(prodOrders, data.workshopWipReports || [], draftMap),
    [prodOrders, data.workshopWipReports, draftMap]
  );

  const visibleRows = useMemo(() => reconcile.rows.filter((r) => {
    if (plantFilter !== 'Tất cả' && r.plant !== plantFilter) return false;
    if (statusFilter === 'Chỉ xem sai lệch' && r.status === 'Khớp') return false;
    if (statusFilter === 'Khớp' && r.status !== 'Khớp') return false;
    if (statusFilter === 'Xưởng chưa báo' && r.status !== 'Hệ thống có dở dang — Xưởng chưa báo') return false;
    if (statusFilter === 'Xưởng báo lệch số' && !r.status.startsWith('Xưởng báo')) return false;
    const q = query.trim().toLowerCase();
    if (q && !`${r.orderNo} ${r.po} ${r.so} ${r.model} ${r.color} ${r.plant} ${r.status}`.toLowerCase().includes(q)) return false;
    return true;
  }), [reconcile.rows, plantFilter, statusFilter, query]);

  const download = (bytes, name) => {
    const u = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const a = document.createElement('a');
    a.href = u;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(u), 1000);
  };

  const handleImport = async (file) => {
    try {
      const parsed = await readWorkshopWipReport(file);
      await onImportReport(parsed.rows, file.name);
      setError('');
    } catch (e) {
      setError(e.message || 'Không đọc được file báo cáo dở dang xưởng.');
    }
  };

  const handleExport = async () => {
    try {
      const bytes = await createWipReconcileWorkbook(reconcile, {
        confirmedActive: Boolean(data.confirmedWip?.active),
        confirmedAt: data.confirmedWip?.confirmedAt ? new Date(data.confirmedWip.confirmedAt).toLocaleString('vi-VN') : '',
      });
      download(bytes, 'Doi_chieu_do_dang_HeThong_vs_Xuong.xlsx');
      setError('');
    } catch (e) {
      setError(e.message || 'Không xuất được file báo cáo đối chiếu.');
    }
  };

  const fillDraftFrom = (source) => {
    const next = {};
    for (const r of reconcile.rows) {
      if (source === 'workshop') {
        if (r.reportedWip !== null) next[r.key] = r.reportedWip;
      } else {
        if (r.systemWip > 0) next[r.key] = r.systemWip;
      }
    }
    setDraftMap(next);
  };

  const updateRowDraft = (rowKey, rawVal) => {
    const trimmed = String(rawVal ?? '').trim();
    setDraftMap((prev) => {
      const next = { ...prev };
      if (trimmed === '') {
        delete next[rowKey];
      } else {
        const n = Number(trimmed.replace(',', '.'));
        if (Number.isFinite(n) && n >= 0) next[rowKey] = n;
      }
      return next;
    });
  };

  const applyConfirmed = async () => {
    const clean = {};
    for (const [k, v] of Object.entries(draftMap)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) clean[k] = n;
    }
    if (!Object.keys(clean).length) {
      setError('Chưa có dòng nào có số lượng chốt > 0. Hãy bấm "Điền chốt = Xưởng báo cáo" hoặc nhập số chốt rồi bấm Chốt.');
      return;
    }
    setError('');
    await onSaveConfirmed({ active: true, confirmedAt: new Date().toISOString(), rows: clean });
  };

  const cancelConfirmed = async () => {
    await onSaveConfirmed({ active: false, confirmedAt: '', rows: draftMap });
  };

  const isActive = Boolean(data.confirmedWip?.active);
  const draftCount = Object.values(draftMap).filter((v) => Number(v) > 0).length;
  const draftTotal = Object.values(draftMap).reduce((s, v) => s + (Number(v) > 0 ? Number(v) : 0), 0);

  return <>
    <div className="page-heading">
      <div>
        <div className="eyebrow">KIỂM SOÁT SỐ LIỆU <span>•</span> ĐỐI CHIẾU DỞ DANG LAF & LVF</div>
        <h1>Đối chiếu số lượng dở dang: Hệ thống vs Xưởng báo cáo</h1>
        <p>So sánh số đôi dở dang từ ERP (<code>TIEN-DO-SX-DONHANG.xlsx</code>) với báo cáo thực tế của xưởng (<code>DON HANG DO DANG THUC TE XUONG BAO CAO.xlsx</code>). Sau khi rà soát và chốt số đúng, đẩy số chốt vào lõi kiểm kê 4 kho.</p>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="button button-secondary" onClick={handleExport}><ArrowDownToLine size={16} /> Xuất báo cáo đối chiếu</button>
        <button className="button button-primary" onClick={applyConfirmed}><Check size={16} /> Chốt số & Áp dụng tính kiểm kê ({money(draftCount)} lệnh)</button>
      </div>
    </div>

    {isActive ? (
      <div className="task-guidance" style={{ marginBottom: 14, borderColor: 'var(--accent, #0ea5e9)' }}>
        <ShieldCheck size={18} />
        <span><strong>Đang áp dụng số dở dang đã chốt</strong> ({Object.keys(data.confirmedWip.rows || {}).length} chỉ lệnh · chốt lúc {data.confirmedWip.confirmedAt ? new Date(data.confirmedWip.confirmedAt).toLocaleString('vi-VN') : '—'}) cho toàn bộ tính toán kiểm kê LAF & LVF.</span>
        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" className="text-button" onClick={() => onOpenWarehouse('LAF')}>Mở kiểm kê LAF →</button>
          <button type="button" className="text-button" onClick={() => onOpenWarehouse('LVF')}>Mở kiểm kê LVF →</button>
          <button type="button" className="text-button" onClick={cancelConfirmed}>Hủy chốt (về tiến độ ERP)</button>
        </div>
      </div>
    ) : (
      <div className="mapping-warning" style={{ marginBottom: 14 }}>
        <CircleAlert size={16} />
        <span><strong>Chưa chốt số dở dang:</strong> Hệ thống kiểm kê 4 kho hiện đang tính theo tiến độ ERP gốc. Hãy rà soát bảng sai lệch bên dưới, điền cột <strong>Số chốt kiểm kê</strong> và bấm <strong>Chốt số & Áp dụng tính kiểm kê</strong> để đẩy số đúng cho LAF và LVF.</span>
      </div>
    )}

    <div className="metric-strip" style={{ marginBottom: 16 }}>
      <MetricInline label="TỔNG CHỈ LỆNH ĐỐI CHIẾU" value={money(reconcile.summary.count)} />
      <MetricInline label="KHỚP HOÀN TOÀN" value={money(reconcile.summary.matched)} />
      <MetricInline label="CÓ SAI LỆCH / THIẾU BÁO" value={money(reconcile.summary.mismatch)} />
      <MetricInline label="DỞ DANG HỆ THỐNG (ĐÔI)" value={money(reconcile.summary.systemWipTotal)} />
      <MetricInline label="DỞ DANG XƯỞNG BÁO (ĐÔI)" value={money(reconcile.summary.reportedWipTotal)} />
      <MetricInline label="ĐANG CHỌN CHỐT (ĐÔI)" value={money(draftTotal)} />
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12, marginBottom: 16 }}>
      {['LAF', 'LVF'].map((p) => {
        const b = reconcile.byPlant[p];
        const d = b.reportedWipTotal - b.systemWipTotal;
        return (
          <section className="panel" key={p} style={{ padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <strong>Nhà máy {p} ({p === 'LAF' ? 'Chặt: S − U' : 'Gò: S − W'})</strong>
              <span className="plant-tag">{money(b.matched)}/{money(b.count)} khớp</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, fontSize: 13 }}>
              <div><small style={{ display: 'block', opacity: 0.7 }}>Hệ thống</small><strong>{money(b.systemWipTotal)} đôi</strong></div>
              <div><small style={{ display: 'block', opacity: 0.7 }}>Xưởng báo</small><strong>{money(b.reportedWipTotal)} đôi</strong></div>
              <div><small style={{ display: 'block', opacity: 0.7 }}>Chênh lệch</small><strong className={d < 0 ? 'text-danger' : d > 0 ? 'text-warning' : ''}>{d > 0 ? `+${money(d)}` : money(d)} đôi</strong></div>
            </div>
          </section>
        );
      })}
    </div>

    <section className="panel" style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
          <label className="button button-secondary button-small upload-control">
            <Upload size={14} /> Import file Xưởng báo cáo (.xlsx)
            <input type="file" accept=".xlsx,.xlsm" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImport(f); e.target.value = ''; }} />
          </label>
          <button type="button" className="button button-secondary button-small" onClick={() => fillDraftFrom('workshop')}>Điền chốt = Xưởng báo cáo</button>
          <button type="button" className="button button-secondary button-small" onClick={() => fillDraftFrom('system')}>Điền chốt = Hệ thống (ERP)</button>
          <button type="button" className="text-button" onClick={() => setDraftMap({})}>Xóa nháp chốt</button>
        </div>
        <span className="helper-label">Đã nạp {money((data.workshopWipReports || []).length)} dòng báo cáo xưởng</span>
      </div>
      {error && <div className="mapping-warning" style={{ marginTop: 10 }}><CircleAlert size={16} />{error}</div>}
    </section>

    <section className="panel table-panel page-table-panel">
      <div className="table-toolbar" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div className="filter-pills">
          {['Tất cả', 'LAF', 'LVF'].map((p) => (
            <button key={p} type="button" className={plantFilter === p ? 'selected' : ''} onClick={() => setPlantFilter(p)}>{p}</button>
          ))}
        </div>
        <div className="filter-pills">
          {['Tất cả', 'Chỉ xem sai lệch', 'Khớp', 'Xưởng chưa báo', 'Xưởng báo lệch số'].map((st) => (
            <button key={st} type="button" className={statusFilter === st ? 'selected' : ''} onClick={() => setStatusFilter(st)}>{st}</button>
          ))}
        </div>
        <div className="search-input">
          <Search size={16} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Tìm chỉ lệnh, PO, mã hàng, màu..." />
        </div>
      </div>

      {visibleRows.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>NHÀ MÁY</th>
                <th>CHỈ LỆNH / PO</th>
                <th>MÃ HÀNG & MÀU</th>
                <th className="numeric">SL ĐẶT (HT)</th>
                <th className="numeric">ĐÃ SX (HT)</th>
                <th className="numeric">DỞ DANG HỆ THỐNG</th>
                <th className="numeric">DỞ DANG XƯỞNG BÁO</th>
                <th className="numeric">CHÊNH LỆCH (XƯỞNG − HT)</th>
                <th>TRẠNG THÁI ĐỐI CHIẾU</th>
                <th className="numeric">SỐ CHỐT KIỂM KÊ</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((r) => (
                <tr key={r.key}>
                  <td><span className="plant-tag">{r.plant}</span><small>{r.cutoffDate || r.stageLabel}</small></td>
                  <td><strong>{r.orderNo}</strong><small>{r.po || r.so || '—'}</small></td>
                  <td><strong>{r.model || '—'}</strong><small>{r.color || '—'}</small></td>
                  <td className="numeric">{money(r.systemPlanned)}</td>
                  <td className="numeric">{money(r.systemDone)}</td>
                  <td className="numeric strong-cell">{money(r.systemWip)}</td>
                  <td className="numeric strong-cell">{r.reportedWip === null ? '—' : money(r.reportedWip)}</td>
                  <td className={`numeric strong-cell ${r.diff === null ? '' : r.diff < -0.0001 ? 'text-danger' : r.diff > 0.0001 ? 'text-warning' : ''}`}>
                    {r.diff === null ? '—' : r.diff > 0 ? `+${money(r.diff)}` : money(r.diff)}
                  </td>
                  <td><StatusBadge status={r.status} /></td>
                  <td className="numeric">
                    <NumberInput
                      className="cell-input numeric-input count-input"
                      placeholder="Nhập chốt"
                      value={draftMap[r.key] ?? ''}
                      onSave={(val) => updateRowDraft(r.key, val)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyInline text="Không có dòng đối chiếu phù hợp với bộ lọc hiện tại." />
      )}
      <div className="table-footnote">
        <span>Mẹo: Bấm "Điền chốt = Xưởng báo cáo" rồi chỉnh tay các dòng sai lệch, sau đó bấm "Chốt số & Áp dụng tính kiểm kê" để đẩy số sang 4 kho.</span>
        <span>Hiển thị {money(visibleRows.length)} / {money(reconcile.rows.length)} dòng</span>
      </div>
    </section>
  </>;
}

function GuidePage({ data, setPage, onOpenWarehouse }) {
  const countRows = data.workshopCounts?.rows || [];
  const countedByWh = {
    HOA_MAU_LAF: countRows.filter((r) => r.warehouseId === 'HOA_MAU_LAF').length,
    LAF: countRows.filter((r) => r.warehouseId === 'LAF').length,
    HOA_MAU_LVF: countRows.filter((r) => r.warehouseId === 'HOA_MAU_LVF').length,
    LVF: countRows.filter((r) => r.warehouseId === 'LVF').length,
  };
  const warehouseExamples = useMemo(() => {
    const specs = [
      { id: 'HOA_MAU_LAF', name: 'Kho Hóa mẫu LAF', stageLabel: 'Chặt (S − U)', lvfStage: '' },
      { id: 'HOA_MAU_LVF', name: 'Kho Hóa mẫu LVF', stageLabel: 'May + Gò (S − V / W)', lvfStage: 'both' },
      { id: 'LAF', name: 'Kho xưởng LAF', stageLabel: 'Chặt (S − U)', lvfStage: '' },
      { id: 'LVF', name: 'Kho xưởng LVF', stageLabel: 'May + Gò (S − V / W)', lvfStage: 'both' },
    ];
    const materialIssues = data.materialIssues || [];
    const prodOrders = data.productionOrders || [];
    const score = (r) => {
      let s = 0;
      if (r.actual !== null && r.actual !== undefined) s += 100;
      if ((Number(r.quantity) || 0) > 0) s += 50;
      if ((r.details?.length || 0) > 0) s += 30;
      if ((Number(r.issuedFromMain) || 0) > 0) s += 20;
      if ((Number(r.actual) || 0) > 0) s += 10;
      return s;
    };
    return specs.map((spec) => {
      const calc = calculateInventorySnapshot(data, spec.id, { mode: 'planned', lvfStage: spec.lvfStage });
      const cmp = compareSnapshotCounts(calc, countRows, spec.id, { materialIssues, lvfStage: spec.lvfStage, productionOrders: prodOrders });
      const merged = mergeRowsByMaterialName(cmp);
      const picked = [...merged].sort((a, b) => score(b) - score(a) || (Number(b.quantity) || 0) - (Number(a.quantity) || 0))[0] || null;
      if (!picked) return { ...spec, picked: null, orderRows: [], totalOrderQty: 0, totalDoneQty: 0, totalWipQty: 0 };
      const orderMap = new Map();
      for (const d of picked.details || []) {
        const k = `${d.orderNo}|${d.model}|${d.color}`;
        if (!orderMap.has(k)) {
          orderMap.set(k, {
            orderNo: d.orderNo,
            purchaseOrder: d.purchaseOrder || '',
            model: d.model,
            color: d.color,
            qty: Number(d.qty) || 0,
            done: Number(d.done) || 0,
            basisQty: Number(d.basisQty) || 0,
            quantity: 0,
            rate: Number(d.rate) || 0,
            stage: d.stage || spec.stageLabel,
            source: d.source || '',
          });
        }
        orderMap.get(k).quantity += Number(d.quantity) || 0;
      }
      const orderRows = [...orderMap.values()].sort((a, b) => b.quantity - a.quantity);
      return {
        ...spec,
        picked,
        orderRows,
        totalOrderQty: orderRows.reduce((sum, o) => sum + o.qty, 0),
        totalDoneQty: orderRows.reduce((sum, o) => sum + o.done, 0),
        totalWipQty: orderRows.reduce((sum, o) => sum + o.basisQty, 0),
      };
    });
  }, [data, countRows]);
  const fileSheetGuide = [
    {
      file: 'TIEN-DO-SX-DONHANG.xlsx',
      sheet: 'New',
      columns: 'Chỉ lệnh, Số PO, Mã hàng, Màu, SL đơn hàng (cột S), SL lệnh SX (cột T), Chặt (U), May (V), Gò (W), Đóng thùng (X), Nhập kho (Y), Giao hàng (Z)',
      purpose: 'Nguồn duy nhất cho sản lượng đơn hàng & tiến độ sản xuất toàn hệ thống (không lấy DON HANG.xlsx, tự loại bỏ nhóm phụ kiện). Tính số đôi dở dang theo công đoạn (S − U cho LAF; S − V/W cho LVF) và tự suy luận ngược nếu thiếu ghi nhận Chặt/May/Gò nhưng đã Đóng thùng/Nhập kho.',
    },
    {
      file: 'DM-MATHANG-HOAMAU LAF-CANLUYEN.xlsx',
      sheet: 'DM-NPL-DH',
      columns: 'Chỉ lệnh, PO, Mã hàng, Mã màu, Tên màu, SL đơn nguồn, Mã hóa chất, Tên hóa chất, Khối lượng định mức, ĐVT',
      purpose: 'Tính định mức hóa chất & cao su cán luyện trên 1 đôi (= Khối lượng ÷ SL đơn nguồn) và nhân với số đôi dở dang Chặt (S − U) để ra tồn lý thuyết Kho Hóa mẫu LAF.',
    },
    {
      file: 'DM NHU CAU THEO BOM.xlsx',
      sheet: 'Sheet1',
      columns: 'Chỉ lệnh ĐH, Số PO, SL đơn hàng, Nhóm lớn/vừa, Mã vật tư, Tên vật tư, Cột AC (Màu / Code màu vật tư), ĐVT, Cột AE (SL theo đơn hàng), Cột AF (SL từng size)',
      purpose: 'Bổ sung định mức chi tiết theo từng đơn hàng, từng size (ưu tiên cột AF, fallback cột AE) và tách riêng từng Code màu vật tư (VD: AETF, A0QM, BLACK-001...) cho Kho xưởng LAF, Kho xưởng LVF và Kho Hóa mẫu LVF.',
    },
    {
      file: 'chi tiet vat tu thuc xuat theo so po.xlsx',
      sheet: 'Sheet1',
      columns: 'Đơn vị yêu cầu, Công đoạn SX, Số chỉ lệnh, Số PO, Nhóm lớn, Mã vật tư, Tên vật tư, Cột AC (Màu / Code màu vật tư), ĐVT, Số lượng xuất kho',
      purpose: 'Tổng hợp Thực lãnh kho tổng theo từng PO và từng Code màu. Tại sheet TongHop chỉ cộng PO của chỉ lệnh còn dở dang; tại sheet ThucLanh_SoVoi_LyThuyet tách rõ phần Đã hoàn tất/nhập kho, PO ngoài tiến độ, Xuất không gắn PO và liệt kê chi tiết từng số PO.',
    },
    {
      file: 'Mau_01_Thong_Ke_Xuong_Doi_Chieu_Kiem_Ke...xlsx',
      sheet: '1_Danh_Muc_Va_Ma_Tran_BOM',
      columns: 'STT danh mục (cột A), Mã vật tư, Tên vật tư, ĐVT, Nhà máy sử dụng (LAF/LVF/Hóa mẫu), Ma trận định mức theo Mã hàng - Màu',
      purpose: 'Quản lý danh mục vật tư dùng chung đa nhà máy (gắn kho đích) và làm định mức BOM ma trận dự phòng cho các đơn chưa có trong DM NHU CAU THEO BOM.',
    },
    {
      file: 'Mau_01_Thong_Ke_Xuong_Doi_Chieu_Kiem_Ke...xlsx',
      sheet: 'DM_BTP_Size_LAF',
      columns: 'STT danh mục, Mã vật tư, Tên vật tư, ĐVT, Mã hàng - màu, Size, Công đoạn LAF (VD: Tẩy...), Định mức / 1 đôi, SL kế hoạch theo size, SL WIP LAF theo size',
      purpose: 'Định mức bán thành phẩm (BTP) chi tiết theo size & công đoạn nhà máy LAF. Hệ thống ưu tiên tính tồn lý thuyết Kho xưởng LAF từ sheet này (theo SL WIP từng size hoặc định mức bình quân gia quyền theo cơ cấu size kế hoạch) thay cho BOM ma trận.',
    },
    {
      file: 'Mau_01_Thong_Ke_Xuong_Doi_Chieu_Kiem_Ke...xlsx',
      sheet: '2_Kho_Hoa_Mau · 3_Kho_Xuong_LAF · 4_Kho_Xuong_LVF',
      columns: 'STT danh mục (cột B), Kiểm kê thực tế (cột M), Phân kho Hóa mẫu LAF/LVF (cột T tại sheet 2_Kho_Hoa_Mau)',
      purpose: 'Nạp số liệu kiểm đếm thực tế hiện trường cho đủ 4 kho (giữ nguyên phân biệt giữa ô trống = Chưa đếm và số 0 thực tế) để tính Chênh lệch tạm tính so với tồn lý thuyết dở dang.',
    },
    {
      file: 'DON HANG DO DANG THUC TE XUONG BAO CAO.xlsx',
      sheet: 'DATA',
      columns: 'Chỉ lệnh (cột C), Mã SO (D), Mã PO# (E), Mã hàng (F), Mã màu (G), SL đặt hàng (I), Gò (N), Số lượng dở dang kỳ kiểm kê (O), Nhà máy LAF/LVF (P), Ngày chốt (Q)',
      purpose: 'Đối chiếu số đôi dở dang xưởng thực tế báo cáo với số dở dang hệ thống ERP tại tab Đối chiếu dở dang. Sau khi rà soát sai lệch và bấm Chốt số, hệ thống đẩy số đôi dở dang đã chốt cho LAF/LVF để làm cơ sở xuất báo cáo kiểm kê 4 kho.',
    },
  ];

  const steps = [
    {
      num: '1',
      title: 'Cập nhật 5 file nguồn trong ổ O:',
      file: 'O:\\1 KHOI VAN HANH\\BO PHAN KHO\\KIEM KE KHO - XUONG',
      detail: 'Chỉ cần lưu đè hoặc cập nhật trực tiếp 5 file Excel (TIEN-DO-SX-DONHANG, DM-MATHANG-HOAMAU LAF, DM NHU CAU THEO BOM, chi tiet vat tu thuc xuat theo so po, Mau_01_Thong_Ke) vào đúng thư mục ổ O:.',
      actionLabel: 'Mở Tác vụ nhập liệu',
      onAction: () => setPage('data-entry'),
    },
    {
      num: '2',
      title: 'Tự động đồng bộ từ ổ O: lên Web Online',
      file: 'F:\\AI\\KIEKEM\\DongBo_DuLieu_O_LenWeb.bat',
      detail: 'Chạy file DongBo_DuLieu_O_LenWeb.bat trên máy quản trị. Trình theo dõi quét mỗi 30 giây; khi file Excel thay đổi và đã đóng, hệ thống tự build real-data-bundle.json, đẩy GitHub và cập nhật web Vercel.',
      actionLabel: 'Xem Định mức BTP LAF',
      onAction: () => setPage('norms'),
    },
    {
      num: '3',
      title: 'Web tự nhận dữ liệu mới & đối chiếu 4 kho',
      file: 'Tự kiểm tra mỗi 5 phút · hoặc bấm "Đồng bộ mới nhất"',
      detail: 'Khi mở web hoặc quay lại tab trình duyệt, web tự so sánh mốc thời gian dữ liệu và tải bản mới nhất về IndexedDB, giữ tách riêng từng Code màu vật tư và tự gom mã trùng tên.',
      actionLabel: 'Mở Tồn theo đơn dở dang',
      onAction: () => onOpenWarehouse('HOA_MAU_LAF'),
    },
    {
      num: '4',
      title: 'Xuất báo cáo Excel kiểm kê 6 sheet',
      file: 'ThongTin · TongHop · TheoDon · ChuaGhep · GiaiThich · ThucLanh_SoVoi_LyThuyet',
      detail: 'Xuất từng kho ra file Excel chuẩn gồm đủ cột Code màu, Đã lãnh kho tổng theo chỉ lệnh dở dang, bảng giải thích đơn thiếu ghi nhận công đoạn và chi tiết từng số PO ở cột M.',
      actionLabel: 'Mở Tổng quan 4 kho',
      onAction: () => setPage('overview'),
    },
  ];

  return <>
    <div className="page-heading">
      <div>
        <div className="eyebrow">TÀI LIỆU VẬN HÀNH <span>•</span> MINDMAP & CẤU TRÚC WEB</div>
        <h1>Hướng dẫn vận hành & Sơ đồ hệ thống</h1>
        <p>Sơ đồ tư duy (Mindmap) luồng dữ liệu từ Excel đầu vào đến đối chiếu kiểm kê 4 kho LAF & LVF.</p>
      </div>
      <button className="button button-primary" onClick={() => onOpenWarehouse('HOA_MAU_LAF')}><ClipboardCheck size={16} /> Vào kiểm kê ngay</button>
    </div>

    <div className="mapping-warning">
      <CircleAlert size={16} />
      <span>
        <strong>Lưu ý đối chiếu mã thực kiểm (VD: 003362 vs 009218):</strong> Trong file <code>Mau_01</code> sheet <code>2_Kho_Hoa_Mau</code>, một số vật tư ADIDAS đã nhập thực kiểm ở mã riêng (như <code>9185 = 3,535</code>, <code>9215 = 2,250</code>, <code>9217 = 560</code>, <code>9218 = 3,010</code>) nằm ở nhóm mã <code>009xxx</code>; còn các mã <code>003362</code>, <code>003363</code> của đơn TUVI&apos;S đang để trống ô kiểm kê nên hiển thị <em>Chưa đếm</em> ở đầu bảng. Hãy dùng bộ lọc <strong>Đã kiểm đếm</strong> tại màn hình <em>Tồn theo đơn dở dang</em> để xem đầy đủ 39 mã đã nhập.
      </span>
    </div>

    <section className="panel mindmap-panel">
      <div className="panel-heading">
        <div><h2>1. Mindmap cấu trúc hệ thống kiểm kê 4 kho</h2><p>Bấm vào từng nhánh kho hoặc màn hình để thao tác trực tiếp</p></div>
        <span className="period-badge">MINDMAP HỆ THỐNG</span>
      </div>

      <div className="mindmap-canvas">
        <div className="mindmap-col mindmap-inputs">
          <div className="mm-group-title">5 FILE NGUỒN (Ổ O:\...\KIEM KE KHO - XUONG)</div>
          <button type="button" className="mm-node mm-input" onClick={() => setPage('orders')}>
            <strong>TIEN-DO-SX-DONHANG.xlsx</strong>
            <span>Sheet New · SL đơn (S), Chặt (U), May (V), Gò (W), Đóng thùng (X), Nhập kho (Y)</span>
          </button>
          <button type="button" className="mm-node mm-input" onClick={() => setPage('data-entry')}>
            <strong>DM-MATHANG-HOAMAU LAF</strong>
            <span>Sheet DM-NPL-DH · Định mức hóa chất & cao su cán luyện LAF</span>
          </button>
          <button type="button" className="mm-node mm-input" onClick={() => onOpenWarehouse('LVF')}>
            <strong>DM NHU CAU THEO BOM.xlsx</strong>
            <span>Cột AE/AF (từng size) & Cột AC (Code màu) → LAF, LVF, Hóa mẫu LVF</span>
          </button>
          <button type="button" className="mm-node mm-input" onClick={() => onOpenWarehouse('HOA_MAU_LAF')}>
            <strong>chi tiet vat tu thuc xuat theo so po.xlsx</strong>
            <span>Thực lãnh kho tổng theo PO & Code màu (cột AC) → Đối chiếu 4 kho</span>
          </button>
          <button type="button" className="mm-node mm-input" onClick={() => setPage('norms')}>
            <strong>Mau_01_Thong_Ke...xlsx</strong>
            <span>Danh mục STT · Ma trận BOM · DM_BTP_Size_LAF · Thực đếm cột M & T</span>
          </button>
        </div>

        <div className="mindmap-connector"><span>→</span></div>

        <div className="mindmap-col mindmap-hub">
          <div className="mm-hub-card">
            <div className="mm-hub-badge">LÕI TÍNH TOÁN</div>
            <h3>HỆ THỐNG KIỂM KÊ 4 KHO</h3>
            <p>Dở dang = SL đơn hàng (S) − Đã SX tại công đoạn</p>
            <div className="mm-hub-stats">
              <span>{money(data.productionOrders.length)} lệnh SX</span>
              <span>{money(data.materials.length)} vật tư</span>
              <span>{money(countRows.length)} mã đã đếm</span>
            </div>
          </div>
          <div className="mm-stage-split">
            <div className="mm-stage-box is-laf">
              <strong>Công đoạn CHẶT (S − U)</strong>
              <span>Áp dụng cho cụm nhà máy LAF</span>
            </div>
            <div className="mm-stage-box is-lvf">
              <strong>Công đoạn MAY / GÒ (S − V / W)</strong>
              <span>Áp dụng cho cụm nhà máy LVF</span>
            </div>
          </div>
        </div>

        <div className="mindmap-connector"><span>→</span></div>

        <div className="mindmap-col mindmap-outputs">
          <div className="mm-group-title">4 KHO ĐỐI CHIẾU & BÁO CÁO</div>
          <button type="button" className="mm-node mm-wh-violet" onClick={() => onOpenWarehouse('HOA_MAU_LAF')}>
            <strong>Kho Hóa mẫu LAF</strong>
            <span>Công đoạn: Chặt · Đã đếm: {money(countedByWh.HOA_MAU_LAF)} mã</span>
          </button>
          <button type="button" className="mm-node mm-wh-blue" onClick={() => onOpenWarehouse('LAF')}>
            <strong>Kho xưởng LAF</strong>
            <span>Công đoạn: Chặt · Đã đếm: {money(countedByWh.LAF)} mã</span>
          </button>
          <button type="button" className="mm-node mm-wh-violet" onClick={() => onOpenWarehouse('HOA_MAU_LVF')}>
            <strong>Kho Hóa mẫu LVF</strong>
            <span>Công đoạn: May/Gò · Đã đếm: {money(countedByWh.HOA_MAU_LVF)} mã</span>
          </button>
          <button type="button" className="mm-node mm-wh-green" onClick={() => onOpenWarehouse('LVF')}>
            <strong>Kho xưởng LVF</strong>
            <span>Công đoạn: May/Gò · Đã đếm: {money(countedByWh.LVF)} mã</span>
          </button>
        </div>
      </div>
    </section>

    <section className="panel" style={{ padding: 20, marginBottom: 16 }}>
      <div className="panel-heading" style={{ padding: '0 0 14px' }}>
        <div>
          <h2>2. Ví dụ kiểm chứng dòng chảy dữ liệu thực tế (4 kho)</h2>
          <p>Lấy trực tiếp 1 vật tư có đầy đủ thông tin tại mỗi kho từ dữ liệu đang chạy để chứng minh công thức: <strong>Tổng SL đơn hàng (S) − Đã SX công đoạn = SL dở dang → × Định mức = Nhu cầu lý thuyết → So với Thực đếm = Thừa / Thiếu</strong>.</p>
        </div>
        <span className="period-badge">KIỂM CHỨNG TRỰC TIẾP</span>
      </div>
      <div className="table-scroll" style={{ marginBottom: 16 }}>
        <table>
          <thead>
            <tr>
              <th>KHO & CÔNG ĐOẠN</th>
              <th>MÃ / TÊN VẬT TƯ TIÊU BIỂU</th>
              <th className="numeric">SỐ CHỈ LỆNH</th>
              <th className="numeric">TỔNG SL ĐƠN (ĐÔI)</th>
              <th className="numeric">ĐÃ SX (ĐÔI)</th>
              <th className="numeric">SL DỞ DANG (ĐÔI)</th>
              <th className="numeric">NHU CẦU LÝ THUYẾT</th>
              <th className="numeric">THỰC LÃNH KHO TỔNG</th>
              <th className="numeric">KIỂM ĐẾM THỰC TẾ</th>
              <th className="numeric">THỪA / THIẾU</th>
              <th>KIỂM TRA</th>
            </tr>
          </thead>
          <tbody>
            {warehouseExamples.map((ex) => {
              const p = ex.picked;
              const diff = p && p.variance !== null && p.variance !== undefined ? p.variance : null;
              const diffLabel = diff === null ? 'Chưa đếm' : diff > 0.0001 ? `Thừa +${money(diff, 2)}` : diff < -0.0001 ? `Thiếu ${money(diff, 2)}` : 'Khớp (0)';
              return (
                <tr key={ex.id}>
                  <td><strong>{ex.name}</strong><small>{ex.stageLabel}</small></td>
                  <td>{p ? <><strong>{p.materialCode}</strong>{p.materialColor ? ` · ${p.materialColor}` : ''}<small>{p.materialName} ({p.unit})</small></> : 'Chưa có dữ liệu'}</td>
                  <td className="numeric">{p ? money(ex.orderRows.length) : '—'}</td>
                  <td className="numeric">{p ? money(ex.totalOrderQty) : '—'}</td>
                  <td className="numeric">{p ? money(ex.totalDoneQty) : '—'}</td>
                  <td className="numeric strong-cell">{p ? money(ex.totalWipQty) : '—'}</td>
                  <td className="numeric strong-cell">{p?.quantity == null ? '—' : `${money(p.quantity, 2)} ${p.unit}`}</td>
                  <td className="numeric">{p?.issuedFromMain == null ? '—' : money(p.issuedFromMain, 2)}</td>
                  <td className="numeric strong-cell">{p?.actual == null ? 'Chưa đếm' : `${money(p.actual, 2)} ${p.unit}`}</td>
                  <td className={`numeric strong-cell ${diff === null ? '' : diff < -0.0001 ? 'text-danger' : diff > 0.0001 ? 'text-warning' : ''}`}>{diffLabel}</td>
                  <td><button type="button" className="text-button" onClick={() => onOpenWarehouse(ex.id)}>Mở kho →</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 14 }}>
        {warehouseExamples.map((ex) => {
          const p = ex.picked;
          if (!p) return null;
          const diff = p.variance !== null && p.variance !== undefined ? p.variance : null;
          return (
            <div key={ex.id} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 14, background: 'var(--surface-soft, rgba(255,255,255,0.02))' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 8 }}>
                <div>
                  <span className="plant-tag">{ex.name} · {ex.stageLabel}</span>
                  <div style={{ marginTop: 6 }}><strong>{p.materialCode}</strong>{p.materialColor ? ` (${p.materialColor})` : ''} — {p.materialName}</div>
                </div>
                <button type="button" className="text-button" onClick={() => onOpenWarehouse(ex.id)}>Đối chiếu →</button>
              </div>
              <div style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 10 }}>
                <div><strong>1. Tiến độ đơn hàng ({ex.orderRows.length} chỉ lệnh dở dang):</strong> Tổng đặt <strong>{money(ex.totalOrderQty)}</strong> đôi − Đã SX <strong>{money(ex.totalDoneQty)}</strong> đôi = <strong>{money(ex.totalWipQty)} đôi dở dang</strong>.</div>
                <div><strong>2. Nhu cầu lý thuyết:</strong> ∑(SL dở dang × Định mức/đôi) = <strong>{money(p.quantity, 2)} {p.unit}</strong>{p.issuedFromMain != null ? ` · Thực lãnh kho tổng (PO dở dang): ${money(p.issuedFromMain, 2)} ${p.unit}` : ''}.</div>
                <div><strong>3. Đối chiếu kiểm đếm:</strong> Thực đếm <strong>{p.actual == null ? 'Chưa đếm' : `${money(p.actual, 2)} ${p.unit}`}</strong> − Lý thuyết <strong>{money(p.quantity, 2)} {p.unit}</strong> = <strong className={diff === null ? '' : diff < -0.0001 ? 'text-danger' : 'text-warning'}>{diff === null ? 'Chưa đủ dữ liệu đếm' : diff > 0.0001 ? `Thừa +${money(diff, 2)} ${p.unit}` : diff < -0.0001 ? `Thiếu ${money(diff, 2)} ${p.unit}` : `Khớp 0 ${p.unit}`}</strong>.</div>
              </div>
              {ex.orderRows.length > 0 && (
                <div className="table-scroll">
                  <table style={{ fontSize: 12 }}>
                    <thead>
                      <tr>
                        <th>CHỈ LỆNH / PO</th>
                        <th className="numeric">SL ĐƠN</th>
                        <th className="numeric">ĐÃ SX</th>
                        <th className="numeric">DỞ DANG</th>
                        <th className="numeric">LÝ THUYẾT ({p.unit})</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ex.orderRows.slice(0, 3).map((o, i) => (
                        <tr key={i}>
                          <td><strong>{o.orderNo}</strong><small>{o.purchaseOrder || o.model}</small></td>
                          <td className="numeric">{money(o.qty)}</td>
                          <td className="numeric">{money(o.done)}</td>
                          <td className="numeric">{money(o.basisQty)}</td>
                          <td className="numeric strong-cell">{money(o.quantity, 2)}</td>
                        </tr>
                      ))}
                      {ex.orderRows.length > 3 && (
                        <tr><td colSpan={5} style={{ textAlign: 'center', opacity: 0.75 }}>... và {money(ex.orderRows.length - 3)} chỉ lệnh dở dang khác (bấm "Mở kho" → "Theo đơn" để xem đầy đủ)</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>

    <section className="panel" style={{ padding: 20, marginBottom: 16 }}>
      <div className="panel-heading" style={{ padding: '0 0 14px' }}>
        <div><h2>3. Diễn giải chi tiết từng File, từng Sheet & Mục đích dữ liệu</h2><p>Bảng ánh xạ đầy đủ 5 file nguồn trong <code>O:\1 KHOI VAN HANH\BO PHAN KHO\KIEM KE KHO - XUONG</code> vào lõi kiểm kê 4 kho</p></div>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th style={{ minWidth: 210 }}>FILE NGUỒN</th>
              <th style={{ minWidth: 160 }}>SHEET LẤY DỮ LIỆU</th>
              <th style={{ minWidth: 260 }}>THÔNG TIN / CỘT ĐƯỢC LẤY</th>
              <th style={{ minWidth: 320 }}>MỤC ĐÍCH & NHU CẦU DỮ LIỆU ĐÁP ỨNG</th>
            </tr>
          </thead>
          <tbody>
            {fileSheetGuide.map((item, idx) => (
              <tr key={idx}>
                <td><strong>{item.file}</strong></td>
                <td><span className="plant-tag">{item.sheet}</span></td>
                <td>{item.columns}</td>
                <td>{item.purpose}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>

    <section className="panel" style={{ padding: 20, marginBottom: 16 }}>
      <div className="panel-heading" style={{ padding: '0 0 14px' }}>
        <div><h2>4. Quy trình tự động đồng bộ từ ổ O: & đối chiếu 4 kho (4 bước)</h2><p>Cập nhật file trên ổ mạng → Tự đẩy lên Web Online → Kiểm kê & Xuất Excel</p></div>
      </div>
      <div className="guide-steps-grid">
        {steps.map((step) => (
          <div className="guide-step-card" key={step.num}>
            <div className="guide-step-head">
              <span className="guide-step-num">Bước {step.num}</span>
              <strong>{step.title}</strong>
            </div>
            <div className="guide-step-file"><FileSpreadsheet size={13} /><span>{step.file}</span></div>
            <p>{step.detail}</p>
            <button type="button" className="text-button" onClick={step.onAction}>{step.actionLabel} <span>→</span></button>
          </div>
        ))}
      </div>
    </section>

    <section className="panel" style={{ padding: 20 }}>
      <div className="panel-heading" style={{ padding: '0 0 12px' }}>
        <div><h2>5. Sơ đồ các màn hình trên Web</h2><p>Chức năng chính của từng mục trong thanh menu bên trái</p></div>
      </div>
      <div className="sitemap-grid">
        <button type="button" className="sitemap-card" onClick={() => setPage('overview')}><strong>Tổng quan</strong><span>Xem nhanh số liệu 4 kho LAF/LVF, số mã đã tính, số mã đã đếm và cảnh báo.</span></button>
        <button type="button" className="sitemap-card" onClick={() => setPage('snapshot')}><strong>Tồn theo đơn dở dang</strong><span>Màn hình chính: tính tồn lý thuyết theo Chặt/May/Gò, lọc Đã kiểm đếm, xem Theo đơn & ChuaGhep, xuất Excel.</span></button>
        <button type="button" className="sitemap-card" onClick={() => setPage('orders')}><strong>Đơn hàng</strong><span>Tra cứu toàn bộ chỉ lệnh từ TIEN-DO-SX-DONHANG, PO/SO, SL đơn, SL lệnh SX và tiến độ từng công đoạn.</span></button>
        <button type="button" className="sitemap-card" onClick={() => setPage('data-entry')}><strong>Tác vụ nhập liệu</strong><span>Import/Export từng file riêng lẻ, tải mẫu trống hoặc nạp lại gói dữ liệu thực tế.</span></button>
        <button type="button" className="sitemap-card" onClick={() => setPage('catalog')}><strong>Danh mục & BOM</strong><span>Quản lý STT vật tư dùng chung đa nhà máy và định mức BOM theo cặp mã hàng - màu.</span></button>
        <button type="button" className="sitemap-card" onClick={() => setPage('norms')}><strong>Định mức BTP LAF</strong><span>Theo dõi các mã ưu tiên tính theo size/công đoạn BTP của nhà máy LAF.</span></button>
      </div>
    </section>
  </>;
}

function ModalShell({ title, subtitle, onClose, children }) {
  useEffect(() => {
    const keyHandler = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', keyHandler);
    return () => window.removeEventListener('keydown', keyHandler);
  }, [onClose]);
  return <div className="modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="modal-card"><div className="modal-heading"><div><h2>{title}</h2><p>{subtitle}</p></div><button className="icon-button" aria-label="Đóng" onClick={onClose}><X size={18} /></button></div>{children}</div></div>;
}

export default App;
