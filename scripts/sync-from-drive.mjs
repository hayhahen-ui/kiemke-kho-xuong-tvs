import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const watchDir = process.env.DATA_DIR || 'O:\\1 KHOI VAN HANH\\BO PHAN KHO\\KIEM KE KHO - XUONG';
const logFile = path.join(rootDir, 'sync-from-drive.log');
const onceMode = process.argv.includes('--once');
const noDeploy = process.argv.includes('--no-deploy');
const pollMs = Number(process.env.SYNC_POLL_MS) || 30000;

const WATCHED_FILES = [
  'TIEN-DO-SX-DONHANG.xlsx',
  'DM-MATHANG-HOAMAU LAF-CANLUYEN.xlsx',
  'Mau_01_Thong_Ke_Xuong_Doi_Chieu_Kiem_Ke-v4_tu_dong_phan_bo_theo_nha_may_da_sua_loi.xlsx',
  'chi tiet vat tu thuc xuat theo so po.xlsx',
  'DM NHU CAU THEO BOM.xlsx',
];

function log(msg) {
  const line = `[${new Date().toLocaleString('vi-VN')}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(logFile, line + '\n', 'utf8');
  } catch {}
}

function snapshotFiles() {
  const state = {};
  for (const name of WATCHED_FILES) {
    const full = path.join(watchDir, name);
    try {
      const st = fs.statSync(full);
      state[name] = `${Math.floor(st.mtimeMs)}:${st.size}`;
    } catch {
      state[name] = 'MISSING';
    }
  }
  return state;
}

function diffStates(prev, next) {
  const changed = [];
  for (const name of WATCHED_FILES) {
    if (prev[name] !== next[name] && next[name] !== 'MISSING') {
      changed.push(name);
    }
  }
  return changed;
}

function hasExcelTempLock() {
  try {
    return fs.readdirSync(watchDir).some((f) => f.startsWith('~$') && f.endsWith('.xlsx'));
  } catch {
    return false;
  }
}

function runCmd(cmd) {
  return execSync(cmd, { cwd: rootDir, stdio: 'pipe', encoding: 'utf8' }).trim();
}

let syncing = false;
async function performSync(reasonFiles) {
  if (syncing) return;
  syncing = true;
  try {
    log(`Phát hiện cập nhật (${reasonFiles.join(', ')}). Đang build lại real-data-bundle.json từ: ${watchDir}`);
    runCmd('node scripts/build-real-data.mjs');
    const status = runCmd('git status --porcelain public/real-data-bundle.json');
    if (!status) {
      log('Không có thay đổi nội dung trong public/real-data-bundle.json. Bỏ qua push/deploy.');
      return;
    }
    if (noDeploy) {
      log('Đã build xong public/real-data-bundle.json (--no-deploy).');
      return;
    }
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    runCmd('git add public/real-data-bundle.json');
    runCmd(`git commit -m "Auto-sync real data from O: drive (${stamp})"`);
    runCmd('git push origin main');
    log('Đã đẩy lên GitHub (origin main). Đang triển khai Vercel production...');
    runCmd('vercel --prod --yes');
    log('Đồng bộ & triển khai web online thành công: https://kiemke-kho-xuong-main.vercel.app');
  } catch (err) {
    log(`LỖI đồng bộ: ${err.stderr?.toString() || err.message || err}`);
  } finally {
    syncing = false;
  }
}

if (!fs.existsSync(watchDir)) {
  log(`CẢNH BÁO: Không truy cập được thư mục nguồn: ${watchDir}`);
  if (onceMode) process.exit(1);
}

if (onceMode) {
  await performSync(['Chạy thủ công --once']);
  process.exit(0);
}

let lastState = snapshotFiles();
log(`Bắt đầu theo dõi tự động (${pollMs / 1000}s/lần) thư mục: ${watchDir}`);
log(`Danh sách file theo dõi: ${WATCHED_FILES.join(', ')}`);

setInterval(async () => {
  if (syncing) return;
  if (!fs.existsSync(watchDir)) return;
  const current = snapshotFiles();
  const changed = diffStates(lastState, current);
  if (!changed.length) return;
  if (hasExcelTempLock()) {
    log(`File đang mở bởi Excel (~$), đợi lần kiểm tra tiếp theo (${changed.join(', ')})...`);
    return;
  }
  lastState = current;
  await new Promise((r) => setTimeout(r, 3000));
  await performSync(changed);
}, pollMs);
