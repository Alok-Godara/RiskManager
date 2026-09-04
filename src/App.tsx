import { useState } from "react";
import "./App.css";
import { useRiskManagerData } from "./hooks/useRiskManagerData";
import { PortfolioDashboard } from "./components/PortfolioDashboard";
import { InstrumentDashboard } from "./components/InstrumentDashboard";
import { StructureList } from "./components/StructureList";
import { NewStructureForm } from "./components/NewStructureForm";
import { StructureDetail } from "./components/StructureDetail";
import { AuditLog } from "./components/AuditLog";
import { MarketDataService } from "./services/MarketDataService";

type Tab = "portfolio" | "instrument" | "structures" | "audit";

function App() {
  const { instruments, contracts, snapshots, portfolio, auditEvents, loading, reload } =
    useRiskManagerData();
  const [tab, setTab] = useState<Tab>("portfolio");
  const [selectedStructureId, setSelectedStructureId] = useState<string | null>(null);

  if (loading) {
    return <div className="app-loading">Loading Risk Manager…</div>;
  }

  const selectedSnapshot = snapshots.find((s) => s.structure.id === selectedStructureId);

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Risk Manager</h1>
        <div className="market-status">
          Market Data: {MarketDataService.getProviderName()} · Live
        </div>
      </header>

      <nav className="tabs">
        <button className={tab === "portfolio" ? "active" : ""} onClick={() => setTab("portfolio")}>
          Portfolio
        </button>
        <button className={tab === "instrument" ? "active" : ""} onClick={() => setTab("instrument")}>
          Instrument Exposure
        </button>
        <button
          className={tab === "structures" ? "active" : ""}
          onClick={() => {
            setTab("structures");
            setSelectedStructureId(null);
          }}
        >
          Structures
        </button>
        <button className={tab === "audit" ? "active" : ""} onClick={() => setTab("audit")}>
          Audit Trail
        </button>
      </nav>

      <main className="app-main">
        {tab === "portfolio" && <PortfolioDashboard summary={portfolio} />}

        {tab === "instrument" && (
          <InstrumentDashboard instruments={instruments} snapshots={snapshots} />
        )}

        {tab === "structures" && !selectedSnapshot && (
          <>
            <StructureList snapshots={snapshots} onSelect={setSelectedStructureId} />
            <NewStructureForm instruments={instruments} contracts={contracts} onCreated={reload} />
          </>
        )}

        {tab === "structures" && selectedSnapshot && (
          <StructureDetail
            snapshot={selectedSnapshot}
            onBack={() => setSelectedStructureId(null)}
            onChanged={reload}
          />
        )}

        {tab === "audit" && <AuditLog events={auditEvents} />}
      </main>
    </div>
  );
}

export default App;
