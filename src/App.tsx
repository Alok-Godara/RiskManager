import { useState, type ReactElement } from "react";
import "./App.css";
import { useRiskManagerData } from "./hooks/useRiskManagerData";
import { PortfolioDashboard } from "./components/PortfolioDashboard";
import { InstrumentDashboard } from "./components/InstrumentDashboard";
import { StructureList } from "./components/StructureList";
import { NewStructureForm } from "./components/NewStructureForm";
import { StructureDetail } from "./components/StructureDetail";
import { AuditLog } from "./components/AuditLog";
import { Settings } from "./components/Settings";
import { MarketDataService } from "./services/MarketDataService";
import { isCloudConfigured } from "./data";
import { fmtMoney, pnlClass } from "./utils/format";
import { IconGrid, IconLayers, IconStructure, IconClock, IconCloud, IconDisk, IconSettings } from "./components/icons";

type Tab = "dashboard" | "structures" | "positions" | "history" | "settings";

const NAV: { id: Tab; label: string; icon: (props: { size?: number }) => ReactElement }[] = [
  { id: "dashboard", label: "Dashboard", icon: IconGrid },
  { id: "structures", label: "Structures", icon: IconStructure },
  { id: "positions", label: "Positions", icon: IconLayers },
  { id: "history", label: "History", icon: IconClock },
  { id: "settings", label: "Settings", icon: IconSettings },
];

const TAB_TITLES: Record<Tab, string> = {
  dashboard: "Portfolio Dashboard",
  structures: "Structures",
  positions: "Instrument Net Positions",
  history: "History & Audit Trail",
  settings: "Settings",
};

function App() {
  const {
    instruments,
    activeInstruments,
    contracts,
    templates,
    activeTemplates,
    snapshots,
    portfolio,
    auditEvents,
    loading,
    reload,
  } = useRiskManagerData();
  const [tab, setTab] = useState<Tab>("dashboard");
  const [selectedStructureId, setSelectedStructureId] = useState<string | null>(null);
  const [creatingStructure, setCreatingStructure] = useState(false);

  if (loading) {
    return (
      <div className="app-loading">
        <div className="loading-spinner" />
        <span>Loading Risk Manager…</span>
      </div>
    );
  }

  const selectedSnapshot = snapshots.find((s) => s.structure.id === selectedStructureId);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">RM</div>
          <div className="brand-text">
            <span className="brand-name">Risk Manager</span>
            <span className="brand-sub">Structure Trading</span>
          </div>
        </div>

        <nav className="side-nav">
          {NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={tab === id ? "active" : ""}
              onClick={() => {
                setTab(id);
                if (id === "structures") {
                  setSelectedStructureId(null);
                  setCreatingStructure(false);
                }
              }}
            >
              <span className="nav-icon">
                <Icon size={17} />
              </span>
              {label}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className={`data-source-pill ${isCloudConfigured ? "cloud" : "local"}`}>
            {isCloudConfigured ? <IconCloud size={12} /> : <IconDisk size={12} />}
            {isCloudConfigured ? "Supabase" : "Local (IndexedDB)"}
          </div>
          <div className="market-pulse">
            <span className="pulse-dot" />
            <div>
              <div className="pulse-label">Market Data</div>
              <div className="pulse-value">{MarketDataService.getProviderName()}</div>
            </div>
          </div>
        </div>
      </aside>

      <div className="main-col">
        <header className="topbar">
          <div className="topbar-title">{TAB_TITLES[tab]}</div>
          <div className="ticker">
            <div className="ticker-item">
              <span className="ticker-label">Net P&amp;L</span>
              <span className={`ticker-value ${pnlClass(portfolio?.net_pnl ?? 0)}`}>
                {fmtMoney(portfolio?.net_pnl ?? 0)}
              </span>
            </div>
            <div className="ticker-item">
              <span className="ticker-label">Risk Utilized</span>
              <span className="ticker-value">{fmtMoney(portfolio?.risk_utilized ?? 0)}</span>
            </div>
            <div className="ticker-item">
              <span className="ticker-label">Open Structures</span>
              <span className="ticker-value">{portfolio?.open_structures ?? 0}</span>
            </div>
          </div>
        </header>

        <main className="app-main">
          {tab === "dashboard" && <PortfolioDashboard summary={portfolio} />}

          {tab === "positions" && <InstrumentDashboard instruments={instruments} snapshots={snapshots} />}

          {tab === "structures" && !selectedSnapshot && creatingStructure && (
            <NewStructureForm
              instruments={activeInstruments}
              contracts={contracts}
              templates={activeTemplates}
              onCreated={() => {
                reload();
                setCreatingStructure(false);
              }}
              onCancel={() => setCreatingStructure(false)}
            />
          )}

          {tab === "structures" && !selectedSnapshot && !creatingStructure && (
            <StructureList
              snapshots={snapshots}
              onSelect={setSelectedStructureId}
              onNewStructure={() => setCreatingStructure(true)}
            />
          )}

          {tab === "structures" && selectedSnapshot && (
            <StructureDetail
              snapshot={selectedSnapshot}
              onBack={() => setSelectedStructureId(null)}
              onChanged={reload}
            />
          )}

          {tab === "history" && <AuditLog events={auditEvents} />}

          {tab === "settings" && (
            <Settings instruments={instruments} templates={templates} onChanged={reload} />
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
