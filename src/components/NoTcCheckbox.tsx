/** "Without transaction cost" tick-box shared by the Exit, Add Entry and Correction windows — see Execution.tc_waived. */
export function NoTcCheckbox({
  checked,
  onChange,
  help,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  help: string;
}) {
  return (
    <div className="form-row">
      <label>
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ marginRight: 6 }} />
        Without transaction cost
      </label>
      <p className="helper-text">{help}</p>
    </div>
  );
}
