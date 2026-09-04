import { useState } from "react";
import type { Instrument, StructureTemplate } from "../types/domain";
import { InstrumentSettings } from "./settings/InstrumentSettings";
import { StructureTemplateSettings } from "./settings/StructureTemplateSettings";
import { ApiSettings } from "./settings/ApiSettings";

type SettingsTab = "instruments" | "templates" | "api";

export function Settings({
  instruments,
  templates,
  onChanged,
}: {
  instruments: Instrument[];
  templates: StructureTemplate[];
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<SettingsTab>("instruments");

  return (
    <div>
      <div className="settings-tabs">
        <button className={tab === "instruments" ? "active" : ""} onClick={() => setTab("instruments")}>
          Instruments
        </button>
        <button className={tab === "templates" ? "active" : ""} onClick={() => setTab("templates")}>
          Structure Templates
        </button>
        <button className={tab === "api" ? "active" : ""} onClick={() => setTab("api")}>
          API Configuration
        </button>
      </div>

      {tab === "instruments" && <InstrumentSettings instruments={instruments} onChanged={onChanged} />}
      {tab === "templates" && <StructureTemplateSettings templates={templates} onChanged={onChanged} />}
      {tab === "api" && <ApiSettings />}
    </div>
  );
}
