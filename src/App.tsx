import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Plus, PieChart, TrendingUp, DollarSign, List, Settings, AlertCircle, CreditCard, Calculator, Trash2, ChevronLeft, Save, CheckCircle, Delete, X, Eye, EyeOff, PiggyBank, RefreshCcw, Lock, Download, AlertTriangle, Heart, Tag, ShoppingBag, Search, Sparkles } from 'lucide-react';
import {
  ResponsiveContainer, PieChart as RePieChart, Pie, Cell, Tooltip as RechartsTooltip
} from 'recharts';

// ============================================================
// 資料存放名稱：和裕堡的版本（yupao_…）完全分開，避免互相覆蓋
// ============================================================
const KEY = {
  tx: 'alice_transactions_v1',
  stats: 'alice_stats_v1',
  budgets: 'alice_budgets_v1',
  categories: 'alice_categories_v1',
  holdings: 'alice_holdings_v1',
  market: 'alice_market_v1',
};
const BACKUP_APP_ID = 'alice-budget';
const APP_NAME = 'Alice 記帳';
const APP_VERSION = 'v1.1';

// --- Type Definitions ---
type TxTag = 'need' | 'want' | 'advance' | 'income' | 'transfer';
type TransferDirection = 'pool_to_savings' | 'savings_to_pool' | 'to_goal' | 'goal_to_savings' | 'to_invest' | 'invest_buy';

interface Transaction {
  id: number;
  date: string;
  category: string;
  amount: number;
  type: 'income' | 'expense' | 'transfer' | 'adjust';
  tag: TxTag;
  note: string;
  groupId?: string;             // 分期付款
  fromSavings?: boolean;        // 從現金存款支付
  fromGoal?: boolean;           // 從夢想帳戶支付
  goal?: string;                // 夢想帳戶名稱
  isReimbursement?: boolean;    // 代墊還款
  isInvestFunding?: boolean;    // 投資資金（例如媽媽給的加碼額度）：進投資帳戶，不算收入、不能花
  holding?: string;             // 投資帳戶買進的標的
  quantity?: number;            // 買進的股數
  adjustTarget?: 'savings' | 'pool'; // 餘額校正的對象（金額可為負）
  transferDirection?: TransferDirection;
}

interface Goal {
  name: string;
  target: number;
  baseBalance: number;
  targetDate?: string;          // YYYY-MM
}

interface Holding {
  name: string;                 // 和試算表 price_ 後面的文字一致，例如 0050、VOO
  quantity: number;             // 持有股數
  cost: number;                 // 投入成本（台幣）
  manualPrice?: number;         // 沒有試算表價格時，自己輸入的價格（台幣）
}

interface MarketData {
  prices: { [key: string]: number };
  fetchedAt: string;
}

interface Budgets { [key: string]: number; }

interface StatsData {
  savings: number;              // 起始現金存款
  initialPool: number;          // 第一個月的可花額度
  investCash?: number;          // 起始投資帳戶現金
  spendRatio: number;           // 結餘有幾 % 變成下個月的可花額度
  priceCsvUrl?: string;
  goals?: Goal[];
}

interface MonthlyData {
  income: number;
  reimb: number;                // 代墊還款
  expense: number;              // 需要（從當月收入支付）
  installmentExpense: number;
  want: number;                 // 想要（從可花額度支付）
  need: number;
  advance: number;              // 本月代墊
  savingsExpense: number;       // 從現金存款支付
  poolToSavings: number;
  savingsToPool: number;
  goalFromPool: number;
  goalFromSavings: number;
  goalToSavings: number;
  toInvest: number;             // 自己的錢轉去投資帳戶
  investFunding: number;        // 投資資金入帳（不算收入）
  investBuy: number;            // 用投資帳戶的錢買股票
  adjustSavings: number;
  adjustPool: number;
  categoryMap: { [key: string]: number };
}

interface MonthStats extends MonthlyData {
  netIncome: number;
  monthlyMax: number;           // 本月新增的可花額度（上個月結餘 × 比例）
  monthlyRemaining: number;
  cumulative: number;           // 之前留下來的可花額度（可能是負的）
  savings: number;
  accumulatedDeficit: number;
  deficitFromPool: number;
  deficitFromSavings: number;
  carryToNext: number;          // 本月結餘中，會變成下個月可花的部分
  savingsAddon: number;         // 本月結餘中，存進現金存款的部分
  advanceOutstanding: number;
  investCash: number;           // 投資帳戶現金（不能花）
}

// --- 色彩配置 ---
const THEME = {
  accent: '#D27D8E',
  danger: '#FF3B30',
  success: '#34C759',
  advance: '#8E8E93',
};

const INITIAL_STATS_DATA: StatsData = { savings: 0, initialPool: 0, investCash: 0, spendRatio: 50, priceCsvUrl: '', goals: [] };

const DEFAULT_EXPENSE_CATEGORIES = ['房租', '飲食', '交通', '日用品', '周邊', '娛樂', '服飾', '醫療', '送禮', '代墊'];

const DEFAULT_HOLDINGS: Holding[] = [
  { name: '0050', quantity: 0, cost: 0 },
  { name: 'VOO', quantity: 0, cost: 0 },
];

const COLORS = ['#D27D8E', '#8B5E3C', '#588157', '#E9C46A', '#F4A261', '#E76F51', '#2A9D8F', '#264653', '#AAB3AB', '#B5838D'];

// --- Helper Functions ---
const formatDateToLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const getLocalDayString = () => formatDateToLocal(new Date());
const getLocalMonthString = () => getLocalDayString().substring(0, 7);
const formatMoney = (amount: number) => amount.toLocaleString(undefined, { maximumFractionDigits: 0 });
const signedMoney = (v: number) => `${v >= 0 ? '+' : '−'}$${formatMoney(Math.abs(v))}`;
const tagLabel = (tag: TxTag) => tag === 'need' ? '需要' : tag === 'want' ? '想要' : tag === 'advance' ? '代墊' : '';

const EMPTY_MARKET: MarketData = { prices: {}, fetchedAt: '' };

// 讀取試算表 Export 的兩欄 CSV，只取 price_ 開頭的資料
const parseMarketCsv = (text: string): MarketData => {
  const data: MarketData = { prices: {}, fetchedAt: new Date().toISOString() };
  text.split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*"?([^",]+)"?\s*,\s*(.*)$/);
    if (!m) return;
    const key = m[1].trim();
    if (!key.startsWith('price_')) return;
    let raw = m[2].trim().replace(/^"|"$/g, '').trim().replace(/,/g, '');
    const value = Number(raw);
    if (raw === '' || !isFinite(value)) return;
    data.prices[key.slice(6)] = value;
  });
  return data;
};

