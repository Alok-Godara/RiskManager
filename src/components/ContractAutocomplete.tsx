import { useEffect, useRef, useState } from "react";
import type { Contract } from "../types/domain";

/**
 * Type-to-filter contract picker: type e.g. "apr" to match Apr26/Apr27,
 * arrow keys to move the highlight, Enter to select, Escape/blur to close.
 * Replaces a plain <select> which becomes unwieldy with 24 months x N years
 * of contracts.
 */
export function ContractAutocomplete({
  contracts,
  value,
  onChange,
  placeholder = "Type month, e.g. Apr26…",
}: {
  contracts: Contract[];
  value: string;
  onChange: (contractId: string) => void;
  placeholder?: string;
}) {
  const selected = contracts.find((c) => c.id === value);
  const [query, setQuery] = useState(selected?.month_label ?? "");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setQuery(selected?.month_label ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery(selected?.month_label ?? "");
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const matches = contracts
    .filter((c) => c.month_label.toLowerCase().includes(query.trim().toLowerCase()))
    .slice(0, 12);

  function selectContract(c: Contract) {
    onChange(c.id);
    setQuery(c.month_label);
    setOpen(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter") {
        setOpen(true);
        setHighlight(0);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (matches[highlight]) selectContract(matches[highlight]);
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery(selected?.month_label ?? "");
    }
  }

  return (
    <div className="autocomplete" ref={rootRef}>
      <input
        value={query}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onKeyDown={handleKeyDown}
      />
      {open && matches.length > 0 && (
        <ul className="autocomplete-list">
          {matches.map((c, i) => (
            <li
              key={c.id}
              className={i === highlight ? "highlighted" : ""}
              onMouseDown={(e) => {
                e.preventDefault();
                selectContract(c);
              }}
              onMouseEnter={() => setHighlight(i)}
            >
              {c.month_label}
            </li>
          ))}
        </ul>
      )}
      {open && matches.length === 0 && (
        <ul className="autocomplete-list">
          <li className="autocomplete-empty">No matching months</li>
        </ul>
      )}
    </div>
  );
}
