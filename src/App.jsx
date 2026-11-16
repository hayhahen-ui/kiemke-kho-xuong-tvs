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
import { calculateInventorySnapshot, readIssuedWorkbook, createIssuedTemplate, createSnapshotWorkbook, readCountWorkbook, readWorkshopCounts, createCountTemplate, compareSnapshotCounts, mergeRowsByMaterialName, readMaterialIssueWorkbook, buildStageExplanationRows, classifyWarehouseIssues } from './lib/inventory-snapshot.js';
import { fetchRealDataBundle } from './lib/real-data.js';

const emptyData = () => ({ materials: [], bom: [], orders: [], productionOrders: [], productMappings: [], orderMappings: [], chemicalNorms: [], importMeta: {}, inventory: {}, norms: [], workshopCounts: null, materialIssues: [] });
const navItems = [
  { id: 'overview', label: 'Tổng quan', icon: Gauge },
  { id: 'snapshot', label: 'Tồn theo đơn dở dang', icon: ClipboardCheck },
  { id: 'guide', label: 'Hướng dẫn & Sơ đồ', icon: GitBranch },
  { id: 'orders', label: 'Đơn hàng', icon: Layers3 },
  { id: 'data-entry', label: 'Tác vụ nhập liệu', icon: ClipboardList },
  { id: 'catalog', label: 'Danh mục & BOM', icon: Boxes },
  { id: 'norms', label: 'Định mức BTP LAF', icon: Settings2 },
  { id: 'inventory', label: 'Kiểm kê (bảng cũ)', icon: ClipboardCheck },
  { id: 'requirements', label: 'Nhu cầu lý thuyết (cũ)', icon: ArrowLeftRight },
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

function currentOrderRows(data) {
  const productionOrders = currentImportedRows(data.productionOrders, data.importMeta, 'production-orders');
  if (!productionOrders.length) return data.orders || [];
  const keys = new Set(productionOrders.map(orderKey));
  return [...productionOrders, ...(data.orders || []).filter((order) => !keys.has(orderKey(order)))];
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
          if (!(saved.materialIssues?.length)) {
            try {
              const bundled = await fetchRealDataBundle();
              if (alive && bundled.materialIssues?.length) {
                const updated = { ...saved, materialIssues: bundled.materialIssues };
                await saveLocalState(updated);
                setData(updated);
                return;
              }
            } catch {}
          }
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
    const next = { ...data, workshopCounts };
    if (!cloudMode) {
      await saveLocalState(next);
    }
    setData(next);
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
    if (!cloudMode) {
      await saveLocalState(next);
    }
    setData(next);
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
          {!cloudMode && <div className="local-notice"><ShieldCheck size={17} /><span><strong>Chế độ thiết bị (IndexedDB).</strong> Dữ liệu từ thư mục <code>DU LIEU THAT</code> đã sẵn sàng để kiểm kê 4 kho. Kết nối Supabase nếu cần nhiều máy cùng sửa đồng thời.</span><button onClick={() => setModal('setup')}>Cách kết nối</button></div>}
          {page === 'overview' && <Dashboard data={data} setPage={setPageSafe} onOpenWarehouse={openWarehouseSnapshot} />}
          {page === 'guide' && <GuidePage data={data} setPage={setPageSafe} onOpenWarehouse={openWarehouseSnapshot} />}
          {page === 'orders' && <OrdersPage data={data} onAdd={() => setModal('order')} onProgress={updateOrderProgress} />}
          {page === 'snapshot' && <SnapshotPage data={data} selectedWarehouse={selectedWarehouse} setWarehouse={setSelectedWarehouse} onSaveCounts={saveWorkshopCounts} onSaveMaterialIssues={saveMaterialIssues} />}
          {page === 'requirements' && <RequirementsPage data={data} selectedWarehouse={selectedWarehouse} setWarehouse={setSelectedWarehouse} onExport={exportTask} onImport={importTask} busyTask={busyTask} />}
          {page === 'inventory' && <InventoryPage data={data} rows={currentRows} selectedPlant={selectedPlant} setPlant={setSelectedPlant} onUpdate={updateInventory} />}
          {page === 'catalog' && <CatalogPage data={data} tab={catalogTab} setTab={setCatalogTab} onAddMaterial={() => setModal('material')} onAddBom={() => setModal('bom')} />}
          {page === 'norms' && <NormsPage data={data} onAdd={() => setModal('norm')} />}
          {page === 'data-entry' && <DataTasksPage data={data} onImport={importTask} onExport={exportTask} onLoadReal={loadRealDataset} busyTask={busyTask} taskErrors={taskErrors} onOpen={(taskId) => {
            if (taskId === 'orders' || taskId === 'wip' || taskId === 'production-orders') setPageSafe('orders');
            else if (taskId === 'order-mapping') setPageSafe('orders');
            else if (taskId === 'product-mapping') { setSelectedWarehouse('LAF'); setPageSafe('requirements'); }
            else if (taskId === 'materials' || taskId === 'bom') { setCatalogTab(taskId); setPageSafe('catalog'); }
            else if (taskId === 'norms') { setPageSafe('norms'); setModal('norm'); }
            else if (taskId.startsWith('inventory:')) { setSelectedPlant(taskId.slice('inventory:'.length)); setPageSafe('inventory'); }
            else if (taskId.startsWith('chemical-norms:')) { setSelectedWarehouse(taskId.slice('chemical-norms:'.length)); setPageSafe('requirements'); }
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
  const W = 640, H = 230, padL = 54, padR = 18, padT = 18, padB = 34;
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
      const theoryTotal = merged.reduce((s, r) => s + (Number(r.quantity) || 0), 0);
      const issuedWipTotal = merged.reduce((s, r) => s + (Number(r.issuedFromMain) || 0), 0);
      const actualTotal = merged.reduce((s, r) => s + (Number(r.actual) || 0), 0);
      return { ...info, ...spec, snap, merged, counted, withVariance, theoryTotal, issuedWipTotal, actualTotal };
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
    const series = [...byPeriod.values()].sort((a, b) => a.label.localeCompare(b.label)).slice(-10);
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

  const maxWhVal = Math.max(1, ...warehouseSnapshots.map((w) => Math.max(w.theoryTotal, w.issuedWipTotal, w.actualTotal)));

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
              <h2>So sánh 3 chỉ số theo từng kho (Định mức · Kho tổng · Thực đếm)</h2>
              <p>Bấm vào từng kho để đi thẳng vào bảng kiểm kê chi tiết</p>
            </div>
            <button className="text-button" onClick={() => setPage('snapshot')}>Chi tiết <span>→</span></button>
          </div>
          <div className="exec-bar-list">
            {warehouseSnapshots.map((wh) => (
              <button type="button" key={wh.id} className="exec-bar-card" onClick={() => onOpenWarehouse(wh.id)}>
                <div className="exec-bar-head">
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className={`plant-dot ${wh.color}`} />
                    <strong>{wh.name}</strong>
                  </span>
                  <span className="period-badge">{wh.stageLabel}</span>
                </div>
                <div className="exec-bars-stack">
                  <div className="exec-mini-bar"><span>Định mức</span><div><i style={{ width: `${Math.min(100, (wh.theoryTotal / maxWhVal) * 100)}%`, background: '#0ea5e9' }} /></div><b>{money(wh.theoryTotal, 0)}</b></div>
                  <div className="exec-mini-bar"><span>Kho tổng</span><div><i style={{ width: `${Math.min(100, (wh.issuedWipTotal / maxWhVal) * 100)}%`, background: '#f59e0b' }} /></div><b>{money(wh.issuedWipTotal, 0)}</b></div>
                  <div className="exec-mini-bar"><span>Thực đếm</span><div><i style={{ width: `${Math.min(100, (wh.actualTotal / maxWhVal) * 100)}%`, background: '#10b981' }} /></div><b>{money(wh.actualTotal, 0)}</b></div>
                </div>
                <div className="exec-bar-foot">
                  <span>{money(wh.counted)} / {money(wh.merged.length)} nhóm đã đếm</span>
                  <span className={wh.snap.unmapped.length ? 'text-warning' : ''}>{money(wh.snap.unmapped.length)} chưa ghép</span>
                </div>
              </button>
            ))}
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
      {orders.length ? <div className="table-scroll"><table className="orders-table">{hasSourceProgress ? <><thead><tr><th>CHỈ LỆNH / PO</th><th>MÃ HÀNG & MÀU</th><th>KHÁCH HÀNG</th><th className="numeric">SL ĐƠN</th><th className="numeric">SL LỆNH SX</th><th className="numeric">CHẶT · LAF/HM</th><th className="numeric">MAY · LVF/HM</th><th className="numeric">GÒ · LVF/HM</th><th className="numeric">NHẬP KHO</th><th className="numeric">GIAO HÀNG</th><th>TRẠNG THÁI</th></tr></thead><tbody>{orders.map((order) => <tr key={orderKey(order)}><td><strong>{resolvedOrderNo(order, orderContext) || 'Chưa ghép chỉ lệnh'}</strong><small>{order.purchaseOrder || order.sourceSheet || '—'}</small></td><td><span className="product-code">{order.model}</span><small>{order.color}</small></td><td>{order.customer || '—'}</td><td className="numeric">{money(order.plannedQty)}</td><td className="numeric strong-cell">{money(order.productionQty)}</td><td className="numeric">{money(order.stageQuantities?.LAF_CUT || 0)}</td><td className="numeric">{money(order.stageQuantities?.LVF_SEW || 0)}</td><td className="numeric">{money(order.stageQuantities?.LVF_GO || 0)}</td><td className="numeric">{money(order.stageQuantities?.RECEIVED || 0)}</td><td className="numeric">{money(order.stageQuantities?.SHIPPED || 0)}</td><td><StatusBadge status={order.productionQty > 0 ? 'Đang sản xuất' : order.status || 'Chờ sản xuất'} /></td></tr>)}</tbody></> : <><thead><tr><th>CHỈ LỆNH / PO</th><th>MÃ HÀNG & MÀU SẮC</th><th>NHÀ MÁY</th><th className="numeric">SL KẾ HOẠCH</th>{PLANTS.map((plant) => <th className="numeric" key={plant.id}>WIP {plant.short}</th>)}<th className="numeric">CÒN LẠI</th><th>TRẠNG THÁI</th></tr></thead><tbody>{orders.map((order) => {
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

function SnapshotPage({ data, selectedWarehouse, setWarehouse, onSaveCounts, onSaveMaterialIssues }) {
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
    const matchText = `${r.materialCode} ${r.materialName}`.toLowerCase().includes(query.toLowerCase());
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
  const exportResult = async () => { try { const bytes=await createSnapshotWorkbook(calc,{asOf,warehouse:selectedWarehouseInfo?.name,warehouseId:selectedWarehouse,modeLabel:labels[mode],groupByName,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,progressSource:data.importMeta?.['production-orders']?.sourceFile || '',normSource:data.importMeta?.['chemical-norms:' + selectedWarehouse]?.sourceFile || 'BOM hoặc nguồn chưa ghi tên',issuedSource:issuedFile,countSource:countFile + (countNotes ? ' | ' + Object.values(countNotes.dates).join(' | ') + ' | Lưu ý: mốc đếm có thể khác mốc tiến độ; đối chiếu chỉ tạm tính.' : ''),comparison: comparison ? displaySummary : null,summaryRows: displaySummary,productionOrders:data.productionOrders || [],materialIssues,lvfStage}); download(bytes,`Ton_kiem_ke_${selectedWarehouse}.xlsx`); setError(''); } catch(e) {setError(e.message || 'Không xuất được file.');} };
  return <>
    <div className="page-heading"><div><div className="eyebrow">KIỂM KÊ <span>•</span> THEO ĐƠN DỞ DANG 4 KHO</div><h1>Tồn lý thuyết theo định mức</h1><p>Chặt (S − U) → Kho xưởng LAF & Hóa mẫu LAF · May/Gò (S − V/W) → Kho xưởng LVF & Hóa mẫu LVF.</p></div><button className="button button-secondary" disabled={!calc.ready || !asOf || (mode === 'issued' && !issuedRows.length)} onClick={exportResult}><ArrowDownToLine size={16} /> Xuất kết quả Excel</button></div>
    <div className="plant-tabs warehouse-tabs">{WAREHOUSES.map(w => <button key={w.id} className={selectedWarehouse === w.id ? 'active' : ''} onClick={() => { setWarehouse(w.id); setSelected(null); }}><span className={`plant-dot ${w.color}`} />{w.name}</button>)}</div>
    <div className="task-guidance"><FileSpreadsheet size={18}/><span><strong>Quy tắc công đoạn:</strong> Chặt (cột U) tương ứng dở dang của <strong>Kho xưởng LAF</strong> và <strong>Kho Hóa mẫu LAF</strong>; May (cột V) & Gò (cột W) tương ứng dở dang của <strong>Kho xưởng LVF</strong> và <strong>Kho Hóa mẫu LVF</strong>. Dở dang = Cơ sở − Đã sản xuất tại công đoạn.</span></div>
    <section className="panel" style={{padding:20,marginBottom:16}}><div className="form-grid">
      <label>Mốc kiểm kê (giờ trên thiết bị)<input type="datetime-local" value={asOf} onChange={e=>setAsOf(e.target.value)}/></label>
      <label>Số đôi cơ sở<select value={mode} onChange={e=>setMode(e.target.value)}><option value="planned">SL đơn hàng (cột S) trong TIEN-DO-SX-DONHANG</option><option value="released">SL phát lệnh SX (cột T)</option><option value="issued">Số đôi đã lĩnh theo file riêng</option></select></label>
      {(selectedWarehouse === 'HOA_MAU_LVF' || selectedWarehouse === 'LVF') && <label>Công đoạn LVF<select value={lvfStage} onChange={e=>setLvfStage(e.target.value)}><option value="both">May + Gò — theo cột công đoạn của định mức</option><option value="may">May (cột V)</option><option value="go">Gò (cột W)</option></select></label>}
      {mode === 'issued' && <div><label className="button button-secondary button-small upload-control"><Upload size={14}/> Nhập file số đôi đã lĩnh<input type="file" accept=".xlsx" onChange={e=>{const f=e.target.files?.[0]; if(f)importIssued(f); e.target.value='';}}/></label> <button className="text-button" onClick={async()=>download(await createIssuedTemplate(),'Mau_So_Doi_Da_Linh.xlsx')}>Tải mẫu</button><p>{issuedFile ? `${issuedFile} · ${issuedRows.length} dòng` : 'Chưa nạp file số đôi đã lĩnh.'}</p></div>}
      <div className="field-span" style={{display:'flex',flexWrap:'wrap',gap:10,alignItems:'center'}}>
        <label className="button button-secondary button-small upload-control"><Upload size={14}/> Import Thực xuất kho tổng (theo PO)<input type="file" accept=".xlsx,.xlsm" onChange={e=>{const f=e.target.files?.[0]; if(f)importMaterialIssues(f); e.target.value='';}}/></label>
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
        calc.ready && (mode !== 'issued' || issuedRows.length) && rows.length ? <div className="table-scroll"><table><thead><tr><th>MÃ VẬT TƯ / TÊN</th><th>ĐVT</th><th className="numeric">SỐ CHỈ LỆNH</th><th className="numeric">TỒN THEO ĐỊNH MỨC</th>{comparison && <><th className="numeric">ĐÃ LÃNH KHO TỔNG (CL DỞ DANG)</th><th className="numeric">THỰC ĐẾM HIỆN TRƯỜNG</th><th className="numeric">CHÊNH LỆCH</th><th>ĐỐI CHIẾU</th></>}<th>CHI TIẾT</th></tr></thead><tbody>{rows.map(r=><tr key={`${r.materialCode}|${r.unit}`}><td><strong>{r.materialCode}</strong>{r.materialCodes?.length > 1 && <span className="pill-badge" style={{marginLeft:6,fontSize:11,padding:'1px 6px',borderRadius:999,background:'var(--accent-soft, #e0f2fe)',color:'var(--accent, #0369a1)'}}>Gộp {r.materialCodes.length} mã</span>}<small>{r.materialName}</small></td><td>{r.unit}</td><td className="numeric">{money(r.orderCount)}</td><td className="numeric strong-cell">{r.quantity == null ? '—' : money(r.quantity,3)}</td>{comparison && <><td className="numeric">{r.issuedFromMain == null ? '—' : money(r.issuedFromMain,3)}</td><td className="numeric"><NumberInput className="cell-input numeric-input count-input" placeholder="Nhập tay" value={r.actual ?? ''} onSave={(val)=>updateManualCount(r,val)} /></td><td className={`numeric ${(r.variance || 0) < 0 ? 'text-danger' : (r.variance || 0) > 0 ? 'text-warning' : ''}`}>{r.variance == null ? '—' : money(r.variance,3)}</td><td>{r.comparison}</td></>}<td>{r.details.length ? <button className="text-button" onClick={()=>setSelected(r)}>Theo đơn →</button> : '—'}</td></tr>)}</tbody></table></div> : <EmptyInline text={calc.hasSource ? 'Chưa có dòng kết quả phù hợp. Kiểm tra cơ sở, tiến độ, định mức và dòng cần rà soát.' : 'Chưa có nguồn định mức cho kho này. Kiểm tra tab ChuaGhep hoặc nạp định mức trong Tác vụ nhập liệu.'}/>
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

function GuidePage({ data, setPage, onOpenWarehouse }) {
  const countRows = data.workshopCounts?.rows || [];
  const countedByWh = {
    HOA_MAU_LAF: countRows.filter((r) => r.warehouseId === 'HOA_MAU_LAF').length,
    LAF: countRows.filter((r) => r.warehouseId === 'LAF').length,
    HOA_MAU_LVF: countRows.filter((r) => r.warehouseId === 'HOA_MAU_LVF').length,
    LVF: countRows.filter((r) => r.warehouseId === 'LVF').length,
  };
  const steps = [
    {
      num: '1',
      title: 'Nạp Tiến độ & Lệnh sản xuất',
      file: 'TIEN-DO-SX-DONHANG.xlsx (sheet New)',
      detail: 'Đọc cột S (SL đơn hàng), cột T (SL lệnh SX), cột U (Chặt), cột V (May), cột W (Gò). Hệ thống tự tính dở dang = Cơ sở − Đã SX (chiều dương, không dùng X/Y/Z bị âm).',
      actionLabel: 'Mở Tác vụ nhập liệu',
      onAction: () => setPage('data-entry'),
    },
    {
      num: '2',
      title: 'Nạp Định mức Hóa mẫu & Ma trận BOM',
      file: 'DM-MATHANG-HOAMAU LAF-CANLUYEN.xlsx + Mau_01_Thong_Ke...xlsx',
      detail: 'Hóa mẫu LAF đọc sheet DM-NPL-DH; Hóa mẫu LVF nạp file riêng (không dùng thay bằng LAF). Danh mục, ma trận BOM và BTP theo size LAF nạp từ workbook thống kê.',
      actionLabel: 'Xem Danh mục & BOM',
      onAction: () => setPage('catalog'),
    },
    {
      num: '3',
      title: 'Nạp Kiểm đếm thực tế 4 kho',
      file: 'Mau_01_Thong_Ke...xlsx (Bảng B cột M, phân kho Hóa mẫu cột T)',
      detail: 'Hệ thống tự tách Hóa mẫu LAF (39 mã đã đếm) và Hóa mẫu LVF (13 mã đã đếm) theo cột T, cộng dồn xưởng LAF (14 mã) và xưởng LVF (4 mã). Ô trống giữ là "Chưa đếm", khác với số 0.',
      actionLabel: 'Mở Tồn theo đơn dở dang',
      onAction: () => onOpenWarehouse('HOA_MAU_LAF'),
    },
    {
      num: '4',
      title: 'Đối chiếu 4 kho & Rà soát ChuaGhep',
      file: 'Xuất Excel 4 sheet: ThongTin · TongHop · TheoDon · ChuaGhep',
      detail: 'Chọn từng kho để xem Tồn lý thuyết theo đơn dở dang, dùng bộ lọc "Đã kiểm đếm" để xem nhanh các mã đã đếm (VD: 009185 = 3,535; 009215 = 2,250; 009218 = 3,010) và mở tab ChuaGhep để xử lý mã thiếu mapping.',
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
          <div className="mm-group-title">NGUỒN DỮ LIỆU ĐẦU VÀO</div>
          <button type="button" className="mm-node mm-input" onClick={() => setPage('data-entry')}>
            <strong>TIEN-DO-SX-DONHANG.xlsx</strong>
            <span>Sheet New · Cột S (SL đơn), U (Chặt), V (May), W (Gò)</span>
          </button>
          <button type="button" className="mm-node mm-input" onClick={() => setPage('data-entry')}>
            <strong>DM-MATHANG-HOAMAU LAF</strong>
            <span>Sheet DM-NPL-DH · Định mức hóa chất ÷ SL đơn nguồn</span>
          </button>
          <button type="button" className="mm-node mm-input" onClick={() => setPage('catalog')}>
            <strong>Mau_01_Thong_Ke...xlsx</strong>
            <span>Danh mục STT · Ma trận BOM · BTP LAF · Thực đếm cột M & T</span>
          </button>
          <button type="button" className="mm-node mm-input" onClick={() => setPage('data-entry')}>
            <strong>Bảng Mapping bổ sung</strong>
            <span>Mapping Chỉ lệnh (PO/SO) & Mapping Mã hàng - Màu BOM</span>
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
        <div><h2>2. Quy trình thao tác nhập liệu & đối chiếu (4 bước)</h2><p>Thực hiện theo thứ tự từ nạp nguồn đến xuất báo cáo kiểm kê</p></div>
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
        <div><h2>3. Sơ đồ các màn hình trên Web</h2><p>Chức năng chính của từng mục trong thanh menu bên trái</p></div>
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