// --- UI Components（放在元件外面，避免重繪時輸入框失去焦點）---
const CardContainer = ({ children, className = '' }: { children: React.ReactNode, className?: string }) => (
  <div className={`bg-white rounded-2xl overflow-hidden ${className}`}>{children}</div>
);
const SectionHeader = ({ children }: { children: React.ReactNode }) => (
  <p className="text-sm text-gray-500 px-4 mb-1.5">{children}</p>
);
const NavRow = ({ label, detail, onClick, danger = false }: { label: string; detail?: string; onClick: () => void; danger?: boolean }) => (
  <button type="button" onClick={onClick} className="w-full px-4 py-3 flex items-center justify-between active:bg-gray-100 transition-colors text-left">
    <span className={`text-base ${danger ? 'text-red-500' : 'text-black'}`}>{label}</span>
    <span className="flex items-center gap-1.5 min-w-0">
      {detail && <span className="text-base text-gray-400 truncate">{detail}</span>}
      {!danger && <ChevronLeft className="w-4 h-4 text-gray-300 rotate-180 flex-shrink-0" />}
    </span>
  </button>
);
const InputRow = ({ label, value, onChange, placeholder = '0', inputMode = 'numeric' }: { label: string; value: string | number; onChange: (v: string) => void; placeholder?: string; inputMode?: 'numeric' | 'decimal' }) => (
  <div className="px-4 py-3 flex items-center justify-between gap-4">
    <label className="text-base text-black">{label}</label>
    <input type="text" inputMode={inputMode} placeholder={placeholder} value={value}
      onChange={e => onChange(e.target.value)}
      className="text-base text-right outline-none text-gray-600 bg-transparent w-32 tabular-nums" />
  </div>
);
const Toggle = ({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) => (
  <button onClick={onClick} aria-label={label} className={`w-12 h-7 rounded-full p-1 transition-colors ${on ? 'bg-green-500' : 'bg-gray-200'}`}>
    <div className={`w-5 h-5 bg-white rounded-full shadow-sm transform transition-transform ${on ? 'translate-x-5' : 'translate-x-0'}`}></div>
  </button>
);
const ErrorLine = ({ text }: { text: string }) => (
  <div className="flex items-center gap-2 px-2 text-red-500"><AlertCircle className="w-4 h-4" /><span className="text-xs font-bold">{text}</span></div>
);

const loadJson = <T,>(key: string, fallback: T): T => {
  try { const saved = localStorage.getItem(key); return saved ? JSON.parse(saved) : fallback; } catch (e) { return fallback; }
};

export default function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [hideFuture, setHideFuture] = useState(true);
  const [filterCategory, setFilterCategory] = useState<string | null>(null);
  const [filterTag, setFilterTag] = useState<'need' | 'want' | 'advance' | null>(null);

  useEffect(() => {
    let meta = document.querySelector('meta[name="viewport"]');
    if (!meta) { meta = document.createElement('meta'); meta.setAttribute('name', 'viewport'); document.head.appendChild(meta); }
    meta.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content');
    const preventPinch = (e: Event) => { e.preventDefault(); };
    document.addEventListener('gesturestart', preventPinch, { passive: false });
    return () => { document.removeEventListener('gesturestart', preventPinch); };
  }, []);

  const [expenseCategories, setExpenseCategories] = useState<string[]>(() => loadJson(KEY.categories, DEFAULT_EXPENSE_CATEGORIES));
  const [transactions, setTransactions] = useState<Transaction[]>(() => loadJson(KEY.tx, [] as Transaction[]));
  const [initialStats, setInitialStats] = useState<StatsData>(() => ({ ...INITIAL_STATS_DATA, ...loadJson(KEY.stats, {}) }));
  const [budgets, setBudgets] = useState<Budgets>(() => loadJson(KEY.budgets, {} as Budgets));
  const [holdings, setHoldings] = useState<Holding[]>(() => loadJson(KEY.holdings, DEFAULT_HOLDINGS));
  const [market, setMarket] = useState<MarketData>(() => ({ ...EMPTY_MARKET, ...loadJson(KEY.market, {}) }));
  const [marketStatus, setMarketStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [marketError, setMarketError] = useState('');
  const [storageUsage, setStorageUsage] = useState(0);

  useEffect(() => { localStorage.setItem(KEY.tx, JSON.stringify(transactions)); }, [transactions]);
  useEffect(() => { localStorage.setItem(KEY.stats, JSON.stringify(initialStats)); }, [initialStats]);
  useEffect(() => { localStorage.setItem(KEY.budgets, JSON.stringify(budgets)); }, [budgets]);
  useEffect(() => { localStorage.setItem(KEY.categories, JSON.stringify(expenseCategories)); }, [expenseCategories]);
  useEffect(() => { localStorage.setItem(KEY.holdings, JSON.stringify(holdings)); }, [holdings]);
  useEffect(() => { localStorage.setItem(KEY.market, JSON.stringify(market)); }, [market]);

  useEffect(() => {
    let total = 0;
    for (const key in localStorage) {
      if (localStorage.hasOwnProperty(key)) total += (localStorage[key].length + key.length) * 2;
    }
    setStorageUsage(total);
  }, [transactions, budgets, initialStats, expenseCategories, holdings, market]);

  const refreshMarket = async () => {
    const url = (initialStats.priceCsvUrl || '').trim();
    if (!url) { setMarketStatus('error'); setMarketError('請先到設定貼上試算表的 CSV 網址'); return; }
    setMarketStatus('loading');
    setMarketError('');
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = parseMarketCsv(await res.text());
      if (Object.keys(parsed.prices).length === 0) throw new Error('CSV 裡找不到任何 price_ 開頭的資料');
      setMarket(parsed);
      setMarketStatus('idle');
    } catch (e: any) {
      setMarketStatus('error');
      setMarketError(`更新失敗：${e?.message || '未知錯誤'}`);
    }
  };

  const [deleteModal, setDeleteModal] = useState<{ show: boolean; id: number | null }>({ show: false, id: null });
  const [resetModal, setResetModal] = useState(false);
  const [selectedMonth, setSelectedMonth] = useState(getLocalMonthString());
  const [swipedId, setSwipedId] = useState<number | null>(null);
  const touchStartX = useRef<number | null>(null);
  const [isCalculatorOpen, setIsCalculatorOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [newCategoryInput, setNewCategoryInput] = useState('');
  const [newHoldingName, setNewHoldingName] = useState('');
  const [numDrafts, setNumDrafts] = useState<{ [key: string]: string }>({});
  const [settingsPage, setSettingsPage] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [newGoalName, setNewGoalName] = useState('');
  const [reconcileActual, setReconcileActual] = useState('');
  const [reconcileTarget, setReconcileTarget] = useState<'savings' | 'pool'>('savings');

  const spendRatio = Math.min(100, Math.max(0, initialStats.spendRatio ?? 50));

  const availableMonths = useMemo(() => {
    const months = new Set(transactions.map(t => t.date.substring(0, 7)));
    months.add(getLocalMonthString());
    return Array.from(months).sort().reverse();
  }, [transactions]);

  useEffect(() => {
    if (!availableMonths.includes(selectedMonth) && availableMonths.length > 0) setSelectedMonth(availableMonths[0]);
  }, [availableMonths, selectedMonth]);

  const getDefaultCategory = () => (expenseCategories.includes('飲食') ? '飲食' : expenseCategories[0] || '一般');

  const emptyForm = () => ({
    date: getLocalDayString(),
    category: getDefaultCategory(),
    amount: '',
    note: '',
    tag: 'need' as TxTag,
    type: 'expense' as 'income' | 'expense' | 'transfer',
    isInstallment: false,
    installmentCount: '3',
    installmentCalcType: 'total' as 'total' | 'monthly',
    perMonthInput: '',
    fromSavings: false,
    fromGoal: false,
    goal: '',
    isReimbursement: false,
    isInvestFunding: false,
    holding: '',
    quantity: '',
    transferDirection: 'pool_to_savings' as TransferDirection,
  });
  const [formData, setFormData] = useState(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);

  const amountInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (amountInputRef.current) amountInputRef.current.scrollLeft = amountInputRef.current.scrollWidth;
  }, [formData.amount]);

  // ================= 備份 =================
  const importInputRef = useRef<HTMLInputElement>(null);
  const [backupMessage, setBackupMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const handleExportBackup = () => {
    const payload = {
      app: BACKUP_APP_ID, version: 1, exportedAt: new Date().toISOString(),
      transactions, initialStats, budgets, expenseCategories, holdings, market,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `alice_budget_backup_${getLocalDayString()}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setBackupMessage({ ok: true, text: `已匯出 ${transactions.length} 筆紀錄` });
  };

  const handleImportBackup = (e: { target: HTMLInputElement }) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        if (!data || data.app !== BACKUP_APP_ID) throw new Error('這不是這個 App 的備份檔');
        if (!Array.isArray(data.transactions)) throw new Error('檔案裡找不到交易紀錄');
        const ok = window.confirm(`這會用備份（${data.exportedAt ? String(data.exportedAt).substring(0, 10) : '日期不明'}，${data.transactions.length} 筆紀錄）取代目前所有資料，確定嗎？`);
        if (!ok) return;
        setTransactions(data.transactions);
        if (data.initialStats) setInitialStats({ ...INITIAL_STATS_DATA, ...data.initialStats });
        if (data.budgets) setBudgets(data.budgets);
        if (Array.isArray(data.expenseCategories)) setExpenseCategories(data.expenseCategories);
        if (Array.isArray(data.holdings)) setHoldings(data.holdings);
        if (data.market) setMarket({ ...EMPTY_MARKET, ...data.market });
        setBackupMessage({ ok: true, text: `已匯入 ${data.transactions.length} 筆紀錄` });
      } catch (err: any) {
        setBackupMessage({ ok: false, text: `匯入失敗：${err?.message || '檔案格式不正確'}` });
      }
    };
    reader.readAsText(file);
  };

  const handleResetApp = () => {
    Object.values(KEY).forEach(k => localStorage.removeItem(k));
    window.location.reload();
  };

  // ================= 計算機 =================
  const evalExpression = (value: string) => {
    let clean = value.replace(/[^0-9+\-*/.]/g, '');
    if (['+', '-', '*', '/'].includes(clean.slice(-1))) clean = clean.slice(0, -1);
    if (!clean) return null;
    // eslint-disable-next-line no-new-func
    const result = Number(new Function('return ' + clean)());
    return isFinite(result) ? result : null;
  };

  const handleCalcInput = (key: string) => {
    const current = formData.amount;
    let next = current;
    if (key === 'AC') next = '';
    else if (key === 'DEL') next = current.slice(0, -1);
    else if (key === '%') {
      try { const r = evalExpression(current); if (r !== null) next = String(Math.round(r * 100) / 10000); } catch (e) { /* 保持原值 */ }
    } else if (key === '=') {
      try { const r = evalExpression(current); if (r !== null) next = String(Math.floor(r)); } catch (e) { /* 保持原值 */ }
      setIsCalculatorOpen(false);
    } else {
      const isOp = ['+', '-', '*', '/'].includes(key);
      if (current === '0' && !isOp && key !== '.') next = key;
      else if (isOp && ['+', '-', '*', '/'].includes(current.slice(-1))) next = current.slice(0, -1) + key;
      else next = current + key;
    }
    setFormData(prev => ({ ...prev, amount: next }));
  };

  const openCalculator = () => {
    if (formData.installmentCalcType === 'monthly' && formData.isInstallment) return;
    setIsCalculatorOpen(true);
    setTimeout(() => { if (scrollRef.current) scrollRef.current.scrollTo({ top: 0, behavior: 'smooth' }); }, 100);
  };

  // ================= 每月計算 =================
  // 規則：
  // 1. 「需要」從當月收入支付。收入 − 需要 = 本月結餘。
  // 2. 「想要」從可花額度支付，不算進本月結餘（和裕堡版本的「投資」相同的位置）。
  // 3. 結餘先補回之前的赤字，剩下的 spendRatio% 變成下個月的可花額度，其餘存進現金存款。
  // 4. 可花額度超用會變成負數，從之後的額度扣回來。
  const stats = useMemo(() => {
    const raw: { [key: string]: MonthlyData } = {};
    const initMonth = (): MonthlyData => ({
      income: 0, reimb: 0, expense: 0, installmentExpense: 0, want: 0, need: 0, advance: 0, savingsExpense: 0,
      poolToSavings: 0, savingsToPool: 0, goalFromPool: 0, goalFromSavings: 0, goalToSavings: 0, toInvest: 0, investFunding: 0, investBuy: 0,
      adjustSavings: 0, adjustPool: 0, categoryMap: {},
    });
    availableMonths.forEach(m => { raw[m] = initMonth(); });

    transactions.forEach(t => {
      const key = t.date.substring(0, 7);
      if (!raw[key]) raw[key] = initMonth();
      const m = raw[key];
      const amount = Number(t.amount);

      if (t.type === 'adjust') {
        if (t.adjustTarget === 'pool') m.adjustPool += amount; else m.adjustSavings += amount;
      } else if (t.type === 'transfer') {
        switch (t.transferDirection) {
          case 'pool_to_savings': m.poolToSavings += amount; break;
          case 'savings_to_pool': m.savingsToPool += amount; break;
          case 'to_goal': if (t.fromSavings) m.goalFromSavings += amount; else m.goalFromPool += amount; break;
          case 'goal_to_savings': m.goalToSavings += amount; break;
          case 'to_invest': m.toInvest += amount; break;
          case 'invest_buy': m.investBuy += amount; break;
        }
      } else if (t.type === 'income') {
        if (t.isInvestFunding) m.investFunding += amount; // 不進現金流
        else if (t.isReimbursement) m.reimb += amount;
        else m.income += amount;
      } else {
        if (t.tag === 'advance') {
          // 代墊是別人欠的錢：先從現金存款墊付，不算支出
          m.advance += amount;
          return;
        }
        if (t.fromGoal) { /* 夢想帳戶早就存好了，不算本月支出 */ }
        else if (t.fromSavings) m.savingsExpense += amount;
        else if (t.tag === 'want') { m.want += amount; }
        else {
          m.expense += amount;
          m.need += amount;
          if (t.groupId) m.installmentExpense += amount;
        }
        if (t.tag === 'want' && t.groupId && !t.fromSavings && !t.fromGoal) m.installmentExpense += amount;
        m.categoryMap[t.category] = (m.categoryMap[t.category] || 0) + amount;
      }
    });

    // 補齊中間沒有紀錄的月份
    const recorded = Object.keys(raw).sort();
    if (recorded.length > 0) {
      let [y, mo] = recorded[0].split('-').map(Number);
      const [maxY, maxM] = recorded[recorded.length - 1].split('-').map(Number);
      while (y < maxY || (y === maxY && mo <= maxM)) {
        const key = `${y}-${String(mo).padStart(2, '0')}`;
        if (!raw[key]) raw[key] = initMonth();
        mo++; if (mo > 12) { mo = 1; y++; }
      }
    }

    const months = Object.keys(raw).sort();
    let carry = initialStats.initialPool || 0;
    let cumulative = 0;
    let savings = initialStats.savings || 0;
    let deficit = 0;
    let receivable = 0;
    let advanceOutstanding = 0;
    let investCash = initialStats.investCash || 0;
    const processed: { [key: string]: MonthStats } = {};

    months.forEach(month => {
      const d = raw[month];
      const monthlyMax = carry;
      let monthlyRemaining = monthlyMax;
      let cumRemaining = cumulative + d.adjustPool + d.savingsToPool;

      savings += d.adjustSavings - d.savingsExpense - d.toInvest - d.savingsToPool + d.poolToSavings + d.goalToSavings - d.goalFromSavings;

      // 代墊：從存款墊付，還款先回到存款；還得比墊的多，多的才算收入
      savings -= d.advance;
      const recvAvailable = receivable + d.advance;
      const reimbToSavings = Math.min(d.reimb, recvAvailable);
      savings += reimbToSavings;
      receivable = recvAvailable - reimbToSavings;
      const income = d.income + (d.reimb - reimbToSavings);
      advanceOutstanding = receivable;

      // 可花額度：先用本月新增的，不夠再用之前留下來的（可以變成負數）
      const poolOut = d.want + d.poolToSavings + d.goalFromPool;
      const fromMonthly = Math.min(poolOut, Math.max(0, monthlyRemaining));
      monthlyRemaining -= fromMonthly;
      cumRemaining -= poolOut - fromMonthly;

      investCash += d.investFunding + d.toInvest - d.investBuy;
      const netIncome = income - d.expense;
      let carryToNext = 0, savingsAddon = 0, deficitFromPool = 0, deficitFromSavings = 0;

      if (netIncome < 0) {
        let toCover = -netIncome;
        const poolAvailable = Math.max(0, cumRemaining) + Math.max(0, monthlyRemaining);
        if (toCover > 0 && poolAvailable > 0) {
          const take = Math.min(toCover, poolAvailable);
          const fromCum = Math.min(take, Math.max(0, cumRemaining));
          cumRemaining -= fromCum;
          monthlyRemaining -= take - fromCum;
          deficitFromPool = take;
          toCover -= take;
        }
        if (toCover > 0 && savings > 0) {
          const take = Math.min(toCover, savings);
          savings -= take;
          deficitFromSavings = take;
          toCover -= take;
        }
        deficit += toCover;
      } else {
        let surplus = netIncome;
        if (deficit > 0) { const repay = Math.min(surplus, deficit); surplus -= repay; deficit -= repay; }
        if (surplus > 0) {
          carryToNext = Math.floor(surplus * spendRatio / 100);
          savingsAddon = surplus - carryToNext;
          savings += savingsAddon;
        }
      }

      cumulative = cumRemaining + monthlyRemaining;
      carry = carryToNext;

      processed[month] = {
        ...d, income, netIncome, monthlyMax, monthlyRemaining, cumulative: cumRemaining, savings,
        accumulatedDeficit: deficit, deficitFromPool, deficitFromSavings, carryToNext, savingsAddon, advanceOutstanding, investCash,
      };
    });

    const firstMonth = months[0];
    // 依「交易日期」的月份查詢狀態（表單用），不只是畫面上選的月份
    const getMonthStats = (month: string): MonthStats => {
      if (processed[month]) return processed[month];
      const before = firstMonth !== undefined && month < firstMonth;
      return {
        ...initMonth(), netIncome: 0,
        monthlyMax: before ? (initialStats.initialPool || 0) : carry,
        monthlyRemaining: before ? (initialStats.initialPool || 0) : carry,
        cumulative: before ? 0 : cumulative,
        savings: before ? (initialStats.savings || 0) : savings,
        accumulatedDeficit: before ? 0 : deficit,
        deficitFromPool: 0, deficitFromSavings: 0, carryToNext: 0, savingsAddon: 0,
        advanceOutstanding: before ? 0 : advanceOutstanding,
        investCash: before ? (initialStats.investCash || 0) : investCash,
      };
    };

    const current = getMonthStats(selectedMonth);
    const pieData = Object.keys(current.categoryMap)
      .map(name => ({ name, value: current.categoryMap[name] }))
      .sort((a, b) => b.value - a.value);
    return { current, pieData, getMonthStats };
  }, [transactions, initialStats, selectedMonth, availableMonths, spendRatio]);

  const poolOf = (s: MonthStats) => s.monthlyRemaining + s.cumulative;

  // ================= 夢想帳戶 =================
  const computeGoals = (excludeId?: number | null) => {
    const today = getLocalDayString();
    const thisMonth = getLocalMonthString();
    const rows = (initialStats.goals || []).map(g => {
      const mine = transactions.filter(t => t.date <= today && t.goal === g.name && t.id !== excludeId);
      const deposited = mine.filter(t => t.type === 'transfer' && t.transferDirection === 'to_goal').reduce((s, t) => s + t.amount, 0);
      const withdrawn = mine.filter(t => t.type === 'transfer' && t.transferDirection === 'goal_to_savings').reduce((s, t) => s + t.amount, 0);
      const spent = mine.filter(t => t.type === 'expense' && t.fromGoal).reduce((s, t) => s + t.amount, 0);
      const balance = (g.baseBalance || 0) + deposited - withdrawn - spent;
      const remaining = Math.max(0, (g.target || 0) - balance);
      let monthsLeft: number | null = null;
      if (g.targetDate && /^\d{4}-\d{2}$/.test(g.targetDate)) {
        const [ty, tm] = g.targetDate.split('-').map(Number);
        const [cy, cm] = thisMonth.split('-').map(Number);
        monthsLeft = Math.max(1, (ty - cy) * 12 + (tm - cm) + 1);
      }
      return { ...g, balance, remaining, progress: g.target > 0 ? Math.min(1, Math.max(0, balance / g.target)) : 0,
        perMonth: monthsLeft !== null && remaining > 0 ? Math.ceil(remaining / monthsLeft) : null };
    });
    return { rows, total: rows.reduce((s, r) => s + r.balance, 0) };
  };

  const installmentSummary = () => {
    const today = getLocalDayString();
    const groups: { [g: string]: { name: string; remaining: number; remainingCount: number; totalCount: number; perMonth: number; lastDate: string } } = {};
    transactions.filter(t => t.groupId && t.type === 'expense').forEach(t => {
      const g = t.groupId!;
      if (!groups[g]) groups[g] = { name: (t.note || '').replace(/\s*\(\d+\/\d+\)$/, '').trim() || t.category, remaining: 0, remainingCount: 0, totalCount: 0, perMonth: t.amount, lastDate: t.date };
      const item = groups[g];
      item.totalCount += 1;
      if (t.date > item.lastDate) item.lastDate = t.date;
      if (t.date > today) { item.remaining += t.amount; item.remainingCount += 1; item.perMonth = t.amount; }
    });
    return Object.values(groups).filter(x => x.remaining > 0).sort((a, b) => b.remaining - a.remaining);
  };

  // ================= 表單動作 =================
  const openAddMode = () => { setEditingId(null); setFormData(emptyForm()); setActiveTab('form'); };

  const openEditMode = (t: Transaction) => {
    if (swipedId === t.id) return;
    if (t.type === 'adjust') { setDeleteModal({ show: true, id: t.id }); return; } // 校正紀錄只能刪除
    setEditingId(t.id);
    setFormData({
      ...emptyForm(),
      date: t.date, category: t.category, amount: String(t.amount),
      note: t.note.replace(/\(\d+\/\d+\)$/, '').trim(), tag: t.tag, type: t.type as 'income' | 'expense' | 'transfer',
      fromSavings: t.fromSavings || false, fromGoal: t.fromGoal || false, goal: t.goal || '',
      isReimbursement: t.isReimbursement || false,
      isInvestFunding: t.isInvestFunding || false,
      holding: t.holding || '',
      quantity: t.quantity ? String(t.quantity) : '',
      transferDirection: t.transferDirection || 'pool_to_savings',
    });
    setActiveTab('form');
  };

  const handleFabClick = () => {
    if (activeTab === 'form' && !editingId) setActiveTab('dashboard');
    else openAddMode();
  };

  const handleSave = () => {
    if (!formData.amount) return;
    let amount = Number(formData.amount);
    try { const r = evalExpression(formData.amount); if (r !== null) amount = Math.floor(r); } catch (e) { /* 用原值 */ }
    if (!isFinite(amount) || amount <= 0) return;

    const isTransfer = formData.type === 'transfer';
    const isIncome = formData.type === 'income';
    const isGoalTransfer = isTransfer && (formData.transferDirection === 'to_goal' || formData.transferDirection === 'goal_to_savings');
    const fromGoal = formData.type === 'expense' && formData.fromGoal;
    const fields = {
      type: formData.type,
      category: isTransfer ? '資金劃轉' : isIncome ? '收入' : formData.category,
      tag: (isTransfer ? 'transfer' : isIncome ? 'income' : formData.category === '代墊' ? 'advance' : formData.tag) as TxTag,
      transferDirection: isTransfer ? formData.transferDirection : undefined,
      fromSavings: (formData.type === 'expense' && formData.fromSavings) || (isTransfer && formData.transferDirection === 'to_goal' && formData.fromSavings),
      fromGoal,
      goal: (isGoalTransfer || fromGoal) && formData.goal ? formData.goal : undefined,
      isReimbursement: isIncome && !formData.isInvestFunding && formData.isReimbursement,
      isInvestFunding: isIncome && formData.isInvestFunding,
      holding: isTransfer && formData.transferDirection === 'invest_buy' ? formData.holding : undefined,
      quantity: isTransfer && formData.transferDirection === 'invest_buy' && Number(formData.quantity) > 0 ? Number(formData.quantity) : undefined,
    };

    if (editingId) {
      const original = transactions.find(t => t.id === editingId);
      if (original && original.groupId) {
        // 分期：日期平移整組，金額只改這一期
        const shift = new Date(formData.date).getTime() - new Date(original.date).getTime();
        setTransactions(transactions.map(t => {
          if (t.groupId !== original.groupId) return t;
          const date = t.id === editingId ? formData.date : shift !== 0 ? formatDateToLocal(new Date(new Date(t.date).getTime() + shift)) : t.date;
          return t.id === editingId ? { ...t, ...fields, date, amount, note: formData.note } : { ...t, ...fields, date };
        }));
      } else {
        setTransactions(transactions.map(t => t.id === editingId ? { ...t, ...fields, date: formData.date, amount, note: formData.note } : t));
      }
      setActiveTab('history');
      return;
    }

    const baseId = transactions.length > 0 ? Math.max(...transactions.map(t => t.id)) + 1 : 1;
    const count = Math.round(Number(formData.installmentCount));
    const shouldInstallment = formData.type === 'expense' && formData.isInstallment && !fields.fromSavings && !fields.fromGoal && fields.tag !== 'advance' && count > 1;

    if (shouldInstallment) {
      const per = Math.floor(amount / count);
      const remainder = amount - per * count;
      const [y, m, d] = formData.date.split('-').map(Number);
      const groupId = `group_${baseId}_${Date.now()}`;
      const items: Transaction[] = [];
      for (let i = 0; i < count; i++) {
        const next = new Date(y, m - 1 + i, d);
        if (next.getDate() !== d) next.setDate(0);
        items.push({ id: baseId + i, ...fields, date: formatDateToLocal(next), amount: i === 0 ? per + remainder : per,
          note: `${formData.note} (${i + 1}/${count})`, groupId });
      }
      setTransactions([...items, ...transactions]);
    } else {
      setTransactions([{ id: baseId, ...fields, date: formData.date, amount, note: formData.note }, ...transactions]);
    }
    setActiveTab('history');
  };

  const requestDelete = (e: any, id: number) => { e.stopPropagation(); setDeleteModal({ show: true, id }); setSwipedId(null); };
  const confirmDelete = () => {
    if (deleteModal.id) {
      setTransactions(transactions.filter(t => t.id !== deleteModal.id));
      if (activeTab === 'form' && editingId === deleteModal.id) setActiveTab('history');
    }
    setDeleteModal({ show: false, id: null });
  };

  // ================= 總覽 =================
  const monthSelect = () => (
    <div className="flex justify-start items-center px-1">
      <select value={selectedMonth} onChange={e => setSelectedMonth(e.target.value)}
        className="bg-white text-black font-bold text-base rounded-full px-4 py-2 outline-none appearance-none pr-8"
        style={{ backgroundImage: `url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='currentColor'%3e%3cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'%3e%3c/path%3e%3c/svg%3e")`, backgroundPosition: 'right 0.5rem center', backgroundRepeat: 'no-repeat', backgroundSize: '1.5em 1.5em' }}>
        {availableMonths.map(m => <option key={m} value={m}>{m}</option>)}
      </select>
    </div>
  );

  const renderDashboardView = () => {
    const s = stats.current;
    const pool = poolOf(s);
    const poolBase = Math.max(pool + s.want, 0); // 花掉之前的額度
    const usedPct = poolBase > 0 ? Math.min(100, (s.want / poolBase) * 100) : s.want > 0 ? 100 : 0;
    const projectedSpend = s.netIncome > 0 ? s.carryToNext : 0;
    const projectedSave = s.netIncome > 0 ? s.savingsAddon : 0;
    const needWantTotal = s.need + s.want;
    const installmentRatio = s.income > 0 ? (s.installmentExpense / s.income) * 100 : 0;
    const goals = computeGoals();

    const title = 'text-base font-bold text-black mb-1';
    const sub = 'text-xs text-gray-500';

    return (
      <div className="space-y-4 pb-4 pt-2">
        {monthSelect()}

        <CardContainer className="p-5">
          <div className="flex items-center gap-2 mb-1"><Sparkles className="w-4 h-4" style={{ color: THEME.accent }} /><p className="text-sm text-gray-500">可花額度</p></div>
          <p className={`text-4xl font-bold tracking-tight tabular-nums ${pool < 0 ? 'text-red-500' : 'text-black'}`}>{pool < 0 ? '−' : ''}${formatMoney(Math.abs(pool))}</p>
          <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden mt-3 mb-2">
            <div className="h-full rounded-full transition-all duration-700" style={{ width: `${usedPct}%`, backgroundColor: pool < 0 ? THEME.danger : THEME.accent }}></div>
          </div>
          <div className="flex justify-between text-xs text-gray-500 tabular-nums">
            <span>本月新增 ${formatMoney(s.monthlyMax)}</span>
            <span>已花 ${formatMoney(s.want)}</span>
          </div>
        </CardContainer>

        <CardContainer className="p-5">
          <div className="flex items-center gap-2 mb-1"><PiggyBank className="w-4 h-4 text-black" /><p className="text-sm text-gray-500">現金存款</p></div>
          <p className="text-3xl font-bold tracking-tight tabular-nums text-black">${formatMoney(s.savings)}</p>
          {s.netIncome > 0 && (
            <div className="mt-3 pt-3 border-t border-gray-100 flex justify-between text-sm tabular-nums">
              <span className="text-gray-500">本月結餘分配</span>
              <span><span style={{ color: THEME.accent }} className="font-bold">下月可花 ${formatMoney(projectedSpend)}</span><span className="text-gray-300 mx-1.5">|</span><span className="font-bold">存款 ${formatMoney(projectedSave)}</span></span>
            </div>
          )}
          {s.accumulatedDeficit > 0 && (
            <div className="mt-3 pt-3 border-t border-gray-100 flex justify-between text-sm tabular-nums">
              <span className="text-red-500">超支待補</span><span className="font-bold text-red-500">−${formatMoney(s.accumulatedDeficit)}</span>
            </div>
          )}
        </CardContainer>

        {goals.rows.length > 0 && (
          <CardContainer className="px-5 py-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className={title}>夢想帳戶</h3>
              <button onClick={() => { setSettingsPage('goals'); setActiveTab('settings'); }} className="text-sm font-bold" style={{ color: THEME.accent }}>編輯</button>
            </div>
            <div className="space-y-4">
              {goals.rows.map(g => (
                <div key={g.name}>
                  <div className="flex justify-between items-baseline mb-1.5">
                    <span className="text-base text-black">{g.name}</span>
                    <span className="text-sm tabular-nums text-gray-500"><span className="font-bold text-black">${formatMoney(g.balance)}</span> / ${formatMoney(g.target)}</span>
                  </div>
                  <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-700" style={{ width: `${g.progress * 100}%`, backgroundColor: g.progress >= 1 ? THEME.success : THEME.accent }}></div>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    {g.progress >= 1 ? '已達成' : `還差 $${formatMoney(g.remaining)}`}
                    {g.perMonth !== null && `・每月存 $${formatMoney(g.perMonth)} 可在 ${g.targetDate} 達成`}
                  </p>
                </div>
              ))}
            </div>
          </CardContainer>
        )}

        <CardContainer className="px-5 py-3.5 flex justify-between items-center">
          <div>
            <h3 className={title}>本月結餘</h3>
            <p className={`text-2xl font-bold tracking-tight ${s.netIncome >= 0 ? 'text-gray-900' : 'text-red-500'}`}>{s.netIncome >= 0 ? '+' : ''}{formatMoney(s.netIncome)}</p>
          </div>
          <div className="text-right space-y-1">
            <div className="flex items-center gap-2 justify-end"><span className={sub}>收入</span><span className="text-sm font-bold tabular-nums" style={{ color: THEME.success }}>+${formatMoney(s.income)}</span></div>
            <div className="flex items-center gap-2 justify-end"><span className={sub}>需要</span><span className="text-sm font-bold tabular-nums" style={{ color: THEME.danger }}>-${formatMoney(s.expense)}</span></div>
          </div>
        </CardContainer>

        {s.installmentExpense > 0 && (
          <CardContainer className="px-5 py-3.5">
            <div className="flex items-center justify-between mb-3">
              <h3 className={title}>分期付款</h3>
              <span className="text-xs font-medium text-gray-400 bg-gray-50 px-2 py-0.5 rounded-md">佔月收入 {installmentRatio.toFixed(1)}%</span>
            </div>
            <div className="flex items-baseline gap-1 mb-2">
              <span className="text-2xl font-bold tracking-tight text-black">${formatMoney(s.installmentExpense)}</span>
              <span className="text-xs text-gray-400 font-medium">/ 月</span>
            </div>
            <div className="w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
              <div className="h-full rounded-full bg-black" style={{ width: `${Math.min(installmentRatio, 100)}%` }}></div>
            </div>
          </CardContainer>
        )}

        <CardContainer className="px-5 py-3.5">
          <h3 className={`${title} mb-4`}>需要與想要</h3>
          <div className="flex h-2.5 w-full rounded-full overflow-hidden bg-gray-100 mb-4">
            <div className="h-full bg-black" style={{ width: `${needWantTotal > 0 ? (s.need / needWantTotal) * 100 : 0}%` }}></div>
            <div className="h-full" style={{ width: `${needWantTotal > 0 ? (s.want / needWantTotal) * 100 : 0}%`, backgroundColor: THEME.accent }}></div>
          </div>
          <div className="flex justify-between items-end gap-2">
            <button type="button" className="flex flex-col gap-0.5 flex-1 text-left active:opacity-70" onClick={() => { setFilterTag('need'); setActiveTab('history'); }}>
              <div className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-black"></div><span className={sub}>需要</span></div>
              <span className="text-2xl font-bold tracking-tight text-gray-900">${formatMoney(s.need)}</span>
            </button>
            <button type="button" className="flex flex-col gap-0.5 items-end flex-1 text-right active:opacity-70" onClick={() => { setFilterTag('want'); setActiveTab('history'); }}>
              <div className="flex items-center gap-1.5"><span className={sub}>想要</span><div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: THEME.accent }}></div></div>
              <span className="text-2xl font-bold tracking-tight text-gray-800">${formatMoney(s.want)}</span>
            </button>
          </div>
          <button type="button" onClick={() => { setFilterTag('advance'); setActiveTab('history'); }} className="mt-4 pt-3 border-t border-gray-100 w-full flex justify-between items-center active:opacity-70">
            <div className="flex items-center gap-1.5"><Tag className="w-3.5 h-3.5" style={{ color: THEME.advance }} /><span className="text-xs font-bold text-gray-600">代墊未收回</span></div>
            <div className="flex items-baseline gap-2">
              {s.advance > 0 && <span className="text-xs text-gray-400">本月代墊 ${formatMoney(s.advance)}</span>}
              <span className="text-base font-bold tabular-nums" style={{ color: s.advanceOutstanding > 0 ? THEME.advance : '#9CA3AF' }}>${formatMoney(s.advanceOutstanding)}</span>
            </div>
          </button>
        </CardContainer>

        <CardContainer className="px-5 py-3.5">
          <div className="flex justify-between items-center mb-4">
            <h3 className={title}>預算</h3>
            <button onClick={() => { setSettingsPage('categories'); setActiveTab('settings'); }} className="text-sm font-bold" style={{ color: THEME.accent }}>編輯</button>
          </div>
          <div className="space-y-4">
            {Object.entries(budgets).filter(([, b]) => (b as number) > 0).map(([cat, budget]) => {
              const spent = transactions.filter(t => t.date.startsWith(selectedMonth) && t.type === 'expense' && t.category === cat && !t.fromSavings && !t.fromGoal).reduce((sum, t) => sum + t.amount, 0);
              const isOver = spent > (budget as number);
              return (
                <div key={cat}>
                  <div className="flex justify-between mb-1">
                    <span className="font-bold text-gray-700 text-xs">{cat}</span>
                    <span className="text-gray-500 font-medium text-xs"><span className={isOver ? 'text-red-500 font-bold' : 'text-black'}>${formatMoney(spent)}</span><span className="text-gray-300 mx-1">/</span>${formatMoney(budget as number)}</span>
                  </div>
                  <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${isOver ? 'bg-red-500' : 'bg-black'}`} style={{ width: `${Math.min((spent / (budget as number)) * 100, 100)}%` }}></div>
                  </div>
                </div>
              );
            })}
            {Object.values(budgets).every(b => !b) && <p className="text-xs text-gray-400 text-center py-1">未設定</p>}
          </div>
        </CardContainer>

        <CardContainer className="px-5 py-4">
          <h3 className={`${title} mb-2`}>支出分類</h3>
          {stats.pieData.length > 0 ? (
            <>
              <div className="h-64 -mx-4 mb-4">
                <ResponsiveContainer width="100%" height="100%">
                  <RePieChart>
                    <Pie onClick={(data: any) => { setFilterCategory(data.name); setActiveTab('history'); }} data={stats.pieData} cx="50%" cy="50%" innerRadius={65} outerRadius={85} paddingAngle={4} dataKey="value" stroke="none" cursor="pointer">
                      {stats.pieData.map((entry, i) => <Cell key={`cell-${i}`} fill={COLORS[i % COLORS.length]} />)}
                    </Pie>
                    <RechartsTooltip contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }} />
                  </RePieChart>
                </ResponsiveContainer>
              </div>
              <div className="space-y-3">
                {(() => { const total = stats.pieData.reduce((a, e) => a + e.value, 0); return stats.pieData.map((entry, i) => (
                  <div key={entry.name} onClick={() => { setFilterCategory(entry.name); setActiveTab('history'); }} className="flex items-center justify-between py-1 cursor-pointer active:bg-gray-50 rounded-lg px-1">
                    <div className="flex items-center gap-3"><div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: COLORS[i % COLORS.length] }}></div><span className="text-xs font-semibold text-gray-600">{entry.name}</span></div>
                    <div className="flex items-center gap-2"><span className="text-sm font-bold text-gray-900 tabular-nums">${formatMoney(entry.value)}</span><span className="text-xs text-gray-400 w-8 text-right tabular-nums">{total > 0 ? ((entry.value / total) * 100).toFixed(0) : 0}%</span></div>
                  </div>
                )); })()}
              </div>
            </>
          ) : <div className="h-32 flex items-center justify-center text-gray-400 text-xs">尚無紀錄</div>}
        </CardContainer>
      </div>
    );
  };

  // ================= 記帳表單 =================
  const renderGoalChips = () => {
    const list = initialStats.goals || [];
    if (list.length === 0) return <span className="text-xs text-gray-400">尚無夢想帳戶</span>;
    return (
      <div className="flex flex-wrap gap-2">
        {list.map(g => (
          <button key={g.name} type="button" onClick={() => setFormData({ ...formData, goal: formData.goal === g.name ? '' : g.name })}
            className={`px-3 py-1.5 rounded-full text-sm font-bold border transition ${formData.goal === g.name ? 'bg-black text-white border-black' : 'bg-white text-gray-500 border-gray-200'}`}>{g.name}</button>
        ))}
      </div>
    );
  };

  const optionRow = (on: boolean, onClick: () => void, icon: React.ReactNode, label: string, detail?: string) => (
    <div onClick={onClick} className={`flex items-center justify-between p-3 rounded-xl border transition-all cursor-pointer ${on ? 'bg-gray-100 border-gray-200' : 'bg-white border-gray-200'}`}>
      <div className="flex items-center gap-2">
        <div className={`p-1.5 rounded-full ${on ? 'bg-black text-white' : 'bg-gray-100 text-gray-400'}`}>{icon}</div>
        <div className="flex flex-col"><span className={`text-sm font-bold ${on ? 'text-gray-800' : 'text-gray-500'}`}>{label}</span>{on && detail && <span className="text-xs text-gray-500 font-medium">{detail}</span>}</div>
      </div>
      <div className={`w-5 h-5 rounded-full border flex items-center justify-center ${on ? 'bg-black border-black' : 'border-gray-300'}`}>{on && <CheckCircle className="w-3.5 h-3.5 text-white" />}</div>
    </div>
  );

  const renderFormView = () => {
    const formMonth = formData.date.substring(0, 7);
    const fs = stats.getMonthStats(formMonth);
    let poolLimit = poolOf(fs);
    let savingsLimit = fs.savings;
    let investLimit = fs.investCash;

    // 編輯時，先把原本那筆加回來
    const original = editingId ? transactions.find(t => t.id === editingId) : undefined;
    if (original && original.date.substring(0, 7) <= formMonth) {
      const a = original.amount;
      if (original.type === 'expense') {
        if (original.fromSavings) savingsLimit += a;
        else if (original.tag === 'want' && !original.fromGoal) poolLimit += a;
        else if (original.tag === 'advance') savingsLimit += a;
      } else if (original.type === 'transfer') {
        const dir = original.transferDirection;
        if (dir === 'pool_to_savings' || (dir === 'to_goal' && !original.fromSavings)) poolLimit += a;
        if (dir === 'savings_to_pool' || dir === 'to_invest' || (dir === 'to_goal' && original.fromSavings)) savingsLimit += a;
        if (dir === 'invest_buy') investLimit += a;
      }
    }
    poolLimit = Math.round(poolLimit);
    savingsLimit = Math.round(savingsLimit);
    investLimit = Math.round(investLimit);
    const amount = Number(formData.amount) || 0;

    const isExpense = formData.type === 'expense';
    const isTransfer = formData.type === 'transfer';
    const isAdvance = isExpense && (formData.category === '代墊' || formData.tag === 'advance');
    const isWantFromPool = isExpense && !isAdvance && formData.tag === 'want' && !formData.fromSavings && !formData.fromGoal;
    const isPoolOver = isWantFromPool && amount > poolLimit;

    const dir = formData.transferDirection;
    const needsGoal = (isTransfer && (dir === 'to_goal' || dir === 'goal_to_savings')) || (isExpense && formData.fromGoal);
    const goalBalance = needsGoal && formData.goal ? Math.round(computeGoals(editingId).rows.find(r => r.name === formData.goal)?.balance || 0) : 0;
    const isGoalMissing = needsGoal && !formData.goal;
    const isGoalInsufficient = !!formData.goal && ((isTransfer && dir === 'goal_to_savings') || (isExpense && formData.fromGoal)) && amount > goalBalance;
    const usesSavings = (isExpense && formData.fromSavings) || (isTransfer && (dir === 'savings_to_pool' || dir === 'to_invest' || (dir === 'to_goal' && formData.fromSavings)));
    const isSavingsInsufficient = usesSavings && amount > savingsLimit;
    const usesPoolTransfer = isTransfer && (dir === 'pool_to_savings' || (dir === 'to_goal' && !formData.fromSavings));
    const isPoolTransferInsufficient = usesPoolTransfer && amount > poolLimit;
    const isInvestBuy = isTransfer && dir === 'invest_buy';
    const isInvestInsufficient = isInvestBuy && amount > investLimit;
    const isHoldingMissing = isInvestBuy && !formData.holding;
    const isSubmitDisabled = !formData.amount || isInvestInsufficient || isHoldingMissing || isGoalMissing || isGoalInsufficient || isSavingsInsufficient || isPoolTransferInsufficient;

    const transferButton = (d: TransferDirection, label: string, wide = false) => (
      <button onClick={() => setFormData({ ...formData, transferDirection: d, fromSavings: false, goal: '' })}
        className={`${wide ? 'col-span-2 ' : ''}py-3 rounded-xl text-sm font-bold transition border ${dir === d ? 'bg-black text-white border-black' : 'bg-white text-gray-400 border-gray-200'}`}>{label}</button>
    );
    const sourceRow = (on: boolean, onClick: () => void, label: string, balance: number) => (
      <div onClick={onClick} className={`flex items-center justify-between cursor-pointer p-2 rounded-lg ${on ? 'bg-gray-100' : ''}`}>
        <div className="flex flex-col"><span className="text-base text-gray-900">{label}</span><span className={`text-xs font-bold mt-0.5 ${balance < amount ? 'text-red-400' : 'text-gray-500'}`}>餘額: ${formatMoney(balance)}</span></div>
        <input type="radio" checked={on} onChange={() => {}} className="w-5 h-5 accent-black" />
      </div>
    );

    return (
      <div className="space-y-5 pb-20 pt-2">
        <div className="flex items-center justify-between px-1 mb-2">
          <button onClick={() => setActiveTab('dashboard')} className="flex items-center text-gray-500 font-medium -ml-2 p-2 rounded-lg"><ChevronLeft className="w-5 h-5" /> 返回</button>
        </div>
        <div className="bg-gray-200 p-0.5 rounded-lg flex mb-4">
          <button onClick={() => setFormData({ ...formData, type: 'expense', category: getDefaultCategory(), tag: 'need', isReimbursement: false, isInvestFunding: false })} className={`flex-1 py-1.5 text-sm font-bold rounded-md transition ${isExpense ? 'bg-white text-black shadow-sm' : 'text-gray-600'}`}>支出</button>
          <button onClick={() => setFormData({ ...formData, type: 'income', category: '收入', tag: 'income', fromSavings: false, fromGoal: false, goal: '' })} className={`flex-1 py-1.5 text-sm font-bold rounded-md transition ${formData.type === 'income' ? 'bg-white text-black shadow-sm' : 'text-gray-600'}`}>收入</button>
          <button onClick={() => setFormData({ ...formData, type: 'transfer', category: '資金劃轉', tag: 'transfer', transferDirection: 'pool_to_savings', fromSavings: false, fromGoal: false, goal: '', isReimbursement: false, isInvestFunding: false })} className={`flex-1 py-1.5 text-sm font-bold rounded-md transition ${isTransfer ? 'bg-white text-black shadow-sm' : 'text-gray-600'}`}>劃轉</button>
        </div>

        <div className="bg-white rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between p-5 border-b border-gray-50">
            <label className="text-base font-bold text-black">金額</label>
            <div className="flex-1 ml-4">
              <input ref={amountInputRef} type="text" placeholder="0" value={formData.amount} readOnly onClick={openCalculator}
                className={`w-full text-right text-3xl font-bold placeholder-gray-200 bg-transparent outline-none overflow-x-auto whitespace-nowrap ${formData.installmentCalcType === 'monthly' && formData.isInstallment ? 'text-gray-300' : 'cursor-pointer text-black'}`} />
            </div>
          </div>
          <div className="flex items-center justify-between p-5 border-b border-gray-50 relative">
            <label className="text-base font-bold text-black">日期</label>
            <div className="flex-1 ml-4 text-right">
              <input type="date" value={formData.date} onChange={e => setFormData({ ...formData, date: e.target.value })} className="absolute inset-0 opacity-0 z-10 w-full h-full cursor-pointer" />
              <span className="text-base font-medium text-gray-600 pointer-events-none relative z-0">{formData.date.split('-').join('/')}</span>
            </div>
          </div>
          <div className="flex items-center justify-between p-5">
            <label className="text-base font-bold text-black">分類</label>
            {isExpense ? (
              <select value={formData.category} onChange={e => {
                const c = e.target.value;
                setFormData({ ...formData, category: c, tag: c === '代墊' ? 'advance' : formData.tag === 'advance' ? 'need' : formData.tag });
              }}
                className="text-base font-medium text-gray-600 bg-transparent outline-none text-right appearance-none pr-6"
                style={{ backgroundImage: `url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='currentColor'%3e%3cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'%3e%3c/path%3e%3c/svg%3e")`, backgroundPosition: 'right center', backgroundRepeat: 'no-repeat', backgroundSize: '1em 1em' }}>
                {expenseCategories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            ) : <span className="text-base font-medium text-gray-600">{isTransfer ? '資金劃轉' : '收入'}</span>}
          </div>
        </div>

        <div className="bg-white rounded-2xl overflow-hidden">
          {isTransfer ? (
            <div className="p-4 flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-3">
                {transferButton('pool_to_savings', '可花 ➔ 存款')}
                {transferButton('savings_to_pool', '存款 ➔ 可花')}
                {transferButton('to_goal', '存入夢想帳戶')}
                {transferButton('goal_to_savings', '夢想帳戶 ➔ 存款')}
                {transferButton('to_invest', '存款 ➔ 投資帳戶')}
                {transferButton('invest_buy', '投資帳戶 ➔ 買股票')}
              </div>
              {(dir === 'pool_to_savings') && sourceRow(true, () => {}, '可花額度', poolLimit)}
              {(dir === 'savings_to_pool' || dir === 'to_invest') && sourceRow(true, () => {}, '現金存款', savingsLimit)}
              {isInvestBuy && (
                <div className="space-y-3">
                  {sourceRow(true, () => {}, '投資帳戶', investLimit)}
                  <p className="text-xs font-bold text-gray-400 pt-1">買進標的</p>
                  <div className="flex flex-wrap gap-2">
                    {holdings.map(h => (
                      <button key={h.name} type="button" onClick={() => setFormData({ ...formData, holding: formData.holding === h.name ? '' : h.name })}
                        className={`px-3 py-1.5 rounded-full text-sm font-bold border transition ${formData.holding === h.name ? 'bg-black text-white border-black' : 'bg-white text-gray-500 border-gray-200'}`}>{h.name}</button>
                    ))}
                  </div>
                  <div className="flex items-center justify-between bg-gray-50 rounded-xl px-3 py-2 border border-gray-100">
                    <span className="text-xs font-bold text-gray-500">買到的股數</span>
                    <input type="text" inputMode="decimal" placeholder="0" value={formData.quantity}
                      onChange={e => { if (/^\d*\.?\d*$/.test(e.target.value)) setFormData({ ...formData, quantity: e.target.value }); }}
                      className="text-right text-sm font-bold text-black bg-transparent outline-none w-32" />
                  </div>
                  {isHoldingMissing && <ErrorLine text="請選擇標的" />}
                  {isInvestInsufficient && <ErrorLine text="投資帳戶餘額不足" />}
                </div>
              )}
              {(dir === 'to_goal' || dir === 'goal_to_savings') && (
                <div className="space-y-3">
                  <p className="text-xs font-bold text-gray-400">夢想帳戶</p>
                  {renderGoalChips()}
                  {dir === 'goal_to_savings' && formData.goal && <p className="text-xs font-bold text-gray-500 px-1">餘額: ${formatMoney(goalBalance)}</p>}
                  {dir === 'to_goal' && (
                    <div className="space-y-2 pt-2">
                      <p className="text-xs font-bold text-gray-400">資金來源</p>
                      {sourceRow(!formData.fromSavings, () => setFormData({ ...formData, fromSavings: false }), '可花額度', poolLimit)}
                      {sourceRow(formData.fromSavings, () => setFormData({ ...formData, fromSavings: true }), '現金存款', savingsLimit)}
                    </div>
                  )}
                </div>
              )}
              {isGoalMissing && <ErrorLine text="請選擇夢想帳戶" />}
              {(isGoalInsufficient || isSavingsInsufficient || isPoolTransferInsufficient) && <ErrorLine text="餘額不足" />}
            </div>
          ) : isExpense ? (
            <div className="p-4 flex flex-col gap-4">
              {!isAdvance && (
                <div className="flex gap-2">
                  <button onClick={() => setFormData({ ...formData, tag: 'need' })} className={`flex-1 py-3 rounded-xl text-sm font-bold transition border ${formData.tag === 'need' ? 'bg-gray-100 text-black border-gray-200' : 'bg-white text-gray-400 border-gray-200'}`}>需要</button>
                  <button onClick={() => setFormData({ ...formData, tag: 'want' })} className={`flex-1 py-3 rounded-xl text-sm font-bold transition border ${formData.tag === 'want' ? 'text-white' : 'bg-white text-gray-400 border-gray-200'}`} style={formData.tag === 'want' ? { backgroundColor: THEME.accent, borderColor: THEME.accent } : undefined}>想要</button>
                </div>
              )}
              {isWantFromPool && (
                <div className="flex justify-between items-baseline px-1">
                  <span className="text-sm text-gray-500">可花額度</span>
                  <span className={`text-sm font-bold tabular-nums ${isPoolOver ? 'text-red-500' : 'text-black'}`}>${formatMoney(poolLimit)}{amount > 0 && <> ➔ {poolLimit - amount < 0 ? '−' : ''}${formatMoney(Math.abs(poolLimit - amount))}</>}</span>
                </div>
              )}
              {isPoolOver && (
                <div className="flex items-start gap-2 p-3 rounded-xl bg-red-50 border border-red-200 text-red-500">
                  <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <span className="text-xs font-bold">超過可花額度 ${formatMoney(amount - Math.max(0, poolLimit))}，會從下個月扣回</span>
                </div>
              )}
              {!isAdvance && optionRow(formData.fromSavings, () => setFormData({ ...formData, fromSavings: !formData.fromSavings, fromGoal: false, goal: '', isInstallment: false }), <PiggyBank className="w-4 h-4" />, '用現金存款支付', `餘額: $${formatMoney(savingsLimit)}`)}
              {isExpense && formData.fromSavings && isSavingsInsufficient && <ErrorLine text="餘額不足" />}
              {!isAdvance && optionRow(formData.fromGoal, () => setFormData({ ...formData, fromGoal: !formData.fromGoal, fromSavings: false, goal: '', isInstallment: false }), <Heart className="w-4 h-4" />, '用夢想帳戶支付')}
              {formData.fromGoal && (
                <div className="space-y-2 px-1">
                  {renderGoalChips()}
                  {formData.goal && <p className="text-xs font-bold text-gray-500">餘額: ${formatMoney(goalBalance)}</p>}
                  {isGoalMissing && <ErrorLine text="請選擇夢想帳戶" />}
                  {isGoalInsufficient && <ErrorLine text="餘額不足" />}
                </div>
              )}
            </div>
          ) : (
            <div className="p-4 flex flex-col gap-3">
              {optionRow(formData.isReimbursement, () => setFormData({ ...formData, isReimbursement: !formData.isReimbursement, isInvestFunding: false }), <Tag className="w-4 h-4" />, '代墊還款')}
              {optionRow(formData.isInvestFunding, () => setFormData({ ...formData, isInvestFunding: !formData.isInvestFunding, isReimbursement: false }), <TrendingUp className="w-4 h-4" />, '投資資金（不能花）', `進投資帳戶・目前 $${formatMoney(investLimit)}`)}
            </div>
          )}
        </div>

        <div className="bg-white rounded-2xl overflow-hidden p-5">
          <input type="text" placeholder="新增備註..." value={formData.note} onChange={e => setFormData({ ...formData, note: e.target.value })} className="w-full text-base bg-transparent outline-none placeholder-gray-400" />
        </div>

        {isExpense && !isAdvance && !editingId && !formData.fromSavings && !formData.fromGoal && (
          <div className="bg-white rounded-2xl overflow-hidden p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3"><div className="w-9 h-9 rounded-full bg-gray-100 flex items-center justify-center text-black"><CreditCard className="w-5 h-5" /></div><span className="text-base font-bold text-gray-900">分期付款</span></div>
              <Toggle on={formData.isInstallment} onClick={() => setFormData({ ...formData, isInstallment: !formData.isInstallment })} label="切換分期付款" />
            </div>
            {formData.isInstallment && (
              <div className="mt-5 pt-5 border-t border-gray-50 space-y-4">
                <div className="flex bg-gray-100 p-1 rounded-lg">
                  <button onClick={() => setFormData({ ...formData, installmentCalcType: 'total' })} className={`flex-1 py-1.5 text-xs font-bold rounded-md transition ${formData.installmentCalcType === 'total' ? 'bg-white shadow-sm text-black' : 'text-gray-400'}`}>輸入總額</button>
                  <button onClick={() => setFormData({ ...formData, installmentCalcType: 'monthly' })} className={`flex-1 py-1.5 text-xs font-bold rounded-md transition ${formData.installmentCalcType === 'monthly' ? 'bg-white shadow-sm text-black' : 'text-gray-400'}`}>輸入每期</button>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div><label className="text-xs font-bold text-gray-400 block mb-2">期數 (月)</label>
                    <input type="text" inputMode="numeric" value={formData.installmentCount} onChange={e => { const v = e.target.value; if (v === '' || /^\d+$/.test(v)) setFormData({ ...formData, installmentCount: v, amount: formData.installmentCalcType === 'monthly' && formData.perMonthInput && v ? String(Number(formData.perMonthInput) * Number(v)) : formData.amount }); }} className="w-full bg-gray-50 rounded-xl p-3 text-center font-bold text-black border border-gray-100 outline-none" />
                  </div>
                  <div><label className="text-xs font-bold text-gray-400 block mb-2">每期金額</label>
                    {formData.installmentCalcType === 'total'
                      ? <div className="w-full bg-gray-50 rounded-xl p-3 text-center font-bold text-gray-500 border border-gray-100 flex items-center justify-center gap-1"><Calculator className="w-3 h-3 opacity-50" />${formData.amount && formData.installmentCount ? Math.floor(Number(formData.amount) / Number(formData.installmentCount)).toLocaleString() : 0}</div>
                      : <input type="text" placeholder="0" value={formData.perMonthInput} inputMode="numeric" onChange={e => { const v = e.target.value; if (/^\d*$/.test(v)) setFormData({ ...formData, perMonthInput: v, amount: v && formData.installmentCount ? String(Number(v) * Number(formData.installmentCount)) : '' }); }} className="w-full bg-white rounded-xl p-3 text-center font-bold text-black border-2 border-gray-200 outline-none" />}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="flex gap-3 pt-4">
          {editingId && <button onClick={e => requestDelete(e, editingId)} className="flex-1 bg-white text-red-500 py-3.5 rounded-xl font-bold border border-gray-200 flex items-center justify-center gap-2"><Trash2 className="w-5 h-5" /> 刪除</button>}
          <button onClick={handleSave} disabled={isSubmitDisabled} className={`flex-1 py-3.5 rounded-xl font-bold transition flex items-center justify-center gap-2 ${isSubmitDisabled ? 'bg-gray-200 text-gray-400' : 'bg-black text-white'}`}>{isSubmitDisabled ? <Lock className="w-5 h-5" /> : <Save className="w-5 h-5" />} {editingId ? '儲存變更' : '新增紀錄'}</button>
        </div>
      </div>
    );
  };

  // ================= 明細 =================
  const transferLabel = (t: Transaction) => {
    switch (t.transferDirection) {
      case 'pool_to_savings': return '可花➔存款';
      case 'savings_to_pool': return '存款➔可花';
      case 'to_goal': return `存入${t.goal || '夢想'}`;
      case 'goal_to_savings': return `${t.goal || '夢想'}➔存款`;
      case 'to_invest': return '存款➔投資';
      case 'invest_buy': return `買進${t.holding ? ` ${t.holding}` : ''}`;
      default: return '劃轉';
    }
  };

  const renderHistoryView = () => {
    const sorted = [...transactions].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
    const today = getLocalDayString();
    const keywords = searchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const isSearching = keywords.length > 0;
    const filtered = sorted.filter(t => {
      if (!isSearching && hideFuture && t.date > today) return false;
      if (filterCategory && t.category !== filterCategory) return false;
      if (filterTag && t.tag !== filterTag) return false;
      if (isSearching) {
        const hay = [t.note, t.category, String(t.amount), t.date, t.date.replace(/-/g, '/'), t.goal].filter(Boolean).join(' ').toLowerCase();
        if (!keywords.every(k => hay.includes(k))) return false;
      }
      return true;
    });
    const searchExpense = filtered.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
    const grouped = filtered.reduce((g: { [key: string]: Transaction[] }, t) => {
      const [y, m] = t.date.split('-').map(Number);
      const key = `${y}年${m}月`;
      (g[key] = g[key] || []).push(t);
      return g;
    }, {});

    const onTouchStart = (e: React.TouchEvent) => { touchStartX.current = e.targetTouches[0].clientX; };
    const onTouchMove = (e: React.TouchEvent, id: number) => {
      if (touchStartX.current === null) return;
      const diff = touchStartX.current - e.targetTouches[0].clientX;
      if (diff > 50) setSwipedId(id); else if (diff < -50 && swipedId === id) setSwipedId(null);
    };
    const chip = (key: 'want' | 'need' | 'advance', label: string, icon: React.ReactNode) => (
      <button onClick={() => setFilterTag(filterTag === key ? null : key)} className={`flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-bold transition border ${filterTag === key ? 'bg-black text-white border-black' : 'bg-white text-gray-800 border-gray-200'}`}>{icon}{label}</button>
    );

    return (
      <div className="space-y-6 pb-4 pt-2">
        <div className="flex justify-between items-center px-1">
          <div>
            <h2 className="text-3xl font-bold text-black tracking-tight">紀錄</h2>
            <p className="text-xs font-semibold text-gray-400 mt-1">{filtered.length} 筆 {!isSearching && hideFuture && '(隱藏未來)'}</p>
          </div>
          <div className="flex gap-1.5">
            {chip('want', '想要', <Heart className="w-3.5 h-3.5" />)}
            {chip('need', '需要', <ShoppingBag className="w-3.5 h-3.5" />)}
            {chip('advance', '代墊', <Tag className="w-3.5 h-3.5" />)}
            <button onClick={() => setHideFuture(!hideFuture)} aria-label="切換顯示未來紀錄" className={`w-8 h-8 rounded-full flex items-center justify-center border transition ${!hideFuture ? 'bg-gray-800 text-white border-gray-800' : 'bg-white text-gray-400 border-gray-200'}`}>
              {!hideFuture ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>

        <div>
          <div className="flex items-center gap-2 bg-gray-200 rounded-xl px-3 py-2">
            <Search className="w-4 h-4 text-gray-500 flex-shrink-0" />
            <input type="search" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="搜尋備註、分類、金額或日期" className="flex-1 min-w-0 bg-transparent outline-none text-base text-black placeholder-gray-500" />
            {searchQuery && <button onClick={() => setSearchQuery('')} aria-label="清除搜尋" className="w-5 h-5 rounded-full bg-gray-400 text-white flex items-center justify-center flex-shrink-0"><X className="w-3 h-3" /></button>}
          </div>
          {isSearching && <p className="text-sm text-gray-500 px-1 mt-2 tabular-nums">找到 {filtered.length} 筆{searchExpense > 0 && `・支出合計 $${formatMoney(searchExpense)}`}</p>}
        </div>

        {(filterCategory || filterTag) && (
          <div className="flex flex-wrap gap-2">
            {filterCategory && (
              <div className="bg-black/5 rounded-xl p-2 pl-3 flex items-center gap-2 border border-black/5">
                <span className="text-xs font-bold text-gray-500">分類:</span><span className="text-sm font-bold text-black">{filterCategory}</span>
                <button onClick={() => setFilterCategory(null)} className="w-5 h-5 rounded-full bg-white text-gray-400 flex items-center justify-center"><X className="w-3 h-3" /></button>
              </div>
            )}
            {filterTag && (
              <div className="rounded-xl p-2 pl-3 flex items-center gap-2 border bg-gray-100 border-gray-200">
                <span className="text-xs font-bold text-black">標籤:</span><span className="text-sm font-bold text-black">{tagLabel(filterTag)}</span>
                <button onClick={() => setFilterTag(null)} className="w-5 h-5 rounded-full bg-white/50 text-gray-500 flex items-center justify-center"><X className="w-3 h-3" /></button>
              </div>
            )}
          </div>
        )}

        {Object.entries(grouped).map(([groupName, items]) => (
          <div key={groupName}>
            <h4 className="text-xs font-bold text-gray-400 mb-2 ml-1">{groupName}</h4>
            <div className="bg-white rounded-2xl overflow-hidden border border-gray-100 divide-y divide-gray-50">
              {(items as Transaction[]).map(t => {
                const isTransfer = t.type === 'transfer';
                const isAdjust = t.type === 'adjust';
                const badge = 'bg-gray-100 text-gray-800 text-xs font-bold px-1.5 py-0.5 rounded-md';
                return (
                  <div key={t.id} className="relative overflow-hidden" onTouchStart={onTouchStart} onTouchMove={e => onTouchMove(e, t.id)} onTouchEnd={() => { touchStartX.current = null; }}>
                    <div className="absolute inset-y-0 right-0 w-24 bg-red-500 flex items-center justify-center z-0" onClick={e => requestDelete(e, t.id)}><Trash2 className="w-6 h-6 text-white" /></div>
                    <div onClick={() => openEditMode(t)} className={`p-4 flex justify-between items-center bg-white relative z-10 transition-transform duration-300 ease-out ${swipedId === t.id ? '-translate-x-24' : 'translate-x-0'} active:bg-gray-50`}>
                      <div className="flex items-center gap-4 overflow-hidden">
                        <div className={`flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center ${t.type === 'income' ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-gray-500'}`}
                          style={t.tag === 'want' ? { backgroundColor: '#FBEFF2', color: THEME.accent } : undefined}>
                          {isTransfer || isAdjust ? <RefreshCcw className="w-5 h-5" /> : t.tag === 'advance' ? <Tag className="w-5 h-5" /> : t.tag === 'want' ? <Heart className="w-5 h-5" /> : <DollarSign className="w-5 h-5" />}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="font-bold text-gray-900 text-base truncate">{t.category}</p>
                            {t.groupId && <span className={badge}>分期</span>}
                            {t.fromSavings && t.type === 'expense' && <span className={badge}>存款</span>}
                            {t.fromGoal && <span className={badge}>夢想{t.goal ? `・${t.goal}` : ''}</span>}
                            {t.isReimbursement && <span className={badge}>代墊還款</span>}
                            {t.isInvestFunding && <span className={badge}>投資資金</span>}
                            {isAdjust && <span className={badge}>{t.adjustTarget === 'pool' ? '可花額度' : '現金存款'}</span>}
                            {isTransfer && <span className={badge}>{transferLabel(t)}</span>}
                          </div>
                          <p className="text-xs text-gray-400 truncate mt-0.5">{t.date} • {t.note || '無備註'}</p>
                        </div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className={`font-bold text-base ${t.type === 'income' ? 'text-green-600' : isTransfer ? 'text-gray-500' : 'text-black'}`}>
                          {isAdjust ? (t.amount >= 0 ? '+' : '−') : t.type === 'income' ? '+' : isTransfer ? '⇌' : '-'}{formatMoney(isAdjust ? Math.abs(t.amount) : t.amount)}
                        </p>
                        {t.type === 'expense' && <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">{tagLabel(t.tag)}</span>}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {transactions.length === 0 && <div className="text-center py-20 text-gray-400"><p>無紀錄</p></div>}
        {transactions.length > 0 && filtered.length === 0 && <div className="text-center py-16 text-gray-400"><p>{isSearching ? `找不到「${searchQuery.trim()}」相關的紀錄` : '沒有符合條件的紀錄'}</p></div>}
      </div>
    );
  };

  // ================= 投資：只追蹤持倉 =================
  const priceOf = (h: Holding): { price: number | null; source: 'market' | 'manual' | null } => {
    if (market.prices[h.name] !== undefined) return { price: market.prices[h.name], source: 'market' };
    if (h.manualPrice) return { price: h.manualPrice, source: 'manual' };
    return { price: null, source: null };
  };

  // 目前持倉 = 設定裡的起始股數／成本 + 之後「投資帳戶 ➔ 買股票」的紀錄
  const effectiveHoldings = () => {
    const today = getLocalDayString();
    return holdings.map(h => {
      const buys = transactions.filter(t => t.type === 'transfer' && t.transferDirection === 'invest_buy' && t.holding === h.name && t.date <= today);
      return {
        ...h,
        quantity: (h.quantity || 0) + buys.reduce((s, t) => s + (t.quantity || 0), 0),
        cost: (h.cost || 0) + buys.reduce((s, t) => s + t.amount, 0),
        bought: buys.length,
      };
    });
  };

  const renderInvestmentView = () => {
    const investCash = Math.round(stats.getMonthStats(getLocalMonthString()).investCash);
    const rows = effectiveHoldings().map((h, i) => {
      const { price, source } = priceOf(h);
      const value = price !== null ? h.quantity * price : null;
      return { ...h, price, source, value, pnl: value !== null ? value - h.cost : null, color: COLORS[i % COLORS.length] };
    });
    const priced = rows.filter(r => r.value !== null);
    const totalValue = priced.reduce((s, r) => s + (r.value || 0), 0);
    const totalCost = priced.reduce((s, r) => s + r.cost, 0);
    const totalPnl = totalValue - totalCost;
    const pnlColor = (v: number) => (Math.round(v) === 0 ? 'text-gray-500' : v > 0 ? 'text-green-600' : 'text-red-500');
    const pct = (v: number, base: number) => (base > 0 ? `${v >= 0 ? '+' : ''}${((v / base) * 100).toFixed(1)}%` : '');
    const fetchedAt = market.fetchedAt ? new Date(market.fetchedAt) : null;

    return (
      <div className="space-y-4 pb-4 pt-2">
        <h2 className="text-3xl font-bold text-black tracking-tight px-1">投資</h2>

        {initialStats.priceCsvUrl && (
          <CardContainer className="px-5 py-3.5 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-bold text-gray-900">市場價格</p>
              <p className={`text-xs mt-0.5 truncate ${marketStatus === 'error' ? 'text-red-500 font-bold' : 'text-gray-400'}`}>
                {marketStatus === 'error' ? marketError : fetchedAt ? `上次更新 ${fetchedAt.toLocaleString()}` : '尚未更新'}
              </p>
            </div>
            <button onClick={refreshMarket} disabled={marketStatus === 'loading'} className="flex-shrink-0 flex items-center gap-1.5 bg-black text-white px-3.5 py-2 rounded-xl text-xs font-bold disabled:opacity-50">
              <RefreshCcw className={`w-3.5 h-3.5 ${marketStatus === 'loading' ? 'animate-spin' : ''}`} />{marketStatus === 'loading' ? '更新中' : '更新價格'}
            </button>
          </CardContainer>
        )}

        <CardContainer className="p-5">
          <div className="flex items-center justify-between mb-1">
            <p className="text-sm text-gray-500">總市值</p>
            <button onClick={() => { setSettingsPage('holdings'); setActiveTab('settings'); }} className="text-sm font-bold" style={{ color: THEME.accent }}>編輯持倉</button>
          </div>
          <p className="text-3xl font-bold tracking-tight tabular-nums">${formatMoney(totalValue)}</p>
          {totalCost > 0 && (
            <div className="flex justify-between items-baseline mt-2 text-sm tabular-nums">
              <span className="text-gray-500">成本 ${formatMoney(totalCost)}</span>
              <span className={`font-bold ${pnlColor(totalPnl)}`}>{signedMoney(totalPnl)} {pct(totalPnl, totalCost)}</span>
            </div>
          )}
          {totalValue > 0 && (
            <div className="flex h-2.5 w-full rounded-full overflow-hidden bg-gray-100 mt-4">
              {priced.filter(r => (r.value || 0) > 0).map(r => <div key={r.name} className="h-full" style={{ width: `${((r.value || 0) / totalValue) * 100}%`, backgroundColor: r.color }}></div>)}
            </div>
          )}
        </CardContainer>

        <CardContainer className="px-4 py-3 flex justify-between items-baseline">
          <span className="text-base text-black">投資帳戶現金</span>
          <span className={`text-base font-bold tabular-nums ${investCash < 0 ? 'text-red-500' : 'text-black'}`}>{investCash < 0 ? '−' : ''}${formatMoney(Math.abs(investCash))}</span>
        </CardContainer>

        <CardContainer className="divide-y divide-gray-100">
          {rows.length === 0 && <div className="px-4 py-6 text-center text-sm text-gray-400">尚無持倉</div>}
          {rows.map(r => (
            <div key={r.name} className="px-4 py-3">
              <div className="flex justify-between items-baseline">
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: r.color }}></div>
                  <span className="text-base font-bold text-black">{r.name}</span>
                  {totalValue > 0 && r.value !== null && <span className="text-xs text-gray-400 tabular-nums">{(((r.value || 0) / totalValue) * 100).toFixed(0)}%</span>}
                </div>
                <span className="text-base font-bold tabular-nums">{r.value !== null ? `$${formatMoney(r.value)}` : '沒有價格'}</span>
              </div>
              <div className="flex justify-between items-baseline mt-0.5 text-sm tabular-nums">
                <span className="text-gray-500">
                  {r.quantity.toLocaleString(undefined, { maximumFractionDigits: 4 })} 股{r.price !== null && ` × $${r.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
                  {r.source === 'manual' && <span className="text-gray-400">（手動）</span>}
                </span>
                {r.pnl !== null && r.cost > 0 && <span className={`font-bold ${pnlColor(r.pnl)}`}>{signedMoney(r.pnl)} {pct(r.pnl, r.cost)}</span>}
              </div>
            </div>
          ))}
        </CardContainer>
      </div>
    );
  };

  // ================= 餘額校正 =================
  const renderReconcileCard = () => {
    const now = stats.getMonthStats(getLocalMonthString());
    const parts = [
      { label: '現金存款', value: now.savings },
      { label: '夢想帳戶', value: computeGoals().total },
      { label: '可花額度', value: poolOf(now) },
      { label: '留到下月的額度', value: now.carryToNext },
      { label: '未填補赤字', value: -now.accumulatedDeficit },
    ].filter(p => Math.round(p.value) !== 0);
    const appTotal = parts.reduce((s, p) => s + p.value, 0);
    const actual = Number(reconcileActual);
    const hasActual = reconcileActual !== '' && isFinite(actual);
    const diff = hasActual ? Math.round(actual - appTotal) : 0;

    const handleReconcile = () => {
      if (!hasActual || diff === 0) return;
      const id = transactions.length > 0 ? Math.max(...transactions.map(t => t.id)) + 1 : 1;
      setTransactions([{ id, date: getLocalDayString(), category: '餘額校正', amount: diff, type: 'adjust', tag: 'transfer',
        note: `實際 ${formatMoney(actual)}，APP ${formatMoney(appTotal)}`, adjustTarget: reconcileTarget }, ...transactions]);
      setReconcileActual('');
    };

    return (
      <CardContainer className="p-4">
        <div className="space-y-1.5 mb-3">
          {parts.map(p => <div key={p.label} className="flex justify-between text-xs"><span className="text-gray-500">{p.label}</span><span className="font-bold tabular-nums">{p.value < 0 ? '−' : ''}${formatMoney(Math.abs(p.value))}</span></div>)}
          <div className="flex justify-between text-sm pt-1.5 border-t border-gray-100"><span className="font-bold">APP 計算的現金合計</span><span className="font-bold tabular-nums">${formatMoney(appTotal)}</span></div>
        </div>
        <div className="flex items-center justify-between bg-gray-50 rounded-xl px-3 py-2 border border-gray-100 mb-3">
          <span className="text-xs font-bold text-gray-600">實際現金（不含投資）</span>
          <input type="text" inputMode="numeric" placeholder="0" value={reconcileActual} onChange={e => { if (/^\d*$/.test(e.target.value)) setReconcileActual(e.target.value); }} className="text-right text-base font-bold bg-transparent outline-none w-32" />
        </div>
        {hasActual && (
          <>
            <div className="flex justify-between items-baseline mb-3">
              <span className="text-xs text-gray-500">差額</span>
              <span className={`text-lg font-bold tabular-nums ${diff < 0 ? 'text-red-500' : diff > 0 ? 'text-green-600' : 'text-black'}`}>{diff > 0 ? '+' : diff < 0 ? '−' : ''}${formatMoney(Math.abs(diff))}</span>
            </div>
            {diff !== 0 && (
              <>
                <p className="text-xs text-gray-400 mb-2">調整項目</p>
                <div className="grid grid-cols-2 gap-2 mb-3">
                  {([['savings', '現金存款'], ['pool', '可花額度']] as const).map(([key, label]) => (
                    <button key={key} onClick={() => setReconcileTarget(key)} className={`py-2 rounded-xl text-xs font-bold border transition ${reconcileTarget === key ? 'bg-black text-white border-black' : 'bg-white text-gray-500 border-gray-200'}`}>{label}</button>
                  ))}
                </div>
                <button onClick={handleReconcile} className="w-full bg-black text-white py-3 rounded-xl font-bold text-sm">建立校正紀錄</button>
              </>
            )}
          </>
        )}
      </CardContainer>
    );
  };

  // ================= 設定 =================
  const renderSettingsView = () => {
    const setNumber = (field: 'savings' | 'initialPool' | 'investCash', v: string) => { if (/^\d*$/.test(v)) setInitialStats(prev => ({ ...prev, [field]: v === '' ? 0 : Number(v) })); };
    const usagePercent = Math.min((storageUsage / (5 * 1024 * 1024)) * 100, 100);
    const PAGE_TITLES: { [key: string]: string } = {
      categories: '分類與預算', ratio: '結餘分配', goals: '夢想帳戶', initial: '起始數值', installments: '分期付款',
      holdings: '持倉', market: '市場價格', reconcile: '餘額校正', backup: '備份與匯入',
    };
    const updateHolding = (idx: number, patch: Partial<Holding>) => setHoldings(holdings.map((h, i) => (i === idx ? { ...h, ...patch } : h)));
    const decimalRow = (key: string, label: string, current: number | undefined, apply: (n: number) => void, placeholder = '0') => (
      <InputRow label={label} inputMode="decimal" placeholder={placeholder}
        value={numDrafts[key] ?? (current ? String(current) : '')}
        onChange={v => { if (/^\d*\.?\d*$/.test(v)) { setNumDrafts(prev => ({ ...prev, [key]: v })); apply(Number(v) || 0); } }} />
    );

    const renderPage = () => {
      switch (settingsPage) {
        case 'categories':
          return (
            <>
              <div>
                <SectionHeader>支出分類</SectionHeader>
                <CardContainer className="p-4">
                  <div className="flex flex-wrap gap-2 mb-4">
                    {expenseCategories.map(cat => (
                      <div key={cat} className="flex items-center gap-1.5 pl-3 pr-1.5 py-1.5 bg-gray-100 rounded-full">
                        <span className="text-sm text-gray-800">{cat}</span>
                        {cat !== '代墊' && <button onClick={() => { setExpenseCategories(expenseCategories.filter(c => c !== cat)); const nb = { ...budgets }; delete nb[cat]; setBudgets(nb); }} aria-label={`刪除 ${cat}`} className="w-5 h-5 rounded-full bg-gray-300 text-white flex items-center justify-center active:bg-red-500"><X className="w-3 h-3" /></button>}
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <input type="text" placeholder="新增分類" value={newCategoryInput} onChange={e => setNewCategoryInput(e.target.value)} className="flex-1 min-w-0 bg-gray-100 rounded-xl px-4 py-2 text-base outline-none" />
                    <button onClick={() => { const c = newCategoryInput.trim(); if (!c || expenseCategories.includes(c)) return; setExpenseCategories([...expenseCategories, c]); setNewCategoryInput(''); }} disabled={!newCategoryInput.trim()} className="px-4 py-2 rounded-xl font-bold text-base text-white disabled:opacity-40" style={{ backgroundColor: THEME.accent }}>新增</button>
                  </div>
                </CardContainer>
              </div>
              <div>
                <SectionHeader>每月預算</SectionHeader>
                <CardContainer className="divide-y divide-gray-100">
                  {expenseCategories.filter(c => c !== '代墊').map(cat => (
                    <InputRow key={cat} label={cat} placeholder="未設定" value={budgets[cat] || ''} onChange={v => { if (/^\d*$/.test(v)) setBudgets(prev => ({ ...prev, [cat]: Number(v) })); }} />
                  ))}
                </CardContainer>
              </div>
            </>
          );

        case 'ratio':
          return (
            <div>
              <CardContainer className="divide-y divide-gray-100">
                <InputRow label="變成下月可花 (%)" placeholder="50" value={initialStats.spendRatio ?? ''}
                  onChange={v => { if (/^\d*$/.test(v) && Number(v) <= 100) setInitialStats(prev => ({ ...prev, spendRatio: v === '' ? 0 : Number(v) })); }} />
                <div className="px-4 py-3 flex justify-between"><span className="text-base text-black">存進現金存款 (%)</span><span className="text-base tabular-nums text-gray-600">{100 - spendRatio}</span></div>
              </CardContainer>
              <CardContainer className="mt-4 p-4">
                <p className="text-sm text-gray-500">例：本月結餘 $10,000</p>
                <p className="text-base font-bold mt-1 tabular-nums">下月可花 ${formatMoney(Math.floor(10000 * spendRatio / 100))}・存款 ${formatMoney(10000 - Math.floor(10000 * spendRatio / 100))}</p>
              </CardContainer>
            </div>
          );

        case 'goals': {
          const list = initialStats.goals || [];
          const summary = computeGoals();
          const setList = (next: Goal[]) => setInitialStats(prev => ({ ...prev, goals: next }));
          return (
            <>
              {list.map((g, idx) => (
                <div key={g.name + idx}>
                  <div className="flex items-center justify-between px-4 mb-1.5">
                    <span className="text-sm text-gray-500">{g.name}</span>
                    <button onClick={() => setList(list.filter((_, i) => i !== idx))} className="text-sm text-red-500">移除</button>
                  </div>
                  <CardContainer className="divide-y divide-gray-100">
                    <InputRow label="目標金額" value={g.target || ''} onChange={v => { if (/^\d*$/.test(v)) setList(list.map((x, i) => i === idx ? { ...x, target: Number(v) || 0 } : x)); }} />
                    <InputRow label="已經存了" value={g.baseBalance || ''} onChange={v => { if (/^\d*$/.test(v)) setList(list.map((x, i) => i === idx ? { ...x, baseBalance: Number(v) || 0 } : x)); }} />
                    <div className="px-4 py-3 flex items-center justify-between gap-4">
                      <label className="text-base text-black">希望達成月份</label>
                      <input type="month" value={g.targetDate || ''} onChange={e => setList(list.map((x, i) => i === idx ? { ...x, targetDate: e.target.value } : x))} className="text-base text-right outline-none text-gray-600 bg-transparent" />
                    </div>
                    <div className="px-4 py-3 flex justify-between"><span className="text-base font-bold text-black">目前餘額</span><span className="text-base font-bold tabular-nums">${formatMoney(summary.rows.find(r => r.name === g.name)?.balance || 0)}</span></div>
                  </CardContainer>
                </div>
              ))}
              <div>
                <SectionHeader>新增夢想帳戶</SectionHeader>
                <CardContainer className="p-4 flex gap-2">
                  <input type="text" placeholder="例如 演唱會" value={newGoalName} onChange={e => setNewGoalName(e.target.value)} className="flex-1 min-w-0 bg-gray-100 rounded-xl px-3 py-2 text-base outline-none" />
                  <button onClick={() => { const n = newGoalName.trim(); if (!n || list.some(g => g.name === n)) return; setList([...list, { name: n, target: 0, baseBalance: 0 }]); setNewGoalName(''); }} disabled={!newGoalName.trim()} className="px-3 py-2 rounded-xl text-white disabled:opacity-40" style={{ backgroundColor: THEME.accent }} aria-label="新增夢想帳戶"><Plus className="w-5 h-5" /></button>
                </CardContainer>
              </div>
            </>
          );
        }

        case 'installments': {
          const list = installmentSummary();
          return (
            <CardContainer className="divide-y divide-gray-100">
              {list.length === 0 ? <div className="px-4 py-3 text-base text-gray-400">目前沒有未付完的分期</div> : list.map(x => (
                <div key={x.name + x.lastDate} className="px-4 py-3">
                  <div className="flex justify-between items-baseline"><span className="text-base text-black">{x.name}</span><span className="text-base font-bold tabular-nums">${formatMoney(x.remaining)}</span></div>
                  <p className="text-sm text-gray-500 mt-0.5 tabular-nums">每期 ${formatMoney(x.perMonth)}・還剩 {x.remainingCount} / {x.totalCount} 期・最後一期 {x.lastDate}</p>
                </div>
              ))}
            </CardContainer>
          );
        }

        case 'initial':
          return (
            <CardContainer className="divide-y divide-gray-100">
              <InputRow label="現金存款" value={initialStats.savings || ''} onChange={v => setNumber('savings', v)} />
              <InputRow label="第一個月可花" value={initialStats.initialPool || ''} onChange={v => setNumber('initialPool', v)} />
              <InputRow label="投資帳戶現金" value={initialStats.investCash || ''} onChange={v => setNumber('investCash', v)} />
            </CardContainer>
          );

        case 'holdings':
          return (
            <>
              {holdings.map((h, idx) => {
                const { price, source } = priceOf(h);
                const eff = effectiveHoldings()[idx];
                return (
                  <div key={h.name}>
                    <div className="flex items-center justify-between px-4 mb-1.5">
                      <span className="text-sm text-gray-500">{h.name}</span>
                      <button onClick={() => setHoldings(holdings.filter((_, i) => i !== idx))} className="text-sm text-red-500">移除</button>
                    </div>
                    <CardContainer className="divide-y divide-gray-100">
                      {decimalRow(`${h.name}:qty`, '起始股數', h.quantity, n => updateHolding(idx, { quantity: n }))}
                      <InputRow label="起始成本" value={h.cost || ''} onChange={v => { if (/^\d*$/.test(v)) updateHolding(idx, { cost: Number(v) || 0 }); }} />
                      {eff && eff.bought > 0 && (
                        <div className="px-4 py-3 flex justify-between"><span className="text-base text-black">目前（含 {eff.bought} 筆買進）</span><span className="text-base tabular-nums text-gray-600">{eff.quantity.toLocaleString(undefined, { maximumFractionDigits: 4 })} 股・${formatMoney(eff.cost)}</span></div>
                      )}
                      {source === 'market'
                        ? <div className="px-4 py-3 flex justify-between"><span className="text-base text-black">目前價格</span><span className="text-base tabular-nums text-gray-400">${price!.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span></div>
                        : decimalRow(`${h.name}:price`, '手動價格（台幣）', h.manualPrice, n => updateHolding(idx, { manualPrice: n || undefined }), '未設定')}
                    </CardContainer>
                  </div>
                );
              })}
              <div>
                <SectionHeader>新增持倉</SectionHeader>
                <CardContainer className="p-4 flex gap-2">
                  <input type="text" placeholder="例如 0056" value={newHoldingName} onChange={e => setNewHoldingName(e.target.value)} className="flex-1 min-w-0 bg-gray-100 rounded-xl px-3 py-2 text-base outline-none" />
                  <button onClick={() => { const n = newHoldingName.trim(); if (!n || holdings.some(h => h.name === n)) return; setHoldings([...holdings, { name: n, quantity: 0, cost: 0 }]); setNewHoldingName(''); }} disabled={!newHoldingName.trim()} className="px-3 py-2 rounded-xl text-white disabled:opacity-40" style={{ backgroundColor: THEME.accent }} aria-label="新增持倉"><Plus className="w-5 h-5" /></button>
                </CardContainer>
              </div>
            </>
          );

        case 'market':
          return (
            <div>
              <SectionHeader>試算表 CSV 網址</SectionHeader>
              <CardContainer className="p-4">
                <textarea rows={3} placeholder="https://docs.google.com/spreadsheets/d/e/.../pub?...output=csv" value={initialStats.priceCsvUrl || ''}
                  onChange={e => setInitialStats(prev => ({ ...prev, priceCsvUrl: e.target.value.trim() }))}
                  className="w-full text-sm text-gray-600 outline-none resize-none bg-transparent break-all" />
              </CardContainer>
            </div>
          );

        case 'reconcile':
          return renderReconcileCard();

        case 'backup':
          return (
            <>
              <CardContainer className="divide-y divide-gray-100">
                <button onClick={handleExportBackup} className="w-full px-4 py-3 flex items-center gap-3 active:bg-gray-100 text-left">
                  <Download className="w-5 h-5" style={{ color: THEME.accent }} /><span className="text-base text-black">匯出完整備份</span>
                </button>
                <button onClick={() => importInputRef.current && importInputRef.current.click()} className="w-full px-4 py-3 flex items-center gap-3 active:bg-gray-100 text-left">
                  <RefreshCcw className="w-5 h-5" style={{ color: THEME.accent }} /><span className="text-base text-black">匯入備份</span>
                </button>
              </CardContainer>
              <input ref={importInputRef} type="file" accept=".json,application/json" onChange={handleImportBackup} className="hidden" />
              {backupMessage && <p className={`text-sm font-bold px-4 ${backupMessage.ok ? 'text-green-600' : 'text-red-500'}`}>{backupMessage.text}</p>}
              <div>
                <SectionHeader>儲存空間</SectionHeader>
                <CardContainer className="p-4">
                  <div className="h-2 w-full bg-gray-100 rounded-full overflow-hidden"><div className={`h-full rounded-full ${usagePercent > 90 ? 'bg-red-500' : 'bg-green-500'}`} style={{ width: `${usagePercent}%` }}></div></div>
                  <p className="text-sm text-gray-500 mt-2">已使用 {usagePercent.toFixed(1)}%</p>
                </CardContainer>
              </div>
            </>
          );

        default:
          return null;
      }
    };

    if (settingsPage) {
      return (
        <div className="space-y-6 pt-2 pb-6">
          <div>
            <button onClick={() => setSettingsPage(null)} className="flex items-center -ml-1 mb-2 text-base" style={{ color: THEME.accent }}><ChevronLeft className="w-5 h-5" />設定</button>
            <h2 className="text-3xl font-bold text-black tracking-tight px-1">{PAGE_TITLES[settingsPage]}</h2>
          </div>
          {renderPage()}
        </div>
      );
    }

    const budgetCount = Object.values(budgets).filter(v => (v as number) > 0).length;
    const goalCount = (initialStats.goals || []).length;
    const installmentCount = installmentSummary().length;

    return (
      <div className="space-y-6 pt-2 pb-6">
        <h2 className="text-3xl font-bold text-black tracking-tight px-1">設定</h2>
        <div>
          <SectionHeader>記帳</SectionHeader>
          <CardContainer className="divide-y divide-gray-100">
            <NavRow label="結餘分配" detail={`可花 ${spendRatio}%`} onClick={() => setSettingsPage('ratio')} />
            <NavRow label="分類與預算" detail={budgetCount > 0 ? `${budgetCount} 項預算` : undefined} onClick={() => setSettingsPage('categories')} />
            <NavRow label="夢想帳戶" detail={goalCount > 0 ? `${goalCount} 個` : '未設定'} onClick={() => setSettingsPage('goals')} />
            <NavRow label="分期付款" detail={installmentCount > 0 ? `${installmentCount} 筆進行中` : '無'} onClick={() => setSettingsPage('installments')} />
            <NavRow label="起始數值" onClick={() => setSettingsPage('initial')} />
          </CardContainer>
        </div>
        <div>
          <SectionHeader>投資</SectionHeader>
          <CardContainer className="divide-y divide-gray-100">
            <NavRow label="持倉" detail={`${holdings.length} 檔`} onClick={() => setSettingsPage('holdings')} />
            <NavRow label="市場價格" detail={initialStats.priceCsvUrl ? '已連結' : '未設定'} onClick={() => setSettingsPage('market')} />
          </CardContainer>
        </div>
        <div>
          <SectionHeader>資料</SectionHeader>
          <CardContainer className="divide-y divide-gray-100">
            <NavRow label="餘額校正" onClick={() => setSettingsPage('reconcile')} />
            <NavRow label="備份與匯入" onClick={() => setSettingsPage('backup')} />
          </CardContainer>
        </div>
        <CardContainer><NavRow label="初始化所有資料" danger onClick={() => setResetModal(true)} /></CardContainer>
        <p className="text-center text-xs text-gray-400">{APP_NAME} {APP_VERSION}</p>
      </div>
    );
  };

  // ================= 版面 =================
  const scrollContainerClasses = 'flex-1 relative p-5 overflow-y-auto hide-scrollbar pb-24';
  const calcKey = (key: string, label: React.ReactNode, dark = false, extra = '') => (
    <button key={key} onClick={() => handleCalcInput(key)} className={`h-full rounded-xl text-2xl font-semibold flex items-center justify-center transition-colors ${dark ? 'bg-black border border-white/20 text-white active:bg-gray-800' : 'bg-white text-black active:bg-gray-200'} ${extra}`}>{label}</button>
  );
  const tabButton = (tab: string, label: string, icon: React.ReactNode, onClick?: () => void) => (
    <button onClick={onClick || (() => setActiveTab(tab))} className={`flex flex-col items-center justify-center w-20 h-14 rounded-2xl transition-all duration-200 ${activeTab === tab ? 'bg-gray-100 text-black' : 'text-gray-400 active:bg-gray-50'}`}>{icon}<span className="text-xs font-bold">{label}</span></button>
  );

  return (
    <>
      <style>{`body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #F2F2F7; } .hide-scrollbar::-webkit-scrollbar { display: none; } .hide-scrollbar { -ms-overflow-style: none; scrollbar-width: none; } @keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } } .animation-slide-up { animation: slideUp 0.2s cubic-bezier(0.16, 1, 0.3, 1) forwards; } * { -webkit-tap-highlight-color: transparent; }`}</style>
      <div className="fixed inset-0 w-full bg-gray-100 flex justify-center items-center overflow-hidden" style={{ height: '100dvh' }}>
        <div className="w-full max-w-md h-full bg-gray-100 flex flex-col relative shadow-2xl overflow-hidden select-none touch-manipulation overscroll-none" ref={scrollRef}>
          {deleteModal.show && (
            <div className="absolute inset-0 z-50 flex items-center justify-center p-8 bg-black/20">
              <div className="bg-white rounded-xl shadow-2xl w-full max-w-xs text-center overflow-hidden">
                <div className="p-5"><h3 className="text-lg font-bold text-black mb-1">刪除紀錄？</h3><p className="text-sm text-gray-500">此動作無法復原。</p></div>
                <div className="flex border-t border-gray-200">
                  <button onClick={() => setDeleteModal({ show: false, id: null })} className="flex-1 py-3 text-lg text-black border-r border-gray-200 active:bg-gray-100">取消</button>
                  <button onClick={confirmDelete} className="flex-1 py-3 text-lg text-red-500 font-bold active:bg-gray-100">刪除</button>
                </div>
              </div>
            </div>
          )}
          {resetModal && (
            <div className="absolute inset-0 z-50 flex items-center justify-center p-8 bg-black/40">
              <div className="bg-white rounded-xl shadow-2xl w-full max-w-xs text-center overflow-hidden">
                <div className="p-5"><AlertTriangle className="w-8 h-8 text-red-500 mx-auto mb-3" /><h3 className="text-lg font-bold text-black mb-1">確認初始化？</h3><p className="text-sm text-gray-500">所有紀錄與設定將被永久刪除。</p></div>
                <div className="flex border-t border-gray-200">
                  <button onClick={() => setResetModal(false)} className="flex-1 py-3 text-lg text-black border-r border-gray-200 active:bg-gray-100">取消</button>
                  <button onClick={handleResetApp} className="flex-1 py-3 text-lg text-red-500 font-bold active:bg-gray-100">確認重置</button>
                </div>
              </div>
            </div>
          )}
          {isCalculatorOpen && (
            <>
              <div className="absolute inset-0 z-40 bg-transparent" onClick={() => setIsCalculatorOpen(false)}></div>
              <div className="absolute inset-x-0 bottom-0 z-50 bg-black shadow-2xl animation-slide-up flex flex-col pt-5 px-3 h-96 rounded-t-3xl" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 30px)' }}>
                <div className="grid grid-cols-4 gap-2 h-full">
                  {calcKey('AC', 'AC')}{calcKey('DEL', <Delete className="w-6 h-6" />)}{calcKey('%', '%')}{calcKey('/', '÷', true)}
                  {calcKey('7', '7')}{calcKey('8', '8')}{calcKey('9', '9')}{calcKey('*', '×', true)}
                  {calcKey('4', '4')}{calcKey('5', '5')}{calcKey('6', '6')}{calcKey('-', '-', true)}
                  {calcKey('1', '1')}{calcKey('2', '2')}{calcKey('3', '3')}{calcKey('+', '+', true)}
                  {calcKey('0', '0', false, 'col-span-2')}{calcKey('.', '.')}{calcKey('=', '=', true)}
                </div>
              </div>
            </>
          )}
          <div className={scrollContainerClasses} style={{ paddingTop: 'calc(env(safe-area-inset-top) + 20px)' }}>
            {activeTab === 'dashboard' && renderDashboardView()}
            {activeTab === 'history' && renderHistoryView()}
            {activeTab === 'form' && renderFormView()}
            {activeTab === 'investment' && renderInvestmentView()}
            {activeTab === 'settings' && renderSettingsView()}
          </div>
          <div className="flex-none bg-white border-t border-gray-200 pt-2 px-2 flex justify-around items-center z-30" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 5px)' }}>
            {tabButton('dashboard', '總覽', <PieChart className="w-6 h-6 mb-0.5" strokeWidth={2.5} />)}
            {tabButton('history', '明細', <List className="w-6 h-6 mb-0.5" strokeWidth={2.5} />, () => { setActiveTab('history'); setFilterCategory(null); setFilterTag(null); setSearchQuery(''); })}
            <div className="relative -top-6"><button onClick={handleFabClick} aria-label="新增紀錄" className={`w-14 h-14 rounded-full flex items-center justify-center text-white shadow-xl transition-transform ${activeTab === 'form' && !editingId ? 'bg-gray-900 rotate-45' : 'bg-black'}`}><Plus className="w-7 h-7" strokeWidth={3} /></button></div>
            {tabButton('investment', '投資', <TrendingUp className="w-6 h-6 mb-0.5" strokeWidth={2.5} />)}
            {tabButton('settings', '設定', <Settings className="w-6 h-6 mb-0.5" strokeWidth={2.5} />, () => { setActiveTab('settings'); setSettingsPage(null); })}
          </div>
        </div>
      </div>
    </>
  );
}
